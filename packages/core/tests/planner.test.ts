import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Executor, ModelConfig } from "../src/application/ports/executor.js";
import type { Packet, OutcomeLedger, SubmitReport } from "../src/domain/index.js";
import { createPlanner } from "../src/infrastructure/opencode/planner.js";

const mockResponse = (text: string) => ({
  info: { id: "msg-1", sessionID: "sess-1" },
  parts: [{ type: "text", text }],
});

// An assistant turn with no text parts — the empty final message of a multi-step turn.
const emptyAssistant = { info: { id: "final", sessionID: "s", role: "assistant" }, parts: [] };

const minConsult = () => ({
  questionType: "reconciliation" as const,
  currentSlice: "slice",
  question: "is this right?",
  approach: "an approach",
  evidence: [],
});

const minPacket = (): Packet => ({
  runId: "20260618-070000-test",
  frontmatter: {
    repo: "test/repo",
    base: "main",
    outcomes: [{ id: "test-outcome", description: "a test outcome" }],
    expected_surface: ["src/**"],
    verification: [{ command: "pnpm test" }],
    constraints: [],
  },
  body: "",
  raw: "---\nrepo: test/repo\n---\ntest body",
});

const minLedger = (): OutcomeLedger => ({
  runId: "20260618-070000-test",
  outcomes: [
    {
      id: "test-outcome",
      description: "a test outcome",
      status: "not_started",
      updatedAt: "2026-06-18T00:00:00.000Z",
    },
  ],
  updatedAt: "2026-06-18T00:00:00.000Z",
});

const minReport = (): SubmitReport => ({
  status: "ready_for_review",
  summary: "done",
  outcomeClaims: [{ id: "test-outcome", status: "done" }],
  filesChanged: [],
  behaviourChanged: [],
  sourceOfTruthFollowed: [],
  verificationClaims: [],
  escalations: [],
  remainingUncertainty: [],
});

const modelConfig: ModelConfig = { providerId: "openai", modelId: "gpt-4", agent: "daddy" };

describe("createPlanner.finalReview", () => {
  it("returns immediately when first response parses as FinalReview", async () => {
    let sendCount = 0;
    const validJson = JSON.stringify({ verdict: "accept", findings: ["ok"], notes: "green" });
    const mockExecutor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCount++;
        if (sendCount === 1) {
          return mockResponse("PLANNER_OK");
        }
        return mockResponse(validJson);
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(mockExecutor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.finalReview(minPacket(), minLedger(), minReport());

    assert.equal(sendCount, 2);
    assert.equal(result.verdict, "accept");
  });

  it("re-asks ONCE on unparseable text, returns retry result on second response", async () => {
    let sendCount = 0;
    const mockExecutor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCount++;
        if (sendCount === 1) {
          return mockResponse("PLANNER_OK");
        }
        if (sendCount === 2) {
          return mockResponse("I think this looks good.\n\nno valid json here");
        }
        const validJson = JSON.stringify({
          verdict: "accept",
          findings: ["retry worked"],
          notes: "fixed",
        });
        return mockResponse(validJson);
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(mockExecutor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.finalReview(minPacket(), minLedger(), minReport());

    assert.equal(
      sendCount,
      3,
      "sendMessage should be called three times: handshake + finalReview + retry",
    );
    assert.equal(result.verdict, "accept");
    assert.deepEqual(result.findings, ["retry worked"]);
    assert.equal(result.notes, "fixed");
  });

  it("re-asks and retry also has fenced JSON — balancedObjects finds it", async () => {
    let sendCount = 0;
    const mockExecutor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCount++;
        if (sendCount === 1) {
          return mockResponse("PLANNER_OK");
        }
        if (sendCount === 2) {
          return mockResponse("```json\n{malformed");
        }
        const validJson = JSON.stringify({
          verdict: "request_changes",
          findings: ["fence parsed"],
          notes: "ok",
        });
        return mockResponse("```json\n" + validJson + "\n```");
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(mockExecutor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.finalReview(minPacket(), minLedger(), minReport());

    assert.equal(sendCount, 3);
    assert.equal(result.verdict, "request_changes");
    assert.deepEqual(result.findings, ["fence parsed"]);
  });

  it("fails closed to request_changes after two parse failures", async () => {
    let sendCount = 0;
    const mockExecutor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCount++;
        if (sendCount === 1) {
          return mockResponse("PLANNER_OK");
        }
        return mockResponse("just prose, no json at all");
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(mockExecutor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.finalReview(minPacket(), minLedger(), minReport());

    assert.equal(
      sendCount,
      3,
      "sendMessage called three times: handshake + finalReview + retry nudge",
    );
    assert.equal(result.verdict, "request_changes");
  });
});

// The fix2 scar: a multi-step mini-model turn leaves its FINAL message empty with the
// verdict in an EARLIER assistant message. Single-turn extractText dropped it and
// parked a healthy run; the all-message harvest recovers it without a re-ask. Covers
// BOTH consult and finalReview, and confirms each still fails closed on a real empty.
describe("createPlanner all-message harvest (fix2)", () => {
  const verdictInEarlierMessage = (verdict: string): Executor =>
    ({
      createSession: async () => "test-session",
      sendMessage: (() => {
        let n = 0;
        return async () => {
          n++;
          return n === 1 ? mockResponse("PLANNER_OK") : emptyAssistant;
        };
      })(),
      listMessages: async () => [
        { info: { id: "u", sessionID: "s", role: "user" }, parts: [] },
        {
          info: { id: "a1", sessionID: "s", role: "assistant" },
          parts: [{ type: "text", text: verdict }],
        },
        emptyAssistant,
      ],
      deleteSession: async () => {},
    }) as unknown as Executor;

  it("consult recovers a verdict that lives only in a non-final message", async () => {
    const verdict = JSON.stringify({ status: "proceed", answer: "go", safe_next_action: "do it" });
    const planner = createPlanner(verdictInEarlierMessage(verdict), modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.consult(minConsult());
    assert.equal(result.status, "proceed", "the buried verdict was harvested, not dropped");
  });

  it("finalReview recovers a verdict that lives only in a non-final message", async () => {
    const verdict = JSON.stringify({ verdict: "accept", findings: [], notes: "green" });
    const planner = createPlanner(verdictInEarlierMessage(verdict), modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.finalReview(minPacket(), minLedger(), minReport());
    assert.equal(result.verdict, "accept");
  });

  it("consult still fails closed to stop when the reply is genuinely empty", async () => {
    const executor = {
      createSession: async () => "test-session",
      sendMessage: (() => {
        let n = 0;
        return async () => {
          n++;
          return n === 1 ? mockResponse("PLANNER_OK") : emptyAssistant;
        };
      })(),
      listMessages: async () => [emptyAssistant],
      deleteSession: async () => {},
    } as unknown as Executor;
    const planner = createPlanner(executor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.consult(minConsult());
    assert.equal(result.status, "stop");
  });
});
