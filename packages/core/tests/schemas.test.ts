import assert from "node:assert";
import { test } from "node:test";
import { PacketFrontmatter, OutcomeDef, VerificationCommand } from "../src/domain/packet.ts";
import { RunMeta, RunStatus, BlockedReason } from "../src/domain/run.ts";
import { OutcomeEntry, OutcomeLedger, OutcomeStatus } from "../src/domain/outcomes.ts";
import { PlannerResponse, QuestionType, PlannerStatus } from "../src/domain/review.ts";
import { Finding, SuperReview } from "../src/domain/convergence.ts";
import { JournalEvent } from "../src/domain/journal.ts";
import { SubmitReport, FileClassification, ReportFile } from "../src/domain/report.ts";
import { AcceptanceOperation, RunStartupOperation } from "../src/domain/operations.ts";

// ---- Packet ----

test("packet: PacketFrontmatter parses valid object", () => {
  const valid = {
    repo: "/tmp/my-repo",
    base: "main",
    compare_commit: "main",
    outcomes: [{ id: "my-feature", description: "Adds the feature" }],
    expected_surface: ["src/**"],
    verification: [{ command: "pnpm test" }],
  };
  const result = PacketFrontmatter.parse(valid);
  assert.strictEqual(result.repo, "/tmp/my-repo");
  assert.strictEqual(result.base, "main");
  assert.deepStrictEqual(result.suspicious_surface, []);
  assert.deepStrictEqual(result.constraints, []);
  assert.strictEqual(result.pass, 1);
  assert.deepStrictEqual(result.regression_outcomes, []);
});

test("packet: PacketFrontmatter rejects missing required fields", () => {
  const invalid = {
    repo: "/tmp/my-repo",
    base: "main",
    verification: [{ command: "pnpm test" }],
  };
  assert.throws(() => PacketFrontmatter.parse(invalid));
});

test("packet: OutcomeDef rejects non-kebab id", () => {
  assert.throws(() => OutcomeDef.parse({ id: "UPPERCASE", description: "bad" }));
});

test("packet: VerificationCommand rejects empty command", () => {
  assert.throws(() => VerificationCommand.parse({ command: "" }));
});

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
  };
  const result = RunMeta.parse(valid);
  assert.strictEqual(result.runId, "20260618-020000-test");
  assert.strictEqual(result.stallRetries, 0);
  assert.strictEqual(result.reorientRetries, 0);
});

test("run-state: OutcomeLedger rejects missing updatedAt", () => {
  const invalid = {
    runId: "test",
    outcomes: [],
  };
  assert.throws(() => OutcomeLedger.parse(invalid));
});

test("run-state: OutcomeEntry uses defaults", () => {
  const entry = OutcomeEntry.parse({
    id: "feat-1",
    description: "A feature",
    status: OutcomeStatus.parse("done"),
    updatedAt: "2026-01-01T00:00:00Z",
  });
  assert.deepStrictEqual(entry.evidence, []);
  assert.strictEqual(entry.state, undefined);
  assert.strictEqual(entry.nextAction, undefined);
});

test("run-state: RunStatus accepts all variant", () => {
  for (const s of ["queued", "running", "ready_for_review", "blocked", "failed", "accepted"]) {
    assert.strictEqual(RunStatus.parse(s), s);
  }
});

test("run-state: BlockedReason accepts all variant", () => {
  for (const r of ["human_decision", "scope_expansion", "stop_condition", "wedged", "crashed"]) {
    assert.strictEqual(BlockedReason.parse(r), r);
  }
});

// ---- Review convergence ----

test("review-convergence: PlannerResponse round-trips", () => {
  const valid = {
    status: PlannerStatus.parse("proceed"),
    answer: "Go ahead.",
    safe_next_action: "Write the schema",
  };
  const result = PlannerResponse.parse(valid);
  assert.strictEqual(result.status, "proceed");
  assert.deepStrictEqual(result.constraints, []);
  assert.deepStrictEqual(result.evidence_used, []);
  assert.strictEqual(result.human_decision_needed, null);
});

