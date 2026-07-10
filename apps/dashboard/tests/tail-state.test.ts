import { strict as assert } from "node:assert";
import { test } from "vitest";

import type { TailSnapshotDto } from "@lathe/contract";
import { applyTailEvent, tailStateFromSnapshot, visiblePaneLines } from "@lathe/tail-state";


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
  panes: {
    baby: [{ text: "restored baby", style: "text" }],
    daddy: [{ text: "restored daddy", style: "think" }],
    super: [],
  },
  driverCommands: [],
  journal: [
    { seq: 1, at: "2026-07-01T18:00:01.000Z", line: "driver booted", event: "log", driver: true },
    { seq: 2, at: "2026-07-01T18:00:02.000Z", line: "baby text", event: "log", driver: false },
  ],
  lastSeq: 2,
});

test("tailStateFromSnapshot initializes panes, driver events, and stats", () => {
  const state = tailStateFromSnapshot(snapshot());

  assert.deepEqual(state.driverEvents, ["driver booted"]);
  assert.equal(state.stats?.contextTokens, 12_000);
  assert.equal(state.stats?.outcomesDone, 1);
  assert.deepEqual(visiblePaneLines(state.panes.baby), [{ text: "restored baby", style: "text" }]);
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
    { text: "restored baby", style: "text" },
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
  assert.deepEqual(visiblePaneLines(changed.panes.baby), [{ text: "restored baby", style: "text" }]);
});

test("pane replacement is authoritative and terminal stats preserve content", () => {
  const state = tailStateFromSnapshot(snapshot());
  const replaced = applyTailEvent(state, {
    kind: "tail.agent.panes.replaced",
    runId: snapshot().runId,
    panes: {
      baby: [{ text: "hydrated", style: "text" }],
      daddy: [],
      super: [],
    },
  }, 100);
  const terminal = applyTailEvent(replaced, {
    kind: "tail.stats",
    runId: snapshot().runId,
    at: "2026-07-01T18:00:03.000Z",
    contextTokens: 20_000,
    turn: 3,
    rotations: 1,
    outcomesDone: 3,
    outcomesTotal: 3,
    gateReason: null,
    status: "ready_for_review",
    promoted: false,
  }, 200);

  assert.deepEqual(visiblePaneLines(terminal.panes.baby), [{ text: "hydrated", style: "text" }]);
});

test("driver verification renders output before its result and includes driver journal events", () => {
  let state = tailStateFromSnapshot(snapshot());
  state = applyTailEvent(state, {
    kind: "tail.driver.command",
    runId: snapshot().runId,
    phase: "report",
    commandId: "command-1",
    command: "task check",
    status: "running",
    at: "2026-07-01T18:00:03.000Z",
  }, 100);
  state = applyTailEvent(state, {
    kind: "tail.driver.delta",
    runId: snapshot().runId,
    phase: "report",
    commandId: "command-1",
    stream: "stdout",
    text: "green\n",
    at: "2026-07-01T18:00:04.000Z",
  }, 200);
  state = applyTailEvent(state, {
    kind: "tail.driver.delta",
    runId: snapshot().runId,
    phase: "report",
    commandId: "command-1",
    stream: "stderr",
    text: "warning\n",
    at: "2026-07-01T18:00:05.000Z",
  }, 300);
  state = applyTailEvent(state, {
    kind: "tail.driver.command",
    runId: snapshot().runId,
    phase: "report",
    commandId: "command-1",
    command: "task check",
    status: "completed",
    exitCode: 0,
    timedOut: false,
    at: "2026-07-01T18:00:08.000Z",
  }, 400);

  assert.deepEqual(visiblePaneLines(state.panes.driver), [
    { text: "green", style: "text" },
    { text: "warning", style: "think" },
    { text: "✓ [report] $ task check (exit 0 · 0m05s)", style: "tool" },
    { text: "driver booted", style: "tool" },
  ]);
});
