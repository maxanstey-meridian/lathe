// The convergence orchestrator (SUPER-DADDY §3, P3). Reviews ONE finished run
// end to end and acts on the verdict — the manual `meridian converge <runId>`
// one-shot. P4 turns this into the always-on post-run step of the run loop; the
// pieces here (review → decide → act) are exactly what it calls.
//
// Side effects are deliberately narrow (§2/§13.7): it writes the campaign ledger,
// transitions the reviewed run's status, and authors a follow-up packet into the
// queue. It never reaches into a live run.

import { writeFileSync, appendFileSync } from "fs"
import { join } from "path"
import { loadConfig } from "./config.js"
import { loadRunForReview, runSuperReview, type LoadedRun, type SuperReviewResult } from "./super-review.js"
import { decideConvergence, renderFollowupPacket, type ConvergeDecision } from "./convergence.js"
import { runVerification, type VerificationResult } from "./verification.js"
import { campaignIdForRun, readCampaign, writeCampaign, upsertPass, alreadyReviewed } from "./campaign.js"
import { addToQueue } from "./queue.js"
import { writeMeta, readMetaIfExists } from "./runtime.js"
import {
  writeOpencodeConfig,
  spawnOpencodeServer,
  warnOnVersionDrift,
  waitForServer,
  createOpencodeClient,
  pluginPath,
  type OpencodeClient,
} from "./opencode.js"
import { startBridgeServer, listenBridge, type CurrentRunRef } from "./bridge.js"
import { amendCommitMessage, isCloneSandbox, fetchBranchFromClone } from "./git.js"
import { nowIso } from "./fsio.js"
import type { Config, FinalReviewVerdict, OutcomeDef, SuperReview, CommitMessage } from "./schemas.js"
import type { Paths } from "./paths.js"

// super-daddy authors subject + body; the commit wants them as one string with a
// blank line between (git's subject/body convention). Trim so a model that pads
// the body never leaves a trailing blank-line-only commit.
export const assembleCommitMessage = (cm: CommitMessage): string => {
  const body = cm.body.trim()
  return body.length > 0 ? `${cm.subject.trim()}\n\n${body}` : cm.subject.trim()
}

