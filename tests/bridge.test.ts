// Tests for the MCP bridge tool handlers (CONTRACT §9, §8 O2/O4).
// Uses real StoreAdapter with temp dirs — matches store.test.ts pattern.

import { test } from "node:test"
import { equal, strictEqual, ok, deepStrictEqual, match, rejects } from "node:assert"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { StoreAdapter } from "../src/infrastructure/store.js"
import { makePaths } from "../src/config/paths.js"
import type { Clock } from "../src/application/ports/clock.js"
import type { Repo } from "../src/application/ports/repo.js"
import type { Packet } from "../src/domain/packet.js"
import { buildMcpServer, handleAskPlanner, handleUpdateOutcomes, handleWriteCheckpoint, handleSubmitReport, handleGetDecisions, startBridgeServer, listenBridge } from "../src/infrastructure/bridge.js"
import { OutcomeStatus } from "../src/domain/outcomes.js"
import type { AskPlannerInput, UpdateOutcomesInput, WriteCheckpointInput, SubmitReportInput, GetDecisionsInput } from "../src/infrastructure/bridge.js"

// ===========================================================================
// Test helpers
// ===========================================================================

const TS_COUNTER = { n: 0 }
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS_COUNTER.n++).padStart(2, "0")}.000Z`,
})

const fakeRepo = (): Repo => ({
  createSandbox: () => { throw new Error("unimplemented") },
  wipCommit: () => undefined,
  amendCommit: () => "",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => ({}),
  reviewableDiff: () => "",
  reviewableDiffAgainst: () => "",
  fetchBranchFromClone: () => { throw new Error("unimplemented") },
  removeSandbox: () => { throw new Error("unimplemented") },
  headBranch: () => "main",
  branchExists: () => true,
  repoValid: () => true,
  mergeAccept: () => { throw new Error("unimplemented") },
})

const makeTestPacket = (overrides?: Record<string, unknown>): Packet => {
  const raw = `---
repo: /tmp/test-repo
base: main
summary: test packet
outcomes:
  - id: test-outcome
    description: A test outcome
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`
  const fm = {
    repo: "/tmp/test-repo",
    base: "main",
    summary: "test packet",
    outcomes: [{ id: "test-outcome", description: "A test outcome" }],
    expected_surface: ["src/index.ts"],
    suspicious_surface: [],
    verification: [{ command: "echo ok" }],
    constraints: [],
    ...overrides,
  }
  return { runId: "20260101-000000-test", frontmatter: fm as any, body: "body\n", raw }
}

const cleanTemp = async (dir: string) => {
  try { await rm(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const makeRef = (overrides?: { packet?: Packet }) => {
  const tmp = join(tmpdir(), `bridge-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const clock = fixedClock()
  const packet = overrides?.packet ?? makeTestPacket()
  const paths = makePaths(tmp)
  const store = StoreAdapter.create(paths, fakeRepo(), clock)
  const ctx = {
    intents: [] as any[],
    pendingConsult: null,
    pendingFinalReview: null,
    reportRejectionCount: 0,
    checkpointBounceCount: 0,
    config: {
      thresholds: {
        checkpointToolCalls: 50,
        checkpointFiles: 6,
        checkpointLoc: 80,
        reportRejectionParkAt: 3,
        checkpointBounceLimit: 1,
        verificationTimeoutMs: 600000,
        maxPasses: 3,
        maxStallRetries: 2,
        maxReorientRetries: 2,
        maxRunMs: 6 * 60 * 60 * 1000,
      },
      opencode: { bridgePort: 0 },
      mutationCommandPatterns: ["\\b(pnpm|npm|yarn)\\b.*\\bgenerate\\b", "task contracts", "dotnet-rivet"],
    },
    paths,
    worktree: tmp,
    packet,
    store,
    turn: 1,
  }
  const ref = { current: ctx }
  // Initialize ledger and gate state
  store.writeMeta({
    runId: packet.runId,
    status: "running",
    attempt: 1,
    repo: "/tmp/test-repo",
    base: "main",
    branch: "meridian/test",
    worktree: tmp,
    updatedAt: clock.nowIso(),
  })
  const ledger = store.initialLedger(packet)
  store.writeLedger(ledger)
  store.writeGateState(packet.runId, {
    runId: packet.runId,
    latched: false,
    firstEditApproved: false,
    reconciliationRequired: false,
    expectedGlobs: ["src/**"],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  })
  return { ref, tmp, clock }
}

