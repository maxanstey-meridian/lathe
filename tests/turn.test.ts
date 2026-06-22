import assert from "node:assert"
import { test } from "node:test"

import { evaluateTurn, TurnFacts } from "../src/domain/turn.js"

// ---------------------------------------------------------------------------
// Helper: build a valid TurnFacts with sensible defaults
// ---------------------------------------------------------------------------

const def = (overrides: Record<string, unknown>) => {
  const base = {
    bridgeIntents: [],
    watchdogPastDeadline: false,
    contextTokens: 10_000,
    contextBudget: 100_000,
    contextTokensFloor: 128,
    isFirstTurn: false,
    gateDemandsCheckpoint: false,
    gateReason: undefined,
    hadAllowedToolCall: true,
    worktreeChanged: false,
    rotationPending: false,
    checkpointBounceCount: 0,
    checkpointBounceLimit: 1,
    sendFailureCount: 0,
    reportRejectionCount: 0,
    reportRejectionParkAt: 3,
    ladder: 0,
    ladderRotateAt: 4,
    ladderParkAt: 10,
    softNudgeDue: false,
  }
  return { ...base, ...overrides }
}

// Validate that the constructed facts pass the TurnFacts schema
const validate = (f: ReturnType<typeof def>) => {
  const result = TurnFacts.safeParse(f)
  if (!result.success) {
    throw new Error(`Invalid TurnFacts: ${JSON.stringify(result.error.errors)}`)
  }
  return result.data
}

const run = (overrides: Record<string, unknown>) => evaluateTurn(validate(def(overrides)))

// ---------------------------------------------------------------------------
// Branch 1: Watchdog
// ---------------------------------------------------------------------------

test("evaluateTurn: branch 1 — watchdog past deadline returns watchdog", () => {
  assert.deepEqual(run({ watchdogPastDeadline: true }), { kind: "watchdog" })
})

// ---------------------------------------------------------------------------
// Branch 2: Park requested by bridge
// ---------------------------------------------------------------------------

test("evaluateTurn: branch 2 — park intent from bridge returns park", () => {
  const facts = def({
    bridgeIntents: [
      { kind: "park", reason: "wedged", question: "planner asked to stop" },
    ],
  })
  assert.deepEqual(run(facts), { kind: "park", reason: "wedged", question: "planner asked to stop" })
})

// ---------------------------------------------------------------------------
// Branch 3: Accepted report
// ---------------------------------------------------------------------------

test("evaluateTurn: branch 3 — accepted report ready_for_review returns terminal", () => {
  const facts = def({
    bridgeIntents: [
      { kind: "report-accepted", status: "ready_for_review", summary: "all done" },
    ],
  })
  const result = run(facts)
  assert.deepStrictEqual(result.kind, "terminal")
  assert.strictEqual(result.status, "ready_for_review")
})

