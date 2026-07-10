import { deepStrictEqual, equal } from "node:assert";
import { test } from "node:test";

import type { TailEvent } from "@lathe/contract";
import { createTailPaneProjection } from "../src/tail-pane-projection.js";

test("history projection preserves assistant parts and isolates composite identities", () => {
  const projection = createTailPaneProjection((_runId, sessionId) => sessionId === "baby" ? "baby" : "daddy", () => {});
  projection.mergeHistory("run", "baby", "baby", [
    { info: { id: "user-message", role: "user" }, parts: [{ id: "same", type: "text", text: "omit" }] },
    { info: { id: "message-1", role: "assistant" }, parts: [{ id: "same", type: "reasoning", text: "thinking" }] },
  ]);
  projection.mergeHistory("run", "daddy", "daddy", [
    { info: { id: "message-2", role: "assistant" }, parts: [{ id: "same", type: "text", text: "review" }] },
  ]);

  const panes = projection.panes("run");
  deepStrictEqual(panes.baby, [{ text: "thinking", style: "think" }]);
  deepStrictEqual(panes.daddy, [{ text: "review", style: "text" }]);
});

test("tool updates show the call but suppress result output", () => {
  const events: TailEvent[] = [];
  const projection = createTailPaneProjection(() => "baby", (event) => events.push(event));
  const part = (status: "running" | "completed", output: string) => ({
    type: "message.part.updated",
    properties: {
      part: {
        id: "tool",
        sessionID: "session",
        messageID: "message",
        type: "tool",
        tool: "bash",
        state: { status, input: { command: "task check" }, output },
      },
    },
  });

  projection.project("run", part("running", "one\n"));
  projection.project("run", part("running", "one\ntwo\n"));
  projection.project("run", part("completed", "one\ntwo\n"));

  deepStrictEqual(projection.panes("run").baby.map((line) => line.text), [
    ". bash task check",
  ]);
  equal(events.filter((event) => event.kind === "tail.pane.tool").length, 1);
  equal(events.filter((event) => event.kind === "tail.agent.panes.replaced").length, 1);
  deepStrictEqual(events.filter((event) => event.kind === "tail.pane.delta"), []);
});

test("later tool detail and input changes replace connected agent panes", () => {
  const events: TailEvent[] = [];
  const projection = createTailPaneProjection(() => "baby", (event) => events.push(event));
  const update = (command: string) => ({
    type: "message.part.updated",
    properties: { part: { id: "tool", sessionID: "session", messageID: "message", type: "tool", tool: "bash", state: { status: "running", input: { command } } } },
  });
  projection.project("run", update("task check"));
  projection.project("run", update("task test"));

  equal(events.at(-1)?.kind, "tail.agent.panes.replaced");
  equal(projection.panes("run").baby[0]?.text, ". bash task test");
});

test("agent part text and tool attachments are bounded before retention", () => {
  const projection = createTailPaneProjection(() => "baby", () => {});
  for (let index = 0; index < 9; index += 1) {
    projection.project("run", {
      type: "message.part.updated",
      properties: { part: { id: `part-${index}`, sessionID: "session", messageID: "message", type: "text", text: String(index).repeat(256_000) } },
    });
  }
  projection.project("run", {
    type: "message.part.updated",
    properties: { part: { id: "tool", sessionID: "session", messageID: "message", type: "tool", tool: "bash", state: { status: "running", input: { command: "x".repeat(20_000) } } } },
  });

  const panes = projection.panes("run").baby;
  equal(panes.some((line) => line.text.startsWith("0")), false);
  equal(panes.every((line) => line.text.length <= 8_000), true);
  equal((panes.at(-1)?.attachment?.length ?? 0) <= 16_000, true);
  JSON.parse(panes.at(-1)?.attachment ?? "{}");
});

test("authoritative projection retains the newest end of oversized lines", () => {
  const projection = createTailPaneProjection(() => "baby", () => {});
  const text = `${"old".repeat(4_000)}${"new".repeat(4_000)}`;
  projection.project("run", {
    type: "message.part.updated",
    properties: {
      part: {
        id: "part",
        sessionID: "session",
        messageID: "message",
        type: "text",
        text,
      },
    },
  });

  equal(projection.panes("run").baby[0]?.text, text.slice(-8_000));
});

test("terminal history repairs tool state and later live updates cannot regress it", () => {
  const projection = createTailPaneProjection(() => "baby", () => {});
  const part = (status: "running" | "completed", output: string) => ({
    type: "message.part.updated",
    properties: { part: { id: "tool", sessionID: "session", messageID: "message", type: "tool", tool: "bash", state: { status, output } } },
  });
  projection.project("run", part("running", "done\n"));
  projection.mergeHistory("run", "baby", "session", [{
    info: { id: "message", role: "assistant" },
    parts: [{ id: "tool", type: "tool", tool: "bash", state: { status: "error", output: "done\n" } }],
  }]);
  projection.project("run", part("running", "done\n"));

  deepStrictEqual(projection.panes("run").baby.map((line) => line.text), ["x bash"]);
});

test("event IDs deduplicate deltas and removal targets one composite part", () => {
  const events: TailEvent[] = [];
  const projection = createTailPaneProjection(() => "baby", (event) => events.push(event));
  const updated = (messageID: string, id: string, text: string) => ({
    type: "message.part.updated",
    properties: { part: { id, sessionID: "session", messageID, type: "text", text } },
  });
  projection.project("run", updated("one", "same", "first"));
  projection.project("run", updated("two", "same", "second"));
  projection.project("run", { id: "delta-1", type: "message.part.delta", properties: { sessionID: "session", messageID: "two", partID: "same", field: "text", delta: "!" } });
  projection.project("run", { id: "delta-1", type: "message.part.delta", properties: { sessionID: "session", messageID: "two", partID: "same", field: "text", delta: "!" } });
  projection.project("run", { type: "message.part.removed", properties: { sessionID: "session", messageID: "one", partID: "same" } });

  deepStrictEqual(projection.panes("run").baby, [{ text: "second!", style: "text" }]);
  equal(events.at(-1)?.kind, "tail.agent.panes.replaced");
});

