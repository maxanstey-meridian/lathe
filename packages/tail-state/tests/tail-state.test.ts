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
  acceptanceReviewLines: [],
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

test("super status detail remains accepted by the shared reducer", () => {
  const state = applyTailEvent(
    tailStateFromSnapshot(snapshot()),
    {
      kind: "tail.super.status",
      runId: "run",
      seq: 1,
      at: "2026-07-10T18:00:00.000Z",
      status: "failed",
      pass: 1,
      detail: "reviewer crashed",
      lines: ["acceptance review failed: reviewer crashed"],
    },
    1,
  );

  deepStrictEqual(visiblePaneLines(state.panes.super), [
    { text: "acceptance review failed: reviewer crashed", style: "tool" },
  ]);
});

test("a new acceptance-review state removes prior findings", () => {
  let state = applyTailEvent(
    tailStateFromSnapshot(snapshot()),
    {
      kind: "tail.super.verdict",
      runId: "run",
      seq: 1,
      at: "2026-07-10T18:00:00.000Z",
      verdict: "request_changes",
      pass: 1,
      findings: ["[P1] stale finding"],
      lines: ["acceptance review: verdict request_changes (pass 1)", "  [P1] stale finding"],
    },
    1,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.super.status",
      runId: "run",
      seq: 2,
      at: "2026-07-10T18:01:00.000Z",
      status: "started",
      pass: 2,
      lines: ["acceptance review: reviewing pass 2"],
    },
    2,
  );

  deepStrictEqual(visiblePaneLines(state.panes.super), [
    { text: "acceptance review: reviewing pass 2", style: "tool" },
  ]);
});

test("a new acceptance-review state removes findings without severity prefixes", () => {
  let state = applyTailEvent(
    tailStateFromSnapshot(snapshot()),
    {
      kind: "tail.super.verdict",
      runId: "run",
      seq: 1,
      at: "2026-07-10T18:00:00.000Z",
      verdict: "request_changes",
      pass: 1,
      findings: ["stale finding"],
      lines: ["acceptance review: verdict request_changes (pass 1)", "  stale finding"],
    },
    1,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.super.status",
      runId: "run",
      seq: 2,
      at: "2026-07-10T18:01:00.000Z",
      status: "started",
      pass: 2,
      lines: ["acceptance review: reviewing pass 2"],
    },
    2,
  );

  deepStrictEqual(visiblePaneLines(state.panes.super), [
    { text: "acceptance review: reviewing pass 2", style: "tool" },
  ]);
});

test("acceptance-review replacement uses typed snapshot ownership, not display prefixes", () => {
  const initial = snapshot();
  initial.acceptanceReviewLines = ["review failed unexpectedly", "  stale finding"];
  initial.panes.super = [{ text: "unrelated tool output", style: "tool" }];
  const state = applyTailEvent(
    tailStateFromSnapshot(initial),
    {
      kind: "tail.super.status",
      runId: "run",
      seq: 2,
      at: "2026-07-10T18:01:00.000Z",
      status: "started",
      pass: 2,
      lines: ["renamed review presentation"],
    },
    2,
  );

  deepStrictEqual(visiblePaneLines(state.panes.super), [
    { text: "unrelated tool output", style: "tool" },
    { text: "renamed review presentation", style: "tool" },
  ]);
});

test("acceptance-review replacement preserves duplicate transcript lines", () => {
  const initial = snapshot();
  initial.acceptanceReviewLines = ["duplicate"];
  initial.panes.super = [
    { text: "duplicate", style: "tool" },
    { text: "unrelated", style: "tool" },
    { text: "duplicate", style: "tool" },
  ];
  const state = applyTailEvent(
    tailStateFromSnapshot(initial),
    {
      kind: "tail.super.status",
      runId: "run",
      seq: 2,
      at: "2026-07-10T18:01:00.000Z",
      status: "started",
      pass: 2,
      lines: ["replacement"],
    },
    2,
  );

  deepStrictEqual(
    visiblePaneLines(state.panes.super).map((line) => line.text),
    ["duplicate", "unrelated", "duplicate", "replacement"],
  );
});

test("acceptance-review replacement preserves a later duplicate tool line by range", () => {
  let state = applyTailEvent(
    tailStateFromSnapshot(snapshot()),
    {
      kind: "tail.super.status",
      runId: "run",
      seq: 1,
      at: "2026-07-10T18:00:00.000Z",
      status: "started",
      pass: 1,
      lines: [". duplicate"],
    },
    1,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.pane.tool",
      runId: "run",
      speaker: "super",
      status: "completed",
      tool: "duplicate",
      detail: "",
      input: "unrelated attachment",
    },
    2,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.super.status",
      runId: "run",
      seq: 2,
      at: "2026-07-10T18:01:00.000Z",
      status: "started",
      pass: 2,
      lines: ["replacement"],
    },
    3,
  );

  deepStrictEqual(visiblePaneLines(state.panes.super), [
    { text: ". duplicate", style: "tool", attachment: "unrelated attachment" },
    { text: "replacement", style: "tool" },
  ]);
});

