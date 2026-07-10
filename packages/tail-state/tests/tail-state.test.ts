import type { TailSnapshotDto } from "@lathe/contract";
import { deepStrictEqual, equal } from "node:assert";
import { test } from "node:test";
import {
  applyTailEvent,
  isTerminalTailStatus,
  tailStateFromSnapshot,
  visiblePaneLines,
} from "../src/index.js";

const snapshot = (): TailSnapshotDto => ({
  runId: "run",
  summary: null,
  status: "running",
  startedAt: null,
  models: { baby: "baby", promoted: "promoted", daddy: "daddy", super: "super" },
  promoted: false,
  budget: 100,
  worktree: "/tmp/run",
  outcomesDone: 0,
  outcomesTotal: 1,
  gateReason: null,
  contextTokens: 0,
  turn: 0,
  rotations: 0,
  panes: { baby: [], daddy: [], super: [] },
  driverCommands: [],
  journal: [],
  lastSeq: 0,
});

test("driver events remain grouped by command identity", () => {
  let state = tailStateFromSnapshot(snapshot());
  state = applyTailEvent(
    state,
    {
      kind: "tail.driver.command",
      runId: "run",
      phase: "report",
      commandId: "one",
      command: "one",
      status: "running",
      at: "2026-07-10T18:00:00.000Z",
    },
    1,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.driver.command",
      runId: "run",
      phase: "report",
      commandId: "two",
      command: "two",
      status: "running",
      at: "2026-07-10T18:00:01.000Z",
    },
    2,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.driver.delta",
      runId: "run",
      phase: "report",
      commandId: "one",
      stream: "stdout",
      text: "hello\n",
      at: "2026-07-10T18:00:02.000Z",
    },
    3,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.driver.delta",
      runId: "run",
      phase: "report",
      commandId: "two",
      stream: "stdout",
      text: "world\n",
      at: "2026-07-10T18:00:03.000Z",
    },
    4,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.driver.delta",
      runId: "run",
      phase: "report",
      commandId: "one",
      stream: "stdout",
      text: "again\n",
      at: "2026-07-10T18:00:04.000Z",
    },
    5,
  );

  deepStrictEqual(
    visiblePaneLines(state.panes.driver).map((line) => line.text),
    ["hello", "again", "world"],
  );
});

test("a start event repairs a delta-before-start placeholder", () => {
  let state = tailStateFromSnapshot(snapshot());
  state = applyTailEvent(
    state,
    {
      kind: "tail.driver.delta",
      runId: "run",
      phase: "autofix",
      commandId: "command",
      stream: "stderr",
      text: "waiting",
      at: "2026-07-10T18:00:00.000Z",
    },
    1,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.driver.command",
      runId: "run",
      phase: "autofix",
      commandId: "command",
      command: "task fix",
      status: "running",
      at: "2026-07-10T18:00:01.000Z",
    },
    2,
  );
  deepStrictEqual(
    visiblePaneLines(state.panes.driver).map((line) => line.text),
    ["waiting"],
  );
});

test("silent running driver commands have a shared visible projection", () => {
  const state = applyTailEvent(
    tailStateFromSnapshot(snapshot()),
    {
      kind: "tail.driver.command",
      runId: "run",
      phase: "autofix",
      commandId: "command",
      command: "pnpm check",
      status: "running",
      at: "2026-07-10T18:00:00.000Z",
    },
    1,
  );

  deepStrictEqual(visiblePaneLines(state.panes.driver), [
    { text: ". [autofix] $ pnpm check (running)", style: "tool" },
  ]);
});

test("stats update every mirrored snapshot field", () => {
  const state = applyTailEvent(
    tailStateFromSnapshot(snapshot()),
    {
      kind: "tail.stats",
      runId: "run",
      at: "2026-07-10T18:00:00.000Z",
      contextTokens: 12,
      turn: 3,
      rotations: 2,
      outcomesDone: 4,
      outcomesTotal: 5,
      gateReason: "approval",
      status: "blocked",
      promoted: true,
    },
    1,
  );

  deepStrictEqual(
    {
      contextTokens: state.snapshot?.contextTokens,
      turn: state.snapshot?.turn,
      rotations: state.snapshot?.rotations,
      outcomesDone: state.snapshot?.outcomesDone,
      outcomesTotal: state.snapshot?.outcomesTotal,
      gateReason: state.snapshot?.gateReason,
      status: state.snapshot?.status,
      promoted: state.snapshot?.promoted,
    },
    {
      contextTokens: 12,
      turn: 3,
      rotations: 2,
      outcomesDone: 4,
      outcomesTotal: 5,
      gateReason: "approval",
      status: "blocked",
      promoted: true,
    },
  );
});

test("stopped is a terminal tail status", () => {
  equal(isTerminalTailStatus("stopped"), true);
  equal(isTerminalTailStatus("running"), false);
});

test("live agent deltas bound completed and partial lines", () => {
  let state = tailStateFromSnapshot(snapshot());
  state = applyTailEvent(
    state,
    {
      kind: "tail.pane.delta",
      runId: "run",
      speaker: "baby",
      style: "text",
      text: `${"a".repeat(20_000)}\n${"b".repeat(20_000)}`,
    },
    1,
  );

  equal(state.panes.baby.lines[0]?.text.length, 8_000);
  equal(state.panes.baby.current.length, 8_000);
});

