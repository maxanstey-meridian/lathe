import { equal, strictEqual, ok } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import { answerRun } from "../src/application/use-cases/answer-run.js";
import { makePaths } from "../src/config/paths.js";
import { StoreAdapter } from "../src/infrastructure/store.js";

// ---------------------------------------------------------------------------
// Test helpers

const TS_COUNTER = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS_COUNTER.n++).padStart(2, "0")}.000Z`,
});

const fakeRepo = (opts?: {
  readDiffStatsValue?: Record<string, { added: number; removed: number }>;
}): Repo => ({
  createSandbox: () => {
    throw new Error("unimplemented");
  },
  wipCommit: () => undefined,
  amendCommit: () => "",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => opts?.readDiffStatsValue ?? { "src/index.ts": { added: 5, removed: 1 } },
  reviewableDiff: () => "",
  reviewableDiffAgainst: () => "",
  fetchBranchFromClone: () => {
    throw new Error("unimplemented");
  },
  removeSandbox: () => {
    throw new Error("unimplemented");
  },
  headBranch: () => "main",
  branchExists: () => true,
  mergeAccept: () => {
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

const makeBlockedMeta = (runId: string, clock: Clock) => ({
  runId,
  status: "blocked" as const,
  attempt: 1,
  repo: "/tmp/repo",
  base: "main",
  branch: "meridian/20260101-000000-test",
  worktree: join(tmpdir(), "worktree"),
  stallRetries: 3,
  updatedAt: clock.nowIso(),
  blockedReason: "stop_condition",
  blockedQuestion: "How should I structure the new module?",
});

// ---------------------------------------------------------------------------
// answerRun

test("answer-run: refuses when run not found", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-notfound-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const result = answerRun(store, fakeRepo(), "nonexistent", "do it", join(tmpdir(), "wt"), clock);
  strictEqual(result.ok, false);
  equal((result as { ok: false; reason: string }).reason, "run nonexistent not found");
  await cleanTemp(tmp);
});

test("answer-run: refuses when run is not blocked", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-notblocked-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const meta = {
    runId: "20260101-000000-running",
    status: "running" as const,
    attempt: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: "meridian/20260101-000000-running",
    worktree: join(tmpdir(), "wt"),
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
    "run 20260101-000000-running is not parked (status: running)",
  );
  await cleanTemp(tmp);
});

test("answer-run: succeeds for blocked run", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-ok-"));
  const clock = fixedClock();
  const repo = fakeRepo();
  const store = StoreAdapter.create(makePaths(tmp), repo, clock);

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
  equal(decisions[0].source, "max");
  equal(decisions[0].questionType, "stop_condition");
  equal(decisions[0].status, "proceed");
  equal(decisions[0].answer, "Use a module-per-feature layout");
  equal(decisions[0].question, "How should I structure the new module?");
  strictEqual(decisions[0].evidence.length, 0);

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

test("answer-run: uses meta.blockedQuestion when present, placeholder when absent", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-noq-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

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
  equal(decisions[0].question, "(parked without a recorded question)");

  await cleanTemp(tmp);
});

test("answer-run: returns checkpoint number when checkpoint exists", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "answer-run-ckpt-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

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
    outcomes: [{ id: "dummy", status: "in_progress" as const }],
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
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

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