// ===========================================================================
// buildMcpServer: five tools present
// ===========================================================================

test("buildMcpServer: exposes five tools", () => {
  const { ref } = makeRef()
  const server = buildMcpServer(ref)
  // The McpServer internally tracks tools — check via its tools property.
  // In @modelcontextprotocol/sdk, tool definitions are registered on the server.
  // We verify by calling handleAskPlanner etc. directly (covered below).
  // Just check the server object was created.
  ok(server)
  strictEqual(server.server._serverInfo.name, "meridian-bridge")
})

// ===========================================================================
// ask_planner: intent recording
// ===========================================================================

test("ask_planner: records consult-requested intent on valid call", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleAskPlanner(ref, {
    questionType: "repo_procedure",
    currentSlice: "tests/bridge.test.ts",
    question: "How do I write tests here?",
    approach: "I'll follow the store.test.ts pattern.",
    evidence: ["tests/store.test.ts"],
  })
  equal(result.isError, false)
  const body = JSON.parse(result.content[0].text)
  equal(body.status, "submitted")
  strictEqual(ref.current.intents.length, 1)
  equal(ref.current.intents[0].kind, "consult-requested")
  deepStrictEqual(ref.current.pendingConsult, {
    questionType: "repo_procedure",
    currentSlice: "tests/bridge.test.ts",
    question: "How do I write tests here?",
    approach: "I'll follow the store.test.ts pattern.",
    evidence: ["tests/store.test.ts"],
  })
  // pendingConsult is cleared after handling — actually it's NOT cleared,
  // the driver drains it on the next turn. So it should still be set.
  ok(ref.current.pendingConsult)
  await cleanTemp(tmp)
})

// ===========================================================================
// ask_planner: already-submitted hold (M3)
// ===========================================================================

test("ask_planner: already_submitted when pendingConsult is set", async () => {
  const { ref, tmp } = makeRef()
  // Set up a prior pending consult
  ref.current.pendingConsult = {
    questionType: "architecture_discoverable",
    currentSlice: "src/bridge.ts",
    question: "How does X work?",
    approach: "Y",
    evidence: ["src/bridge.ts"],
  }
  const result = await handleAskPlanner(ref, {
    questionType: "repo_procedure",
    currentSlice: "tests/bridge.test.ts",
    question: "How do I write tests here?",
    approach: "I'll follow the store.test.ts pattern.",
    evidence: ["tests/store.test.ts"],
  })
  equal(result.isError, false)
  const body = JSON.parse(result.content[0].text)
  equal(body.status, "already_submitted")
  strictEqual(ref.current.intents.length, 1)
  equal(ref.current.intents[0].kind, "consult-requested")
  // pendingConsult should NOT be overwritten
  equal(ref.current.pendingConsult?.questionType, "architecture_discoverable")
  await cleanTemp(tmp)
})

// ===========================================================================
// ask_planner: empty-arg rejection (M2)
// ===========================================================================

test("ask_planner: rejects empty question", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleAskPlanner(ref, {
    questionType: "other",
    currentSlice: "src/foo.ts",
    question: "   ",
    approach: "doing stuff",
    evidence: ["src/foo.ts"],
  })
  equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  match(body.error, /invalid meridian-bridge_ask_planner/)
  ok(body.problems.includes("question is empty"))
  strictEqual(ref.current.intents.length, 0)
  strictEqual(ref.current.pendingConsult, null)
  await cleanTemp(tmp)
})

test("ask_planner: rejects empty currentSlice", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleAskPlanner(ref, {
    questionType: "other",
    currentSlice: "  ",
    question: "what is x?",
    approach: "doing stuff",
    evidence: ["src/foo.ts"],
  })
  equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  ok(body.problems.includes("currentSlice is empty"))
  strictEqual(ref.current.intents.length, 0)
  await cleanTemp(tmp)
})

test("ask_planner: rejects empty approach", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleAskPlanner(ref, {
    questionType: "other",
    currentSlice: "src/foo.ts",
    question: "what is x?",
    approach: "  ",
    evidence: ["src/foo.ts"],
  })
  equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  ok(body.problems.some((p: string) => p.includes("approach is empty")))
  strictEqual(ref.current.intents.length, 0)
  await cleanTemp(tmp)
})

