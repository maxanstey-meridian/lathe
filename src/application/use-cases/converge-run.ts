// ---------------------------------------------------------------------------
// Converge-run orchestration (CONTRACT §18)
//
// Application-layer use case that runs the convergence loop: verification,
// super-daddy review, the pure decision, and the act (stop / author / escalate)
// with all bookkeeping. This is the always-on post-run step the run loop calls.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from "node:fs"
import { decideConvergence, renderFollowupPacket, assembleCommitMessage, renderNits, type ConvergeDecision } from "../../domain/convergence.js"
import { campaignIdForRun, upsertPass, alreadyReviewed, type CampaignPass } from "../../domain/campaign.js"
import { parsePacketShape } from "../../domain/packet.js"
import type { OutcomeDef, Packet } from "../../domain/packet.js"
import type { Store, ConvergenceLogEntry } from "../ports/store.js"
import type { Reviewer, SuperReviewResult } from "../ports/reviewer.js"
import type { Repo } from "../ports/repo.js"
import type { Verify, VerificationResult } from "../ports/verify.js"
import type { Clock } from "../ports/clock.js"
import type { Config } from "../../config/schemas.js"
import type { Paths } from "../../config/paths.js"
import { expandHome } from "../../config/paths.js"

// ---------------------------------------------------------------------------
// Dependencies

export type ConvergeDeps = {
  store: Store
  repo: Repo
  reviewer: Reviewer
  verify: Verify
  clock: Clock
  config: Config
  paths: Paths
}

// ---------------------------------------------------------------------------
// Pure helpers

const allGreen = (results: VerificationResult[]): boolean =>
  results.every((r) => r.exitCode === 0)

const isoToTimestamp = (iso: string): string =>
  iso.slice(0, 10).replace(/-/g, "") + "-" + iso.slice(11, 19).replace(/:/g, "")

const campaignPassOf = (
  runId: string,
  pass: number,
  review: SuperReviewResult,
  atIso: string,
): CampaignPass => ({
  runId,
  pass,
  verdict: review.review.verdict,
  groundedBlockers: review.review.findings.filter((f) => f.grounding.kind !== "none").length,
  atIso,
})

const makeConvergenceEntry = (
  runId: string,
  campaignId: string,
  pass: number,
  maxPasses: number,
  verification: VerificationResult[],
  decision: ConvergeDecision,
  review: SuperReviewResult,
  amendedSha: string | null,
  atIso: string,
): ConvergenceLogEntry => ({
  at: atIso,
  runId,
  campaignId,
  pass,
  maxPasses,
  verification: { green: allGreen(verification), commands: verification },
  decision,
  amendedCommitSha: amendedSha,
  primary: review.review,
  primaryRaw: review.raw,
})

const slugFromRunId = (runId: string, pass: number): string => {
  const parts = runId.split("-").slice(2)
  // Strip any prior -fixN suffix before appending the new one.
  while (parts.length > 0) {
    const last = parts[parts.length - 1]
    if (last === undefined || !last.startsWith("fix")) break
    parts.pop()
  }
  const base = parts.join("-")
  return `${base}-fix${pass}`
}

// ---------------------------------------------------------------------------
// Main entry point — matches `ConvergeCallback = (runId: string) => Promise<void>`