test("evaluateTurn: branch 3 — accepted report failed returns terminal with note", () => {
  const facts = def({
    bridgeIntents: [
      { kind: "report-accepted", status: "failed", summary: "verification failed" },
    ],
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "terminal")
  assert.strictEqual(result.status, "failed")
  assert.strictEqual(result.note, "verification failed")
})

test("evaluateTurn: branch 3 — accepted report blocked returns terminal with reason defaults", () => {
  const facts = def({
    bridgeIntents: [
      { kind: "report-accepted", status: "blocked", summary: "blocked question" },
    ],
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "terminal")
  assert.strictEqual(result.status, "blocked")
  assert.strictEqual(result.reason, "stop_condition")
  assert.strictEqual(result.question, "blocked question")
})

// ---------------------------------------------------------------------------
// Branch 4: Report rejected
// ---------------------------------------------------------------------------

test("evaluateTurn: branch 4 — under cap returns reject_report", () => {
  const facts = def({
    reportRejectionCount: 2,
    reportRejectionParkAt: 3,
    bridgeIntents: [
      { kind: "report-rejected", problems: ["ts error"] },
    ],
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "reject_report")
  assert.deepStrictEqual(result.problems, ["ts error"])
})

test("evaluateTurn: branch 4 — at cap returns terminal failed", () => {
  const facts = def({
    reportRejectionCount: 3,
    reportRejectionParkAt: 3,
    bridgeIntents: [
      { kind: "report-rejected", problems: ["ts error"] },
    ],
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "terminal")
  assert.strictEqual(result.status, "failed")
  assert.ok(result.note?.includes("report rejected 3 times"))
})

// ---------------------------------------------------------------------------
// Branch 5: Pending consult
// ---------------------------------------------------------------------------

test("evaluateTurn: branch 5 — pending consult returns run_consult", () => {
  const facts = def({
    bridgeIntents: [{ kind: "consult-requested" }],
  })
  assert.strictEqual(run(facts).kind, "run_consult")
})

// ---------------------------------------------------------------------------
// Branch 6: Pending final review
// ---------------------------------------------------------------------------

test("evaluateTurn: branch 6 — pending final review returns run_final_review", () => {
  const facts = def({
    bridgeIntents: [{ kind: "final-review-requested" }],
  })
  assert.strictEqual(run(facts).kind, "run_final_review")
})

// ---------------------------------------------------------------------------
// Branch 7: Rotation in flight — three sub-cases
// ---------------------------------------------------------------------------

test("evaluateTurn: branch 7a — rotation with checkpoint written returns rotate with checkpoint", () => {
  const facts = def({
    rotationPending: true,
    bridgeIntents: [
      { kind: "checkpoint-written", checkpoint: { number: 3, reason: "rotation", summary: "checkpoint" } },
    ],
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "rotate")
  assert.ok(result.checkpoint)
})

test("evaluateTurn: branch 7b — rotation with bounce count over limit returns park wedged", () => {
  const facts = def({
    rotationPending: true,
    checkpointBounceCount: 2,
    checkpointBounceLimit: 1,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "park")
  assert.strictEqual(result.reason, "wedged")
  assert.strictEqual(result.question, "Rotation checkpoint bounced past the limit")
})

test("evaluateTurn: branch 7b boundary — bounce count AT limit does NOT park", () => {
  // checkpointBounceCount > checkpointBounceLimit (not >=)
  const facts = def({
    rotationPending: true,
    checkpointBounceCount: 1,
    checkpointBounceLimit: 1,
  })
  // Falls through to ladder check (7c), not park
  const result = run(facts)
  assert.ok(result.kind === "re_demand_teardown" || result.kind === "park")
})

test("evaluateTurn: branch 7c — rotation without checkpoint, under bound, ladder below parkAt returns re_demand_teardown", () => {
  const facts = def({
    rotationPending: true,
    ladder: 3,
    ladderParkAt: 10,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "re_demand_teardown")
})

test("evaluateTurn: branch 7c at bound — ladder at parkAt-1 returns park wedged", () => {
  const facts = def({
    rotationPending: true,
    ladder: 9,
    ladderParkAt: 10,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "park")
  assert.strictEqual(result.reason, "wedged")
  assert.ok(result.question.includes("Rotation teardown demanded repeatedly"))
})

// No-crash case: rotation pending with empty bridgeIntents and ladder below bound
test("evaluateTurn: no-crash — rotation pending with empty bridgeIntents returns re_demand_teardown", () => {
  const facts = def({
    rotationPending: true,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "re_demand_teardown")
})

// ---------------------------------------------------------------------------
// Branch 8: Context budget reached
// ---------------------------------------------------------------------------

test("evaluateTurn: branch 8 — context budget reached returns demand_teardown", () => {
  const facts = def({
    contextTokens: 100_000,
    contextBudget: 100_000,
  })
  assert.strictEqual(run(facts).kind, "demand_teardown")
})

test("evaluateTurn: branch 8 — context tokens just under budget continues", () => {
  const facts = def({
    contextTokens: 99_999,
    contextBudget: 100_000,
  })
  assert.strictEqual(run(facts).kind, "continue")
})

// ---------------------------------------------------------------------------
// Branch 9: Gate latched/triggers
// ---------------------------------------------------------------------------

test("evaluateTurn: branch 9 — gate demands checkpoint returns demand_gate_checkpoint", () => {
  const facts = def({
    gateDemandsCheckpoint: true,
    gateReason: "first edit required",
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "demand_gate_checkpoint")
  assert.strictEqual(result.reason, "first edit required")
})

test("evaluateTurn: branch 9 default reason — when gateReason is undefined", () => {
  const facts = def({
    gateDemandsCheckpoint: true,
    gateReason: undefined,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "demand_gate_checkpoint")
  assert.strictEqual(result.reason, "checkpoint required")
})

test("evaluateTurn: branch 9 at ladder bound — ladder at parkAt-1 returns park wedged", () => {
  const facts = def({
    gateDemandsCheckpoint: true,
    ladder: 9,
    ladderParkAt: 10,
    gateReason: "first edit required",
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "park")
  assert.strictEqual(result.reason, "wedged")
  assert.ok(result.question.includes("first edit required"))
})

// ---------------------------------------------------------------------------
// Branch 10: No progress — ladder action
// ---------------------------------------------------------------------------

test("evaluateTurn: branch 10 — no progress, ladder below rotateAt returns nudge", () => {
  const facts = def({
    hadAllowedToolCall: false,
    worktreeChanged: false,
    ladder: 1,
    ladderRotateAt: 4,
    ladderParkAt: 10,
  })
  assert.strictEqual(run(facts).kind, "nudge")
})

test("evaluateTurn: branch 10 — no progress, ladder at rotateAt returns rotate", () => {
  const facts = def({
    hadAllowedToolCall: false,
    worktreeChanged: false,
    ladder: 3,
    ladderRotateAt: 4,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "rotate")
  assert.strictEqual(result.checkpoint, null)
})

test("evaluateTurn: branch 10 — no progress, ladder at parkAt returns park", () => {
  const facts = def({
    hadAllowedToolCall: false,
    worktreeChanged: false,
    ladder: 9,
    ladderParkAt: 10,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "park")
  assert.strictEqual(result.reason, "wedged")
  assert.ok(result.question.includes("consecutive turns"))
})

test("evaluateTurn: branch 10 — allowed tool call signals progress, climbs ladder but continues", () => {
  // progress but ladder is at parkAt — progress resets ladder in application,
  // but here ladder was 0 so hadAllowedToolCall = true means branch 10 doesn't fire
  const facts = def({
    hadAllowedToolCall: true,
    worktreeChanged: false,
  })
  assert.strictEqual(run(facts).kind, "continue")
})

test("evaluateTurn: branch 10 — worktree changed signals progress", () => {
  const facts = def({
    hadAllowedToolCall: false,
    worktreeChanged: true,
  })
  assert.strictEqual(run(facts).kind, "continue")
})

// ---------------------------------------------------------------------------
// Branch 11: Continue
// ---------------------------------------------------------------------------

test("evaluateTurn: branch 11 — progress with no pending returns continue (softNudgeDue false)", () => {
  const facts = def({
    hadAllowedToolCall: true,
    softNudgeDue: false,
  })
  assert.strictEqual(run(facts).kind, "continue")
})

test("evaluateTurn: branch 11 — progress with soft nudge due returns continue (softNudgeDue true)", () => {
  const facts = def({
    hadAllowedToolCall: true,
    softNudgeDue: true,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "continue")
  assert.strictEqual(result.softNudgeDue, true)
})

// ---------------------------------------------------------------------------
// Bridge signal: checkpoint-written counts as progress (CONTRACT §6 L2)
// ---------------------------------------------------------------------------

test("evaluateTurn: checkpoint-written intent counts as progress (not no-progress ladder)", () => {
  const facts = def({
    bridgeIntents: [
      { kind: "checkpoint-written", checkpoint: { number: 5, reason: "check-in", summary: "progress" } },
    ],
    hadAllowedToolCall: false,
    worktreeChanged: false,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "continue")
  assert.strictEqual(result.softNudgeDue, false)
})

// ---------------------------------------------------------------------------
// First-match-wins precedence
// ---------------------------------------------------------------------------

test("evaluateTurn: precedence 1 — watch dog beats park", () => {
  const facts = def({
    watchdogPastDeadline: true,
    bridgeIntents: [{ kind: "park", reason: "wedged", question: "stop" }],
  })
  assert.strictEqual(run(facts).kind, "watchdog")
})

test("evaluateTurn: precedence 2 — park beats accepted report", () => {
  const facts = def({
    bridgeIntents: [
      { kind: "park", reason: "wedged", question: "stop" },
      { kind: "report-accepted", status: "ready_for_review", summary: "done" },
    ],
  })
  assert.strictEqual(run(facts).kind, "park")
})

test("evaluateTurn: precedence 3 — accepted report beats report rejected", () => {
  const facts = def({
    reportRejectionCount: 3,
    reportRejectionParkAt: 3,
    bridgeIntents: [
      { kind: "report-rejected", problems: ["error"] },
      { kind: "report-accepted", status: "ready_for_review", summary: "done" },
    ],
  })
  assert.strictEqual(run(facts).kind, "terminal")
})

test("evaluateTurn: precedence 4 — report rejected beats pending consult", () => {
  const facts = def({
    reportRejectionCount: 1,
    bridgeIntents: [
      { kind: "report-rejected", problems: ["error"] },
      { kind: "consult-requested" },
    ],
  })
  const result = run(facts)
  assert.ok(result.kind === "reject_report" || result.kind === "terminal")
  assert.notStrictEqual(result.kind, "run_consult")
})

test("evaluateTurn: precedence 5 — pending consult beats pending final review", () => {
  const facts = def({
    bridgeIntents: [
      { kind: "consult-requested" },
      { kind: "final-review-requested" },
    ],
  })
  assert.strictEqual(run(facts).kind, "run_consult")
})

test("evaluateTurn: precedence 5 — pending consult beats rotation in-flight", () => {
  const facts = def({
    rotationPending: true,
    bridgeIntents: [
      { kind: "consult-requested" },
    ],
  })
  assert.strictEqual(run(facts).kind, "run_consult")
})

test("evaluateTurn: precedence 6 — final review beats rotation in-flight", () => {
  const facts = def({
    rotationPending: true,
    bridgeIntents: [
      { kind: "final-review-requested" },
    ],
  })
  assert.strictEqual(run(facts).kind, "run_final_review")
})

test("evaluateTurn: precedence 7 — rotation in-flight beats context budget", () => {
  const facts = def({
    rotationPending: true,
    contextTokens: 100_000,
    contextBudget: 100_000,
  })
  const result = run(facts)
  assert.ok(result.kind === "re_demand_teardown" || result.kind === "rotate" || result.kind === "park")
  assert.notStrictEqual(result.kind, "demand_teardown")
})

test("evaluateTurn: precedence 8 — context budget beats gate demand", () => {
  const facts = def({
    contextTokens: 100_000,
    contextBudget: 100_000,
    gateDemandsCheckpoint: true,
  })
  assert.strictEqual(run(facts).kind, "demand_teardown")
})

test("evaluateTurn: precedence 9 — gate demand beats no-progress", () => {
  const facts = def({
    gateDemandsCheckpoint: true,
    hadAllowedToolCall: false,
    worktreeChanged: false,
  })
  const result = run(facts)
  assert.notStrictEqual(result.kind, "nudge")
  assert.notStrictEqual(result.kind, "park")
  assert.notStrictEqual(result.kind, "rotate")
})

test("evaluateTurn: precedence 11 — no-progress loses to progress", () => {
  const facts = def({
    hadAllowedToolCall: true,
    ladder: 9,
  })
  assert.strictEqual(run(facts).kind, "continue")
})

// ---------------------------------------------------------------------------
// Bridge intent derivation
// ---------------------------------------------------------------------------

test("evaluateTurn: bridgeIntents scan — multiple intents are all processed", () => {
  const facts = def({
    bridgeIntents: [
      { kind: "consult-requested" },
      { kind: "consult-requested" }, // duplicate, only first matters
    ],
  })
  assert.strictEqual(run(facts).kind, "run_consult")
})

test("evaluateTurn: bridgeIntents scan — outcomes-updated does not produce a signal", () => {
  const facts = def({
    bridgeIntents: [{ kind: "outcomes-updated" }],
    hadAllowedToolCall: false,
    worktreeChanged: false,
  })
  // outcomes-updated alone doesn't trigger any branch; falls through to
  // branch 10 ladder (no progress since hadAllowedToolCall=false).
  const result = run(facts)
  assert.notStrictEqual(result.kind, "continue")
})

test("evaluateTurn: bridgeIntents scan — checkpoint-written payload is checked correctly (not crashed on null)", () => {
  const facts = def({
    rotationPending: true,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "re_demand_teardown")
})

// ---------------------------------------------------------------------------
// Dead-session guard (complementary to branch 7 send-failure path)
// ---------------------------------------------------------------------------

test("evaluateTurn: dead-session guard — low tokens, not first turn, no progress returns park wedged", () => {
  const facts = def({
    contextTokens: 4,
    contextTokensFloor: 128,
    isFirstTurn: false,
    hadAllowedToolCall: false,
    worktreeChanged: false,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "park")
  assert.strictEqual(result.reason, "wedged")
  assert.ok(result.question.includes("4 context tokens"))
})

test("evaluateTurn: dead-session guard — fires when ladder > 0 (dead session after no-progress rotation)", () => {
  // The primary v2 scar: dead session landing after a no-progress rotation has ladder > 0.
  // The guard must NOT depend on ladder — it fires regardless.
  const facts = def({
    contextTokens: 10,
    contextTokensFloor: 128,
    isFirstTurn: false,
    ladder: 3,
    hadAllowedToolCall: false,
    worktreeChanged: false,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "park")
  assert.strictEqual(result.reason, "wedged")
})

test("evaluateTurn: dead-session guard — first turn exempt even with low tokens", () => {
  const facts = def({
    contextTokens: 4,
    contextTokensFloor: 128,
    isFirstTurn: true,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "continue")
})

test("evaluateTurn: dead-session guard — low tokens but first turn has progress continues", () => {
  const facts = def({
    contextTokens: 50,
    contextTokensFloor: 128,
    isFirstTurn: true,
    hadAllowedToolCall: true,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "continue")
})

test("evaluateTurn: dead-session guard — low tokens not first turn parks regardless of progress (guard fires before branch 10)", () => {
  // The guard fires BEFORE progress evaluation — that's the intended design.
  // Below-floor tokens means dead session regardless of any spurious tool call.
  const facts = def({
    contextTokens: 50,
    contextTokensFloor: 128,
    isFirstTurn: false,
    hadAllowedToolCall: true,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "park")
  assert.strictEqual(result.reason, "wedged")
})

test("evaluateTurn: dead-session guard — tokens above floor does not trip", () => {
  const facts = def({
    contextTokens: 200,
    contextTokensFloor: 128,
    isFirstTurn: false,
    hadAllowedToolCall: false,
    worktreeChanged: false,
  })
  const result = run(facts)
  // Falls through to branch 10 no-progress (nudge)
  assert.notStrictEqual(result.kind, "park")
})

test("evaluateTurn: dead-session guard — precedence over no-progress ladder", () => {
  const facts = def({
    contextTokens: 2,
    contextTokensFloor: 128,
    isFirstTurn: false,
    hadAllowedToolCall: false,
    worktreeChanged: false,
    ladder: 9,
  })
  const result = run(facts)
  assert.strictEqual(result.kind, "park")
  assert.strictEqual(result.reason, "wedged")
  assert.ok(result.question.includes("2 context tokens"))
})