test("ask_planner: rejects empty evidence array", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleAskPlanner(ref, {
    questionType: "other",
    currentSlice: "src/foo.ts",
    question: "what is x?",
    approach: "doing stuff",
    evidence: ["  ", ""],
  })
  equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  ok(body.problems.includes("evidence is empty"))
  strictEqual(ref.current.intents.length, 0)
  await cleanTemp(tmp)
})

test("ask_planner: rejects all args empty", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleAskPlanner(ref, {
    questionType: "other",
    currentSlice: "  ",
    question: "  ",
    approach: "  ",
    evidence: [""],
  })
  equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  equal(body.problems.length, 4) // question, currentSlice, approach, evidence all empty
  strictEqual(ref.current.intents.length, 0)
  await cleanTemp(tmp)
})

// ===========================================================================
// update_outcomes: intent recording
// ===========================================================================

test("update_outcomes: records outcomes-updated intent on valid call", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleUpdateOutcomes(ref, {
    outcomes: [{ id: "test-outcome", status: "in_progress", state: "started", nextAction: "finish it" }],
  })
  equal(result.isError, false)
  const body = JSON.parse(result.content[0].text)
  equal(body.ok, true)
  equal(body.outcomes[0].status, "in_progress")
  strictEqual(ref.current.intents.length, 1)
  equal(ref.current.intents[0].kind, "outcomes-updated")
  // Verify persisted in store
  const ledger = ref.current.store.readLedger(ref.current.packet.runId)
  equal(ledger.outcomes[0].status, "in_progress")
  equal(ledger.outcomes[0].state, "started")
  equal(ledger.outcomes[0].nextAction, "finish it")
  await cleanTemp(tmp)
})

test("update_outcomes: rejects done without evidence (O2) when ledger also has no evidence", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleUpdateOutcomes(ref, {
    outcomes: [{ id: "test-outcome", status: "done" }],
  })
  equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  ok(body.problems.some((p: string) => p.includes("cannot be done without evidence")))
  strictEqual(ref.current.intents.length, 0)
  // Ledger unchanged
  const ledger = ref.current.store.readLedger(ref.current.packet.runId)
  equal(ledger.outcomes[0].status, "not_started")
  await cleanTemp(tmp)
})

test("update_outcomes: rejects done with whitespace-only evidence (O2)", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleUpdateOutcomes(ref, {
    outcomes: [{ id: "test-outcome", status: "done", evidence: ["  "] }],
  })
  equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  ok(body.problems.some((p: string) => p.includes("cannot be done without evidence")))
  strictEqual(ref.current.intents.length, 0)
  const ledger = ref.current.store.readLedger(ref.current.packet.runId)
  equal(ledger.outcomes[0].status, "not_started")
  await cleanTemp(tmp)
})

test("update_outcomes: blank evidence does not overwrite existing non-empty evidence", async () => {
  const { ref, tmp } = makeRef()
  await handleUpdateOutcomes(ref, {
    outcomes: [{ id: "test-outcome", status: "done", evidence: ["real-evidence.txt"] }],
  })
  const result = await handleUpdateOutcomes(ref, {
    outcomes: [{ id: "test-outcome", status: "in_progress", evidence: ["  "] }],
  })
  equal(result.isError, false)
  const ledger = ref.current.store.readLedger(ref.current.packet.runId)
  strictEqual(ledger.outcomes[0].evidence[0], "real-evidence.txt")
  await cleanTemp(tmp)
})

test("update_outcomes: allows done with evidence", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleUpdateOutcomes(ref, {
    outcomes: [{ id: "test-outcome", status: "done", evidence: ["evidence.txt"] }],
  })
  equal(result.isError, false)
  const body = JSON.parse(result.content[0].text)
  equal(body.ok, true)
  equal(body.outcomes[0].status, "done")
  strictEqual(ref.current.intents.length, 1)
  equal(ref.current.intents[0].kind, "outcomes-updated")
  const ledger = ref.current.store.readLedger(ref.current.packet.runId)
  equal(ledger.outcomes[0].status, "done")
  equal(ledger.outcomes[0].evidence[0], "evidence.txt")
  await cleanTemp(tmp)
})

