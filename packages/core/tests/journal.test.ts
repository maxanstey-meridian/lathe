import { equal, match } from "node:assert";
import { describe, it } from "node:test";
import type { JournalEvent } from "../src/domain/index.js";
import { renderJournalEvent, isDriverEvent } from "../src/domain/journal.js";

describe("journal-render — renderJournalEvent", () => {
  it("renders run_started with attempt number", () => {
    const event: JournalEvent = {
      at: "2026-06-18T12:00:00.000Z",
      event: "run_started",
      runId: "test",
      attempt: 1,
    };
    const line = renderJournalEvent(event);
    match(line, /run started/);
    match(line, /attempt 1/);
    match(line, /12:00:00/);
  });

  it("renders verification_run with exitCode 0 as ✅", () => {
    const event: JournalEvent = {
      at: "2026-06-18T12:00:00.000Z",
      event: "verification_run",
      command: "pnpm test",
      exitCode: 0,
    };
    const line = renderJournalEvent(event);
    match(line, /✅/);
    match(line, /pnpm test/);
  });

  it("renders verification_run with non-zero exitCode as ❌", () => {
    const event: JournalEvent = {
      at: "2026-06-18T12:00:00.000Z",
      event: "verification_run",
      command: "pnpm test",
      exitCode: 1,
    };
    const line = renderJournalEvent(event);
    match(line, /❌/);
  });

  it("renders gate_latched", () => {
    const event: JournalEvent = {
      at: "2026-06-18T12:00:00.000Z",
      event: "gate_latched",
      reason: "first edit unapproved",
    };
    const line = renderJournalEvent(event);
    match(line, /gate latched/);
  });
});

describe("journal-render — isDriverEvent", () => {
  it("returns false for tool_call", () => {
    const event: JournalEvent = {
      at: "2026-06-18T12:00:00.000Z",
      event: "tool_call",
      tool: "meridian-bridge_ask_planner",
      status: "completed",
    };
    equal(isDriverEvent(event), false);
  });

  it("returns false for turn_ended", () => {
    const event: JournalEvent = {
      at: "2026-06-18T12:00:00.000Z",
      event: "turn_ended",
      messageId: "m1",
      tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 150,
      text: "hello",
    };
    equal(isDriverEvent(event), false);
  });

  it("returns false for prompt_sent", () => {
    const event: JournalEvent = {
      at: "2026-06-18T12:00:00.000Z",
      event: "prompt_sent",
      promptName: "q1InitialSeed",
      preview: "You are Baby",
    };
    equal(isDriverEvent(event), false);
  });

  it("returns true for run_started", () => {
    const event: JournalEvent = {
      at: "2026-06-18T12:00:00.000Z",
      event: "run_started",
      runId: "test",
      attempt: 1,
    };
    equal(isDriverEvent(event), true);
  });

  it("returns true for gate_latched", () => {
    const event: JournalEvent = {
      at: "2026-06-18T12:00:00.000Z",
      event: "gate_latched",
      reason: "latch",
    };
    equal(isDriverEvent(event), true);
  });
});
