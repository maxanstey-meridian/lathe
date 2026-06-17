// Inter-campaign CHAINING (CONTRACT.v3.md §19). A long build (e.g. the v3
// rebuild) is decomposed into many packets that must run on consecutive nights,
// each building on the PREVIOUS one's super-daddy-converged work. A staged child
// names its upstream via `parent_run_id` and only enters the queue once that
// campaign has CONVERGED, basing off the converged tip branch.
//
// Two registries are at play: the QUEUE (runs now) and STAGED (`<root>/staged`,
// waiting for a parent). `meridian chain add <dir>` copies every runId-named
// packet in <dir> into STAGED; the promotion sweep moves a staged child into the
// QUEUE the moment its parent campaign converges. The sweep runs at chain-add
// time, after every convergence in the run loop, and at run-loop startup.
//
// This mirrors the convergence author path (converge.ts `act` on "author"):
// fetch the upstream branch out of its self-rooted clone into the source repo so
// admission's `git rev-parse --verify <base>` resolves, then admit. The pure
// promotion DECISION is separated from that I/O so it can be unit-tested.

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs"
import { basename, join } from "path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { FRONTMATTER_RE } from "./packet.js"
import { PacketFrontmatter, type Campaign } from "./schemas.js"
import { readCampaign } from "./campaign.js"
import { addToQueue, archivePacket } from "./queue.js"
import { isCloneSandbox, fetchBranchFromClone } from "./git.js"
import type { Paths } from "./paths.js"

const RUN_ID_RE = /^\d{8}-\d{6}-[a-z0-9-]+$/

// A run's branch and clone, derived the same way executeRun derives them — the
// converged tip lives only in its own self-rooted clone until accept merges it.
const branchOf = (runId: string): string => `meridian/${runId}`
const worktreeOf = (paths: Paths, runId: string): string => join(paths.runDir(runId), "worktree")

// A staged child omits `base` (stamped at promotion to the converged tip) — so
// validation at stage time checks the work fields and lineage, NOT base or the
// repo on disk (the target repo may not even exist yet when a chain is staged).
const StagedFrontmatter = PacketFrontmatter.extend({ base: z.string().min(1).optional() })

export type StagedInfo = { runId: string; parentRunId: string | undefined; repo: string }

export type StageParse =
  | { ok: true; info: StagedInfo }
  | { ok: false; problems: string[] }

// Relaxed parse for a staged child (CONTRACT §19): frontmatter must parse and the
// runId must be well-formed, but `base` is optional and no filesystem check runs
// here — full admission (parsePacket) happens at promotion, once base is stamped.
export const parseStaged = (raw: string, fileName: string): StageParse => {
  const runId = basename(fileName).replace(/\.md$/, "")
  if (!RUN_ID_RE.test(runId)) {
    return { ok: false, problems: [`packet filename must be YYYYMMDD-HHMMSS-<slug>.md, got: ${fileName}`] }
  }
  const match = FRONTMATTER_RE.exec(raw)
  if (!match || match[1] === undefined) {
    return { ok: false, problems: ["no YAML frontmatter block (--- ... ---) at top of packet"] }
  }
  let yamlValue: unknown
  try {
    yamlValue = parseYaml(match[1])
  } catch (err) {
    return { ok: false, problems: [`frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`] }
  }
  const fm = StagedFrontmatter.safeParse(yamlValue)
  if (!fm.success) {
    return { ok: false, problems: fm.error.issues.map((i) => `frontmatter.${i.path.join(".")}: ${i.message}`) }
  }
  // A child WITH a parent omits base on purpose; one WITHOUT a parent must still
  // be self-sufficient (base stamped from HEAD at promotion, exactly as a normal
  // `queue add` does) — so an absent base is only an error when there is no parent
  // AND no base to stamp from is impossible to know here; admission catches that.
  return { ok: true, info: { runId, parentRunId: fm.data.parent_run_id, repo: fm.data.repo } }
}

