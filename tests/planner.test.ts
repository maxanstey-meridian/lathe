import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createPlanner } from "../src/infrastructure/opencode/planner.js"
import type { Executor, ModelConfig } from "../src/application/ports/executor.js"
import type { Packet, OutcomeLedger, SubmitReport } from "../src/domain/index.js"

const mockResponse = (text: string) => ({
  info: { id: "msg-1", sessionID: "sess-1" },
  parts: [{ type: "text", text }],
})

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
})

const minLedger = (): OutcomeLedger => ({
  runId: "20260618-070000-test",
  outcomes: [
    { id: "test-outcome", description: "a test outcome", status: "not_started", updatedAt: "2026-06-18T00:00:00.000Z" },
  ],
  updatedAt: "2026-06-18T00:00:00.000Z",
})

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
})

const modelConfig: ModelConfig = { providerId: "openai", modelId: "gpt-4", agent: "daddy" }

describe("createPlanner.finalReview", () => {
  it("returns immediately when first response parses as FinalReview", async () => {
    let sendCount = 0
    const validJson = JSON.stringify({ verdict: "accept", findings: ["ok"], notes: "green" })
    const mockExecutor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCount++
        if (sendCount === 1) return mockResponse("PLANNER_OK")
        return mockResponse(validJson)
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor

    const planner = createPlanner(mockExecutor, modelConfig, 30000, "test-dir")
    await planner.handshake("seed")
    const result = await planner.finalReview(minPacket(), "(diff)", minLedger(), minReport())

    assert.equal(sendCount, 2)
    assert.equal(result.verdict, "accept")
  })

  it("re-asks ONCE on unparseable text, returns retry result on second response", async () => {
    let sendCount = 0
    const mockExecutor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCount++
        if (sendCount === 1) return mockResponse("PLANNER_OK")
        if (sendCount === 2) {
          return mockResponse("I think this looks good.\n\nno valid json here")
        }
        const validJson = JSON.stringify({ verdict: "accept", findings: ["retry worked"], notes: "fixed" })
        return mockResponse(validJson)
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor

    const planner = createPlanner(mockExecutor, modelConfig, 30000, "test-dir")
    await planner.handshake("seed")
    const result = await planner.finalReview(minPacket(), "(diff)", minLedger(), minReport())

    assert.equal(sendCount, 3, "sendMessage should be called three times: handshake + finalReview + retry")
    assert.equal(result.verdict, "accept")
    assert.deepEqual(result.findings, ["retry worked"])
    assert.equal(result.notes, "fixed")
  })

  it("re-asks and retry also has fenced JSON — balancedObjects finds it", async () => {
    let sendCount = 0
    const mockExecutor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCount++
        if (sendCount === 1) return mockResponse("PLANNER_OK")
        if (sendCount === 2) {
          return mockResponse("```json\n{malformed")
        }
        const validJson = JSON.stringify({ verdict: "request_changes", findings: ["fence parsed"], notes: "ok" })
        return mockResponse("```json\n" + validJson + "\n```")
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor

    const planner = createPlanner(mockExecutor, modelConfig, 30000, "test-dir")
    await planner.handshake("seed")
    const result = await planner.finalReview(minPacket(), "(diff)", minLedger(), minReport())

    assert.equal(sendCount, 3)
    assert.equal(result.verdict, "request_changes")
    assert.deepEqual(result.findings, ["fence parsed"])
  })

  it("fails closed to request_changes after two parse failures", async () => {
    let sendCount = 0
    const mockExecutor = {
      createSession: async () => "test-session",
      sendMessage: async () => {
        sendCount++
        if (sendCount === 1) return mockResponse("PLANNER_OK")
        return mockResponse("just prose, no json at all")
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    } as unknown as Executor

    const planner = createPlanner(mockExecutor, modelConfig, 30000, "test-dir")
    await planner.handshake("seed")
    const result = await planner.finalReview(minPacket(), "(diff)", minLedger(), minReport())

    assert.equal(sendCount, 3, "sendMessage called three times: handshake + finalReview + retry nudge")
    assert.equal(result.verdict, "request_changes")
  })
})
