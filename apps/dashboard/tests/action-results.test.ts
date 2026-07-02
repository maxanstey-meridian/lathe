import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  clearAnswerAfterSuccess,
  removeReviewRunAfterSuccess,
} from "../app/pages/index/logic/action-results";

test("removeReviewRunAfterSuccess removes only after a successful action", async () => {
  const removed: string[] = [];

  const failed = await removeReviewRunAfterSuccess(
    "run-1",
    async () => false,
    (runId) => {
      removed.push(runId);
    },
  );

  assert.equal(failed, false);
  assert.deepEqual(removed, []);

  const succeeded = await removeReviewRunAfterSuccess(
    "run-1",
    async () => true,
    (runId) => {
      removed.push(runId);
    },
  );

  assert.equal(succeeded, true);
  assert.deepEqual(removed, ["run-1"]);
});

test("clearAnswerAfterSuccess clears only after a successful answer", async () => {
  const cleared: string[] = [];
  const calls: Array<{ runId: string; answer: string }> = [];

  const failed = await clearAnswerAfterSuccess(
    "run-1",
    "please continue",
    async (runId, answer) => {
      calls.push({ runId, answer });
      return false;
    },
    (runId) => {
      cleared.push(runId);
    },
  );

  assert.equal(failed, false);
  assert.deepEqual(cleared, []);
  assert.deepEqual(calls, [{ runId: "run-1", answer: "please continue" }]);

  const succeeded = await clearAnswerAfterSuccess(
    "run-1",
    "please continue",
    async (runId, answer) => {
      calls.push({ runId, answer });
      return true;
    },
    (runId) => {
      cleared.push(runId);
    },
  );

  assert.equal(succeeded, true);
  assert.deepEqual(cleared, ["run-1"]);
});
