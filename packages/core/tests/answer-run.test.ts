import { equal, strictEqual, ok, throws } from "node:assert";
import { mkdir } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import { answerRun } from "../src/application/use-cases/answer-run.js";
import { makePaths } from "../src/config/paths.js";
import type { RunMeta } from "../src/domain/run.js";
import { SqliteStoreAdapter } from "../src/infrastructure/sqlite-store.js";

// ---------------------------------------------------------------------------
// Test helpers

const TS_COUNTER = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS_COUNTER.n++).padStart(2, "0")}.000Z`,
});

const fakeRepo = (opts?: {
  readDiffStatsValue?: Record<string, { added: number; removed: number }>;
  readDiffStatsError?: Error;
}): Repo => ({
  createSandbox: () => {
    throw new Error("unimplemented");
  },
  wipCommit: () => undefined,
  amendCommit: () => "",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => {
    if (opts?.readDiffStatsError) {
      throw opts.readDiffStatsError;
    }
    return opts?.readDiffStatsValue ?? { "src/index.ts": { added: 5, removed: 1 } };
  },
  reviewableDiff: () => "",
  reviewableDiffAgainst: () => "",
  resolveRevision: () => "abc",
  reconciliationGitState: () => ({
    head: "abc",
    status: [] as string[],
    diffHash: "",
    untracked: [],
    changedFiles: [],
  }),
  fetchBranchFromClone: () => {
    throw new Error("unimplemented");
  },
  removeSandbox: () => {
    throw new Error("unimplemented");
  },
  headBranch: () => "main",
  branchExists: () => true,
  deleteBranch: () => {
    throw new Error("unimplemented");
  },
  repoValid: () => true,
});

const cleanTemp = async (dir: string) => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

const makeBlockedMeta = (runId: string, clock: Clock): RunMeta => ({
  runId,
  status: "blocked" as const,
  attempt: 1,
  repo: "/tmp/repo",
  base: "main",
  branch: "meridian/20260101-000000-test",
  worktree: join(tmpdir(), "worktree"),
  stallRetries: 3,
  crashRetries: 0,
  reorientRetries: 0,
  promoted: false,
  pass: 1,
  updatedAt: clock.nowIso(),
  blockedReason: "stop_condition",
  blockedQuestion: "How should I structure the new module?",
});

// ---------------------------------------------------------------------------
// answerRun

test("answer-run: refuses when run not found", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-notfound-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const result = answerRun(store, fakeRepo(), "nonexistent", "do it", join(tmpdir(), "wt"), clock);
  strictEqual(result.ok, false);
  equal((result as { ok: false; reason: string }).reason, "run nonexistent not found");
  await cleanTemp(tmp);
});

test("answer-run: refuses when run is not blocked", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-notblocked-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const meta: RunMeta = {
    runId: "20260101-000000-running",
    status: "running" as const,
    attempt: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: "meridian/20260101-000000-running",
    worktree: join(tmpdir(), "wt"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  const result = answerRun(
    store,
    fakeRepo(),
    "20260101-000000-running",
    "do it",
    join(tmpdir(), "wt"),
    clock,
  );
  strictEqual(result.ok, false);
  equal(
    (result as { ok: false; reason: string }).reason,
    "run 20260101-000000-running is not answerable (status: running)",
  );
  await cleanTemp(tmp);
});

test("answer-run: succeeds for blocked run", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-ok-"));
  const clock = fixedClock();
  const repo = fakeRepo();
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

  const meta = makeBlockedMeta("20260101-000000-test", clock);
  store.writeMeta(meta);

  // Write gate state (blocked runs always have a live gate)
  store.writeGateState("20260101-000000-test", {
    runId: "20260101-000000-test",
    phase: { phase: "checkpoint-demand-latched", reason: "first edit approved" },
    expectedGlobs: ["src/**/*.ts"],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    lastAcceptedDecisionAt: clock.nowIso(),
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  });

  const result = answerRun(
    store,
    repo,
    "20260101-000000-test",
    "Use a module-per-feature layout",
    join(tmpdir(), "wt"),
    clock,
  );
  strictEqual(result.ok, true);
  equal((result as { ok: true; decision: { source: "max" } }).decision.source, "max");
  equal((result as { ok: true; decision: { status: "proceed" } }).decision.status, "proceed");

  // Decision appended
  const decisions = store.readDecisions("20260101-000000-test");
  strictEqual(decisions.length, 1);
  equal(decisions[0]!.source, "max");
  equal(decisions[0]!.questionType, "stop_condition");
  equal(decisions[0]!.status, "proceed");
  equal(decisions[0]!.answer, "Use a module-per-feature layout");
  equal(decisions[0]!.question, "How should I structure the new module?");
  strictEqual(decisions[0]!.evidence.length, 0);

  // Gate cleared
  const gate = store.readGateState("20260101-000000-test");
  strictEqual(gate.phase.phase, "cleared");
  ok(gate.lastAcceptedDecisionAt);

  // Meta updated
  const updatedMeta = store.readMeta("20260101-000000-test");
  strictEqual(updatedMeta.status, "queued");
  strictEqual(updatedMeta.stallRetries, 0);
  equal((updatedMeta as unknown as Record<string, unknown>).blockedReason, undefined);
  equal((updatedMeta as unknown as Record<string, unknown>).blockedQuestion, undefined);

  await cleanTemp(tmp);
});

test("answer-run: diff failure does not requeue or clear a blocked run", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-diff-failure-"));
  const clock = fixedClock();
  const repo = fakeRepo({ readDiffStatsError: new Error("git unavailable") });
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  const runId = "20260101-000000-diff-failure";
  store.writeMeta(makeBlockedMeta(runId, clock));
  store.writeGateState(runId, {
    runId,
    phase: { phase: "checkpoint-demand-latched", reason: "approval required" },
    expectedGlobs: [],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  });

  throws(
    () => answerRun(store, repo, runId, "continue", "/tmp/worktree", clock),
    /git unavailable/,
  );
  equal(store.readMeta(runId).status, "blocked");
  equal(store.readGateState(runId).phase.phase, "checkpoint-demand-latched");
  equal(store.readDecisions(runId).length, 0);
  await cleanTemp(tmp);
});

test("answer-run: uses meta.blockedQuestion when present, placeholder when absent", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-noq-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

  const meta = { ...makeBlockedMeta("20260101-000000-noq", clock), blockedQuestion: undefined };
  store.writeMeta(meta);
  store.writeGateState("20260101-000000-noq", {
    runId: "20260101-000000-noq",
    phase: { phase: "cleared" },
    expectedGlobs: [],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  });

  answerRun(store, fakeRepo(), "20260101-000000-noq", "go ahead", join(tmpdir(), "wt"), clock);

  const decisions = store.readDecisions("20260101-000000-noq");
  equal(decisions[0]!.question, "(parked without a recorded question)");

  await cleanTemp(tmp);
});

test("answer-run: succeeds for failed run (retry)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-failed-"));
  const clock = fixedClock();
  const repo = fakeRepo();
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

  const meta: RunMeta = {
    runId: "20260101-000000-failed",
    status: "failed" as const,
    attempt: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: "meridian/20260101-000000-failed",
    worktree: join(tmpdir(), "wt"),
    crashRetries: 3,
    stallRetries: 2,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);

  const result = answerRun(
    store,
    repo,
    "20260101-000000-failed",
    "Tests are fixed. Please continue.",
    join(tmpdir(), "wt"),
    clock,
  );
  strictEqual(result.ok, true);

  // Decision appended with retry context
  const decisions = store.readDecisions("20260101-000000-failed");
  strictEqual(decisions.length, 1);
  equal(decisions[0]!.answer, "Tests are fixed. Please continue.");
  equal(decisions[0]!.question, "(run failed — retry requested)");

  // Meta updated: queued, counters reset
  const updatedMeta = store.readMeta("20260101-000000-failed");
  strictEqual(updatedMeta.status, "queued");
  strictEqual(updatedMeta.crashRetries, 0);
  strictEqual(updatedMeta.stallRetries, 0);

  await cleanTemp(tmp);
});

test("answer-run: reviewer transport answer retries convergence without requeueing Executor", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-convergence-retry-"));
  const clock = fixedClock();
  const repo = fakeRepo({ readDiffStatsError: new Error("Executor gate must not be touched") });
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  const runId = "20260101-000000-convergence-retry";
  store.writeMeta({
    ...makeBlockedMeta(runId, clock),
    blockedReason: "human_decision",
    blockedQuestion: "Super-daddy unreachable: socket hang up",
  });
  const lease = store.acquireRepositoryLease("/tmp/repo", "fixture", runId, "execute")!;
  const started = {
    runId,
    attempt: 1,
    phase: "autofix_started" as const,
    autofixFingerprint: "fingerprint",
  };
  store.persistConvergenceOperation(started, lease);
  store.persistConvergenceOperation({ ...started, phase: "autofix_applied" }, lease);
  store.releaseRepositoryLease(lease);

  const result = answerRun(store, repo, runId, "retry the reviewer", "/tmp/worktree", clock);

  equal(result.ok, true);
  if (result.ok) {
    equal(result.decision.questionType, "convergence_retry");
  }
  equal(store.readMeta(runId).status, "ready_for_review");
  const decision = store.readDecisions(runId).at(-1)!;
  equal(decision.questionType, "convergence_retry");
  equal(decision.currentSlice, "attempt:1");
  await cleanTemp(tmp);
});

test("answer-run: ambiguous autofix_started answer creates a new execution attempt", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-autofix-started-"));
  const clock = fixedClock();
  const repo = fakeRepo();
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  const runId = "20260101-000000-autofix-started";
  store.writeMeta({
    ...makeBlockedMeta(runId, clock),
    blockedReason: "crashed",
    blockedQuestion: "Autofix may have run before the driver exited.",
  });
  store.writeGateState(runId, {
    runId,
    phase: { phase: "cleared" },
    expectedGlobs: [],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  });
  const lease = store.acquireRepositoryLease("/tmp/repo", "fixture", runId, "execute")!;
  store.persistConvergenceOperation(
    {
      runId,
      attempt: 1,
      phase: "autofix_started",
      autofixFingerprint: "fingerprint",
    },
    lease,
  );
  store.releaseRepositoryLease(lease);

  const result = answerRun(store, repo, runId, "start a clean attempt", "/tmp/worktree", clock);

  equal(result.ok, true);
  if (result.ok) {
    equal(result.decision.questionType, "stop_condition");
  }
  equal(store.readMeta(runId).status, "queued");
  equal(store.readDecisions(runId).at(-1)?.questionType, "stop_condition");
  const claimed = store.claimNextQueuedRun([], "next-worker")!;
  equal(store.readMeta(runId).attempt, 2);
  equal(store.readConvergenceOperation(runId, 2), undefined);
  store.releaseRepositoryLease(claimed.lease);
  await cleanTemp(tmp);
});

test("answer-run: returns checkpoint number when checkpoint exists", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-ckpt-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

  const meta = makeBlockedMeta("20260101-000000-ckpt", clock);
  store.writeMeta(meta);
  store.writeGateState("20260101-000000-ckpt", {
    runId: "20260101-000000-ckpt",
    phase: { phase: "cleared" },
    expectedGlobs: [],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  });
  // Write a checkpoint so latestCheckpoint returns something
  store.writeCheckpoint("20260101-000000-ckpt", {
    number: 3,
    reason: "rotation",
    summary: "halfway",
    outcomes: [{ id: "dummy", status: "in_progress" as const, evidence: [] }],
    filesChanged: [],
    filesInspected: [],
    uncertainties: [],
    writtenAt: clock.nowIso(),
  });

  const result = answerRun(
    store,
    fakeRepo(),
    "20260101-000000-ckpt",
    "yes",
    join(tmpdir(), "wt"),
    clock,
  );
  strictEqual(result.ok, true);
  equal((result as { ok: true; checkpoint?: number }).checkpoint, 3);

  await cleanTemp(tmp);
});

test("answer-run: returns checkpoint undefined when no checkpoint", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-nockpt-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

  const meta = makeBlockedMeta("20260101-000000-nockpt", clock);
  store.writeMeta(meta);
  store.writeGateState("20260101-000000-nockpt", {
    runId: "20260101-000000-nockpt",
    phase: { phase: "cleared" },
    expectedGlobs: [],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  });

  const result = answerRun(
    store,
    fakeRepo(),
    "20260101-000000-nockpt",
    "yes",
    join(tmpdir(), "wt"),
    clock,
  );
  strictEqual(result.ok, true);
  equal((result as { ok: true; checkpoint?: number }).checkpoint, undefined);

  await cleanTemp(tmp);
});

test("answer-run: decision, gate, and run transition roll back together", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-rollback-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-answer-rollback";
  const meta = makeBlockedMeta(runId, clock);
  store.writeMeta(meta);
  store.writeGateState(runId, {
    runId,
    phase: { phase: "checkpoint-demand-latched", reason: "test" },
    expectedGlobs: [],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    mutationCommandPatterns: [],
    updatedAt: clock.nowIso(),
  });
  const db = new DatabaseSync(paths.dbFile);
  db.exec(
    "CREATE TRIGGER fail_answer_decision BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT, 'forced decision failure'); END;",
  );

  throws(
    () => answerRun(store, fakeRepo(), runId, "continue", meta.worktree, clock),
    /forced decision/,
  );
  equal(store.readMeta(runId).status, "blocked");
  equal(store.readGateState(runId).phase.phase, "checkpoint-demand-latched");
  equal(store.readDecisions(runId).length, 0);
  db.close();
  await cleanTemp(tmp);
});

test("answer-run: gate file projection failure does not undo the committed answer", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-projection-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-answer-projection";
  const meta = makeBlockedMeta(runId, clock);
  store.writeMeta(meta);
  store.writeGateState(runId, {
    runId,
    phase: { phase: "checkpoint-demand-latched", reason: "test" },
    expectedGlobs: [],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    mutationCommandPatterns: [],
    updatedAt: clock.nowIso(),
  });
  const gateFile = join(paths.runDir(runId), "gate-state.json");
  await rm(gateFile);
  await mkdir(gateFile);

  const result = answerRun(store, fakeRepo(), runId, "continue", meta.worktree, clock);
  equal(result.ok, true);
  equal(store.readMeta(runId).status, "queued");
  equal(store.readGateState(runId).phase.phase, "cleared");
  equal(store.readDecisions(runId).length, 1);
  await cleanTemp(tmp);
});
