// Driver-side gate state management (CONTRACT §10). The driver decides and
// writes gate-state.json; the plugin enforces and writes nothing (D3).
// Trigger evaluation order is G5.

import { readDiffStats, diffDelta } from "./git.js"
import { GateState, type Config } from "./schemas.js"
import { writeValidated, nowIso, readValidatedIfExists } from "./fsio.js"
import type { Paths } from "./paths.js"

// Carried verbatim from v1 watchdog-core (proven glob → regex translation).
export const globToRegExp = (glob: string): RegExp => {
  let pattern = ""
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*"
        i += glob[i + 2] === "/" ? 3 : 2
        continue
      }
      pattern += "[^/]*"
      i += 1
      continue
    }
    pattern += /[a-zA-Z0-9_-]/.test(ch ?? "") ? ch : `\\${ch}`
    i += 1
  }
  return new RegExp(`^${pattern}$`)
}

export const initialGateState = (
  runId: string,
  worktree: string,
  expectedGlobs: string[],
  suspiciousGlobs: string[],
  config: Config,
): GateState => ({
  runId,
  latched: true,
  latchReason: "first edit of the run requires an accepted planner decision",
  firstEditApproved: false,
  reconciliationRequired: false,
  expectedGlobs,
  suspiciousGlobs,
  baselineDiffStats: readDiffStats(worktree),
  checkpointNudgeMs: config.thresholds.checkpointNudgeMs,
  checkpointToolCalls: config.thresholds.checkpointToolCalls,
  checkpointFiles: config.thresholds.checkpointFiles,
  checkpointLoc: config.thresholds.checkpointLoc,
  mutationCommandPatterns: config.mutationCommandPatterns,
  updatedAt: nowIso(),
})

// The volume reminder, evaluated at the turn boundary for the driver's VISIBLE
// journal event (§10). Tool calls OR files OR LoC since the last planner check-in,
// whichever crosses first — the work-interval cadence reborn as a shout. Pure;
// returns the same reason string the plugin appends to Baby (via denyMessage), so
// the journal and Baby see one message. The plugin owns the per-call shout; this
// owns the visibility. Returns the reason when due, else undefined.
export const volumeCheckpointReason = (
  toolCalls: number,
  delta: { files: string[]; loc: number },
  limits: { checkpointToolCalls: number; checkpointFiles: number; checkpointLoc: number },
): string | undefined => {
  if (toolCalls >= limits.checkpointToolCalls)
    return `work checkpoint interval reached (${toolCalls} tool calls since your last planner check-in)`
  if (delta.files.length >= limits.checkpointFiles || delta.loc >= limits.checkpointLoc)
    return `work checkpoint interval reached (${delta.files.length} files, ${delta.loc} changed LoC since your last planner check-in)`
  return undefined
}

export const readGateState = (paths: Paths, runId: string): GateState | undefined =>
  readValidatedIfExists(paths.gateStateFile(runId), GateState)

export const writeGateState = (paths: Paths, state: GateState): void =>
  writeValidated(paths.gateStateFile(state.runId), GateState, { ...state, updatedAt: nowIso() })

// G3: the only clear path is an accepted decision. The driver IS the bridge, so
// it calls this synchronously when one lands — no ledger re-read dance (v1 X2
// made impossible).
export const clearGate = (paths: Paths, state: GateState, worktree: string): GateState => {
  const cleared: GateState = {
    ...state,
    latched: false,
    firstEditApproved: true,
    reconciliationRequired: false,
    baselineDiffStats: readDiffStats(worktree),
    lastAcceptedDecisionAt: nowIso(),
    updatedAt: nowIso(),
  }
  delete cleared.latchReason
  writeGateState(paths, cleared)
  return cleared
}

