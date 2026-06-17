// Shared run context and durable-state helpers. The bridge and the driver loop
// are one process (CONTRACT §9); this module is the state they share. All
// durable writes go through here — one writer per fact (D3).

import {
  type Packet,
  type Config,
  type RunMeta,
  type OutcomeLedger,
  type ReviewState,
  type Decision,
  type Checkpoint,
  type SubmitReport,
  type JournalEvent,
  type BlockedReason,
  type FinalReview,
  type AskPlannerInput,
  RunMeta as RunMetaSchema,
  OutcomeLedger as OutcomeLedgerSchema,
  ReviewState as ReviewStateSchema,
  Decision as DecisionSchema,
  Checkpoint as CheckpointSchema,
  JournalEvent as JournalEventSchema,
} from "./schemas.js"
import { readValidated, readValidatedIfExists, writeValidated, appendJsonl, readJsonl, nowIso } from "./fsio.js"
import type { Paths } from "./paths.js"
import type { OpencodeClient } from "./opencode.js"
import { join } from "path"
import { readdirSync, existsSync, mkdirSync } from "fs"

export type ParkRequest = { reason: BlockedReason; question: string }

export type RunContext = {
  config: Config
  paths: Paths
  packet: Packet
  worktree: string
  client: OpencodeClient
  daddySessionId: string
  babySessionId: string
  turn: number
  // Id of the final message of the previous turn — the window boundary for
  // collecting THIS turn's full message/part history (opencode's POST returns
  // only the final message, hiding earlier-step tool calls from progress detection).
  lastSeenMessageId?: string
  // Flags the bridge raises and the driver loop evaluates at turn end:
  parkRequest?: ParkRequest
  acceptedReport?: SubmitReport
  // Daddy's accepted final-review verdict (V7), rendered into report.md.
  finalReview?: FinalReview
  reportRejectionProblems?: string[]
  reportRejectionCount: number
  checkpointWrittenThisTurn?: Checkpoint
  checkpointBounceCount: number
  rotationPending: boolean
  // Volume reminder tally (§10), driver side: non-bridge tool calls since the last
  // accepted planner decision. Drives the VISIBLE checkpoint_volume_nudge journal
  // event (the plugin does the per-call shout to Baby). Reset on an accepted consult.
  toolCallsSinceDecision: number
  // Set by the ask_planner bridge tool: the executor's submission, awaiting the
  // driver's consult. The driver runs the Daddy call off the MCP request path
  // (opencode's MCP client cancels a tool-call held >~5min) and delivers the
  // verdict to Baby on the next turn. Cleared once the driver has consulted.
  pendingConsult?: AskPlannerInput
  // Set by submit_report when the mechanical floor passed and verification is
  // green: the report awaiting Daddy's final review (V7). Same off-MCP-path
  // treatment as pendingConsult — the driver runs the review. Cleared once done.
  pendingFinalReview?: SubmitReport
}

// ---------------------------------------------------------------------------
// Journal

// Omit over a discriminated union must distribute, or it collapses to the
// common keys and rejects every variant's own fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export const journal = (
  ctx: RunContext,
  event: DistributiveOmit<JournalEvent, "at" | "turn"> & { turn?: number },
): void => {
  appendJsonl(ctx.paths.journalFile(ctx.packet.runId), JournalEventSchema, {
    at: nowIso(),
    turn: event.turn ?? ctx.turn,
    ...event,
  } as JournalEvent)
}

// A lifecycle journal append with no live RunContext (the worker loop logs
// post-run recovery after ctx is gone). `turn` is optional in the schema, so
// ctx-free events omit it.
export const appendJournal = (
  paths: Paths,
  runId: string,
  event: DistributiveOmit<JournalEvent, "at" | "turn"> & { turn?: number },
): void => {
  appendJsonl(paths.journalFile(runId), JournalEventSchema, { at: nowIso(), ...event } as JournalEvent)
}

// ---------------------------------------------------------------------------
// Stall recovery (P6 / CONTRACT §5 R10)

// A `wedged` park is a harness-detected stall (ladder, rotation bounce, turn
// failures, run watchdog) — recoverable by retrying. `crashed` (driver threw)
// and the judgement parks (human_decision/scope_expansion/stop_condition) are
// NOT auto-retried: a crash may hot-loop, and a judgement park is Max's by
// definition. Bounded exactly like the convergence circuit breaker (maxPasses):
// auto-requeue up to `maxStallRetries`, then escalate so a deterministic stall
// can't requeue forever. This is the automated, capped "try again pls".
export type StallDecision =
  | { action: "requeue"; stallRetries: number }
  | { action: "escalate"; stallRetries: number }
  | { action: "none" }