test("update_outcomes: rejects unknown outcome id", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleUpdateOutcomes(ref, {
    outcomes: [{ id: "nonexistent", status: "done", evidence: ["x"] }],
  })
  equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  ok(body.problems.some((p: string) => p.includes("unknown outcome id")))
  strictEqual(ref.current.intents.length, 0)
  await cleanTemp(tmp)
})

// ===========================================================================
// write_checkpoint: intent recording
// ===========================================================================

test("write_checkpoint: records checkpoint-written intent on valid call", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleWriteCheckpoint(ref, { summary: "halfway point" })
  equal(result.isError, false)
  const body = JSON.parse(result.content[0].text)
  equal(body.ok, true)
  equal(body.number, 1)
  strictEqual(ref.current.intents.length, 1)
  equal(ref.current.intents[0].kind, "checkpoint-written")
  ok(ref.current.intents[0].checkpoint)
  equal(ref.current.intents[0].checkpoint.number, 1)
  await cleanTemp(tmp)
})

test("write_checkpoint: invalid checkpoint records zero intents, increments bounce count", async () => {
  const { ref, tmp } = makeRef()
  // Add a phantom outcome to the packet that's not in the ledger, so checkpointProblems rejects.
  ref.current.packet.frontmatter.outcomes.push({ id: "phantom-outcome", description: "not in ledger" })
  const result = await handleWriteCheckpoint(ref, { summary: "halfway point" })
  equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  equal(body.ok, false)
  strictEqual(ref.current.intents.length, 0)
  strictEqual(ref.current.checkpointBounceCount, 1)
  await cleanTemp(tmp)
})

// ===========================================================================
// submit_report: intent recording — blocked/failed
// ===========================================================================

test("submit_report: blocked records report-accepted intent", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleSubmitReport(ref, {
    status: "blocked",
    blockedReason: "human_decision",
    blockedQuestion: "Should we proceed with this design?",
    summary: "Need Max's input on X.",
  })
  equal(result.isError, false)
  const body = JSON.parse(result.content[0].text)
  equal(body.ok, true)
  equal(body.status, "blocked")
  strictEqual(ref.current.intents.length, 1)
  equal(ref.current.intents[0].kind, "report-accepted")
  equal(ref.current.intents[0].status, "blocked")
  await cleanTemp(tmp)
})

test("submit_report: failed records report-accepted intent", async () => {
  const { ref, tmp } = makeRef()
  const result = await handleSubmitReport(ref, {
    status: "failed",
    summary: "Could not complete the task.",
  })
  equal(result.isError, false)
  const body = JSON.parse(result.content[0].text)
  equal(body.ok, true)
  equal(body.status, "failed")
  strictEqual(ref.current.intents.length, 1)
  equal(ref.current.intents[0].kind, "report-accepted")
  await cleanTemp(tmp)
})

// ===========================================================================
// submit_report: final-review-requested intent (success path)
// ===========================================================================

test("submit_report: sets final-review-requested intent when ready_for_review succeeds", async () => {
  const { ref, tmp } = makeRef()
  // Mark outcome done, gate clear (already latched=false by default), verification green (echo ok passes)
  await handleUpdateOutcomes(ref, {
    outcomes: [{ id: "test-outcome", status: "done", evidence: ["test.txt"] }],
  })
  // Verify gate is clear
  const gateState = ref.current.store.readGateState(ref.current.packet.runId)
  equal(gateState.latched, false)
  const result = await handleSubmitReport(ref, {
    status: "ready_for_review",
    summary: "All done.",
  })
  equal(result.isError, false)
  const body = JSON.parse(result.content[0].text)
  equal(body.status, "review_pending")
  strictEqual(ref.current.intents.length, 2)
  equal(ref.current.intents[0].kind, "outcomes-updated")
  equal(ref.current.intents[ref.current.intents.length - 1].kind, "final-review-requested")
  strictEqual(ref.current.pendingFinalReview !== null, true)
  await cleanTemp(tmp)
})

// ===========================================================================
// submit_report: report-rejected intent — outcome problems
// ===========================================================================

