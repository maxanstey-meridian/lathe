// Pure gate decisions, deny/notice messages (CONTRACT §10 G5/G10).
// No fs, no child_process, no Date. All functions take their time,
// state, and diff inputs as parameters so they are testable
// without a clock or git — importable by both driver and plugin.

import type { DiffStats } from "./gate-classification.js";
import { editTargetOutOfSurface } from "./gate-tools.js";
import type { GateState } from "./gate.js";
import { ACCEPTED_STATUSES, type PlannerStatus } from "./review.js";
import type { Decision } from "./run.js";

type DeltaInput = { files: string[]; loc: number };

// G5 (clear): the gate state after an accepted planner decision. First-edit is
// approved, any reconciliation requirement is lifted, and the baseline diff is
// re-anchored to NOW so the next volume reminder measures work since this
// check-in. Pure: the caller supplies the fresh baseline (readDiffStats) and
// nowIso. Used by the off-MCP consult (an accepted decision) and the bridge's
// get_decisions clear — one definition, two call sites.
export const clearedGateState = (
  state: GateState,
  baselineDiffStats: DiffStats,
  nowIso: string,
): GateState => ({
  ...state,
  latched: false,
  latchReason: undefined,
  firstEditApproved: true,
  reconciliationRequired: false,
  lastAcceptedDecisionAt: nowIso,
  baselineDiffStats,
  updatedAt: nowIso,
});

// G5: trigger evaluation — first match wins.
// The in-worktree surface gate is GONE (only absolute-path-outside
// is blocked). The checkpoint cadence is no longer a gate trigger
// (demoted to non-blocking NOTICE). Gate latches for first-edit
// approval exactly once per session, plus crash-path reconciliation.
export const gateTriggerReason = (state: GateState, delta: DeltaInput): string | undefined => {
  if (!state.firstEditApproved && delta.files.length > 0) {
    return "first edit of the run requires an accepted planner decision";
  }
  if (state.reconciliationRequired) {
    return "reconciliation required: no valid checkpoint from the previous session";
  }
  return undefined;
};

// The volume reminder, evaluated at the turn boundary for the driver's VISIBLE
// journal event (§10). Tool calls OR files OR LoC since the last planner check-in,
// whichever crosses first. Pure; returns the same reason string the plugin appends
// to executor output. Returns the reason when due, else undefined.
export const volumeCheckpointReason = (
  toolCalls: number,
  delta: { files: string[]; loc: number },
  limits: { checkpointToolCalls: number; checkpointFiles: number; checkpointLoc: number },
): string | undefined => {
  if (toolCalls >= limits.checkpointToolCalls) {
    return `work checkpoint interval reached (${toolCalls} tool calls since your last planner check-in)`;
  }
  if (delta.files.length >= limits.checkpointFiles || delta.loc >= limits.checkpointLoc) {
    return `work checkpoint interval reached (${delta.files.length} files, ${delta.loc} changed LoC since your last planner check-in)`;
  }
  return undefined;
};

// O5: the gate state a replaced session inherits.
// First-edit is re-latched on EVERY rotation.
// needsReconciliation stacks reconciliation on top (crash path: no checkpoint
// AND no prior accepted reconciliation).
// The driver writes the result; this function is pure.
export const rotationGateState = (
  state: GateState,
  needsReconciliation: boolean,
): {
  next: GateState;
  reason: string;
} => {
  const reason = needsReconciliation
    ? "reconciliation required: no valid checkpoint from the previous session"
    : "first edit of the new session requires an accepted planner decision";
  return {
    next: {
      ...state,
      latched: true,
      firstEditApproved: false,
      reconciliationRequired: needsReconciliation,
      latchReason: reason,
    },
    reason,
  };
};

// Re-latch an unlatched gate mid-run (checkpoint demand). Preserves
// firstEditApproved and reconciliationRequired — only forces latched.
export const relatchGate = (state: GateState, reason: string): GateState => ({
  ...state,
  latched: true,
  latchReason: reason,
});

// O6 skip: if the most recent decision was a Daddy-accepted reconciliation,
// the state was already validated — don't force the successor session to
// re-reconcile. Scoped to the LAST decision only: a recon from turn 1 must
// not suppress a legitimately needed recon at turn 9.
export const priorReconciliationAccepted = (decisions: Decision[]): boolean => {
  const last = decisions.at(-1);
  return (
    last?.questionType === "reconciliation" &&
    ACCEPTED_STATUSES.some((s) => s === (last.status as PlannerStatus))
  );
};

