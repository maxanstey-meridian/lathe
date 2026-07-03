// ---------------------------------------------------------------------------
// Converge-run orchestration (CONTRACT §18)
//
// Application-layer use case that runs the convergence loop: verification,
// super-daddy review, the pure decision, and the act (stop / author / escalate)
// with all bookkeeping. This is the always-on post-run step the run loop calls.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import type { Paths } from "../../config/paths.js";
import { expandHome } from "../../config/paths.js";
import type { Config } from "../../config/schemas.js";
import {
  campaignIdForRun,
  upsertPass,
  alreadyReviewed,
  type CampaignPass,
} from "../../domain/campaign.js";
import {
  decideConvergence,
  stampFollowupLineage,
  assembleCommitMessage,
  renderNits,
  type ConvergeDecision,
} from "../../domain/convergence.js";
import { parsePacketShape } from "../../domain/packet.js";
import type { OutcomeDef, Packet } from "../../domain/packet.js";
import type { Clock } from "../ports/clock.js";
import type { Repo } from "../ports/repo.js";
import type { Reviewer, SuperReviewResult } from "../ports/reviewer.js";
import type { Store, ConvergenceLogEntry } from "../ports/store.js";
import type { Verify, VerificationResult } from "../ports/verify.js";

// ---------------------------------------------------------------------------
// Dependencies

export type ConvergeDeps = {
  store: Store;
  repo: Repo;
  reviewer: Reviewer;
  verify: Verify;
  clock: Clock;
  config: Config;
  paths: Paths;
};

// ---------------------------------------------------------------------------
// Pure helpers

const allGreen = (results: VerificationResult[]): boolean => results.every((r) => r.exitCode === 0);

const isoToTimestamp = (iso: string): string =>
  iso.slice(0, 10).replace(/-/g, "") + "-" + iso.slice(11, 19).replace(/:/g, "");

const campaignPassOf = (
  runId: string,
  attempt: number,
  pass: number,
  review: SuperReviewResult,
  atIso: string,
): CampaignPass => ({
  runId,
  attempt,
  pass,
  verdict: review.review.verdict,
  groundedBlockers: review.review.findings.filter((f) => f.grounding.kind !== "none").length,
  atIso,
});

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
  kind: "reviewed",
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
});

// An UNREACHABLE attempt — logged honestly (no forged verdict/decision) so
// reading convergence.jsonl shows the transport drop for what it was.
const makeUnreachableEntry = (
  runId: string,
  campaignId: string,
  pass: number,
  maxPasses: number,
  verification: VerificationResult[],
  detail: string,
  attempt: number,
  budget: number,
  atIso: string,
): ConvergenceLogEntry => ({
  kind: "unreachable",
  at: atIso,
  runId,
  campaignId,
  pass,
  maxPasses,
  verification: { green: allGreen(verification), commands: verification },
  detail,
  attempt,
  budget,
});

const slugFromRunId = (runId: string, pass: number): string => {
  const parts = runId.split("-").slice(2);
  // Strip any prior -fixN suffix before appending the new one.
  while (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last === undefined || !last.startsWith("fix")) {
      break;
    }
    parts.pop();
  }
  const base = parts.join("-");
  return `${base}-fix${pass}`;
};

// ---------------------------------------------------------------------------
// Main entry point — matches `ConvergeCallback = (runId: string) => Promise<void>`