// The gate state a replaced session inherits (O5). First-edit is re-latched on
// EVERY rotation: a replaced session is a new reasoning context with a plan Daddy
// hasn't seen, so it must clear its first edit exactly as a fresh run does — even
// when a valid checkpoint exists (the checkpoint proves the worktree trustworthy,
// not the plan sound). The crash path (no checkpoint) stacks the reconciliation
// reason on top; the one accepted decision the new session produces clears both.
// Pure — the driver writes the result and journals the reason.
export const rotationGateState = (state: GateState, hasCheckpoint: boolean): { next: GateState; reason: string } => {
  const reason = hasCheckpoint
    ? "first edit of the new session requires an accepted planner decision"
    : "reconciliation required: no valid checkpoint from the previous session"
  return {
    next: { ...state, latched: true, firstEditApproved: false, reconciliationRequired: !hasCheckpoint, latchReason: reason },
    reason,
  }
}

export const latchGate = (paths: Paths, state: GateState, reason: string): GateState => {
  // An already-latched gate keeps its original reason (v1 G10, carried).
  if (state.latched) return state
  const latched: GateState = { ...state, latched: true, latchReason: reason, updatedAt: nowIso() }
  writeGateState(paths, latched)
  return latched
}

// Evaluated by the driver at turn boundaries (the plugin runs its own
// synchronous copy of the same triggers mid-turn). Returns a latch reason or
// undefined. Order is contract G5.
export const gateTriggerReason = (state: GateState, worktree: string): string | undefined => {
  const delta = diffDelta(state.baselineDiffStats, readDiffStats(worktree))

  // File-surface gate removed: out-of-surface edits are no longer blocked. Baby
  // reliably touches only files the work needs; the pre-emptive block only sent
  // Daddy into "why am I blocked?" spirals before issuing a continue. Surface
  // drift is now caught after the fact in Daddy's final review (verification.ts
  // classifyChanges), not enforced mid-run. expectedGlobs is retained in state
  // purely for that classification.
  //
  // Checkpoint CADENCE removed (work-interval, time-interval): a periodic forced
  // checkpoint blocked Baby's edits and — post async-consult, where a forced
  // ask_planner ENDS the turn — cancelled Baby's turn on every trip, so a
  // finished run could never chain verify→submit before the next interval cut it
  // off (the live "trapped in a checkpoint loop" wedge). The planner stays in the
  // loop by Baby's own judgment (ask_planner is always available) and by Daddy's
  // final review — never by a forced interval. The gate latches for first-edit
  // approval at the START OF EACH SESSION — once for a fresh run, and again on
  // every rotation (rotateSession), because a replaced session is a new reasoning
  // context with a plan Daddy hasn't seen. It clears on that session's accepted
  // decision and stays clear for the rest of the session's life (plus the crash-
  // path reconciliation latch). It is NOT a periodic cadence: exactly one latch
  // per session, on the one event where the plan is rebuilt.
  if (!state.firstEditApproved && delta.files.length > 0) {
    return "first edit of the run requires an accepted planner decision"
  }
  if (state.reconciliationRequired) {
    return "reconciliation required: no valid checkpoint from the previous session"
  }
  return undefined
}

// The checkpoint cadence reborn as a SHOUT, not a wall (§10). The work/time
// interval that used to THROW (and, post async-consult, end Baby's turn — the
// live "trapped in a checkpoint loop" wedge) is gone. This is its non-blocking
// heir: once `intervalMs` has elapsed since Baby's last planner check-in, the
// driver prepends a soft reminder to EVERY continue prompt until Baby actually
// checks in (clearGate resets lastAcceptedDecisionAt). Deliberately NOT
// throttled — repetition is the point; Baby is an easily-distracted child and we
// keep shouting. Baby keeps full tool access and may ignore it.
//
// Only after the first plan lands (a fresh run shouldn't be nagged), and only
// once there's an accepted decision to measure from. Returns the elapsed whole
// minutes when due, else undefined.
export const checkpointNudgeDue = (state: GateState, nowMs: number, intervalMs: number): number | undefined => {
  if (!state.firstEditApproved || !state.lastAcceptedDecisionAt) return undefined
  const elapsed = nowMs - Date.parse(state.lastAcceptedDecisionAt)
  if (elapsed < intervalMs) return undefined
  return Math.round(elapsed / 60_000)
}