test("hydrated, replacement, and tool lines use the same character bounds", () => {
  const initial = snapshot();
  initial.panes.baby = [{ text: "a".repeat(20_000), style: "text" }];
  let state = tailStateFromSnapshot(initial);
  equal(state.panes.baby.lines[0]?.text.length, 8_000);
  equal(state.snapshot?.panes.baby[0]?.text.length, 8_000);

  state = applyTailEvent(
    state,
    {
      kind: "tail.agent.panes.replaced",
      runId: "run",
      panes: {
        baby: [{ text: "b".repeat(20_000), style: "text" }],
        daddy: [],
        super: [],
      },
    },
    1,
  );
  equal(state.panes.baby.lines[0]?.text.length, 8_000);
  equal(state.snapshot?.panes.baby[0]?.text.length, 8_000);

  state = applyTailEvent(
    state,
    {
      kind: "tail.pane.tool",
      runId: "run",
      speaker: "baby",
      status: "completed",
      tool: "Read",
      detail: "c".repeat(20_000),
      input: "d".repeat(20_000),
    },
    2,
  );
  equal(state.panes.baby.lines.at(-1)?.text.length, 8_000);
  const attachment = state.panes.baby.lines.at(-1)?.attachment ?? "";
  equal(attachment.length <= 8_000, true);
  deepStrictEqual(JSON.parse(attachment), {
    truncated: true,
    preview: "d".repeat(4_000),
  });
});

test("live and authoritative oversized lines retain the same newest text", () => {
  const oversized = `${"old".repeat(4_000)}${"new".repeat(4_000)}`;
  const live = applyTailEvent(
    tailStateFromSnapshot(snapshot()),
    {
      kind: "tail.pane.delta",
      runId: "run",
      speaker: "baby",
      style: "text",
      text: `${oversized}\n`,
    },
    1,
  );
  const authoritative = snapshot();
  authoritative.panes.baby = [{ text: oversized, style: "text" }];

  equal(
    live.panes.baby.lines[0]?.text,
    tailStateFromSnapshot(authoritative).panes.baby.lines[0]?.text,
  );
  equal(live.panes.baby.lines[0]?.text, oversized.slice(-8_000));
});

test("live and authoritative driver output retain the same newest text", () => {
  const oversized = `${"old".repeat(100_000)}${"new".repeat(100_000)}`;
  let live = tailStateFromSnapshot(snapshot());
  live = applyTailEvent(
    live,
    {
      kind: "tail.driver.command",
      runId: "run",
      phase: "report",
      commandId: "command",
      command: "pnpm test",
      status: "running",
      at: "2026-07-10T18:00:00.000Z",
    },
    1,
  );
  live = applyTailEvent(
    live,
    {
      kind: "tail.driver.delta",
      runId: "run",
      phase: "report",
      commandId: "command",
      stream: "stdout",
      text: oversized,
      at: "2026-07-10T18:00:01.000Z",
    },
    2,
  );
  const authoritative = snapshot();
  authoritative.driverCommands = [
    {
      commandId: "command",
      phase: "report",
      command: "pnpm test",
      startedAt: "2026-07-10T18:00:00.000Z",
      segments: [{ stream: "stdout", text: oversized }],
      terminal: null,
    },
  ];

  equal(
    visiblePaneLines(live.panes.driver)[0]?.text,
    visiblePaneLines(tailStateFromSnapshot(authoritative).panes.driver)[0]?.text,
  );
  equal(visiblePaneLines(live.panes.driver)[0]?.text, oversized.slice(-8_000));
});

test("live and authoritative driver commands use the same text bound", () => {
  const oversized = `${"command ".repeat(2_000)}end`;
  const live = applyTailEvent(
    tailStateFromSnapshot(snapshot()),
    {
      kind: "tail.driver.command",
      runId: "run",
      phase: "report",
      commandId: "command",
      command: oversized,
      status: "running",
      at: "2026-07-10T18:00:00.000Z",
    },
    1,
  );
  const authoritative = snapshot();
  authoritative.driverCommands = [
    {
      commandId: "command",
      phase: "report",
      command: oversized,
      startedAt: "2026-07-10T18:00:00.000Z",
      segments: [],
      terminal: null,
    },
  ];
  const hydrated = tailStateFromSnapshot(authoritative);

  equal(live.driverCommands[0]?.command, hydrated.driverCommands[0]?.command);
  equal(live.driverCommands[0]?.command, oversized.slice(0, 8_000));
});

test("visible pane lines remove multiline HTML comments", () => {
  deepStrictEqual(
    visiblePaneLines({
      lines: [
        { text: "before <!-- hidden", style: "text" },
        { text: "still hidden --> after", style: "text" },
        { text: "visible", style: "text" },
      ],
      current: "",
      currentStyle: "text",
      lastAt: 0,
    }).map((line) => line.text),
    ["before ", " after", "visible"],
  );
});