export const convergeRun = (deps: ConvergeDeps): ((runId: string) => Promise<void>) => {
  const { store, repo, reviewer, verify, clock, config } = deps;

  return async (runId: string): Promise<void> => {
    store.writeActiveConvergence({ runId, startedAt: clock.nowIso() });
    try {
      let meta = store.readMeta(runId);

      // --- Load packet --------------------------------------------------------
      const queueRaw = store.readQueuePacket(runId);
      if (!queueRaw) {
        throw new Error(`convergeRun: no queue packet for ${runId}`);
      }
      const parsed = parsePacketShape(queueRaw, runId);
      if (!parsed.ok) {
        throw new Error(`convergeRun: cannot parse queue packet: ${parsed.problems.join("; ")}`);
      }
      const packet: Packet = parsed.packet;

      const campaignId = campaignIdForRun(packet, runId);
      const campaign = store.readCampaign(campaignId);
      const maxPasses = config.thresholds.maxPasses;

      // S10: pass already recorded → pure early return, zero side effects.
      if (alreadyReviewed(campaign, runId, meta.attempt)) {
        return;
      }

      const pass = packet.frontmatter.pass;
      const atIso = clock.nowIso();

      // Record super-daddy's session into meta the instant the reviewer binds it,
      // so `lathe tail` can route the reviewer's live tool calls (pnpm test, git
      // diff, reads) to its pane DURING the review. Re-reads meta on each bind to
      // avoid clobbering concurrent fields (single-driver, but stay additive).
      const recordReviewerSession = (sessionId: string): void => {
        const current = store.readMeta(runId);
        if (current.reviewerSessionId !== sessionId) {
          store.writeMeta({ ...current, reviewerSessionId: sessionId, updatedAt: clock.nowIso() });
        }
      };

      // --- Convergence loop ---------------------------------------------------
      try {
        // 1. Autofix — best-effort mechanical fixes scoped to expected_surface.
        await verify.runAutoFix(
          packet.frontmatter.autofix_commands,
          packet.frontmatter.expected_surface,
          meta.worktree,
          config.thresholds.verificationTimeoutMs,
        );

        // 2. Verification — driver's own command execution (S6).
        const verificationResults = await verify.run(
          packet.frontmatter.verification,
          meta.worktree,
          config.thresholds.verificationTimeoutMs,
        );
        const verificationGreen = allGreen(verificationResults);

        // 3. Super-daddy review — ONE reviewer, trusted (S2/S4). The reviewer's
        // cwd IS the worktree; it inspects the tree directly (git diff HEAD, rg,
        // read) rather than being handed a diff slice.
        const reportText = store.readReport(runId);
        const skillPath = expandHome(config.superdaddy.skillPath);
        const skillText = readFileSync(skillPath, "utf-8");

        const outcome = await reviewer.superReview(
          {
            packet,
            worktree: meta.worktree,
            reportText,
            skillText,
            pass,
            maxPasses,
            campaignId,
          },
          recordReviewerSession,
        );

        // 3a. Transport failure — NOT a verdict. Never record a campaign pass (that
        // would make alreadyReviewed no-op the retry), never author/stop from a
        // non-result. Self-heal: bump the counter and leave the run as-is so the
        // next drive-loop sweep / a manual `lathe converge` retries. Only after
        // maxReviewerUnreachable consecutive drops do we park for Max — Codex is
        // durably down or misconfigured — resetting the counter (and NOT recording
        // a pass) so a manual re-run works once the connection is fixed.
        if (outcome.kind === "unreachable") {
          const attempt = (meta.reviewerUnreachable ?? 0) + 1;
          const budget = config.thresholds.maxReviewerUnreachable;
          if (attempt >= budget) {
            const { blockedReason: _br, blockedQuestion: _bq, ...rest } = meta;
            store.writeMeta({
              ...rest,
              status: "blocked",
              blockedReason: "human_decision",
              blockedQuestion: `Super-daddy unreachable after ${attempt} attempts — last: ${outcome.detail}. Check the Codex connection, then re-run \`lathe converge ${runId}\`.`,
              reviewerUnreachable: 0,
              updatedAt: atIso,
            });
          } else {
            store.writeMeta({ ...meta, reviewerUnreachable: attempt, updatedAt: atIso });
          }
          store.appendConvergence(
            runId,
            makeUnreachableEntry(
              runId,
              campaignId,
              pass,
              maxPasses,
              verificationResults,
              outcome.detail,
              attempt,
              budget,
              atIso,
            ),
          );
          return;
        }

        // 3b. A real verdict arrived — the unreachable streak (if any) is broken.
        const result: SuperReviewResult = outcome;

        // Refresh meta: recordReviewerSession wrote reviewerSessionId into the
        // store during the review. Re-read so the decision/act spreads below
        // carry it forward instead of clobbering it with the pre-review snapshot.
        meta = store.readMeta(runId);

        // Make the verdict VISIBLE in the tail/journal. The convergence log
        // (convergence.jsonl) is the system of record but is never streamed, so
        // without this the reviewer's verdict never reaches `lathe tail`. Mirrors
        // the daddy `final_review` event, for super-daddy's convergence pass.
        store.appendJournal(runId, {
          at: atIso,
          event: "super_review",
          pass,
          verdict: result.review.verdict,
          findings: result.review.findings.map(
            (f) =>
              `[${f.severity}] ${f.title}${f.grounding.kind !== "none" ? ` ⟨${f.grounding.kind}⟩` : ""}`,
          ),
        });

        // 3. Pure decision. At the cap, the promoted pass (Baby's harness on Daddy's
        // model) is the last resort before parking — unless THIS run already was that
        // promoted pass, in which case the cap escalates for real.
        const decision = decideConvergence(result.review, verificationGreen, pass, maxPasses, {
          promoteAtCap: config.thresholds.promoteAtCap,
          alreadyPromoted: packet.frontmatter.promoted,
        });

        // 4. Act on the decision.
        let amendedSha: string | null = null;
        // Set when super-daddy cannot author an admittable follow-up packet — turns
        // the author path into an escalate (park for Max) instead of a silent stall.
        let authoringFailure: string | null = null;

        switch (decision.action) {
          case "stop": {
            // Campaign converged; run STAYS ready_for_review (S9/R3). Un-park a
            // previously-blocked run, and clear any unreachable streak now that a
            // real verdict landed.
            if (meta.status !== "ready_for_review" || (meta.reviewerUnreachable ?? 0) !== 0) {
              const { blockedReason: _br, blockedQuestion: _bq, ...rest } = meta;
              store.writeMeta({
                ...rest,
                status: "ready_for_review",
                reviewerUnreachable: 0,
                updatedAt: atIso,
              });
            }
            // Amend commit message — best effort, not fatal.
            if (result.review.commit_message) {
              try {
                const msg = assembleCommitMessage(result.review.commit_message);
                amendedSha = repo.amendCommit(meta.worktree, msg);
              } catch {
                // R3: a missing message or a git failure there leaves the WIP
                // line rather than failing convergence.
                amendedSha = null;
              }
            }
            break;
          }

          case "author": {
            // Fetch parent tip into source repo FIRST (S8/§19) so the follow-up's
            // base (= parent run's branch tip) resolves at admission.
            try {
              repo.fetchBranchFromClone(packet.frontmatter.repo, meta.worktree, meta.branch);
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
            ];

            const followupRunId = `${isoToTimestamp(atIso)}-${slugFromRunId(runId, pass + 1)}`;
            const lineage = {
              repo: packet.frontmatter.repo,
              baseBranch: meta.branch,
              compareCommit: packet.frontmatter.compare_commit,
              campaignId,
              parentRunId: runId,
              pass: pass + 1,
              priorOutcomes,
              promoted: decision.promote,
            };

            // Make the cap escape hatch visible in the tail: this follow-up is the
            // one promoted attempt on Daddy's model before convergence would give up.
            if (decision.promote) {
              store.appendJournal(runId, {
                at: atIso,
                event: "driver_note",
                note: `convergence cap reached (${pass}/${maxPasses}) — authoring a PROMOTED repair pass (Baby's harness on Daddy's model) as run ${followupRunId}`,
              });
            }

            // Super-daddy AUTHORS the follow-up packet — the same session that just
            // reviewed, a bigger author with final authority, picking its own
            // outcomes/surface/verification to fix the blockers it raised. The engine
            // stamps the lineage and validates on admission. ONE retry feeding back
            // the admission problems (the packet skill's "fix and re-run until it
            // admits"); then escalate rather than loop or stall.
            const packetSkillText = readFileSync(
              expandHome(config.superdaddy.packetSkillPath),
              "utf-8",
            );
            let problems: string[] | null = null;
            let priorRawSnippet: string | undefined;
            for (let attempt = 0; attempt < 2; attempt++) {
              const authored = await reviewer.authorFollowup(
                {
                  worktree: meta.worktree,
                  packetSkillText,
                  blockers: decision.blockers,
                  priorOutcomes,
                  pass: pass + 1,
                  campaignId,
                  priorProblems: problems ?? undefined,
                  priorRawSnippet,
                },
                recordReviewerSession,
              );

              // The review just succeeded over this socket, so an authoring drop is
              // transient — throw to the fail-safe: the run stays ready_for_review
              // and the next sweep re-reviews + re-authors. No forged pass, no park.
              if (authored.kind === "unreachable") {
                throw new Error(`authorFollowup unreachable: ${authored.detail}`);
              }

              // Stamp + admission-check this attempt, collecting any problems.
              let stamped: string | null = null;
              let attemptProblems: string[] | null = null;
              try {
                stamped = stampFollowupLineage(authored.content, lineage);
                const shape = parsePacketShape(stamped, followupRunId);
                if (!shape.ok) {
                  attemptProblems = shape.problems;
                }
              } catch (err) {
                attemptProblems = [err instanceof Error ? err.message : String(err)];
              }

              // Persist the raw reply for EVERY attempt (success or failure) so an
              // authoring failure is diagnosable post-hoc — the raw is otherwise lost.
              store.appendJournal(runId, {
                at: atIso,
                event: "authoring_attempt",
                attempt: attempt + 1,
                ok: attemptProblems === null,
                problems: attemptProblems ?? [],
                authoredRaw: authored.content,
              });

              if (attemptProblems === null && stamped !== null) {
                store.admitQueue(followupRunId, stamped);
                problems = null;
                break;
              }
              // Feed the problems AND a snippet of what was emitted into the retry,
              // so the model can see and fix its own malformed output.
              problems = attemptProblems;
              priorRawSnippet = authored.content.slice(0, 800);
            }

            if (problems) {
              // Two tries, still unadmittable — park for Max with the exact problems
              // rather than dropping the pass. Handled as an escalate below.
              authoringFailure = `Super-daddy could not author an admittable follow-up packet (2 attempts): ${problems.join("; ")}. Review the run manually, then re-run \`lathe converge ${runId}\`.`;
              store.writeMeta({
                ...meta,
                status: "blocked" as const,
                blockedReason: "human_decision" as const,
                blockedQuestion: authoringFailure,
                reviewerUnreachable: 0,
                updatedAt: atIso,
              });
            }
            break;
          }

          case "escalate": {
            // Park blocked/human_decision. A real verdict landed, so clear any
            // unreachable streak.
            const blockedMeta = {
              ...meta,
              status: "blocked" as const,
              blockedReason: "human_decision" as const,
              blockedQuestion: decision.reason,
              reviewerUnreachable: 0,
              updatedAt: atIso,
            };
            store.writeMeta(blockedMeta);
            break;
          }
        }

        // 5. Campaign ledger — upsert the pass.
        const campaignPass = campaignPassOf(runId, meta.attempt, pass, result, atIso);
        const campaignStatus: "open" | "converged" | "needs_max" = (() => {
          switch (decision.action) {
            case "stop":
              return "converged";
            case "author":
              // A follow-up was admitted → open; authoring failed → parked for Max.
              return authoringFailure ? "needs_max" : "open";
            case "escalate":
              return "needs_max";
          }
        })();

        const updated = upsertPass(
          campaign,
          {
            campaignId,
            originalRunId: packet.frontmatter.parent_run_id ?? runId,
            originalIntent: packet.frontmatter.outcomes[0]?.description.slice(0, 160) ?? runId,
            maxPasses,
          },
          campaignPass,
          campaignStatus,
        );
        store.writeCampaign(updated);

        // 6. Nits — super-daddy's by-the-way findings (NOT when authoring;
        // every finding becomes a packet outcome on author — S10).
        if (decision.action !== "author") {
          const nits = renderNits(runId, result.review);
          if (nits) {
            store.writeNits(runId, nits);
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
        );
        store.appendConvergence(runId, entry);
      } catch {
        // Fail-safe: ANY error leaves the run ready_for_review
        // (never corrupt a finished result).
        try {
          const currentMeta = store.readMeta(runId);
          store.writeMeta({
            ...currentMeta,
            status: "ready_for_review" as const,
            updatedAt: clock.nowIso(),
          });
        } catch {
          // If we can't even write meta, the run stays wherever it is.
        }
      }
    } finally {
      store.clearActiveConvergence();
    }
  };
};
