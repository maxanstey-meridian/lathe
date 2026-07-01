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
    compare_commit: "main",
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

describe("createPlanner.consult", () => {
  it("renders live review obligations and driver telemetry", async () => {
    const validJson = JSON.stringify({
      status: "proceed",
      answer: "ok",
      constraints: [],
      evidence_used: ["prompt context"],
      safe_next_action: "continue",
      human_decision_needed: null,
    });
    const sent: string[] = [];
    const mockExecutor = {
      createSession: async () => "test-session",
      sendMessage: async (_sessionId: string, prompt: string) => {
        sent.push(prompt);
        if (sent.length === 1) {
          return mockResponse("PLANNER_OK");
        }
        return mockResponse(validJson);
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(mockExecutor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    await planner.consult(minConsult(), {
      reviewState: {
        runId: "20260618-070000-test",
        obligations: ["keep the seam narrow"],
        updatedAt: "2026-06-18T00:00:00.000Z",
      },
      facts: {
        attempt: 3,
        rotations: 2,
        ledgerSummary: "test-outcome: in_progress; evidence=started",
      },
    });

    const consultPrompt = sent[1] ?? "";
    assert.match(consultPrompt, /keep the seam narrow/);
    assert.match(consultPrompt, /Run attempt: 3/);
    assert.match(consultPrompt, /Session rotations: 2/);
    assert.match(consultPrompt, /test-outcome: in_progress; evidence=started/);
  });
});

describe("createPlanner.syncMaxDecisions", () => {
  it("injects Max answers into the Daddy session before later planner work", async () => {
    const sent: string[] = [];
    const mockExecutor = {
      createSession: async () => "test-session",
      sendMessage: async (_sessionId: string, prompt: string) => {
        sent.push(prompt);
        if (sent.length === 1) {
          return mockResponse("PLANNER_OK");
        }
        return mockResponse("DADDY_SYNC_OK");
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(mockExecutor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    await planner.syncMaxDecisions?.([
      {
        timestamp: "2026-06-29T19:30:53.925Z",
        question: "May I add a test dependency?",
        answer: "Yes, use userEvent; do not add seams.",
      },
    ]);

    assert.equal(sent.length, 2);
    assert.match(sent[1] ?? "", /DADDY STATE SYNC/);
    assert.match(sent[1] ?? "", /May I add a test dependency\?/);
    assert.match(sent[1] ?? "", /Yes, use userEvent; do not add seams\./);
  });

  it("fails closed when Daddy does not acknowledge the sync", async () => {
    const mockExecutor = {
      createSession: async () => "test-session",
      sendMessage: (() => {
        let count = 0;
        return async () => {
          count++;
          return count === 1 ? mockResponse("PLANNER_OK") : mockResponse("I ignored that");
        };
      })(),
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(mockExecutor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    await assert.rejects(
      planner.syncMaxDecisions?.([
        {
          timestamp: "2026-06-29T19:30:53.925Z",
          question: "May I add a test dependency?",
          answer: "Yes.",
        },
      ]),
      /Daddy sync failed/,
    );
  });
});

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

describe("createPlanner.finalReview latest-reply harvest", () => {
  it("does not re-parse a stale final-review JSON object from an earlier Daddy message", async () => {
    let sendCount = 0;
    const staleReview = JSON.stringify({
      verdict: "request_changes",
      findings: ["stale finding from an earlier final review"],
      notes: "old review",
    });
    const executor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCount++;
        if (sendCount === 1) {
          return mockResponse("PLANNER_OK");
        }
        return mockResponse("I inspected the current files but forgot to emit JSON.");
      },
      listMessages: async () => [
        {
          info: { id: "old", sessionID: "s", role: "assistant" },
          parts: [{ type: "text", text: staleReview }],
        },
        {
          info: { id: "latest", sessionID: "s", role: "assistant" },
          parts: [{ type: "text", text: "I inspected the current files but forgot to emit JSON." }],
        },
      ],
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(executor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.finalReview(minPacket(), minLedger(), minReport());

    assert.equal(sendCount, 3, "latest unparseable reply should trigger the one allowed re-ask");
    assert.equal(result.verdict, "request_changes");
    assert.deepEqual(result.findings, [
      "Daddy's final-review response was not valid JSON; failing closed to request_changes.",
    ]);
  });
});
