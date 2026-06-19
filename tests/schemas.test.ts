import assert from "node:assert"
import { test } from "node:test"

import {
  PacketFrontmatter,
  OutcomeDef,
  VerificationCommand,
  RunMeta,
  OutcomeEntry,
  OutcomeLedger,
  OutcomeStatus,
  RunStatus,
  BlockedReason,
  PlannerResponse,
  QuestionType,
  PlannerStatus,
  Finding,
  SuperReview,
  JournalEvent,
  SubmitReport,
  FileClassification,
  ReportFile,
} from "../src/domain/index.ts"

// ---- Packet ----

test("packet: PacketFrontmatter parses valid object", () => {
  const valid = {
    repo: "/tmp/my-repo",
    base: "main",
    outcomes: [{ id: "my-feature", description: "Adds the feature" }],
    expected_surface: ["src/**"],
    verification: [{ command: "pnpm test" }],
  }
  const result = PacketFrontmatter.parse(valid)
  assert.strictEqual(result.repo, "/tmp/my-repo")
  assert.strictEqual(result.base, "main")
  assert.deepStrictEqual(result.suspicious_surface, [])
  assert.deepStrictEqual(result.constraints, [])
  assert.strictEqual(result.pass, 1)
  assert.deepStrictEqual(result.regression_outcomes, [])
})

test("packet: PacketFrontmatter rejects missing required fields", () => {
  const invalid = {
    repo: "/tmp/my-repo",
    base: "main",
    verification: [{ command: "pnpm test" }],
  }
  assert.throws(() => PacketFrontmatter.parse(invalid))
})

test("packet: OutcomeDef rejects non-kebab id", () => {
  assert.throws(() => OutcomeDef.parse({ id: "UPPERCASE", description: "bad" }))
})

test("packet: VerificationCommand rejects empty command", () => {
  assert.throws(() => VerificationCommand.parse({ command: "" }))
})

// ---- Run state ----

test("run-state: RunMeta round-trips valid data", () => {
  const valid = {
    runId: "20260618-020000-test",
    status: "running",
    attempt: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: "meridian/test",
    worktree: "/tmp/wh/worktree",
    updatedAt: "2026-01-01T00:00:00Z",
  }
  const result = RunMeta.parse(valid)
  assert.strictEqual(result.runId, "20260618-020000-test")
  assert.strictEqual(result.stallRetries, 0)
  assert.strictEqual(result.reorientRetries, 0)
})

test("run-state: OutcomeLedger rejects missing updatedAt", () => {
  const invalid = {
    runId: "test",
    outcomes: [],
  }
  assert.throws(() => OutcomeLedger.parse(invalid))
})

test("run-state: OutcomeEntry uses defaults", () => {
  const entry = OutcomeEntry.parse({
    id: "feat-1",
    description: "A feature",
    status: OutcomeStatus.parse("done"),
    updatedAt: "2026-01-01T00:00:00Z",
  })
  assert.deepStrictEqual(entry.evidence, [])
  assert.strictEqual(entry.state, undefined)
  assert.strictEqual(entry.nextAction, undefined)
})

test("run-state: RunStatus accepts all variant", () => {
  for (const s of ["queued", "running", "interrupted", "ready_for_review", "blocked", "failed", "accepted"]) {
    assert.strictEqual(RunStatus.parse(s), s)
  }
})

test("run-state: BlockedReason accepts all variant", () => {
  for (const r of ["human_decision", "scope_expansion", "stop_condition", "wedged", "crashed"]) {
    assert.strictEqual(BlockedReason.parse(r), r)
  }
})

// ---- Review convergence ----

test("review-convergence: PlannerResponse round-trips", () => {
  const valid = {
    status: PlannerStatus.parse("proceed"),
    answer: "Go ahead.",
    safe_next_action: "Write the schema",
  }
  const result = PlannerResponse.parse(valid)
  assert.strictEqual(result.status, "proceed")
  assert.deepStrictEqual(result.constraints, [])
  assert.deepStrictEqual(result.evidence_used, [])
  assert.strictEqual(result.human_decision_needed, null)
})

test("review-convergence: Finding rejects invalid kebab id", () => {
  const validObject = {
    id: "CamelCase_Id",
    severity: "P0",
    title: "bad id",
    grounding: { kind: "clause", ref: "" },
  }
  assert.throws(() => Finding.parse(validObject), /kebab-case/)
})

