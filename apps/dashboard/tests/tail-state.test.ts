import { strict as assert } from "node:assert";
import { test } from "vitest";

import type { TailSnapshotDto } from "@lathe/contract";

import { applyTailEvent, tailStateFromSnapshot, visiblePaneLines } from "../app/pages/index/logic/tail-state";

const snapshot = (runId = "20260701-180000-dashboard-spa"): TailSnapshotDto => ({
  runId,
  summary: "Dashboard SPA",
  status: "running",
  startedAt: "2026-07-01T18:00:00.000Z",
  models: {
    baby: "baby-model",
    promoted: "promoted-model",
    daddy: "daddy-model",
    super: "super-model",
  },
  promoted: false,
  budget: 200_000,
  worktree: "/tmp/lathe",
  outcomesDone: 1,
  outcomesTotal: 3,
  gateReason: null,
  contextTokens: 12_000,
  turn: 2,
  rotations: 0,
  journal: [
    { seq: 1, at: "2026-07-01T18:00:01.000Z", line: "driver booted", event: "log", driver: true },
    { seq: 2, at: "2026-07-01T18:00:02.000Z", line: "baby text", event: "log", driver: false },
  ],
  lastSeq: 2,
});

test("tailStateFromSnapshot initializes driver events and stats", () => {
  const state = tailStateFromSnapshot(snapshot());

  assert.deepEqual(state.driverEvents, ["driver booted"]);
  assert.equal(state.stats?.contextTokens, 12_000);
  assert.equal(state.stats?.outcomesDone, 1);
});

test("applyTailEvent appends pane text, tools, and stats for the active run", () => {
  const state = tailStateFromSnapshot(snapshot());
  const withText = applyTailEvent(state, {
    kind: "tail.pane.delta",
    runId: snapshot().runId,
    speaker: "baby",
    style: "text",
    text: "hello\nworld",
  }, 100);

  const withTool = applyTailEvent(withText, {
    kind: "tail.pane.tool",
    runId: snapshot().runId,
    speaker: "baby",
    status: "completed",
    tool: "Bash",
    detail: "pnpm test",
  }, 200);

  const withStats = applyTailEvent(withTool, {
    kind: "tail.stats",
    runId: snapshot().runId,
    at: "2026-07-01T18:00:03.000Z",
    contextTokens: 20_000,
    turn: 3,
    rotations: 1,
    outcomesDone: 2,
    outcomesTotal: 3,
    gateReason: "reviewing",
    status: "running",
    promoted: true,
  }, 300);

  assert.deepEqual(visiblePaneLines(withStats.panes.baby), [
    { text: "hello", style: "text" },
    { text: "world", style: "text" },
    { text: ". Bash pnpm test", style: "tool" },
  ]);
  assert.equal(withStats.stats?.contextTokens, 20_000);
  assert.equal(withStats.stats?.gateReason, "reviewing");
  assert.equal(withStats.snapshot?.promoted, true);
});

test("applyTailEvent ignores events from another run and resets on run changes", () => {
  const state = tailStateFromSnapshot(snapshot());
  const ignored = applyTailEvent(state, {
    kind: "tail.journal",
    runId: "other-run",
    seq: 3,
    at: "2026-07-01T18:00:03.000Z",
    line: "wrong run",
    event: "log",
    driver: true,
  }, 100);

  assert.deepEqual(ignored.driverEvents, ["driver booted"]);

  const nextSnapshot = snapshot("20260701-190000-next-run");
  const changed = applyTailEvent(ignored, { kind: "tail.run.changed", runId: nextSnapshot.runId, snapshot: nextSnapshot }, 200);

  assert.equal(changed.snapshot?.runId, nextSnapshot.runId);
  assert.deepEqual(changed.driverEvents, ["driver booted"]);
  assert.deepEqual(visiblePaneLines(changed.panes.baby), []);
});