// The converged tip of a campaign is the run whose pass `accept`ed — the branch
// `meridian accept` would merge. A super-daddy repair pass can be the tip, so a
// child bases off the LATEST accepted pass, not necessarily parent_run_id itself.
export const convergedTip = (campaign: Campaign): string | undefined =>
  [...campaign.passes].reverse().find((p) => p.verdict === "accept")?.runId

export type PromotionDecision =
  | { action: "promote-now" } // no parent → admit straight away (base stamped from HEAD)
  | { action: "promote-with-base"; tipRunId: string; base: string } // parent converged → base = tip
  | { action: "hold"; reason: string } // parent needs Max — never build on unblessed work
  | { action: "wait"; reason: string } // parent not converged yet

// Pure (CONTRACT §19): a staged child + its parent campaign → what to do. No I/O.
export const decidePromotion = (
  parentRunId: string | undefined,
  parentCampaign: Campaign | undefined,
): PromotionDecision => {
  if (!parentRunId) return { action: "promote-now" }
  if (!parentCampaign) return { action: "wait", reason: `parent campaign ${parentRunId} has not started` }
  if (parentCampaign.status === "needs_max") {
    return { action: "hold", reason: `parent campaign ${parentRunId} is parked for Max (needs_max)` }
  }
  if (parentCampaign.status !== "converged") {
    return { action: "wait", reason: `parent campaign ${parentRunId} is still open` }
  }
  const tip = convergedTip(parentCampaign)
  // Stop condition (CONTRACT §19): a campaign marked converged with no accepted
  // pass is incoherent — hold, never invent a tip, so a stuck chain is visible.
  if (!tip) return { action: "hold", reason: `parent campaign ${parentRunId} is converged but has no accepted pass` }
  return { action: "promote-with-base", tipRunId: tip, base: branchOf(tip) }
}

// Insert an explicit `base:` into a frontmatter block (the converged-tip case).
// Mirrors stampBaseFromHead's output shape; the rest of the frontmatter and body
// are preserved verbatim.
const stampExplicitBase = (raw: string, base: string): string => {
  const match = FRONTMATTER_RE.exec(raw)
  if (!match || match[1] === undefined) return raw
  return `---\nbase: ${base}\n${match[1]}\n---\n${match[2] ?? ""}`
}

const listStagedIds = (paths: Paths): string[] =>
  existsSync(paths.stagedDir)
    ? readdirSync(paths.stagedDir)
        .filter((f) => f.endsWith(".md") && RUN_ID_RE.test(f.replace(/\.md$/, "")))
        .map((f) => f.replace(/\.md$/, ""))
        .sort()
    : []

export type StagedStatus = {
  runId: string
  parentRunId: string | undefined
  state: "promotable" | "held" | "waiting"
  reason: string
}

// What `meridian status` reads: every staged child and whether it is promotable,
// held (parent needs Max), or waiting (parent not converged) — so a stuck chain
// is visible. A staged file that no longer parses is reported as held.
export const listStagedStatus = (paths: Paths): StagedStatus[] =>
  listStagedIds(paths).map((runId) => {
    const parsed = parseStaged(readFileSync(paths.stagedFile(runId), "utf-8"), `${runId}.md`)
    if (!parsed.ok) return { runId, parentRunId: undefined, state: "held" as const, reason: parsed.problems[0] ?? "invalid staged packet" }
    const { parentRunId } = parsed.info
    const decision = decidePromotion(parentRunId, parentRunId ? readCampaign(paths, parentRunId) : undefined)
    const state = decision.action === "hold" ? "held" : decision.action === "wait" ? "waiting" : "promotable"
    const reason = decision.action === "hold" || decision.action === "wait" ? decision.reason : "ready to promote"
    return { runId, parentRunId, state, reason }
  })

export type PromotionReport = {
  promoted: string[]
  failed: { runId: string; problem: string }[]
}