test("review-convergence: SuperReview uses defaults", () => {
  const valid = {
    verdict: "accept",
    convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 } },
  }
  const result = SuperReview.parse(valid)
  assert.deepStrictEqual(result.findings, [])
  assert.strictEqual(result.commit_message, null)
  assert.strictEqual(result.notes, "")
})

test("review-convergence: QuestionType accepts all variants", () => {
  for (const q of ["repo_procedure", "architecture_discoverable", "handoff_interpretation", "stop_condition", "diff_audit", "reconciliation", "other"]) {
    assert.strictEqual(QuestionType.parse(q), q)
  }
})

// ---- Journal ----

test("journal: JournalEvent parses run_started", () => {
  const valid = {
    event: "run_started",
    runId: "20260618-020000-test",
    attempt: 1,
    at: "2026-01-01T00:00:00Z",
  }
  const result = JournalEvent.parse(valid)
  assert.strictEqual(result.event, "run_started")
  assert.strictEqual(result.runId, "20260618-020000-test")
})

test("journal: JournalEvent rejects invalid event type", () => {
  const invalid = {
    event: "unknown_event",
    at: "2026-01-01T00:00:00Z",
  }
  assert.throws(() => JournalEvent.parse(invalid))
})

test("journal: JournalEvent parses tool_call with defaults", () => {
  const valid = {
    event: "tool_call",
    tool: "bash",
    status: "completed",
    at: "2026-01-01T00:00:00Z",
  }
  const result = JournalEvent.parse(valid)
  assert.strictEqual(result.gateDenied, false)
})

test("journal: JournalEvent parses parked with BlockedReason", () => {
  const valid = {
    event: "parked",
    reason: "human_decision",
    question: "Should we merge?",
    at: "2026-01-01T00:00:00Z",
  }
  const result = JournalEvent.parse(valid)
  assert.strictEqual(result.reason, "human_decision")
})

test("journal: JournalEvent parses outcomes_updated with OutcomeStatus", () => {
  const valid = {
    event: "outcomes_updated",
    outcomes: [{ id: "feat-1", status: "done" }],
    at: "2026-01-01T00:00:00Z",
  }
  const result = JournalEvent.parse(valid)
  assert.strictEqual(result.outcomes[0].status, "done")
})

test("journal: JournalEvent parses final_review with FinalReviewVerdict", () => {
  const valid = {
    event: "final_review",
    verdict: "accept",
    findings: [],
    at: "2026-01-01T00:00:00Z",
  }
  const result = JournalEvent.parse(valid)
  assert.strictEqual(result.verdict, "accept")
})

// ---- Report ----

test("report: SubmitReport round-trips", () => {
  const valid = {
    status: "ready_for_review",
    summary: "Completed the task",
    outcomeClaims: [{ id: "feat-1", status: OutcomeStatus.parse("done") }],
  }
  const result = SubmitReport.parse(valid)
  assert.strictEqual(result.status, "ready_for_review")
  assert.deepStrictEqual(result.filesChanged, [])
  assert.deepStrictEqual(result.verificationClaims, [])
})

test("report: SubmitReport rejects missing summary", () => {
  const invalid = {
    status: "ready_for_review",
    outcomeClaims: [{ id: "feat-1", status: OutcomeStatus.parse("done") }],
  }
  assert.throws(() => SubmitReport.parse(invalid))
})

test("report: SubmitReport accepts blocked with BlockedReason", () => {
  const valid = {
    status: "blocked",
    summary: "Blocked by X",
    blockedReason: BlockedReason.parse("human_decision"),
    outcomeClaims: [{ id: "feat-1", status: OutcomeStatus.parse("blocked") }],
  }
  const result = SubmitReport.parse(valid)
  assert.strictEqual(result.blockedReason, "human_decision")
})

test("report: FileClassification accepts all variants", () => {
  for (const c of ["expected", "acceptable-but-not-predeclared", "suspicious", "forbidden"]) {
    assert.strictEqual(FileClassification.parse(c), c)
  }
})

test("report: ReportFile action accepts all variants", () => {
  const rf = ReportFile.parse({
    path: "src/foo.ts",
    classification: FileClassification.parse("expected"),
    reason: "intended",
    action: "kept",
  })
  assert.strictEqual(rf.action, "kept")
})
