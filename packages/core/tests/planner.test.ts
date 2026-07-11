import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Executor, ModelConfig } from "../src/application/ports/executor.js";
import type { Packet } from "../src/domain/packet.js";
import type { OutcomeLedger } from "../src/domain/outcomes.js";
import type { SubmitReport } from "../src/domain/report.js";
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
    suspicious_surface: [],
    verification: [{ command: "pnpm test" }],
    constraints: [],
    pass: 1,
    promoted: false,
    autofix_commands: [],
    regression_outcomes: [],
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
      evidence: [],
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
  regressionGuard: { tests: [] },
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

  it("rejects an accepted code decision until Daddy inspects the repository", async () => {
    const validJson = JSON.stringify({
      status: "proceed",
      answer: "ok",
      constraints: [],
      evidence_used: ["src/example.ts"],
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
        if (sent.length === 2) {
          return mockResponse(validJson);
        }
        return {
          ...mockResponse(validJson),
          parts: [
            { type: "tool", tool: "read", state: { status: "completed" } },
            { type: "text", text: validJson },
          ],
        };
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(mockExecutor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.consult({
      ...minConsult(),
      questionType: "architecture_discoverable",
    });

    assert.equal(result.status, "proceed");
    assert.equal(sent.length, 3);
    assert.match(sent[2] ?? "", /used no repository inspection tool/);
    assert.match(sent[2] ?? "", /Use read, grep, glob, GitNexus, or ast-grep now/);
  });

  it("stops when accepted replies remain ungrounded after all re-asks", async () => {
    const ungroundedJson = JSON.stringify({
      status: "proceed",
      answer: "ok",
      constraints: [],
      evidence_used: [],
      safe_next_action: "continue",
      human_decision_needed: null,
    });
    let sendCount = 0;
    const executor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCount++;
        return sendCount === 1 ? mockResponse("PLANNER_OK") : mockResponse(ungroundedJson);
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(executor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.consult({
      ...minConsult(),
      questionType: "architecture_discoverable",
    });

    assert.equal(sendCount, 5);
    assert.equal(result.status, "stop");
    assert.equal(result.human_decision_needed, null);
    assert.match(result.answer, /used no repository inspection tool/);
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
      planner.syncMaxDecisions!([
        {
          timestamp: "2026-06-29T19:30:53.925Z",
          question: "May I add a test dependency?",
          answer: "Yes.",
        },
      ]),
      /Daddy sync failed/,
    );
  });

  it("recovers sync ack from a non-final message in the current exchange", async () => {
    let listCalls = 0;
    let sendCalls = 0;
    const executor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCalls++;
        return sendCalls === 1 ? mockResponse("PLANNER_OK") : emptyAssistant;
      },
      listMessages: async () => {
        listCalls++;
        if (listCalls === 1) {
          return [];
        }
        if (listCalls === 2) {
          return [
            {
              info: { id: "seed", sessionID: "s", role: "assistant" },
              parts: [{ type: "text", text: "PLANNER_OK" }],
            },
          ];
        }
        if (listCalls === 3) {
          return [
            {
              info: { id: "old", sessionID: "s", role: "assistant" },
              parts: [{ type: "text", text: "old" }],
            },
          ];
        }
        return [
          {
            info: { id: "old", sessionID: "s", role: "assistant" },
            parts: [{ type: "text", text: "old" }],
          },
          {
            info: { id: "sync", sessionID: "s", role: "assistant" },
            parts: [{ type: "text", text: "DADDY_SYNC_OK" }],
          },
          emptyAssistant,
        ];
      },
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(executor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    await planner.syncMaxDecisions?.([
      { timestamp: "2026-06-29T19:30:53.925Z", question: "Continue?", answer: "Yes." },
    ]);
  });
});

describe("createPlanner cancellation", () => {
  it("propagates AbortSignal through handshake", async () => {
    let observedSignal: AbortSignal | undefined;
    const executor = {
      createSession: async () => "test-session",
      sendMessage: async (...args: Parameters<Executor["sendMessage"]>) => {
        observedSignal = args[4];
        return mockResponse("PLANNER_OK");
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;
    const controller = new AbortController();

    await createPlanner(executor, modelConfig, 30000).handshake(
      "seed",
      "test-dir",
      controller.signal,
    );

    assert.equal(observedSignal, controller.signal);
  });

  it("propagates AbortSignal through sync, consult, and final review sends", async () => {
    const signals: Array<AbortSignal | undefined> = [];
    let sends = 0;
    const validConsult = JSON.stringify({
      status: "proceed",
      answer: "go",
      constraints: [],
      evidence_used: [],
      safe_next_action: "continue",
      human_decision_needed: null,
    });
    const executor = {
      createSession: async () => "test-session",
      sendMessage: async (...args: Parameters<Executor["sendMessage"]>) => {
        sends++;
        signals.push(args[4]);
        if (sends === 1) {
          return mockResponse("PLANNER_OK");
        }
        if (sends === 2) {
          return mockResponse("DADDY_SYNC_OK");
        }
        if (sends === 3) {
          return mockResponse(validConsult);
        }
        return mockResponse(JSON.stringify({ verdict: "accept", findings: [], notes: "ok" }));
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;
    const planner = createPlanner(executor, modelConfig, 30000);
    const controller = new AbortController();
    await planner.handshake("seed", "test-dir");
    await planner.syncMaxDecisions?.(
      [{ timestamp: "2026-01-01T00:00:00Z", question: "retry?", answer: "yes" }],
      controller.signal,
    );
    await planner.consult(minConsult(), undefined, controller.signal);
    await planner.finalReview(minPacket(), minLedger(), minReport(), controller.signal);

    assert.deepEqual(signals, [undefined, controller.signal, controller.signal, controller.signal]);
  });

  it("does not convert an aborted final review into a human escalation", async () => {
    let sends = 0;
    const controller = new AbortController();
    const executor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sends++;
        if (sends === 1) {
          return mockResponse("PLANNER_OK");
        }
        controller.abort();
        throw new DOMException("cancelled", "AbortError");
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor;
    const planner = createPlanner(executor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");

    await assert.rejects(
      planner.finalReview(minPacket(), minLedger(), minReport(), controller.signal),
      (error: Error) => error.name === "AbortError",
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

  it("escalates after all re-asks fail to parse", async () => {
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
      5,
      "sendMessage called five times: handshake + finalReview + 3 re-asks",
    );
    assert.equal(result.verdict, "escalate");
    assert.ok(result.human_decision_needed);
  });
});

// The fix2 scar: a multi-step mini-model turn leaves its FINAL message empty with the
// verdict in an EARLIER assistant message in the SAME exchange. Single-turn extractText
// dropped it and parked a healthy run; current-exchange harvest recovers it without
// reading stale JSON from earlier Daddy turns.
describe("createPlanner current-exchange harvest (fix2)", () => {
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
      listMessages: (() => {
        let calls = 0;
        return async () => {
          calls++;
          if (calls === 1) {
            return [];
          }
          if (calls === 2) {
            return [
              {
                info: { id: "seed", sessionID: "s", role: "assistant" },
                parts: [{ type: "text", text: "PLANNER_OK" }],
              },
            ];
          }
          if (calls === 3) {
            return [
              {
                info: { id: "seed", sessionID: "s", role: "assistant" },
                parts: [{ type: "text", text: "PLANNER_OK" }],
              },
            ];
          }
          return [
            {
              info: { id: "seed", sessionID: "s", role: "assistant" },
              parts: [{ type: "text", text: "PLANNER_OK" }],
            },
            {
              info: { id: "a1", sessionID: "s", role: "assistant" },
              parts: [{ type: "text", text: verdict }],
            },
            emptyAssistant,
          ];
        };
      })(),
      deleteSession: async () => {},
    }) as unknown as Executor;

  it("consult recovers a verdict that lives only in a non-final message", async () => {
    const verdict = JSON.stringify({ status: "proceed", answer: "go", safe_next_action: "do it" });
    const planner = createPlanner(verdictInEarlierMessage(verdict), modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.consult(minConsult());
    assert.equal(result.status, "proceed", "the buried verdict was harvested, not dropped");
  });

  it("consult stops when the reply remains genuinely empty", async () => {
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
    assert.equal(result.human_decision_needed, null);
    assert.match(result.answer, /Last issue: Unexpected end of JSON input/);
  });
});

describe("createPlanner.finalReview all-message harvest", () => {
  it("recovers current-exchange JSON when the final message is empty", async () => {
    const staleReview = JSON.stringify({
      verdict: "request_changes",
      findings: ["stale finding from an earlier final review"],
      notes: "old review",
    });
    const freshReview = JSON.stringify({
      verdict: "accept",
      findings: ["looks good now"],
      notes: "all clear",
    });
    let listCalls = 0;
    let sendCalls = 0;
    const executor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCalls++;
        return sendCalls === 1 ? mockResponse("PLANNER_OK") : emptyAssistant;
      },
      listMessages: async () => {
        listCalls++;
        if (listCalls === 1) {
          return [];
        }
        if (listCalls === 2) {
          return [
            {
              info: { id: "seed", sessionID: "s", role: "assistant" },
              parts: [{ type: "text", text: "PLANNER_OK" }],
            },
          ];
        }
        if (listCalls === 3) {
          return [
            {
              info: { id: "old", sessionID: "s", role: "assistant" },
              parts: [{ type: "text", text: staleReview }],
            },
          ];
        }
        return [
          {
            info: { id: "old", sessionID: "s", role: "assistant" },
            parts: [{ type: "text", text: staleReview }],
          },
          {
            info: { id: "current", sessionID: "s", role: "assistant" },
            parts: [{ type: "text", text: freshReview }],
          },
          emptyAssistant,
        ];
      },
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(executor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.finalReview(minPacket(), minLedger(), minReport());

    assert.equal(result.verdict, "accept");
    assert.deepEqual(result.findings, ["looks good now"]);
  });

  it("does not parse stale final-review JSON when the current exchange is empty", async () => {
    const staleReview = JSON.stringify({
      verdict: "request_changes",
      findings: ["stale finding from an earlier final review"],
      notes: "old review",
    });
    let listCalls = 0;
    let sendCalls = 0;
    const executor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCalls++;
        return sendCalls === 1 ? mockResponse("PLANNER_OK") : emptyAssistant;
      },
      listMessages: async () => {
        listCalls++;
        if (listCalls === 1) {
          return [];
        }
        if (listCalls === 2) {
          return [
            {
              info: { id: "seed", sessionID: "s", role: "assistant" },
              parts: [{ type: "text", text: "PLANNER_OK" }],
            },
          ];
        }
        return [
          {
            info: { id: "old", sessionID: "s", role: "assistant" },
            parts: [{ type: "text", text: staleReview }],
          },
          emptyAssistant,
        ];
      },
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(executor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.finalReview(minPacket(), minLedger(), minReport());

    assert.equal(result.verdict, "escalate");
    assert.ok(result.human_decision_needed);
  });

  it("escalates when all replies are genuinely empty (no stale fallback)", async () => {
    let sendCount = 0;
    const executor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCount++;
        return sendCount === 1 ? mockResponse("PLANNER_OK") : emptyAssistant;
      },
      listMessages: async () => [emptyAssistant],
      deleteSession: async () => {},
    } as unknown as Executor;

    const planner = createPlanner(executor, modelConfig, 30000);
    await planner.handshake("seed", "test-dir");
    const result = await planner.finalReview(minPacket(), minLedger(), minReport());

    assert.equal(result.verdict, "escalate");
    assert.ok(result.human_decision_needed);
  });
});