export const decideStallRecovery = (
  meta: Pick<RunMeta, "status" | "blockedReason" | "stallRetries">,
  maxStallRetries: number,
): StallDecision => {
  if (meta.status !== "blocked" || meta.blockedReason !== "wedged") return { action: "none" }
  const used = meta.stallRetries ?? 0
  return used < maxStallRetries
    ? { action: "requeue", stallRetries: used + 1 }
    : { action: "escalate", stallRetries: used }
}

// What to do on a no-progress turn at this ladder height (driver branch 7, L3).
// Precedence, in order: PARK once the dead-turn count hits the backstop; else
// ROTATE every `rotateAt` dead turns (a fresh session is the only thing seen to
// break a narration loop — more nudges never did); else NUDGE. PARK is checked
// first so a misconfigured rotateAt ≥ parkAt can never rotate forever — the
// backstop always wins, keeping this bounded.
export type StallAction = "park" | "rotate" | "nudge"

export const stallAction = (ladder: number, rotateAt: number, parkAt: number): StallAction => {
  if (ladder >= parkAt) return "park"
  if (rotateAt > 0 && ladder % rotateAt === 0) return "rotate"
  return "nudge"
}

// ---------------------------------------------------------------------------
// Meta

export const readMeta = (paths: Paths, runId: string): RunMeta =>
  readValidated(paths.metaFile(runId), RunMetaSchema)

export const readMetaIfExists = (paths: Paths, runId: string): RunMeta | undefined =>
  readValidatedIfExists(paths.metaFile(runId), RunMetaSchema)

export const writeMeta = (paths: Paths, meta: RunMeta): void =>
  writeValidated(paths.metaFile(meta.runId), RunMetaSchema, { ...meta, updatedAt: nowIso() })

export const listRunIds = (paths: Paths): string[] =>
  existsSync(paths.runsDir) ? readdirSync(paths.runsDir).filter((d) => existsSync(paths.metaFile(d))).sort() : []

// ---------------------------------------------------------------------------
// Outcome ledger (O1, O2)

export const initialLedger = (packet: Packet): OutcomeLedger => ({
  runId: packet.runId,
  outcomes: packet.frontmatter.outcomes.map((o) => ({
    id: o.id,
    description: o.description,
    status: "not_started" as const,
    evidence: [],
    updatedAt: nowIso(),
  })),
  updatedAt: nowIso(),
})

export const readLedger = (paths: Paths, runId: string): OutcomeLedger =>
  readValidated(paths.outcomesFile(runId), OutcomeLedgerSchema)

export const writeLedger = (paths: Paths, ledger: OutcomeLedger): void =>
  writeValidated(paths.outcomesFile(ledger.runId), OutcomeLedgerSchema, { ...ledger, updatedAt: nowIso() })

// ---------------------------------------------------------------------------
// Review state (M5 — replacement semantics live here and only here)

export const initialReviewState = (runId: string): ReviewState => ({
  runId,
  obligations: [],
  updatedAt: nowIso(),
})

export const readReviewState = (paths: Paths, runId: string): ReviewState =>
  readValidated(paths.reviewStateFile(runId), ReviewStateSchema)

export const replaceObligations = (paths: Paths, runId: string, constraints: string[]): ReviewState => {
  const next: ReviewState = {
    runId,
    obligations: constraints.map((c) => c.trim()).filter((c) => c.length > 0),
    lastDecisionAt: nowIso(),
    updatedAt: nowIso(),
  }
  writeValidated(paths.reviewStateFile(runId), ReviewStateSchema, next)
  return next
}

// ---------------------------------------------------------------------------
// Decisions

export const appendDecision = (paths: Paths, runId: string, decision: Decision): void =>
  appendJsonl(paths.decisionsFile(runId), DecisionSchema, decision)

export const readDecisions = (paths: Paths, runId: string): Decision[] =>
  readJsonl(paths.decisionsFile(runId), DecisionSchema)

// ---------------------------------------------------------------------------
// Checkpoints (O4)

export const latestCheckpoint = (paths: Paths, runId: string): Checkpoint | undefined => {
  const dir = paths.checkpointsDir(runId)
  if (!existsSync(dir)) return undefined
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort()
  const last = files[files.length - 1]
  return last ? readValidated(join(dir, last), CheckpointSchema) : undefined
}

