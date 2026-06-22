import assert from "node:assert";
import { test } from "node:test";
import { stallAction, decideStallRecovery, checkReorientBound } from "../src/domain/liveness.js";

// ---------------------------------------------------------------------------
// stallAction (CONTRACT §6 L3)
// ---------------------------------------------------------------------------

test("stallAction: nudges on dead turns below rotateAt", () => {
  assert.strictEqual(stallAction(1, 4, 10), "nudge");
  assert.strictEqual(stallAction(2, 4, 10), "nudge");
  assert.strictEqual(stallAction(3, 4, 10), "nudge");
});

test("stallAction: rotates every rotateAt dead turns", () => {
  assert.strictEqual(stallAction(4, 4, 10), "rotate");
  assert.strictEqual(stallAction(8, 4, 10), "rotate");
});

test("stallAction: continues nudging between rotation boundaries", () => {
  assert.strictEqual(stallAction(5, 4, 10), "nudge");
  assert.strictEqual(stallAction(6, 4, 10), "nudge");
  assert.strictEqual(stallAction(7, 4, 10), "nudge");
  assert.strictEqual(stallAction(9, 4, 10), "nudge");
});

test("stallAction: parks once ladder reaches parkAt", () => {
  assert.strictEqual(stallAction(10, 4, 10), "park");
  assert.strictEqual(stallAction(11, 4, 10), "park");
  assert.strictEqual(stallAction(20, 4, 10), "park");
});

test("stallAction: park always wins over rotate (rotateAt at parkAt still parks)", () => {
  // 8 is a multiple of 4, but parkAt 8 means the run is already wedged —
  // park, not rotate.
  assert.strictEqual(stallAction(8, 4, 8), "park");
  assert.strictEqual(stallAction(8, 4, 7), "park");
});

test("stallAction: misconfigured rotateAt > parkAt can never rotate — bounded by park", () => {
  for (let i = 1; i < 10; i++) {
    assert.strictEqual(stallAction(i, 12, 10), "nudge");
  }
  assert.strictEqual(stallAction(10, 12, 10), "park");
});

test("stallAction: rotateAt 0 means never rotate (nudge-only until park)", () => {
  for (let l = 1; l < 10; l++) {
    assert.strictEqual(stallAction(l, 0, 10), "nudge");
  }
  assert.strictEqual(stallAction(10, 0, 10), "park");
});

// ---------------------------------------------------------------------------
// decideStallRecovery (CONTRACT §5 R10)
// ---------------------------------------------------------------------------

test("decideStallRecovery: wedged park under the cap → requeue, count incremented", () => {
  assert.deepEqual(
    decideStallRecovery({ status: "blocked", blockedReason: "wedged", stallRetries: 0 }, 2),
    {
      action: "requeue",
      stallRetries: 1,
    },
  );
  assert.deepEqual(
    decideStallRecovery({ status: "blocked", blockedReason: "wedged", stallRetries: 1 }, 2),
    {
      action: "requeue",
      stallRetries: 2,
    },
  );
});

test("decideStallRecovery: wedged park at the cap → escalate", () => {
  assert.deepEqual(
    decideStallRecovery({ status: "blocked", blockedReason: "wedged", stallRetries: 2 }, 2),
    {
      action: "escalate",
      stallRetries: 2,
    },
  );
});

test("decideStallRecovery: crashed and judgement parks are never auto-recovered", () => {
  for (const reason of ["crashed", "human_decision", "scope_expansion", "stop_condition"]) {
    assert.deepEqual(
      decideStallRecovery({ status: "blocked", blockedReason: reason, stallRetries: 0 }, 2),
      { action: "none" },
      `${reason} must not auto-retry`,
    );
  }
});

test("decideStallRecovery: non-blocked statuses are never touched", () => {
  assert.deepEqual(decideStallRecovery({ status: "ready_for_review", stallRetries: 0 }, 2), {
    action: "none",
  });
  assert.deepEqual(decideStallRecovery({ status: "running", stallRetries: 0 }, 2), {
    action: "none",
  });
  assert.deepEqual(decideStallRecovery({ status: "queued", stallRetries: 0 }, 2), {
    action: "none",
  });
});

test("decideStallRecovery: maxStallRetries 0 disables auto-recovery", () => {
  assert.deepEqual(
    decideStallRecovery({ status: "blocked", blockedReason: "wedged", stallRetries: 0 }, 0),
    { action: "escalate", stallRetries: 0 },
  );
});

test("decideStallRecovery: handles missing stallRetries (undefined)", () => {
  assert.deepEqual(
    decideStallRecovery({ status: "blocked", blockedReason: "wedged", stallRetries: 0 }, 2),
    { action: "requeue", stallRetries: 1 },
  );
});

// ---------------------------------------------------------------------------
// checkReorientBound (CONTRACT §5 R11)
// ---------------------------------------------------------------------------

test("checkReorientBound: under the cap → allowed", () => {
  assert.deepEqual(checkReorientBound(0, 2), { allowed: true, escalating: false });
  assert.deepEqual(checkReorientBound(1, 2), { allowed: true, escalating: false });
});

test("checkReorientBound: at the cap → block and escalate", () => {
  assert.deepEqual(checkReorientBound(2, 2), { allowed: false, escalating: true });
  assert.deepEqual(checkReorientBound(3, 2), { allowed: false, escalating: true });
});

test("checkReorientBound: with cap 0 → always block", () => {
  assert.deepEqual(checkReorientBound(0, 0), { allowed: false, escalating: true });
});

test("checkReorientBound: high cap allows many retries", () => {
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(checkReorientBound(i, 10), { allowed: true, escalating: false });
  }
  assert.deepEqual(checkReorientBound(10, 10), { allowed: false, escalating: true });
});