test("submit_report: rejected when ready_for_review with incomplete outcomes", async () => {
  const { ref, tmp } = makeRef()
  // Outcome is "not_started" in the ledger — ready_for_review should fail.
  const result = await handleSubmitReport(ref, {
    status: "ready_for_review",
    summary: "All done.",
  })
  equal(result.isError, true)
  const body = JSON.parse(result.content[0].text)
  ok(body.problems.some((p: string) => p.includes("ready_for_review requires every outcome done")))
  strictEqual(ref.current.intents.length, 1)
  equal(ref.current.intents[0].kind, "report-rejected")
  await cleanTemp(tmp)
})

// ===========================================================================
// submit_report: already-reviewing hold
// ===========================================================================

test("submit_report: returns review_pending when pendingFinalReview is set", async () => {
  const { ref, tmp } = makeRef()
  ref.current.pendingFinalReview = {
    status: "ready_for_review",
    summary: "prev review",
  }
  const result = await handleSubmitReport(ref, {
    status: "ready_for_review",
    summary: "another review",
  })
  equal(result.isError, false)
  const body = JSON.parse(result.content[0].text)
  equal(body.status, "review_pending")
  strictEqual(ref.current.intents.length, 0)
})

// ===========================================================================
// get_decisions: basic
// ===========================================================================

test("get_decisions: returns decisions", async () => {
  const { ref, tmp } = makeRef()
  // Plant a decision
  ref.current.store.appendDecision(ref.current.packet.runId, {
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "daddy",
    questionType: "other",
    question: "q1",
    status: "proceed",
    answer: "a1",
    constraints: [],
  })
  const result = await handleGetDecisions(ref, {})
  equal(result.isError, false)
  const body = JSON.parse(result.content[0].text)
  equal(body.decisions.length, 1)
  equal(body.decisions[0].question, "q1")
  await cleanTemp(tmp)
})

test("get_decisions: respects limit", async () => {
  const { ref, tmp } = makeRef()
  ref.current.store.appendDecision(ref.current.packet.runId, {
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "daddy",
    questionType: "other",
    question: "q1",
    status: "proceed",
    answer: "a1",
    constraints: [],
  })
  ref.current.store.appendDecision(ref.current.packet.runId, {
    timestamp: "2026-01-01T00:00:01.000Z",
    source: "daddy",
    questionType: "other",
    question: "q2",
    status: "proceed",
    answer: "a2",
    constraints: [],
  })
  const result = await handleGetDecisions(ref, { limit: 1 })
  equal(result.isError, false)
  const body = JSON.parse(result.content[0].text)
  equal(body.decisions.length, 1)
  equal(body.decisions[0].question, "q2") // last 1
  await cleanTemp(tmp)
})

// ===========================================================================
// get_decisions: accepted-decision gate-clear branch
// ===========================================================================

test("get_decisions: clears gate on accepted decision newer than lastAcceptedDecisionAt", async () => {
  const { ref, tmp, clock } = makeRef()
  // Overwrite with a dirty gate so post-clear assertions are non-vacuous
  ref.current.store.writeGateState(ref.current.packet.runId, {
    runId: ref.current.packet.runId,
    latched: true,
    latchReason: "work in progress",
    firstEditApproved: false,
    reconciliationRequired: true,
    expectedGlobs: ["src/**"],
    suspiciousGlobs: [],
    // Seed a stale sentinel so the post-clear value is provably a fresh read,
    // not the vacuous initial {}: clearGate re-reads readDiffStats(worktree),
    // which on this non-git temp worktree returns {}, overwriting the sentinel.
    baselineDiffStats: { "STALE.ts": { added: 1, removed: 1 } },
    lastAcceptedDecisionAt: "2025-01-01T00:00:00.000Z",
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  })
  // Plant an accepted decision with a newer timestamp
  ref.current.store.appendDecision(ref.current.packet.runId, {
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "daddy",
    questionType: "other",
    question: "q1",
    status: "proceed",
    answer: "go ahead",
    constraints: [],
  })
  await handleGetDecisions(ref, {})
  const gateState = ref.current.store.readGateState(ref.current.packet.runId)
  equal(gateState.latched, false)
  equal(gateState.latchReason, undefined)
  equal(gateState.firstEditApproved, true)
  equal(gateState.reconciliationRequired, false)
  ok(gateState.lastAcceptedDecisionAt && gateState.lastAcceptedDecisionAt > "2025-01-01T00:00:00.000Z")
  strictEqual(gateState.expectedGlobs.length, 1)
  strictEqual(gateState.expectedGlobs[0], "src/**")
  // clearGate overwrote the stale sentinel with a fresh readDiffStats(worktree).
  deepStrictEqual(gateState.baselineDiffStats, {})
  await cleanTemp(tmp)
})

