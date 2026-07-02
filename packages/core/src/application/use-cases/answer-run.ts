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

// Answer a parked (blocked) or failed run with Max's decision.
//
// On success:
//   1. Append a Decision record (source=max, status=proceed).
//   2. Clear the gate using clearedGateState (same helper the consult uses).
//   3. Update meta: status=queued, stallRetries=0, crashRetries=0,
//      no blockedReason/blockedQuestion.
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

  store.appendDecision(runId, {
    timestamp: clock.nowIso(),
    source: "max",
    questionType: "stop_condition",
    question:
      meta.blockedQuestion ??
      (isFailed ? "(run failed — retry requested)" : "(parked without a recorded question)"),
    evidence: [],
    status: "proceed",
    answer,
    constraints: [],
  });

  // Clear the gate if one exists (blocked runs always have one; failed runs
  // may not if the failure preceded gate initialisation).
  try {
    const g = store.readGateState(runId);
    store.writeGateState(runId, clearedGateState(g, repo.readDiffStats(worktree), clock.nowIso()));
  } catch {
    // No gate state — nothing to clear.
  }

  const { blockedReason: _br, blockedQuestion: _bq, ...rest } = meta;
  store.writeMeta({
    ...rest,
    status: "queued",
    stallRetries: 0,
    crashRetries: 0,
    promoted: false,
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