// The I/O wrapper around decidePromotion. For each staged child whose parent has
// converged: fetch the converged tip branch out of its clone into the source repo
// (so admission resolves it), stamp base, admit to the queue, and clear the staged
// copy. A child with no parent admits immediately (base stamped from HEAD). A held
// or waiting child is left staged. A promotion that fails ADMISSION archives the
// staged copy with its reasons (never deleted — F3); a transient error (e.g. the
// tip clone is mid-teardown) leaves it staged to retry on the next sweep.
export const promoteStagedChildren = (paths: Paths): PromotionReport => {
  const report: PromotionReport = { promoted: [], failed: [] }
  for (const runId of listStagedIds(paths)) {
    const stagedFile = paths.stagedFile(runId)
    if (!existsSync(stagedFile)) continue // raced by a concurrent sweep — already handled
    let raw: string
    try {
      raw = readFileSync(stagedFile, "utf-8")
    } catch {
      continue
    }
    const parsed = parseStaged(raw, `${runId}.md`)
    if (!parsed.ok) {
      archivePacket(paths, stagedFile, parsed.problems)
      report.failed.push({ runId, problem: parsed.problems.join("; ") })
      continue
    }
    const { parentRunId, repo } = parsed.info
    const decision = decidePromotion(parentRunId, parentRunId ? readCampaign(paths, parentRunId) : undefined)
    if (decision.action === "hold" || decision.action === "wait") continue

    const dest = join(paths.queueDir, `${runId}.md`)
    try {
      mkdirSync(paths.queueDir, { recursive: true })
      if (decision.action === "promote-with-base") {
        // The converged tip's commits live only in its clone; pull the branch into
        // the source repo so the child can fork from it (same fetch `accept` does).
        const tipClone = worktreeOf(paths, decision.tipRunId)
        if (isCloneSandbox(tipClone)) fetchBranchFromClone(repo, tipClone, branchOf(decision.tipRunId))
        writeFileSync(dest, stampExplicitBase(raw, decision.base))
      } else {
        writeFileSync(dest, raw) // promote-now: addToQueue stamps base from HEAD
      }
      const admission = addToQueue(paths, dest)
      if (admission.ok) {
        unlinkSync(stagedFile) // promoted — the queue copy is now authoritative
        report.promoted.push(runId)
      } else {
        // addToQueue already archived the rejected queue copy with its problems;
        // archive the staged copy too so the sweep stops retrying a bad packet.
        archivePacket(paths, stagedFile, admission.problems)
        report.failed.push({ runId, problem: admission.problems.join("; ") })
      }
    } catch (err) {
      // Transient (e.g. the tip clone is being torn down) — leave it staged to
      // retry next sweep. Clean up a half-written queue copy so listQueue ignores it.
      if (existsSync(dest)) {
        try {
          unlinkSync(dest)
        } catch {
          /* best effort */
        }
      }
      report.failed.push({ runId, problem: err instanceof Error ? err.message : String(err) })
    }
  }
  return report
}

export type ChainAddReport = {
  staged: string[]
  skipped: string[]
  rejected: { runId: string; problems: string[] }[]
  promotion: PromotionReport
}

// `meridian chain add <dir>` (CONTRACT §19): copy every runId-named packet in
// <dir> into the staged registry, skipping any file whose name is not the runId
// format (READMEs, _CHAIN.md). A file that fails the relaxed parse is reported,
// not staged (the source file in <dir> is the operator's — never moved). Then run
// the promotion sweep once, so a parent-less head packet enters the queue at once.
export const chainAdd = (paths: Paths, dir: string): ChainAddReport => {
  mkdirSync(paths.stagedDir, { recursive: true })
  const staged: string[] = []
  const skipped: string[] = []
  const rejected: { runId: string; problems: string[] }[] = []

  for (const fileName of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const runId = fileName.replace(/\.md$/, "")
    if (!RUN_ID_RE.test(runId)) {
      skipped.push(fileName)
      continue
    }
    const raw = readFileSync(join(dir, fileName), "utf-8")
    const parsed = parseStaged(raw, fileName)
    if (!parsed.ok) {
      rejected.push({ runId, problems: parsed.problems })
      continue
    }
    writeFileSync(paths.stagedFile(runId), raw)
    staged.push(runId)
  }

  const promotion = promoteStagedChildren(paths)
  return { staged, skipped, rejected, promotion }
}