test("oversized acceptance-review lines are replaced using their bounded identity", () => {
  const stale = `stale-${"a".repeat(10_000)}`;
  const replacement = `replacement-${"b".repeat(10_000)}`;
  let state = applyTailEvent(
    tailStateFromSnapshot(snapshot()),
    {
      kind: "tail.super.status",
      runId: "run",
      seq: 1,
      at: "2026-07-10T18:00:00.000Z",
      status: "started",
      pass: 1,
      lines: [stale],
    },
    1,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.super.status",
      runId: "run",
      seq: 2,
      at: "2026-07-10T18:01:00.000Z",
      status: "started",
      pass: 2,
      lines: [replacement],
    },
    2,
  );

  equal(state.panes.super.lines.length, 1);
  equal(state.panes.super.lines[0]?.text, replacement.slice(-8_000));
  deepStrictEqual(state.acceptanceReviewLines, [replacement.slice(-8_000)]);
  deepStrictEqual(state.snapshot?.acceptanceReviewLines, [replacement.slice(-8_000)]);
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
      acceptanceReviewLines: [],
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

test("authoritative pane replacement preserves review ownership", () => {
  let state = tailStateFromSnapshot(snapshot());
  state = applyTailEvent(
    state,
    {
      kind: "tail.super.verdict",
      runId: "run",
      seq: 1,
      at: "2026-07-10T18:00:00.000Z",
      verdict: "accept",
      pass: 1,
      findings: [],
      lines: ["review one"],
    },
    1,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.agent.panes.replaced",
      runId: "run",
      panes: {
        baby: [],
        daddy: [],
        super: [{ text: "unrelated", style: "tool" }],
      },
      acceptanceReviewLines: ["review one"],
    },
    2,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.super.verdict",
      runId: "run",
      seq: 2,
      at: "2026-07-10T18:01:00.000Z",
      verdict: "accept",
      pass: 1,
      findings: [],
      lines: ["review two"],
    },
    3,
  );

  deepStrictEqual(
    state.panes.super.lines.map((line) => line.text),
    ["unrelated", "review two"],
  );
});

test("authoritative replacement carries changed review line counts without stale ownership", () => {
  let state = applyTailEvent(
    tailStateFromSnapshot(snapshot()),
    {
      kind: "tail.agent.panes.replaced",
      runId: "run",
      panes: {
        baby: [],
        daddy: [],
        super: [{ text: "transcript", style: "text" }],
      },
      acceptanceReviewLines: ["old status", "old finding one", "old finding two"],
    },
    1,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.agent.panes.replaced",
      runId: "run",
      panes: {
        baby: [],
        daddy: [],
        super: [{ text: "transcript", style: "text" }],
      },
      acceptanceReviewLines: ["new status"],
    },
    2,
  );

  deepStrictEqual(
    state.panes.super.lines.map((line) => line.text),
    ["transcript", "new status"],
  );
});

test("semantic review follows an unfinished Super transcript delta", () => {
  let state = applyTailEvent(
    tailStateFromSnapshot(snapshot()),
    {
      kind: "tail.pane.delta",
      runId: "run",
      speaker: "super",
      style: "text",
      text: "unfinished review transcript",
    },
    1,
  );
  state = applyTailEvent(
    state,
    {
      kind: "tail.super.status",
      runId: "run",
      seq: 1,
      at: "2026-07-10T18:01:00.000Z",
      status: "failed",
      pass: 1,
      lines: ["review failed"],
    },
    2,
  );

  deepStrictEqual(
    visiblePaneLines(state.panes.super).map((line) => line.text),
    ["unfinished review transcript", "review failed"],
  );
});

test("transcript and semantic review compose correctly after 300-line trimming", () => {
  const initial = snapshot();
  initial.panes.super = Array.from({ length: 305 }, (_, index) => ({
    text: `transcript-${index}`,
    style: "text" as const,
  }));
  initial.acceptanceReviewLines = ["old status", "old finding"];
  let state = tailStateFromSnapshot(initial);

  state = applyTailEvent(
    state,
    {
      kind: "tail.super.status",
      runId: "run",
      seq: 2,
      at: "2026-07-10T18:01:00.000Z",
      status: "started",
      pass: 2,
      lines: ["new status"],
    },
    2,
  );

  equal(state.panes.super.lines.length, 300);
  equal(state.panes.super.lines[0]?.text, "transcript-6");
  equal(state.panes.super.lines.at(-1)?.text, "new status");
  equal(
    state.panes.super.lines.some((line) => line.text === "old finding"),
    false,
  );
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