export const writeCheckpoint = (paths: Paths, runId: string, checkpoint: Checkpoint): void => {
  const dir = paths.checkpointsDir(runId)
  mkdirSync(dir, { recursive: true })
  writeValidated(join(dir, `${String(checkpoint.number).padStart(4, "0")}.json`), CheckpointSchema, checkpoint)
}

export const nextCheckpointNumber = (paths: Paths, runId: string): number => {
  const dir = paths.checkpointsDir(runId)
  if (!existsSync(dir)) return 1
  return readdirSync(dir).filter((f) => f.endsWith(".json")).length + 1
}

// O4: a defensive check on the driver-ASSEMBLED checkpoint before teardown.
// The driver builds the outcome block from the ledger and the file list from
// the diff (the executor supplies only prose: summary + uncertainties), so the
// per-outcome state/next-action and ledger-equality checks that once policed
// the executor's hand-written structure are now vacuous — the structure cannot
// diverge from its own source. What remains is pure defence: every packet
// outcome present, no phantom ids, done implies evidence (already an
// update_outcomes invariant). In practice this returns []; it exists so the
// journal's `valid` flag stays honest and a future assembly bug fails loud.
export const checkpointProblems = (checkpoint: Checkpoint, packet: Packet, ledger: OutcomeLedger): string[] => {
  const problems: string[] = []
  const packetIds = new Set(packet.frontmatter.outcomes.map((o) => o.id))
  const checkpointIds = new Set(checkpoint.outcomes.map((o) => o.id))

  for (const id of packetIds) {
    if (!checkpointIds.has(id)) problems.push(`checkpoint omits outcome ${id} — every outcome must be accounted for`)
  }
  for (const o of checkpoint.outcomes) {
    if (!packetIds.has(o.id)) problems.push(`checkpoint names unknown outcome ${o.id}`)
    if (o.status === "done" && o.evidence.length === 0) problems.push(`done outcome ${o.id} has no evidence`)
  }
  return problems
}

// ---------------------------------------------------------------------------
// Report rendering (V4) — report.md is a render of the validated structure.

export const renderReportMarkdown = (report: SubmitReport, runId: string, finalReview?: FinalReview): string => {
  const lines: string[] = [
    `# Implementation Report — ${runId}`,
    "",
    `Status: **${report.status}**${report.blockedReason ? ` (${report.blockedReason})` : ""}`,
    "",
  ]
  if (report.blockedQuestion) lines.push(`## Decision needed`, "", report.blockedQuestion, "")
  lines.push(`## Summary`, "", report.summary, "")
  if (report.filesChanged.length > 0) {
    lines.push(`## Files changed`, "", "| File | Classification | Reason | Action |", "|---|---|---|---|")
    for (const f of report.filesChanged) lines.push(`| \`${f.path}\` | ${f.classification} | ${f.reason} | ${f.action} |`)
    lines.push("")
  }
  if (report.behaviourChanged.length > 0)
    lines.push(`## Behaviour changed`, "", ...report.behaviourChanged.map((b) => `- ${b}`), "")
  if (report.sourceOfTruthFollowed.length > 0)
    lines.push(`## Source of truth followed`, "", ...report.sourceOfTruthFollowed.map((s) => `- ${s}`), "")
  lines.push(`## Outcomes`, "", ...report.outcomeClaims.map((o) => `- ${o.id}: ${o.status}`), "")
  if (report.verificationClaims.length > 0) {
    lines.push(`## Verification`, "", "| Command | Result | Notes |", "|---|---|---|")
    for (const v of report.verificationClaims) lines.push(`| \`${v.command}\` | ${v.result} | ${v.notes ?? ""} |`)
    lines.push("")
  }
  if (report.escalations.length > 0) lines.push(`## Escalations`, "", ...report.escalations.map((e) => `- ${e}`), "")
  if (report.remainingUncertainty.length > 0)
    lines.push(`## Remaining uncertainty`, "", ...report.remainingUncertainty.map((u) => `- ${u}`), "")
  if (finalReview) {
    lines.push(
      `## Final review (Daddy)`,
      "",
      `Verdict: **${finalReview.verdict}**${finalReview.notes ? ` — ${finalReview.notes}` : ""}`,
      "",
      ...finalReview.findings.map((f) => `- ${f}`),
      "",
    )
  }
  return lines.join("\n")
}