test("review-convergence: PlannerStatus accepts promote_run", () => {
  assert.strictEqual(PlannerStatus.parse("promote_run"), "promote_run");
});

test("review-convergence: Finding rejects invalid kebab id", () => {
  const validObject = {
    id: "CamelCase_Id",
    severity: "P0",
    title: "bad id",
    grounding: { kind: "clause", ref: "" },
  };
  assert.throws(() => Finding.parse(validObject), /kebab-case/);
});

test("review-convergence: SuperReview uses defaults", () => {
  const valid = {
    verdict: "accept",
    convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 } },
  };
  const result = SuperReview.parse(valid);
  assert.deepStrictEqual(result.findings, []);
  assert.strictEqual(result.commit_message, null);
  assert.strictEqual(result.notes, "");
});

test("review-convergence: QuestionType accepts all variants", () => {
  for (const q of [
    "repo_procedure",
    "architecture_discoverable",
    "handoff_interpretation",
    "stop_condition",
    "diff_audit",
    "reconciliation",
    "other",
  ]) {
    assert.strictEqual(QuestionType.parse(q), q);
  }
});

// ---- Journal ----

test("journal: JournalEvent parses run_started", () => {
  const valid = {
    event: "run_started",
    runId: "20260618-020000-test",
    attempt: 1,
    at: "2026-01-01T00:00:00Z",
  };
  const result = JournalEvent.parse(valid);
  assert.strictEqual(result.event, "run_started");
  assert.strictEqual(result.runId, "20260618-020000-test");
});

test("journal: JournalEvent rejects invalid event type", () => {
  const invalid = {
    event: "unknown_event",
    at: "2026-01-01T00:00:00Z",
  };
  assert.throws(() => JournalEvent.parse(invalid));
});

test("journal: JournalEvent parses tool_call with defaults", () => {
  const valid = {
    event: "tool_call",
    tool: "bash",
    status: "completed",
    at: "2026-01-01T00:00:00Z",
  };
  const result = JournalEvent.parse(valid);
  assert(result.event === "tool_call");
  assert.strictEqual(result.gateDenied, false);
});

test("journal: JournalEvent parses parked with BlockedReason", () => {
  const valid = {
    event: "parked",
    reason: "human_decision",
    question: "Should we merge?",
    at: "2026-01-01T00:00:00Z",
  };
  const result = JournalEvent.parse(valid);
  assert(result.event === "parked");
  assert.strictEqual(result.reason, "human_decision");
});

test("journal: JournalEvent parses outcomes_updated with OutcomeStatus", () => {
  const valid = {
    event: "outcomes_updated",
    outcomes: [{ id: "feat-1", status: "done" }],
    at: "2026-01-01T00:00:00Z",
  };
  const result = JournalEvent.parse(valid);
  assert(result.event === "outcomes_updated");
  assert.strictEqual(result.outcomes[0]!.status, "done");
});

test("journal: JournalEvent parses final_review with FinalReviewVerdict", () => {
  const valid = {
    event: "final_review",
    verdict: "accept",
    findings: [],
    at: "2026-01-01T00:00:00Z",
  };
  const result = JournalEvent.parse(valid);
  assert(result.event === "final_review");
  assert.strictEqual(result.verdict, "accept");
});

test("journal: JournalEvent parses durable super-review lifecycle state", () => {
  const result = JournalEvent.parse({
    event: "super_review_status",
    pass: 2,
    status: "failed",
    detail: "connection dropped",
    at: "2026-01-01T00:00:00Z",
  });
  assert(result.event === "super_review_status");
  assert.strictEqual(result.status, "failed");
});

// ---- Report ----

test("report: SubmitReport round-trips", () => {
  const valid = {
    status: "ready_for_review",
    summary: "Completed the task",
    outcomeClaims: [{ id: "feat-1", status: OutcomeStatus.parse("done") }],
  };
  const result = SubmitReport.parse(valid);
  assert.strictEqual(result.status, "ready_for_review");
  assert.deepStrictEqual(result.filesChanged, []);
  assert.deepStrictEqual(result.verificationClaims, []);
});