// G5 (deny): mutation deny reason, first match wins.
// Order: out-of-surface absolute > latched > memory-latch > first-edit > reconciliation.
// This calls editTargetOutOfSurface from gate-tools; both files are
// pure, so this cross-module import has no I/O.
export const mutationDenyReason = (
  tool: string,
  args: unknown,
  state: GateState,
  worktree: string,
  memoryLatchReason: string | undefined,
): string | undefined => {
  const surfaceTarget = editTargetOutOfSurface(tool, args, worktree);
  if (surfaceTarget) {
    return `attempted edit outside the handoff's expected change surface: ${surfaceTarget}`;
  }
  if (state.latched) {
    return state.latchReason ?? "planner checkpoint required";
  }
  if (memoryLatchReason) {
    return memoryLatchReason;
  }
  if (!state.firstEditApproved) {
    return "first edit of the run requires an accepted planner decision";
  }
  if (state.reconciliationRequired) {
    return "reconciliation required: no valid checkpoint from the previous session";
  }
  return undefined;
};

// L1 (soft checkpoint reminder): time-based, non-blocking.
// Once `intervalMs` has elapsed since the executor's last accepted decision,
// returns the elapsed whole minutes when due, else undefined.
// Deliberately NOT throttled — repetition is the point (G10).
export const checkpointNudgeDue = (
  state: GateState,
  nowMs: number,
  intervalMs: number,
): number | undefined => {
  if (!state.firstEditApproved || !state.lastAcceptedDecisionAt) {
    return undefined;
  }
  const elapsed = nowMs - Date.parse(state.lastAcceptedDecisionAt);
  if (elapsed < intervalMs) {
    return undefined;
  }
  return Math.round(elapsed / 60_000);
};

// G10 (NOTICE): non-blocking checkpoint reminder on the ALLOW path.
// Returns the notice string when due, else undefined.
// The driver appends this to executor per-mutation results.
export const checkpointNudgeNotice = (state: GateState, nowMs: number): string | undefined => {
  if (!state.firstEditApproved || !state.lastAcceptedDecisionAt) {
    return undefined;
  }
  const intervalMs = state.checkpointNudgeMs ?? 20 * 60 * 1000;
  const elapsed = nowMs - Date.parse(state.lastAcceptedDecisionAt);
  if (elapsed < intervalMs) {
    return undefined;
  }
  const minutes = Math.round(elapsed / 60_000);
  return `MERIDIAN GATE NOTICE: ~${minutes} min since your last planner check-in. You are NOT blocked — this is a reminder, keep working with full tool access. If your direction could use Daddy's eyes, call ask_planner; otherwise carry on and call submit_report once the packet is complete.`;
};

// NON-BLOCKING VOLUME reminder (G10). Pure: takes delta precomputed by the caller
// (not readDiffStats). Tool-call axis checked first; then if isMutationCall,
// files/LoC delta. Same wording as volumeCheckpointReason for cross-file consistency.
export const volumeNoticeReason = (
  state: GateState,
  toolCallCount: number,
  isMutationCall: boolean,
  delta: DeltaInput,
): string | undefined => {
  if (typeof state.checkpointToolCalls === "number" && toolCallCount >= state.checkpointToolCalls) {
    return `work checkpoint interval reached (${toolCallCount} tool calls since your last planner check-in)`;
  }
  if (!isMutationCall) {
    return undefined;
  }
  const fileLimit = state.checkpointFiles;
  const locLimit = state.checkpointLoc;
  if (typeof fileLimit !== "number" && typeof locLimit !== "number") {
    return undefined;
  }
  if (
    (typeof fileLimit === "number" && delta.files.length >= fileLimit) ||
    (typeof locLimit === "number" && delta.loc >= locLimit)
  ) {
    return `work checkpoint interval reached (${delta.files.length} files, ${delta.loc} changed LoC since your last planner check-in)`;
  }
  return undefined;
};
// --- messages (all carry the MERIDIAN GATE marker the driver journals on) ----

export const denyMessage = (reason: string): string =>
  `MERIDIAN GATE BLOCKED: ${reason}. Your next tool call must be ask_planner — and it must state exactly what you were about to change (file and intended edit), WHY, and where the work stands overall. The planner can correct your direction even while approving, but only if you show it the real intent, not a summary that flatters it. Continue only on proceed or proceed_with_constraints. Reads stay available for gathering evidence.`;

export const QUESTION_MESSAGE = `MERIDIAN GATE BLOCKED: interactive questions are disabled — Max is not present during a run. Route it: implementation/architecture/procedure/scope questions go to ask_planner; decisions only Max can make go into submit_report with status "blocked" and the exact question.`;

export const SUBAGENT_MESSAGE = `MERIDIAN GATE BLOCKED: exploration subagents are disabled during a run. Broad discovery routes to ask_planner; bounded inspection of files the packet names stays available in this session.`;

export const GIT_MESSAGE = `MERIDIAN GATE BLOCKED: git mutations are not yours — the driver owns commits, branches, and worktrees. Work in the files; the driver commits at the end of the run.`;