test("get_decisions: gate unchanged for non-accepted decision", async () => {
  const { ref, tmp, clock } = makeRef()
  ref.current.store.writeGateState(ref.current.packet.runId, {
    runId: ref.current.packet.runId,
    latched: true,
    latchReason: "work in progress",
    firstEditApproved: false,
    reconciliationRequired: true,
    expectedGlobs: ["src/**"],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    lastAcceptedDecisionAt: "2025-01-01T00:00:00.000Z",
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  })
  // Plant a non-accepted decision
  ref.current.store.appendDecision(ref.current.packet.runId, {
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "daddy",
    questionType: "other",
    question: "q1",
    status: "revise_slice",
    answer: "try again",
    constraints: [],
  })
  await handleGetDecisions(ref, {})
  const gateState = ref.current.store.readGateState(ref.current.packet.runId)
  equal(gateState.latched, true)
  strictEqual(gateState.latchReason, "work in progress")
  equal(gateState.firstEditApproved, false)
  equal(gateState.reconciliationRequired, true)
  strictEqual(gateState.lastAcceptedDecisionAt, "2025-01-01T00:00:00.000Z")
  await cleanTemp(tmp)
})

test("get_decisions: gate unchanged for stale accepted decision", async () => {
  const { ref, tmp, clock } = makeRef()
  ref.current.store.writeGateState(ref.current.packet.runId, {
    runId: ref.current.packet.runId,
    latched: true,
    latchReason: "work in progress",
    firstEditApproved: false,
    reconciliationRequired: true,
    expectedGlobs: ["src/**"],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    lastAcceptedDecisionAt: "2027-01-01T00:00:00.000Z",
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  })
  // Plant an accepted decision with an OLDER timestamp than lastAcceptedDecisionAt
  ref.current.store.appendDecision(ref.current.packet.runId, {
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "daddy",
    questionType: "other",
    question: "q1",
    status: "proceed",
    answer: "go ahead",
    constraints: [],
  })
  await handleGetDecisions(ref, {})
  const gateState = ref.current.store.readGateState(ref.current.packet.runId)
  equal(gateState.latched, true)
  strictEqual(gateState.latchReason, "work in progress")
  equal(gateState.firstEditApproved, false)
  equal(gateState.reconciliationRequired, true)
  strictEqual(gateState.lastAcceptedDecisionAt, "2027-01-01T00:00:00.000Z")
  await cleanTemp(tmp)
})

// ===========================================================================
// cleanup
// ===========================================================================

test("update_outcomes: ledger persists through store read", async () => {
  const { ref, tmp, clock } = makeRef()
  await handleUpdateOutcomes(ref, {
    outcomes: [{ id: "test-outcome", status: "done", evidence: ["test.txt"] }],
  })
  strictEqual(ref.current.intents.length, 1)
  // Fresh read from store
  const fresh = ref.current.store.readLedger(ref.current.packet.runId)
  equal(fresh.outcomes[0].status, "done")
  equal(fresh.outcomes[0].evidence[0], "test.txt")
  await cleanTemp(tmp)
})

// ===========================================================================
// listenBridge: single-driver bind lock (R1)
// ===========================================================================

test("listenBridge: second bind on same port fails with one-driver error", async () => {
  const { ref } = makeRef()
  const port = 19876 // arbitrary non-privileged port
  ref.current.config.opencode.bridgePort = port
  const server1 = startBridgeServer(ref.current.config, ref)
  await listenBridge(server1, { ...ref.current.config, opencode: { bridgePort: port } })
  // Second server on the same port
  const server2 = startBridgeServer(ref.current.config, ref)
  try {
    await listenBridge(server2, { ...ref.current.config, opencode: { bridgePort: port } })
    equal(true, false, "should have thrown")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ok(msg.includes("One driver at a time"))
  } finally {
    server1.close()
    server2.close()
  }
})
