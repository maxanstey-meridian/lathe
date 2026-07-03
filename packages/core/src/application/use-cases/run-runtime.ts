// ---------------------------------------------------------------------------
// Run runtime (CONTRACT R2/§6, ARCHITECTURE §4)
//
// Shared types + the journal helper for the per-run use cases (execute-run,
// turn-loop, rotation). Pure glue: no I/O of its own beyond the ports it is
// handed. Keeping these here breaks the turn-loop ↔ rotation import cycle.
// ---------------------------------------------------------------------------

import type { Config } from "../../config/schemas.js";
import type { JournalEvent } from "../../domain/journal.js";
import type { SubmitReport } from "../../domain/report.js";
import type { FinalReview, AskPlannerInput } from "../../domain/review.js";
import type { BlockedReason } from "../../domain/run.js";
import type { BridgeIntent } from "../../domain/turn.js";
import type { Clock } from "../ports/clock.js";
import type { Executor } from "../ports/executor.js";
import type { Planner } from "../ports/planner.js";
import type { Repo } from "../ports/repo.js";
import type { Store } from "../ports/store.js";

// The ports the run-level use cases depend on. One bag, injected at the
// composition root; every side effect in the loop flows through it.
export type RunPorts = {
  config: Config;
  store: Store;
  repo: Repo;
  executor: Executor;
  planner: Planner;
  clock: Clock;
};

// ---------------------------------------------------------------------------
// RunChannel — the per-turn bridge channel, as the loop SEES it.
//
// This is the narrow, application-owned view of the bridge's per-run context
// (infrastructure `ActiveRunRef`). The bridge RECORDS typed intents and bumps
// its internal counters here during a send; the loop DRAINS `intents` and reads
// the counters after the send returns (ARCHITECTURE §4 — the keystone). The
// loop never reads a scalar the bridge wrote "behind its back": every signal is
// derived from the drained `intents` by the pure `evaluateTurn`.
//
// The infrastructure `ActiveRunRef` is a structural SUPERSET of this type, so
// the composition root passes it straight in with zero casts; the loop cannot
// import infrastructure (the dependency rule), and does not need to.
// ---------------------------------------------------------------------------

export type RunChannel = {
  intents: BridgeIntent[];
  pendingConsult: AskPlannerInput | null;
  pendingFinalReview: SubmitReport | null;
  reportRejectionCount: number;
  checkpointBounceCount: number;
  turn: number;
  // Set to true by the bridge the instant it records a stop-and-wait intent
  // (ask_planner / submit_report). All subsequent bridge tool calls return an
  // "End your turn" error; stopTurn asks opencode to interrupt the active
  // message in the same session so the driver can run the deferred intent.
  turnComplete: boolean;
  stopTurn?: () => Promise<void>;
  // While true, only verify_handoff is accepted — blocks all other tool calls
  // until the predecessor's handoff has been verified. Cleared by verify_handoff.
  awaitingVerification: boolean;
};

// What a finished attempt resolves to — the terminal lifecycle status the
// run-loop reads back from meta.
export type RunOutcome =
  | { status: "ready_for_review" }
  | { status: "failed"; note: string }
  | { status: "blocked"; reason: BlockedReason; question: string }
  | { status: "stopped" };

// The turn loop returns the outcome plus, for a ready_for_review, the accepted
// report and Daddy's final review so finalize can render report.md. They are
// kept off RunOutcome so the terminal decision and the render payload stay
// separable (a defensively-reached terminal carries no payload).
export type TurnLoopResult = {
  outcome: RunOutcome;
  acceptedReport?: SubmitReport;
  finalReview?: FinalReview;
};

// A prompt to send next turn: a stable name (journalled) + its text.
export type Seed = { name: string; text: string };

// ---------------------------------------------------------------------------
// Journal helper — append an event, stamping `at` (Clock) and `turn`.
// Mirrors the bridge's helper so driver- and bridge-side events share a shape.
// ---------------------------------------------------------------------------

type Without<T, K extends keyof T> = {
  [P in keyof T as P extends K ? never : P]: T[P];
};

export const journal = (
  ports: Pick<RunPorts, "store" | "clock">,
  runId: string,
  turn: number,
  event: Without<JournalEvent, "at" | "turn">,
): void => {
  ports.store.appendJournal(runId, {
    ...event,
    at: ports.clock.nowIso(),
    turn,
  } as JournalEvent);
};

// ---------------------------------------------------------------------------
// Handoff inject — builds the system message prepended to baby's seed when a
// predecessor handoff exists. Pure function, no I/O. The 2000-char cap on the
// handoff JSON matches the run-loop-handoff-inject constraint ("capped at 2000
// chars"). Returns "" when handoffJson is undefined (no handoff to inject).
// ---------------------------------------------------------------------------

export const buildHandoffInject = (handoffJson: string | undefined): string => {
  if (!handoffJson) {
    return "";
  }
  return `Predecessor handoff available: ${handoffJson.slice(0, 2000)}. Call verify_handoff once you have read the packet and the handoff, before starting new work.`;
};