test("report: SubmitReport rejects missing summary", () => {
  const invalid = {
    status: "ready_for_review",
    outcomeClaims: [{ id: "feat-1", status: OutcomeStatus.parse("done") }],
  };
  assert.throws(() => SubmitReport.parse(invalid));
});

test("report: SubmitReport accepts blocked with BlockedReason", () => {
  const valid = {
    status: "blocked",
    summary: "Blocked by X",
    blockedReason: BlockedReason.parse("human_decision"),
    outcomeClaims: [{ id: "feat-1", status: OutcomeStatus.parse("blocked") }],
  };
  const result = SubmitReport.parse(valid);
  assert.strictEqual(result.blockedReason, "human_decision");
});

test("report: FileClassification accepts all variants", () => {
  for (const c of ["expected", "acceptable-but-not-predeclared", "suspicious", "forbidden"]) {
    assert.strictEqual(FileClassification.parse(c), c);
  }
});

const acceptanceOperation = () => ({
  campaignId: "campaign",
  phase: "prepared" as const,
  tipRunId: "tip",
  acceptedInto: "meridian/tip",
  expectedTipSha: "head",
  members: [
    {
      runId: "first",
      revision: 1,
      status: "ready_for_review" as const,
      repo: "/repo",
      branch: "meridian/first",
      worktree: "/runs/first",
      base: "main",
      pass: 1,
    },
    {
      runId: "tip",
      revision: 1,
      status: "ready_for_review" as const,
      repo: "/repo",
      branch: "meridian/tip",
      worktree: "/runs/tip",
      base: "meridian/first",
      pass: 2,
    },
  ],
  cleanedSandboxes: [],
  cleanedBranches: [],
  updatedAt: "2026-01-01T00:00:00Z",
});

test("acceptance operation requires unique members", () => {
  const value = acceptanceOperation();
  value.members[1] = { ...value.members[1]!, runId: "first" };
  assert.throws(() => AcceptanceOperation.parse(value), /unique run ids/);
});

test("acceptance operation requires the tip exactly once", () => {
  const value = acceptanceOperation();
  value.tipRunId = "missing";
  assert.throws(() => AcceptanceOperation.parse(value), /present exactly once/);
});

test("acceptance operation requires one repository", () => {
  const value = acceptanceOperation();
  value.members[1] = { ...value.members[1]!, repo: "/other" };
  assert.throws(() => AcceptanceOperation.parse(value), /one repository/);
});

test("run startup operation requires session ids once their phases create them", () => {
  assert.throws(() =>
    RunStartupOperation.parse({
      runId: "run",
      attempt: 1,
      phase: "planner_session_created",
      updatedAt: "now",
    }),
  );
  assert.throws(() =>
    RunStartupOperation.parse({
      runId: "run",
      attempt: 1,
      phase: "executor_session_created",
      plannerSessionId: "planner",
      updatedAt: "now",
    }),
  );
  assert.doesNotThrow(() =>
    RunStartupOperation.parse({
      runId: "run",
      attempt: 1,
      phase: "active",
      plannerSessionId: "planner",
      executorSessionId: "executor",
      updatedAt: "now",
    }),
  );
});

test("acceptance cleanup progress is a unique known member subset and never cleans the tip branch", () => {
  assert.throws(
    () =>
      AcceptanceOperation.parse({ ...acceptanceOperation(), cleanedSandboxes: ["first", "first"] }),
    /unique/,
  );
  assert.throws(
    () => AcceptanceOperation.parse({ ...acceptanceOperation(), cleanedSandboxes: ["unknown"] }),
    /members/,
  );
  assert.throws(
    () => AcceptanceOperation.parse({ ...acceptanceOperation(), cleanedBranches: ["tip"] }),
    /tip branch/,
  );
});

test("report: ReportFile action accepts all variants", () => {
  const rf = ReportFile.parse({
    path: "src/foo.ts",
    classification: FileClassification.parse("expected"),
    reason: "intended",
    action: "kept",
  });
  assert.strictEqual(rf.action, "kept");
});
