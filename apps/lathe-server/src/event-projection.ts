/**
 * STAGING REFERENCE — drop into apps/lathe-server/src (or @lathe/core) in P00.
 *
 * Projects the rich INTERNAL journal union (domain/journal.ts `JournalEvent`,
 * discriminated on `event`) onto the STABLE WIRE union (`LatheEvent` from
 * @lathe/contract, discriminated on `kind`). The API never leaks the journal
 * shape; this is the only seam where the two unions meet.
 *
 * Most internal events are noise to a dashboard and project to `null` (dropped).
 * A few wire kinds (turn.started's `pass`, tokens' `window`, verdict's
 * `reviewer`) are NOT carried by the journal event itself — they come from
 * supervisor state, passed in as `ctx`. That coupling is real and is why the
 * full projection lives in the supervisor packet (P02); this is its seed.
 */
import type { JournalEvent } from "@lathe/core";
import type { LatheEvent, Reviewer } from "@lathe/contract";

/** Per-run state the supervisor holds and the journal event can't supply. */
export interface ProjectionContext {
  runId: string;
  pass: number; // convergence pass — not on journal events
  contextWindow: number; // baby.contextWindow — for the tokens gauge
  reviewer: Reviewer; // who produced the current review (daddy in-loop / superdaddy on convergence)
}

/**
 * Pure. Returns the wire event, or null when the internal event has no
 * dashboard projection. Exhaustive over the journal union — a new `event`
 * variant is a compile error here (good: forces a projection decision).
 */
export const projectJournalEvent = (
  e: JournalEvent,
  ctx: ProjectionContext,
): LatheEvent | null => {
  const at = e.at;
  const runId = ctx.runId;

  switch (e.event) {
    case "run_started":
      return { kind: "run.state", runId, status: "running", at };

    case "prompt_sent":
      // Prompt-to-Baby is the visible start of a turn. `turn` rides on base.
      return { kind: "turn.started", runId, pass: ctx.pass, turn: e.turn ?? 0, at };

    case "turn_ended":
      return { kind: "tokens", runId, contextTokens: e.contextTokens, window: ctx.contextWindow, at };

    case "tool_call":
      // Only surface the gate decision, not every call. Denied → block.
      return e.gateDenied
        ? { kind: "gate.decision", runId, decision: "block", tool: e.tool, at }
        : null;

    case "checkpoint_volume_nudge":
      return { kind: "gate.decision", runId, decision: "notice", tool: "checkpoint", at };

    case "gate_latched":
      return { kind: "log", runId, line: `gate latched: ${e.reason}`, at };

    case "final_review":
      return { kind: "verdict", runId, reviewer: ctx.reviewer, verdict: e.verdict, at };

    case "super_review":
      return { kind: "verdict", runId, reviewer: "superdaddy", verdict: e.verdict, at };

    case "parked":
      return { kind: "run.state", runId, status: "paused", at };

    case "committed":
      return { kind: "log", runId, line: `committed ${e.sha.slice(0, 8)}: ${e.message}`, at };

    case "driver_note":
      return { kind: "log", runId, line: e.note, at };

    case "rotation":
      return { kind: "log", runId, line: `rotation: ${e.phase}`, at };

    case "stall_recovery":
      return { kind: "log", runId, line: `stall ${e.action} (retry ${e.stallRetries})`, at };

    case "reorient":
      return { kind: "log", runId, line: `reorient #${e.attempt}: ${e.fix}`, at };

    case "model_promoted":
      return { kind: "log", runId, line: `model promoted: ${e.from} -> ${e.to}`, at };

    // Internal-only: no dashboard projection.
    case "gate_cleared":
    case "planner_exchange":
    case "outcomes_updated":
    case "checkpoint_written":
    case "verification_run":
    case "report_submitted":
    case "report_rejected":
    case "report_accepted":
    case "ladder_step":
      return null;

    default: {
      // Exhaustiveness guard — a new journal variant won't compile until mapped.
      const _never: never = e;
      void _never;
      return null;
    }
  }
};
