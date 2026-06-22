// ---------------------------------------------------------------------------
// Answer use case (CONTRACT R7)
//
// Max's morning "yes": he answers a parked (blocked) run's question with a
// decision, the gate clears via the same clearedGateState the consult uses,
// stallRetries resets to 0, and the run is requeued at the front.
//
// Only a blocked run is answerable; anything else is refused (no-op).
// ---------------------------------------------------------------------------

import { clearedGateState } from "../../domain/index.js";
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
        questionType: "stop_condition";
      };
    }
  | {
      ok: false;
      reason: string;
    };

// Answer a parked run with Max's decision. The run must be blocked; otherwise
// this is a no-op refusal (only a blocked run is answerable — R7).
//
// On success:
//   1. Append a Decision record (source=max, status=proceed).
//   2. Clear the gate using clearedGateState (same helper the consult uses).
//   3. Update meta: status=queued, stallRetries=0, no blockedReason/blockedQuestion.
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
  if (!meta || meta.status !== "blocked") {
    return {
      ok: false,
      reason: meta
        ? `run ${runId} is not parked (status: ${meta.status})`
        : `run ${runId} not found`,
    };
  }

  store.appendDecision(runId, {
    timestamp: clock.nowIso(),
    source: "max",
    questionType: "stop_condition",
    question: meta.blockedQuestion ?? "(parked without a recorded question)",
    evidence: [],
    status: "proceed",
    answer,
    constraints: [],
  });

  const g = store.readGateState(runId);
  store.writeGateState(runId, clearedGateState(g, repo.readDiffStats(worktree), clock.nowIso()));

  const { blockedReason: _br, blockedQuestion: _bq, ...rest } = meta;
  store.writeMeta({
    ...rest,
    status: "queued",
    stallRetries: 0,
    updatedAt: clock.nowIso(),
  });

  const checkpoint = store.latestCheckpoint(runId);

  return {
    ok: true,
    checkpoint: checkpoint?.number,
    decision: {
      source: "max",
      status: "proceed",
      questionType: "stop_condition",
    },
  };
};