const pad = (n: number, w = 2): string => String(n).padStart(w, "0")
const stamp = (d: Date): string =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`

// The follow-up slug derives from the run's own slug, with any prior -fixN suffix
// stripped so passes don't stack (rename-fix2-fix3 → rename-fix3).
const followupSlug = (runId: string, newPass: number): string => {
  const slug = runId.replace(/^\d{8}-\d{6}-/, "").replace(/-fix\d+$/, "")
  return `${slug}-fix${newPass}`
}

// The delivered surface carried forward as regression (§9): this run's outcomes
// plus anything it already carried, deduped by id.
const priorOutcomes = (loaded: LoadedRun): OutcomeDef[] => {
  const fm = loaded.input.packet.frontmatter
  const byId = new Map<string, OutcomeDef>()
  for (const o of [...fm.outcomes, ...fm.regression_outcomes]) byId.set(o.id, o)
  return [...byId.values()]
}

export type ConvergeOutcome = {
  loaded: LoadedRun
  primary: SuperReview
  verificationGreen: boolean
  decision: ConvergeDecision
  result: ActResult
}

// The convergence core (§3): review → decide → act, against an ALREADY-RUNNING
// opencode server (the caller owns the client + bridge lifecycle). One reviewer
// (super-daddy): it reviews the whole packet against doctrine and the run drives
// straight off its verdict — findings author a follow-up, clean stops, a Max-only
// call escalates. The manual one-shot below bootstraps its own server around this;
// P4's run loop calls it directly with the live server it already holds.
export const convergeRun = async (
  config: Config,
  paths: Paths,
  client: OpencodeClient,
  loaded: LoadedRun,
): Promise<ConvergeOutcome> => {
  const runId = loaded.runId
  const campaignId = campaignIdForRun(loaded.input.packet, runId)
  const existing = readCampaign(paths, campaignId)
  if (alreadyReviewed(existing, runId)) {
    console.error(`note: ${runId} was already reviewed in campaign ${campaignId} — re-reviewing (its pass record will be replaced).`)
  }

  // Ground truth FIRST: run the packet's verification ourselves so "cannot
  // converge on red" (§6) is enforced on real exit codes, not a reviewer claim.
  console.error(`running verification for ${runId} (ground truth)…`)
  const verification = runVerification(loaded.input.packet.frontmatter, loaded.worktree, config.thresholds.verificationTimeoutMs)
  const verificationGreen = verification.every((v) => v.exitCode === 0)
  for (const v of verification) console.error(`  ${v.exitCode === 0 ? "✓" : "✗"} ${v.command}`)

  console.error(`super-daddy (${loaded.model.providerId}/${loaded.model.modelId}) reviewing…`)
  const sdSession = await client.createSession(`superdaddy:${runId}`, loaded.worktree)
  const { review: primary, raw: primaryRaw } = await runSuperReview(client, sdSession, loaded.model, loaded.timeoutMs, loaded.input)
  await client.deleteSession(sdSession)

  const pass = loaded.input.packet.frontmatter.pass
  const decision = decideConvergence(primary, verificationGreen, pass, config.thresholds.maxPasses)

  const result = act(config, paths, loaded, campaignId, existing, primary, decision, pass)

  // On convergence, reword the run's single commit with super-daddy's message
  // (R3): the throwaway `WIP <runId>` line must never reach Max's integration
  // branch. Only on a clean stop, and only if the reviewer actually authored a
  // message — a missing one leaves the WIP line rather than failing convergence,
  // and a git failure here is logged, not fatal (the run is already converged).
  let amendedSha: string | undefined
  if (decision.action === "stop" && primary.commit_message) {
    try {
      amendedSha = amendCommitMessage(loaded.worktree, assembleCommitMessage(primary.commit_message))
      console.error(`  ✎ commit reworded ${amendedSha.slice(0, 9)}: ${primary.commit_message.subject}`)
    } catch (err) {
      console.error(`  ! commit reword failed (left WIP message): ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // nits.md only when we are NOT authoring a fix pass: on author, every finding
  // became a packet outcome, so there is nothing left to note. On accept/escalate,
  // any findings super-daddy raised are the "by the way"s Max reads in the morning.
  if (decision.action !== "author") writeNits(paths, runId, primary)
  writeConvergenceLog(paths, loaded, campaignId, verification, verificationGreen, { review: primary, raw: primaryRaw }, decision, amendedSha)
  return { loaded, primary, verificationGreen, decision, result }
}