test("late history cannot erase a newer live part or resurrect a removed part", () => {
  const projection = createTailPaneProjection(() => "baby", () => {});
  projection.project("run", {
    type: "message.part.updated",
    properties: { part: { id: "live", sessionID: "session", messageID: "message", type: "text", text: "new live value" } },
  });
  projection.project("run", {
    type: "message.part.removed",
    properties: { sessionID: "session", messageID: "message", partID: "removed" },
  });
  projection.mergeHistory("run", "baby", "session", [{
    info: { id: "message", role: "assistant" },
    parts: [
      { id: "live", type: "text", text: "old" },
      { id: "removed", type: "text", text: "must stay removed" },
    ],
  }]);

  deepStrictEqual(projection.panes("run").baby, [{ text: "new live value", style: "text" }]);
});

test("history restores chronological order around an already observed live part", () => {
  const projection = createTailPaneProjection(() => "baby", () => {});
  projection.project("run", {
    type: "message.part.updated",
    properties: { part: { id: "later", sessionID: "session", messageID: "message", type: "text", text: "later" } },
  });
  projection.mergeHistory("run", "baby", "session", [{
    info: { id: "message", role: "assistant" },
    parts: [
      { id: "earlier", type: "text", text: "earlier" },
      { id: "later", type: "text", text: "later" },
    ],
  }]);

  deepStrictEqual(projection.panes("run").baby.map((line) => line.text), ["earlier", "later"]);
});

test("divergent authoritative updates replace connected pane state", () => {
  const events: TailEvent[] = [];
  const projection = createTailPaneProjection(() => "baby", (event) => events.push(event));
  const updated = (text: string) => ({
    type: "message.part.updated",
    properties: { part: { id: "part", sessionID: "session", messageID: "message", type: "text", text } },
  });

  projection.project("run", updated("old"));
  projection.project("run", updated("corrected"));

  deepStrictEqual(projection.panes("run").baby, [{ text: "corrected", style: "text" }]);
  equal(events.at(-1)?.kind, "tail.agent.panes.replaced");
});

test("driver projection is updated before publication can be snapshotted", () => {
  const events: TailEvent[] = [];
  const projection = createTailPaneProjection(() => undefined, (event) => events.push(event));
  projection.projectDriver({
    kind: "tail.driver.command",
    runId: "run",
    phase: "convergence",
    commandId: "one",
    command: "pnpm test",
    status: "running",
    at: "2026-07-10T18:00:00.000Z",
  });
  projection.projectDriver({
    kind: "tail.driver.delta",
    runId: "run",
    phase: "convergence",
    commandId: "one",
    stream: "stdout",
    text: "passing\n",
    at: "2026-07-10T18:00:01.000Z",
  });
  projection.projectDriver({
    kind: "tail.driver.command",
    runId: "run",
    phase: "convergence",
    commandId: "one",
    command: "pnpm test",
    status: "completed",
    exitCode: 0,
    timedOut: false,
    at: "2026-07-10T18:00:02.000Z",
  });

  deepStrictEqual(projection.driverCommands("run"), [{
    commandId: "one",
    phase: "convergence",
    command: "pnpm test",
    startedAt: "2026-07-10T18:00:00.000Z",
    segments: [{ stream: "stdout", text: "passing\n" }],
    terminal: { status: "completed", exitCode: 0, timedOut: false, finishedAt: "2026-07-10T18:00:02.000Z" },
  }]);
  deepStrictEqual(events.map((event) => event.kind), ["tail.driver.command", "tail.driver.delta", "tail.driver.command"]);
});

test("driver projection preserves split chunks independently for concurrent commands", () => {
  const projection = createTailPaneProjection(() => undefined, () => {});
  for (const [commandId, command] of [["one", "first"], ["two", "second"]] as const) {
    projection.projectDriver({ kind: "tail.driver.command", runId: "run", phase: "report", commandId, command, status: "running", at: "2026-07-10T18:00:00.000Z" });
  }
  projection.projectDriver({ kind: "tail.driver.delta", runId: "run", phase: "report", commandId: "one", stream: "stdout", text: "hel", at: "2026-07-10T18:00:01.000Z" });
  projection.projectDriver({ kind: "tail.driver.delta", runId: "run", phase: "report", commandId: "two", stream: "stdout", text: "other\n", at: "2026-07-10T18:00:01.000Z" });
  projection.projectDriver({ kind: "tail.driver.delta", runId: "run", phase: "report", commandId: "one", stream: "stdout", text: "lo\n", at: "2026-07-10T18:00:02.000Z" });

  deepStrictEqual(projection.driverCommands("run").map((command) => ({
    command: command.command,
    output: command.segments.map((segment) => segment.text).join(""),
  })), [
    { command: "first", output: "hello\n" },
    { command: "second", output: "other\n" },
  ]);
});

test("verdict projection remains part of every authoritative replacement", () => {
  const projection = createTailPaneProjection(() => "super", () => {});
  projection.projectVerdict("run", ["verdict: accept (pass 1)", "  no findings"]);
  projection.mergeHistory("run", "super", "reviewer", [{
    info: { id: "message", role: "assistant" },
    parts: [{ id: "text", type: "text", text: "review complete" }],
  }]);

  deepStrictEqual(projection.panes("run").super.map((line) => line.text), [
    "review complete",
    "verdict: accept (pass 1)",
    "  no findings",
  ]);
});
