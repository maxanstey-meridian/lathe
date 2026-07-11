// ---------------------------------------------------------------------------
// Answer use case (CONTRACT R7)
//
// Max's morning "yes": he answers a parked (blocked) or failed run with a
// decision. For blocked runs, the gate clears and the run requeues. For failed
// runs, retry counters reset and the run requeues — the worktree is live, so
// the next execution resumes (or starts fresh if the packet changed).
//
// Only blocked and failed runs are answerable; anything else is refused (no-op).
// ---------------------------------------------------------------------------

import { clearedGateState } from "../../domain/gate-decisions.js";
import type { Decision } from "../../domain/run.js";
import type { Clock } from "../ports/clock.js";
import type { Repo } from "../ports/repo.js";
import type { Store } from "../ports/store.js";

export type AnswerResult =
  | {
      ok: true;
      checkpoint?: number;
      decision: {
        source: "max";
        status: "proceed";
        questionType: "stop_condition" | "convergence_retry";
      };
    }
  | {
      ok: false;
      reason: string;
    };

// Answer a parked (blocked) or failed run with Max's decision.
//
// On success:
//   1. Append a Decision record (source=max, status=proceed).
//   2. For an unpublished convergence operation, mark this attempt for a
//      convergence-only retry. Otherwise clear the gate for Executor resume.
//   3. Update meta without blockedReason/blockedQuestion and reset retry counts.
//   4. Return checkpoint number if available.
export const answerRun = (
  store: Store,
  repo: Repo,
  runId: string,
  answer: string,
  worktree: string,
  clock: Clock,
): AnswerResult => {
  const meta = store.readMetaIfExists(runId);
  if (!meta || (meta.status !== "blocked" && meta.status !== "failed")) {
    return {
      ok: false,
      reason: meta
        ? `run ${runId} is not answerable (status: ${meta.status})`
        : `run ${runId} not found`,
    };
  }

  const isFailed = meta.status === "failed";
  const convergenceOperation = store.readConvergenceOperation(runId, meta.attempt);
  const retryConvergence =
    meta.status === "blocked" &&
    convergenceOperation !== undefined &&
    convergenceOperation.phase !== "autofix_started" &&
    convergenceOperation.phase !== "published";
  const questionType = retryConvergence ? "convergence_retry" : "stop_condition";

  const decision: Decision = {
    timestamp: clock.nowIso(),
    source: "max",
    questionType,
    ...(retryConvergence ? { currentSlice: `attempt:${meta.attempt}` } : {}),
    question:
      meta.blockedQuestion ??
      (isFailed ? "(run failed — retry requested)" : "(parked without a recorded question)"),
    evidence: [],
    status: "proceed",
    answer,
    constraints: [],
  };

  // A convergence retry never returns to Executor, so its gate is irrelevant.
  // Other answers clear the gate before the resumed Executor turn.
  let gateState;
  if (!retryConvergence) {
    try {
      const g = store.readGateState(runId);
      gateState = g;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("gate state not found:")) {
        throw error;
      }
      // No gate state — nothing to clear.
    }
    if (gateState) {
      gateState = clearedGateState(gateState, repo.readDiffStats(worktree), clock.nowIso());
    }
  }

  const { blockedReason: _br, blockedQuestion: _bq, ...rest } = meta;
  store.answerRun({
    runId,
    expectedRevision: meta.revision ?? 0,
    expectedStatus: meta.status,
    decision,
    gateState,
    meta: {
      ...rest,
      status: retryConvergence ? "ready_for_review" : "queued",
      stallRetries: 0,
      crashRetries: 0,
      promoted: retryConvergence ? rest.promoted : false,
      updatedAt: clock.nowIso(),
    },
  });

  const checkpoint = store.latestCheckpoint(runId);

  return {
    ok: true,
    checkpoint: checkpoint?.number,
    decision: {
      source: "max",
      status: "proceed",
      questionType,
    },
  };
};