export const convergeCommand = async (runId: string, sdModelOverride?: string): Promise<number> => {
  const { config, paths } = loadConfig()
  let loaded: LoadedRun
  try {
    loaded = loadRunForReview(config, paths, runId)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
  // Debug-only super-daddy model override (e.g. gpt-5.5 vs the gpt-5.5-pro default),
  // mirroring super-review.
  if (sdModelOverride) loaded = { ...loaded, model: { ...loaded.model, modelId: sdModelOverride } }

  const ref: CurrentRunRef = { current: undefined }
  const bridgeServer = startBridgeServer(config, ref)
  await listenBridge(bridgeServer, config)
  writeOpencodeConfig(config, paths, pluginPath())
  warnOnVersionDrift(config)
  const serverProcess = spawnOpencodeServer(config, paths)

  try {
    await waitForServer(config)
    const client: OpencodeClient = createOpencodeClient(config)
    const outcome = await convergeRun(config, paths, client, loaded)
    printSummary(outcome)
    return 0
  } finally {
    bridgeServer.close()
    serverProcess.kill()
  }
}

export type ActResult =
  | { kind: "stop" }
  | { kind: "escalate"; reason: string }
  | { kind: "author"; followupRunId: string; admitted: boolean; problem?: string }

const verdictOf = (action: "stop" | "author" | "escalate"): FinalReviewVerdict =>
  action === "stop" ? "accept" : action === "author" ? "request_changes" : "escalate"

const act = (
  config: Config,
  paths: Paths,
  loaded: LoadedRun,
  campaignId: string,
  existing: ReturnType<typeof readCampaign>,
  primary: SuperReview,
  decision: ConvergeDecision,
  pass: number,
): ActResult => {
  const atIso = nowIso()
  const blockerCount =
    decision.action === "author"
      ? decision.blockers.length
      : decision.action === "escalate"
        ? primary.findings.length
        : 0
  const status = decision.action === "stop" ? "converged" : decision.action === "author" ? "open" : "needs_max"

  const campaign = upsertPass(
    existing,
    {
      campaignId,
      originalRunId: loaded.input.packet.frontmatter.parent_run_id ?? loaded.runId,
      originalIntent: loaded.input.packet.frontmatter.outcomes[0]?.description.slice(0, 160) ?? loaded.runId,
      maxPasses: config.thresholds.maxPasses,
    },
    { runId: loaded.runId, pass, verdict: verdictOf(decision.action), groundedBlockers: blockerCount, atIso },
    status,
  )
  writeCampaign(paths, campaign)

  if (decision.action === "stop") {
    // Converged → the run must be ready_for_review so Max can `meridian accept`
    // (merge) it; the campaign ledger — not the run status — dedups the trigger.
    // Usually a no-op (the daemon converges runs that are ALREADY ready_for_review),
    // but a run PARKED by a prior escalate — e.g. a transient super-daddy outage —
    // that is later re-converged to a clean stop must be UN-PARKED here, or accept
    // (which requires ready_for_review) refuses the now-good run.
    const meta = readMetaIfExists(paths, loaded.runId)
    if (meta && meta.status !== "ready_for_review") {
      const { blockedReason: _r, blockedQuestion: _q, ...rest } = meta
      writeMeta(paths, { ...rest, status: "ready_for_review", updatedAt: atIso })
    }
    return { kind: "stop" }
  }

  if (decision.action === "escalate") {
    const meta = readMetaIfExists(paths, loaded.runId)
    if (meta) {
      writeMeta(paths, { ...meta, status: "blocked", blockedReason: "human_decision", blockedQuestion: decision.reason, updatedAt: atIso })
    }
    return { kind: "escalate", reason: decision.reason }
  }

  // author: render the follow-up against the run branch, admit it to the queue.
  // The sandbox is a self-rooted clone, so the parent's commits live ONLY in its
  // refs — invisible to the source repo. The follow-up packet keeps `repo` = the
  // source repo (so `meridian accept` later merges THERE) with `base` = the parent
  // run branch, and createRunSandbox forks the follow-up FROM the source repo at
  // that base. Both need the parent branch present in the source repo, so fetch it
  // in first — exactly as `accept` does before merging. Without this, admission's
  // `git rev-parse --verify <base>` fails and every follow-up is rejected.
  const repo = loaded.input.packet.frontmatter.repo
  if (isCloneSandbox(loaded.worktree)) fetchBranchFromClone(repo, loaded.worktree, loaded.branch)
  const newPass = pass + 1
  const slug = followupSlug(loaded.runId, newPass)
  const followup = renderFollowupPacket({
    original: loaded.input.packet,
    parentRunId: loaded.runId,
    campaignId,
    pass: newPass,
    blockers: decision.blockers,
    priorOutcomes: priorOutcomes(loaded),
    baseBranch: loaded.branch,
    timestamp: stamp(new Date()),
    slug,
  })
  const dest = join(paths.queueDir, followup.filename)
  writeFileSync(dest, followup.content, "utf-8")
  const admission = addToQueue(paths, dest)
  return admission.ok
    ? { kind: "author", followupRunId: followup.runId, admitted: true }
    : { kind: "author", followupRunId: followup.runId, admitted: false, problem: admission.problems.join("; ") }
}

const printSummary = ({ loaded, primary, verificationGreen, decision, result }: ConvergeOutcome): void => {
  console.log(`\n=== converge ${loaded.runId} (pass ${loaded.input.packet.frontmatter.pass}/${loaded.input.maxPasses}) ===`)
  console.log(`verification:   ${verificationGreen ? "GREEN" : "RED"}`)
  console.log(`super-daddy:    ${primary.verdict} — ${primary.findings.length} finding(s): ${primary.findings.map((f) => f.id).join(", ") || "none"}`)
  console.log(`decision:       ${decision.action.toUpperCase()}`)

  if (result.kind === "stop") {
    console.log(`→ CONVERGED. Campaign closed. Run left ready_for_review — merge it with: meridian accept ${loaded.runId}`)
  } else if (result.kind === "escalate") {
    console.log(`→ ESCALATED. Run parked as blocked/human_decision.`)
    console.log(`  reason: ${result.reason}`)
    console.log(`  resolve with: meridian answer ${loaded.runId} "<decision>"`)
  } else if (result.admitted) {
    console.log(`→ AUTHORED follow-up ${result.followupRunId} — admitted to the queue. Next 'meridian run' drains it.`)
  } else {
    console.log(`→ follow-up ${result.followupRunId} was authored but REJECTED by admission: ${result.problem}`)
  }

  if (decision.action !== "author" && renderNits(loaded.runId, primary)) {
    console.log(`  notes: ${loaded.runId} — super-daddy's notes in nits.md`)
  }
}

// --- nits.md surfacing (§10/§13) ---------------------------------------------
// When the loop is NOT authoring a fix pass (accept or escalate), super-daddy's
// findings are the "by the way" notes Max reads in the morning — nothing here
// drives the loop (on request_changes they all become packet outcomes instead).
// Pure render so it can be unit-tested; writeNits is the thin I/O wrapper.

export const renderNits = (runId: string, primary: SuperReview): string | undefined => {
  const nits = primary.findings
  if (nits.length === 0) return undefined

  const lines = [
    `# Notes — ${runId}`,
    "",
    "Findings from super-daddy's review that the loop is not auto-fixing — here for",
    "your call, not the loop's.",
    "",
  ]
  for (const finding of nits) {
    lines.push(`## [${finding.severity}] ${finding.title}`)
    lines.push(`- id: \`${finding.id}\``)
    if (finding.grounding.kind !== "none" && finding.grounding.ref.trim().length > 0) {
      lines.push(`- grounding (${finding.grounding.kind}): ${finding.grounding.ref}`)
    }
    for (const e of finding.evidence) lines.push(`- ${e}`)
    lines.push("")
  }
  return lines.join("\n")
}

const writeNits = (paths: Paths, runId: string, primary: SuperReview): void => {
  const md = renderNits(runId, primary)
  if (md) writeFileSync(paths.nitsFile(runId), md, "utf-8")
}

// --- convergence.jsonl: the durable record of the whole review ---------------
// The campaign ledger keeps only counts and nits.md keeps only the ungrounded
// findings, so super-daddy's full verdict — grounded blockers with evidence, the
// ground-truth command exit codes it actually ran, and the decision — would
// otherwise live only on the console and scroll away. One JSONL line per pass,
// next to journal.jsonl, so a converged (or escalated) run can be audited after
// the fact: what did super-daddy find, and why did it stop/author/escalate?
// Append, not overwrite: a re-review of the same run leaves both records rather
// than silently clobbering the first.
const writeConvergenceLog = (
  paths: Paths,
  loaded: LoadedRun,
  campaignId: string,
  verification: VerificationResult[],
  verificationGreen: boolean,
  primary: SuperReviewResult,
  decision: ConvergeDecision,
  amendedSha?: string,
): void => {
  const entry = {
    at: nowIso(),
    runId: loaded.runId,
    campaignId,
    pass: loaded.input.packet.frontmatter.pass,
    maxPasses: loaded.input.maxPasses,
    verification: { green: verificationGreen, commands: verification },
    decision,
    // The reworded commit sha when super-daddy authored a message and the run
    // converged; null otherwise (still WIP-labelled).
    amendedCommitSha: amendedSha ?? null,
    primary: primary.review,
    // Raw model text verbatim — the ground truth when a verdict fails to parse
    // (the parsed object above is then just the fail-closed escalate stub).
    primaryRaw: primary.raw,
  }
  appendFileSync(paths.convergenceFile(loaded.runId), `${JSON.stringify(entry)}\n`, "utf-8")
}