export const convergeRun = (deps: ConvergeDeps): (runId: string) => Promise<void> => {
  const { store, repo, reviewer, verify, clock, config, paths } = deps

  return async (runId: string): Promise<void> => {
    const meta = store.readMeta(runId)

    // --- Load packet --------------------------------------------------------
    let packet: Packet

    let frozenRaw: string | undefined
    try {
      frozenRaw = store.readFrozenPacket(runId)
    } catch {
      frozenRaw = undefined
    }

    if (frozenRaw) {
      const parsed = parsePacketShape(frozenRaw, runId)
      if (!parsed.ok) {
        throw new Error(`convergeRun: cannot parse frozen packet: ${parsed.problems.join("; ")}`)
      }
      packet = parsed.packet
    } else {
      // Fresh queue entry with no frozen packet — derive from meta.
      packet = {
        runId: meta.runId,
        frontmatter: {
          repo: meta.repo,
          base: meta.base,
          outcomes: [],
          expected_surface: [],
          suspicious_surface: [],
          verification: [],
          constraints: [],
          autofix_commands: [],
          pass: 1,
          regression_outcomes: [],
        },
        body: "",
        raw: "",
      }
    }

    const campaignId = campaignIdForRun(packet, runId)
    const campaign = store.readCampaign(campaignId)
    const maxPasses = config.thresholds.maxPasses

    // S10: pass already recorded → pure early return, zero side effects.
    if (alreadyReviewed(campaign, runId)) {
      return
    }

    const pass = packet.frontmatter.pass
    const atIso = clock.nowIso()

    // --- Convergence loop ---------------------------------------------------
    try {
      // 1. Autofix — best-effort mechanical fixes scoped to expected_surface.
      await verify.runAutoFix(
        packet.frontmatter.autofix_commands,
        packet.frontmatter.expected_surface,
        meta.worktree,
        config.thresholds.verificationTimeoutMs,
      )

      // 2. Verification — driver's own run, ground truth (S6).
      const verificationResults = await verify.run(
        packet.frontmatter.verification,
        meta.worktree,
        config.thresholds.verificationTimeoutMs,
      )
      const verificationGreen = allGreen(verificationResults)

      // 3. Super-daddy review — ONE reviewer, trusted (S2/S4).
      const diff = repo.reviewableDiffAgainst(
        meta.worktree,
        meta.base,
        config.superdaddy.diffCapBytes,
      )
      const reportText = existsSync(paths.reportFile(runId))
        ? readFileSync(paths.reportFile(runId), "utf-8")
        : ""
      const skillPath = expandHome(config.superdaddy.skillPath)
      const skillText = readFileSync(skillPath, "utf-8")

      const result: SuperReviewResult = await reviewer.superReview({
        packet,
        diff,
        reportText,
        skillText,
        pass,
        maxPasses,
        campaignId,
      })

      // 3. Pure decision.
      const decision = decideConvergence(
        result.review,
        verificationGreen,
        pass,
        maxPasses,
      )

      // 4. Act on the decision.
      let amendedSha: string | null = null

      switch (decision.action) {
        case "stop": {
           // Campaign converged; run STAYS ready_for_review (S9/R3).
           // Un-park a previously-blocked run.
           if (meta.status !== "ready_for_review") {
             const { blockedReason: _br, blockedQuestion: _bq, ...rest } = meta
             store.writeMeta({ ...rest, status: "ready_for_review", updatedAt: atIso })
           }
           // Amend commit message — best effort, not fatal.
           if (result.review.commit_message) {
             try {
               const msg = assembleCommitMessage(result.review.commit_message)
               amendedSha = repo.amendCommit(meta.worktree, msg)
             } catch {
               // R3: a missing message or a git failure there leaves the WIP
               // line rather than failing convergence.
               amendedSha = null
             }
           }
           break
         }

        case "author": {
          // Fetch parent tip into source repo FIRST (S8/§19), then render + admit.
          try {
            repo.fetchBranchFromClone(
              packet.frontmatter.repo,
              meta.worktree,
              meta.branch,
            )
          } catch {
            // Transient fetch failure — admission of the follow-up will fail
            // its base-verify, which is correct behaviour.
          }

          const priorOutcomes: OutcomeDef[] = [
            ...new Map(
              packet.frontmatter.outcomes
                .concat(packet.frontmatter.regression_outcomes)
                .map((o) => [o.id, o]),
            ).values(),
          ]

          const followup = renderFollowupPacket({
            original: packet,
            parentRunId: runId,
            campaignId,
            pass: pass + 1,
            blockers: decision.blockers,
            priorOutcomes,
            baseBranch: meta.branch,
            timestamp: isoToTimestamp(atIso),
            slug: slugFromRunId(runId, pass + 1),
          })

          store.admitQueue(followup.runId, followup.content)
          break
        }

        case "escalate": {
          // Park blocked/human_decision.
          const blockedMeta = {
            ...meta,
            status: "blocked" as const,
            blockedReason: "human_decision" as const,
            blockedQuestion: decision.reason,
            updatedAt: atIso,
          }
          store.writeMeta(blockedMeta)
          break
        }
      }

      // 5. Campaign ledger — upsert the pass.
      const campaignPass = campaignPassOf(runId, pass, result, atIso)
      const campaignStatus: "open" | "converged" | "needs_max" = (() => {
        switch (decision.action) {
          case "stop": return "converged"
          case "author": return "open"
          case "escalate": return "needs_max"
        }
      })()

      const updated = upsertPass(
        campaign,
        { campaignId, originalRunId: packet.frontmatter.parent_run_id ?? runId, originalIntent: packet.frontmatter.outcomes[0]?.description.slice(0, 160) ?? runId, maxPasses },
        campaignPass,
        campaignStatus,
      )
      store.writeCampaign(updated)

      // 6. Nits — super-daddy's by-the-way findings (NOT when authoring;
      // every finding becomes a packet outcome on author — S10).
      if (decision.action !== "author") {
        const nits = renderNits(runId, result.review)
        if (nits) {
          store.writeNits(runId, nits)
        }
      }

      // 7. Convergence log.
      const entry = makeConvergenceEntry(
        runId,
        campaignId,
        pass,
        maxPasses,
        verificationResults,
        decision,
        result,
        amendedSha,
        atIso,
      )
      store.appendConvergence(runId, entry)
    } catch {
      // Fail-safe: ANY error leaves the run ready_for_review
      // (never corrupt a finished result).
      try {
        const currentMeta = store.readMeta(runId)
        store.writeMeta({
          ...currentMeta,
          status: "ready_for_review" as const,
          updatedAt: clock.nowIso(),
        })
      } catch {
        // If we can't even write meta, the run stays wherever it is.
      }
    }
  }
}
