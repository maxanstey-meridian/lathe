import { deepEqual, equal, strictEqual, ok, match, rejects, throws } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import type { ConvergenceLogEntry } from "../src/application/ports/store.js";
import type { Store } from "../src/application/ports/store.js";
import { makePaths } from "../src/config/paths.js";
import type { Packet } from "../src/domain/packet.js";
import { SqliteStoreAdapter } from "../src/infrastructure/sqlite-store.js";

// ---------------------------------------------------------------------------
// Test helpers

const TS_COUNTER = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => new Date(Date.UTC(2026, 0, 1) + TS_COUNTER.n++ * 1_000).toISOString(),
});

const seedExecutorStartup = (store: Store, runId: string, at: string): void => {
  store.persistRunStartup({ runId, attempt: 1, phase: "claimed", updatedAt: at });
  store.persistRunStartup({ runId, attempt: 1, phase: "setup_completed", updatedAt: at });
  store.persistRunStartup({ runId, attempt: 1, phase: "planner_session_started", updatedAt: at });
  store.persistRunStartup({
    runId,
    attempt: 1,
    phase: "planner_session_created",
    plannerSessionId: "planner",
    updatedAt: at,
  });
  store.persistRunStartup({
    runId,
    attempt: 1,
    phase: "executor_session_started",
    plannerSessionId: "planner",
    updatedAt: at,
  });
  store.persistRunStartup({
    runId,
    attempt: 1,
    phase: "executor_session_created",
    plannerSessionId: "planner",
    executorSessionId: "baby",
    updatedAt: at,
  });
};

const fakeRepo = (opts?: {
  headBranch?: string;
  branchExists?: boolean;
  headBranchThrows?: boolean;
  repoValid?: boolean;
}): Repo & { headBranchCallCount: number } => {
  let headBranchCallCount = 0;
  return {
    get headBranchCallCount() {
      return headBranchCallCount;
    },
    createSandbox: () => {
      throw new Error("unimplemented");
    },
    wipCommit: () => undefined,
    amendCommit: () => "",
    worktreeIsDirty: () => false,
    diffStat: () => "",
    readDiffStats: () => ({}),
    reviewableDiff: () => "",
    reviewableDiffAgainst: () => "",
    fetchBranchFromClone: () => {
      throw new Error("unimplemented");
    },
    removeSandbox: () => {
      throw new Error("unimplemented");
    },
    headBranch: (_w: string) => {
      headBranchCallCount++;
      if (opts?.headBranchThrows) {
        throw new Error("not a repo");
      }
      return opts?.headBranch ?? "main";
    },
    branchExists: (_w: string, _b: string) => opts?.branchExists ?? true,
    repoValid: () => opts?.repoValid ?? true,
    reconciliationGitState: () => ({
      head: "",
      status: [],
      diffHash: "",
      untracked: [],
      changedFiles: [],
    }),
    deleteBranch: () => {
      throw new Error("unimplemented");
    },
  };
};

const makeTestPacket = (override?: Record<string, unknown>): Packet => {
  const raw = `---
repo: /tmp/test-repo
base: main
compare_commit: main
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
`;
  const fm = {
    repo: "/tmp/test-repo",
    base: "main",
    compare_commit: "main",
    summary: "test packet",
    outcomes: [{ id: "test-outcome", description: "A test outcome" }],
    expected_surface: ["src/index.ts"],
    verification: [{ command: "echo ok" }],
    constraints: [],
    ...override,
  };
  return { runId: "20260101-000000-test", frontmatter: fm as any, body: "body\n", raw };
};

const makeValidConvergenceEntry = (
  overrides?: Partial<Extract<ConvergenceLogEntry, { kind: "reviewed" }>>,
): ConvergenceLogEntry => {
  const at = fixedClock().nowIso();
  return {
    at,
    kind: "reviewed",
    runId: "20260101-000000-test",
    campaignId: "test-campaign",
    pass: 1,
    maxPasses: 5,
    verification: { green: true, commands: [{ command: "echo ok", exitCode: 0, outputTail: "" }] },
    decision: { action: "stop" },
    amendedCommitSha: null,
    primary: {
      verdict: "accept" as const,
      findings: [],
      convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
      commit_message: null,
      notes: "",
      human_decision_needed: null,
    },
    primaryRaw: `{"verdict":"accept"}`,
    ...overrides,
  };
};

const cleanTemp = async (dir: string) => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

// ---------------------------------------------------------------------------
// Meta

test("store: meta round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-meta-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const meta = {
    runId: "20260101-000000-meta",
    status: "queued" as const,
    attempt: 0,
    repo: "/tmp/repo",
    base: "main",
    branch: "meridian/20260101-000000-meta",
    worktree: join(tmp, "worktree"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  const read = store.readMeta(meta.runId);
  equal(read.runId, meta.runId);
  equal(read.status, "queued");
  equal(read.attempt, 0);
  await cleanTemp(tmp);
});

test("store: transitionRun commits meta, active pointer, and journal event atomically", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-transition-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const runId = "20260101-000000-transition";
  const meta = {
    runId,
    status: "running" as const,
    attempt: 1,
    revision: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: `meridian/${runId}`,
    worktree: join(tmp, "runs", runId, "worktree"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  store.addActiveRun({
    runId,
    runDir: join(tmp, "runs", runId),
    worktree: meta.worktree,
    babySessionId: "baby-transition",
    startedAt: clock.nowIso(),
  });

  const next = store.transitionRun({
    runId,
    expectedRevision: 1,
    expectedStatuses: ["running"],
    meta: { ...meta, status: "blocked", blockedReason: "human_decision" },
    activeRun: null,
    event: {
      at: clock.nowIso(),
      turn: 0,
      event: "parked",
      reason: "human_decision",
    },
  });

  equal(next.revision, 2);
  equal(store.readMeta(runId).status, "blocked");
  deepEqual(store.listActiveRuns(), []);
  equal(store.readJournal(runId).at(0)?.event, "parked");
  await rejects(
    async () =>
      store.transitionRun({
        runId,
        expectedRevision: 1,
        expectedStatuses: ["blocked"],
        meta: next,
      }),
    /revision conflict/,
  );
  equal(store.readMeta(runId).revision, 2);
  strictEqual(store.readJournal(runId).length, 1);

  const rollbackRunId = "20260101-000001-transition-rollback";
  store.writeMeta({ ...meta, runId: rollbackRunId, revision: 0, status: "queued" });
  strictEqual(store.claimNextQueuedRun([])?.runId, rollbackRunId);
  store.addActiveRun({
    runId: rollbackRunId,
    runDir: join(tmp, "runs", rollbackRunId),
    worktree: meta.worktree,
    babySessionId: "baby-rollback",
    startedAt: clock.nowIso(),
  });
  const inspectionDb = new DatabaseSync(makePaths(tmp).dbFile);
  inspectionDb.exec(
    "CREATE TRIGGER fail_transition_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'forced event failure'); END;",
  );
  throws(
    () =>
      store.transitionRun({
        runId: rollbackRunId,
        expectedRevision: 1,
        expectedStatuses: ["running"],
        meta: { ...store.readMeta(rollbackRunId), status: "blocked", blockedReason: "crashed" },
        activeRun: null,
        lease: store.listRepositoryLeases().at(0),
        event: { at: clock.nowIso(), turn: 0, event: "parked", reason: "crashed" },
      }),
    /forced event failure/,
  );
  equal(store.readMeta(rollbackRunId).status, "running");
  equal(store.listActiveRuns().at(0)?.runId, rollbackRunId);
  strictEqual(store.readJournal(rollbackRunId).length, 0);
  const lease = inspectionDb
    .prepare("SELECT run_id FROM repository_leases WHERE run_id = ?")
    .get(rollbackRunId) as { run_id: string } | undefined;
  equal(lease?.run_id, rollbackRunId);
  inspectionDb.close();
  await cleanTemp(tmp);
});

test("store: transitionRun rejects mismatched nested run identities", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-transition-identity-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const meta = {
    runId: "run-a",
    status: "queued" as const,
    attempt: 0,
    repo: "/tmp/repo",
    base: "main",
    branch: "meridian/run-a",
    worktree: join(tmp, "worktree"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);

  throws(
    () =>
      store.transitionRun({
        runId: "run-a",
        expectedRevision: 0,
        expectedStatuses: ["queued"],
        meta: { ...meta, runId: "run-b", status: "running" },
      }),
    /identity mismatch/,
  );
  throws(
    () =>
      store.transitionRun({
        runId: "run-a",
        expectedRevision: 0,
        expectedStatuses: ["queued"],
        meta: { ...meta, status: "running" },
        activeRun: {
          runId: "run-b",
          runDir: "/tmp/run-b",
          worktree: "/tmp/run-b/worktree",
          babySessionId: "baby-b",
          startedAt: clock.nowIso(),
        },
      }),
    /identity mismatch/,
  );

  equal(store.readMeta("run-a").status, "queued");
  await cleanTemp(tmp);
});

test("store: answerRun rejects mismatched nested run identities", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-answer-identity-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const meta = {
    runId: "run-a",
    status: "blocked" as const,
    attempt: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: "meridian/run-a",
    worktree: join(tmp, "worktree"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  const decision = {
    timestamp: clock.nowIso(),
    source: "max" as const,
    questionType: "other",
    question: "q",
    status: "proceed",
    answer: "a",
    evidence: [],
    constraints: [],
  };

  throws(
    () =>
      store.answerRun({
        runId: "run-a",
        expectedRevision: 0,
        expectedStatus: "blocked",
        meta: { ...meta, runId: "run-b", status: "queued" },
        decision,
      }),
    /identity mismatch/,
  );
  equal(store.readMeta("run-a").status, "blocked");
  await cleanTemp(tmp);
});

test("store: a failed active-run projection does not roll back a committed transition", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-transition-projection-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-projection";
  const meta = {
    runId,
    status: "running" as const,
    attempt: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: `meridian/${runId}`,
    worktree: join(tmp, "runs", runId, "worktree"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  mkdirSync(join(paths.root, "active-run.json"), { recursive: true });

  store.transitionRun({
    runId,
    expectedRevision: 0,
    expectedStatuses: ["running"],
    meta: { ...meta, status: "blocked", blockedReason: "crashed" },
    activeRun: null,
  });

  equal(store.readMeta(runId).status, "blocked");
  equal(store.readMeta(runId).revision, 1);
  await cleanTemp(tmp);
});

test("store: a failed active-run activation projection fails closed after the durable transition", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-transition-activation-projection-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-activation-projection";
  const meta = {
    runId,
    status: "queued" as const,
    attempt: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: `meridian/${runId}`,
    worktree: join(tmp, "runs", runId, "worktree"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  mkdirSync(join(paths.root, "active-run.json"), { recursive: true });

  throws(
    () =>
      store.transitionRun({
        runId,
        expectedRevision: 0,
        expectedStatuses: ["queued"],
        meta: { ...meta, status: "running" },
        activeRun: {
          runId,
          runDir: paths.runDir(runId),
          worktree: meta.worktree,
          babySessionId: "baby",
          startedAt: clock.nowIso(),
        },
      }),
    /EISDIR/,
  );

  equal(store.readMeta(runId).status, "running");
  equal(store.readMeta(runId).revision, 1);
  equal(store.listActiveRuns().length, 1);
  await cleanTemp(tmp);
});

test("store: activateRunStartup rejects a concurrent cancellation before pointer and event writes", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-startup-cas-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-startup-cas";
  const meta = {
    runId,
    status: "running" as const,
    attempt: 1,
    revision: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: `meridian/${runId}`,
    worktree: join(tmp, "worktree"),
    babySessionId: "baby",
    daddySessionId: "planner",
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  const operation = {
    runId,
    attempt: 1,
    phase: "executor_session_created" as const,
    plannerSessionId: "planner",
    executorSessionId: "baby",
    updatedAt: clock.nowIso(),
  };
  seedExecutorStartup(store, runId, clock.nowIso());
  const lease = store.acquireRepositoryLease(meta.repo, "startup-cas", runId, "execute")!;
  const competing = new DatabaseSync(paths.dbFile);
  competing
    .prepare(
      "UPDATE runs SET meta = json_set(meta, '$.status', 'stopped', '$.revision', 2) WHERE run_id = ?",
    )
    .run(runId);
  competing.close();

  throws(
    () =>
      store.activateRunStartup(operation, {
        runId,
        expectedRevision: 1,
        expectedStatuses: ["running"],
        meta,
        activeRun: {
          runId,
          runDir: paths.runDir(runId),
          worktree: meta.worktree,
          babySessionId: "baby",
          startedAt: clock.nowIso(),
        },
        event: { event: "run_started", runId, attempt: 1, at: clock.nowIso() },
        lease,
      }),
    /changed during startup activation/,
  );
  deepEqual(store.listActiveRuns(), []);
  equal(store.readJournal(runId).length, 0);
  equal(store.readRunStartup(runId, 1)?.phase, "executor_session_created");
  await cleanTemp(tmp);
});

test("store: activateRunStartup validates every startup identity and requires one claimed operation", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-startup-identity-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-startup-identity";
  const meta = {
    runId,
    status: "running" as const,
    attempt: 1,
    revision: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: `meridian/${runId}`,
    worktree: join(tmp, "worktree"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  const operation = {
    runId,
    attempt: 1,
    phase: "executor_session_created" as const,
    plannerSessionId: "planner",
    executorSessionId: "baby",
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  seedExecutorStartup(store, runId, clock.nowIso());
  const lease = store.acquireRepositoryLease(meta.repo, "startup-identity", runId, "execute")!;
  const transition = {
    runId,
    expectedRevision: 1,
    expectedStatuses: ["running" as const],
    meta,
    activeRun: {
      runId,
      runDir: paths.runDir(runId),
      worktree: meta.worktree,
      babySessionId: "baby",
      startedAt: clock.nowIso(),
    },
    event: { event: "run_started" as const, runId, attempt: 1, at: clock.nowIso() },
    lease,
  };

  throws(
    () =>
      store.activateRunStartup(operation, {
        ...transition,
        lease: { ...lease, epoch: lease.epoch + 1 },
      }),
    /repository lease lost/,
  );
  throws(
    () => store.activateRunStartup(operation, { ...transition, meta: { ...meta, runId: "other" } }),
    /identity mismatch/,
  );
  throws(
    () =>
      store.activateRunStartup(operation, {
        ...transition,
        activeRun: { ...transition.activeRun, runId: "other" },
      }),
    /identity mismatch/,
  );
  throws(
    () =>
      store.activateRunStartup(operation, {
        ...transition,
        event: { ...transition.event, attempt: 2 },
      }),
    /attempt mismatch/,
  );

  const db = new DatabaseSync(paths.dbFile);
  db.prepare("DELETE FROM run_startup_operations WHERE run_id = ? AND attempt = ?").run(runId, 1);
  db.close();
  throws(() => store.activateRunStartup(operation, transition), /startup operation changed/);
  equal(store.readMeta(runId).revision, 1);
  deepEqual(store.listActiveRuns(), []);
  equal(store.readJournal(runId).length, 0);
  await cleanTemp(tmp);
});

test("store: acceptance operation cannot regress or replace its durable snapshot", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-acceptance-cas-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const runId = "20260101-000000-acceptance-cas";
  const prepared = {
    campaignId: runId,
    phase: "prepared" as const,
    tipRunId: runId,
    acceptedInto: `meridian/${runId}`,
    expectedTipSha: "head",
    members: [
      {
        runId,
        revision: 0,
        status: "ready_for_review" as const,
        repo: "/tmp/repo",
        branch: `meridian/${runId}`,
        worktree: "/tmp/worktree",
        base: "main",
        pass: 1,
      },
    ],
    cleanedSandboxes: [],
    cleanedBranches: [],
    updatedAt: clock.nowIso(),
  };
  store.persistAcceptanceOperation(prepared);
  store.persistAcceptanceOperation({ ...prepared, phase: "fetched" });

  throws(() => store.persistAcceptanceOperation(prepared), /invalid acceptance phase transition/);
  throws(
    () =>
      store.persistAcceptanceOperation({ ...prepared, phase: "fetched", acceptedInto: "other" }),
    /snapshot changed/,
  );
  equal(store.readAcceptanceOperation(runId)?.phase, "fetched");
  await cleanTemp(tmp);
});

test("store: startup and convergence operations reject phase regression", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-operation-regression-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-operation-regression";
  store.admitQueue(runId, makeTestPacket().raw);
  const claim = store.claimNextQueuedRun([], "operation-regression")!;

  throws(
    () =>
      store.persistRunStartup(
        { runId, attempt: 1, phase: "sandbox_ready", updatedAt: clock.nowIso() },
        claim.lease,
      ),
    /invalid startup phase transition/,
  );
  equal(store.readRunStartup(runId, 1)?.phase, "claimed");

  const entry = makeValidConvergenceEntry({ runId, campaignId: runId });
  const decided = {
    runId,
    attempt: 1,
    phase: "decided" as const,
    campaignId: runId,
    pass: 1,
    maxPasses: 3,
    decidedAt: clock.nowIso(),
    autofixFingerprint: "fingerprint",
    verification: entry.verification.commands,
    review: entry.primary,
    reviewRaw: entry.primaryRaw,
    decision: entry.decision,
  };
  store.persistConvergenceOperation(
    { runId, attempt: 1, phase: "autofix_started", autofixFingerprint: "fingerprint" },
    claim.lease,
  );
  store.persistConvergenceOperation(
    { runId, attempt: 1, phase: "autofix_applied", autofixFingerprint: "fingerprint" },
    claim.lease,
  );
  store.persistConvergenceOperation(decided, claim.lease);
  store.persistConvergenceOperation(
    {
      ...decided,
      phase: "effect_applied",
      effectiveDecision: decided.decision,
      amendedCommitSha: null,
    },
    claim.lease,
  );
  throws(
    () => store.persistConvergenceOperation(decided, claim.lease),
    /invalid convergence phase transition/,
  );
  equal(store.readConvergenceOperation(runId, 1)?.phase, "effect_applied");
  await cleanTemp(tmp);
});

test("store: pending packet projection is unclaimable and recovered on open", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-packet-recovery-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const first = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-packet-recovery";
  const packet = makeTestPacket().raw;
  const meta = {
    runId,
    status: "queued",
    attempt: 0,
    repo: "/tmp/test-repo",
    base: "main",
    branch: `meridian/${runId}`,
    worktree: paths.runDir(runId),
    pass: 1,
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    updatedAt: clock.nowIso(),
  };
  const db = new DatabaseSync(paths.dbFile);
  db.prepare("INSERT INTO runs(run_id, meta) VALUES (?, ?)").run(runId, JSON.stringify(meta));
  db.prepare("INSERT INTO packet_projections(run_id, content, published) VALUES (?, ?, 0)").run(
    runId,
    packet,
  );
  db.close();

  equal(first.claimNextQueuedRun([], "before-recovery"), undefined);
  const recovered = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  equal(readFileSync(paths.packetFile(runId), "utf8"), packet);
  equal(recovered.claimNextQueuedRun([], "after-recovery")?.runId, runId);
  await cleanTemp(tmp);
});

test("store: admission keeps a failed packet projection pending instead of failing the commit", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-packet-admission-outbox-"));
  const paths = makePaths(tmp);
  const runId = "20260101-000000-admission-outbox";
  mkdirSync(join(tmp, "runs"), { recursive: true });
  writeFileSync(paths.runDir(runId), "blocks packet directory");
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());

  store.admitQueue(runId, makeTestPacket().raw);

  equal(store.readMeta(runId).status, "queued");
  equal(existsSync(paths.packetFile(runId)), false);
  equal(store.claimNextQueuedRun([], "pending-admission"), undefined);
  SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());

  await rm(paths.runDir(runId), { force: true });
  const recovered = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  ok(existsSync(paths.packetFile(runId)));
  equal(recovered.claimNextQueuedRun([], "recovered-admission")?.runId, runId);
  await cleanTemp(tmp);
});

test("store: versioned legacy attempt semantics preserve identities on first claim", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-schema-reconciliation-"));
  const paths = makePaths(tmp);
  const db = new DatabaseSync(paths.dbFile);
  db.exec(
    "CREATE TABLE runs(run_id TEXT PRIMARY KEY, meta TEXT NOT NULL); PRAGMA user_version = 1;",
  );
  const base = {
    status: "queued",
    attempt: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: "meridian/test",
    worktree: "/tmp/worktree",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  db.prepare("INSERT INTO runs(run_id, meta) VALUES (?, ?)").run(
    "fresh",
    JSON.stringify({ ...base, runId: "fresh" }),
  );
  db.prepare("INSERT INTO runs(run_id, meta) VALUES (?, ?)").run(
    "resumed",
    JSON.stringify({ ...base, runId: "resumed", babySessionId: "baby-1" }),
  );
  db.prepare("INSERT INTO runs(run_id, meta) VALUES (?, ?)").run(
    "crash-requeued",
    JSON.stringify({ ...base, runId: "crash-requeued", crashRetries: 1 }),
  );
  db.close();

  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  equal(store.readMeta("fresh").attempt, 1);
  equal(store.readMeta("resumed").attempt, 1);
  equal(store.readMeta("crash-requeued").attempt, 1);
  const migratedDb = new DatabaseSync(paths.dbFile);
  equal(
    (
      migratedDb
        .prepare("SELECT value FROM store_metadata WHERE key = 'attempt_semantics'")
        .get() as {
        value: string;
      }
    ).value,
    "claim_v2",
  );
  migratedDb.close();
  deepEqual(store.listPlans(), []);
  strictEqual(store.claimNextQueuedRun([])?.runId, "crash-requeued");
  equal(store.readMeta("crash-requeued").attempt, 1);
  await cleanTemp(tmp);
});

test("store: refuses populated unversioned attempt state rather than guessing", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-attempt-ambiguous-"));
  const paths = makePaths(tmp);
  const db = new DatabaseSync(paths.dbFile);
  db.exec("CREATE TABLE runs(run_id TEXT PRIMARY KEY, meta TEXT NOT NULL)");
  db.prepare("INSERT INTO runs(run_id, meta) VALUES (?, ?)").run(
    "ambiguous",
    JSON.stringify({
      runId: "ambiguous",
      status: "queued",
      attempt: 1,
      repo: "/tmp/repo",
      base: "main",
      branch: "meridian/ambiguous",
      worktree: "/tmp/worktree",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  );
  db.close();

  throws(
    () => SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock()),
    /cannot determine attempt semantics/,
  );
  await cleanTemp(tmp);
});

test("store: campaign acceptance rolls back every member on one revision conflict", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-accept-campaign-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  const base = {
    status: "ready_for_review" as const,
    attempt: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: "meridian/a",
    worktree: "/tmp/worktree",
    pass: 1,
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  store.writeMeta({ ...base, runId: "a", revision: 2 });
  store.writeMeta({ ...base, runId: "b", revision: 4 });

  throws(
    () =>
      store.acceptCampaign(
        [
          { runId: "a", expectedRevision: 2, expectedStatus: "ready_for_review" },
          { runId: "b", expectedRevision: 3, expectedStatus: "ready_for_review" },
        ],
        "meridian/b",
      ),
    /revision conflict/,
  );
  equal(store.readMeta("a").status, "ready_for_review");
  equal(store.readMeta("a").revision, 2);
  equal(store.readMeta("b").status, "ready_for_review");
  await cleanTemp(tmp);
});

test("store: failed SQLite admission removes the published packet", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-admission-rollback-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const db = new DatabaseSync(paths.dbFile);
  db.exec(
    "CREATE TRIGGER fail_admission BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'forced admission failure'); END;",
  );
  throws(
    () => store.admitQueue("20260101-000000-rollback", makeTestPacket().raw),
    /forced admission/,
  );
  equal(existsSync(paths.packetFile("20260101-000000-rollback")), false);
  db.close();
  await cleanTemp(tmp);
});

test("store: admission refuses to overwrite an orphan packet", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-admission-orphan-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const runId = "20260101-000000-orphan";
  mkdirSync(paths.runDir(runId), { recursive: true });
  writeFileSync(paths.packetFile(runId), "original packet");

  throws(() => store.admitQueue(runId, makeTestPacket().raw), /packet already exists/);
  equal(readFileSync(paths.packetFile(runId), "utf8"), "original packet");
  equal(store.readMetaIfExists(runId), undefined);
  await cleanTemp(tmp);
});

test("store: failed follow-up campaign commit removes the published packet", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-followup-rollback-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const runId = "20260101-000000-followup-rollback";
  const campaign = {
    campaignId: "campaign-rollback",
    originalRunId: "original",
    originalIntent: "test",
    status: "open" as const,
    maxPasses: 3,
    passes: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const db = new DatabaseSync(paths.dbFile);
  db.exec(
    "CREATE TRIGGER fail_campaign BEFORE INSERT ON campaigns BEGIN SELECT RAISE(ABORT, 'forced campaign failure'); END;",
  );

  throws(
    () => store.admitQueueWithCampaign(runId, makeTestPacket().raw, campaign),
    /forced campaign/,
  );
  equal(store.readMetaIfExists(runId), undefined);
  equal(existsSync(paths.packetFile(runId)), false);
  db.close();
  await cleanTemp(tmp);
});

test("store: convergence publication rolls back every SQLite write", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-convergence-publication-rollback-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-publication-rollback";
  const meta = {
    runId,
    status: "ready_for_review" as const,
    attempt: 1,
    repo: "/tmp/test-repo",
    base: "main",
    branch: `meridian/${runId}`,
    worktree: join(tmp, "worktree"),
    pass: 1,
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  const entry = makeValidConvergenceEntry({ runId, campaignId: runId });
  const operation = {
    runId,
    attempt: 1,
    phase: "effect_applied" as const,
    campaignId: runId,
    pass: 1,
    maxPasses: 3,
    decidedAt: clock.nowIso(),
    autofixFingerprint: "fingerprint",
    verification: entry.verification.commands,
    review: entry.primary,
    reviewRaw: entry.primaryRaw,
    decision: entry.decision,
    effectiveDecision: entry.decision,
    amendedCommitSha: null,
  };
  const lease = store.acquireRepositoryLease(meta.repo, "convergence", runId, "execute")!;
  store.persistConvergenceOperation(
    { runId, attempt: 1, phase: "autofix_started", autofixFingerprint: "fingerprint" },
    lease,
  );
  store.persistConvergenceOperation(
    { runId, attempt: 1, phase: "autofix_applied", autofixFingerprint: "fingerprint" },
    lease,
  );
  store.persistConvergenceOperation(
    { ...operation, phase: "decided", effectiveDecision: undefined, amendedCommitSha: undefined },
    lease,
  );
  store.persistConvergenceOperation(operation, lease);
  const campaign = {
    campaignId: runId,
    originalRunId: runId,
    originalIntent: "test",
    status: "converged" as const,
    maxPasses: 3,
    passes: [
      {
        runId,
        attempt: 1,
        pass: 1,
        verdict: "accept" as const,
        groundedBlockers: 0,
        atIso: clock.nowIso(),
      },
    ],
    updatedAt: clock.nowIso(),
  };
  const db = new DatabaseSync(paths.dbFile);
  throws(
    () =>
      store.publishConvergence({
        operation: { ...operation, phase: "published" },
        campaign,
        entry,
        event: {
          at: clock.nowIso(),
          event: "super_review",
          pass: 1,
          verdict: "accept",
          proposedVerdict: "accept",
          findings: [],
        },
        lease: { ...lease, epoch: lease.epoch + 1 },
      }),
    /repository lease lost/,
  );
  db.exec(
    "CREATE TRIGGER fail_convergence_publication BEFORE INSERT ON convergence BEGIN SELECT RAISE(ABORT, 'forced convergence failure'); END;",
  );

  throws(
    () =>
      store.publishConvergence({
        operation: { ...operation, phase: "published" },
        campaign,
        entry,
        event: {
          at: clock.nowIso(),
          event: "super_review",
          pass: 1,
          verdict: "accept",
          proposedVerdict: "accept",
          findings: [],
        },
        nits: "# Notes",
        lease,
      }),
    /forced convergence failure/,
  );

  equal(store.readCampaign(runId), undefined);
  equal(store.readJournal(runId).length, 0);
  equal(store.readConvergence(runId).length, 0);
  equal(store.readNits(runId), "");
  equal(store.readConvergenceOperation(runId, 1)?.phase, "effect_applied");
  db.close();
  await cleanTemp(tmp);
});

test("store: failed convergence follow-up admission compensates its packet file", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-convergence-packet-rollback-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-publication-parent";
  const followupRunId = "20260101-000001-publication-child";
  store.writeMeta({
    runId,
    status: "ready_for_review",
    attempt: 1,
    repo: "/tmp/test-repo",
    base: "main",
    branch: `meridian/${runId}`,
    worktree: join(tmp, "worktree"),
    pass: 1,
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    updatedAt: clock.nowIso(),
  });
  const entry = makeValidConvergenceEntry({
    runId,
    campaignId: runId,
    decision: { action: "author", blockers: [], promote: false },
  });
  const operation = {
    runId,
    attempt: 1,
    phase: "effect_applied" as const,
    campaignId: runId,
    pass: 1,
    maxPasses: 3,
    decidedAt: clock.nowIso(),
    autofixFingerprint: "fingerprint",
    verification: entry.verification.commands,
    review: entry.primary,
    reviewRaw: entry.primaryRaw,
    decision: entry.decision,
    effectiveDecision: entry.decision,
    amendedCommitSha: null,
    followup: { runId: followupRunId, packet: makeTestPacket().raw },
  };
  const lease = store.acquireRepositoryLease("/tmp/test-repo", "convergence", runId, "execute")!;
  store.persistConvergenceOperation(
    { runId, attempt: 1, phase: "autofix_started", autofixFingerprint: "fingerprint" },
    lease,
  );
  store.persistConvergenceOperation(
    { runId, attempt: 1, phase: "autofix_applied", autofixFingerprint: "fingerprint" },
    lease,
  );
  store.persistConvergenceOperation(
    { ...operation, phase: "decided", effectiveDecision: undefined, amendedCommitSha: undefined },
    lease,
  );
  store.persistConvergenceOperation(operation, lease);
  const campaign = {
    campaignId: runId,
    originalRunId: runId,
    originalIntent: "test",
    status: "open" as const,
    maxPasses: 3,
    passes: [],
    updatedAt: clock.nowIso(),
  };
  const db = new DatabaseSync(paths.dbFile);
  db.exec(
    `CREATE TRIGGER fail_child_insert BEFORE INSERT ON runs WHEN NEW.run_id = '${followupRunId}' BEGIN SELECT RAISE(ABORT, 'forced child failure'); END;`,
  );

  throws(
    () =>
      store.publishConvergence({
        operation: { ...operation, phase: "published" },
        campaign,
        entry,
        event: {
          at: clock.nowIso(),
          event: "super_review",
          pass: 1,
          verdict: "request_changes",
          proposedVerdict: "accept",
          findings: [],
        },
        followup: { runId: followupRunId, raw: makeTestPacket().raw },
        lease,
      }),
    /forced child failure/,
  );

  equal(existsSync(paths.packetFile(followupRunId)), false);
  equal(store.readMetaIfExists(followupRunId), undefined);
  equal(store.readConvergenceOperation(runId, 1)?.phase, "effect_applied");
  db.close();
  await cleanTemp(tmp);
});

test("store: convergence keeps a failed follow-up packet projection pending and unclaimable", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-convergence-packet-outbox-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-outbox-parent";
  const followupRunId = "20260101-000001-outbox-child";
  store.writeMeta({
    runId,
    status: "ready_for_review",
    attempt: 1,
    repo: "/tmp/test-repo",
    base: "main",
    branch: `meridian/${runId}`,
    worktree: join(tmp, "worktree"),
    pass: 1,
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    updatedAt: clock.nowIso(),
  });
  const entry = makeValidConvergenceEntry({
    runId,
    campaignId: runId,
    decision: { action: "author", blockers: [], promote: false },
  });
  const operation = {
    runId,
    attempt: 1,
    phase: "effect_applied" as const,
    campaignId: runId,
    pass: 1,
    maxPasses: 3,
    decidedAt: clock.nowIso(),
    autofixFingerprint: "fingerprint",
    verification: entry.verification.commands,
    review: entry.primary,
    reviewRaw: entry.primaryRaw,
    decision: entry.decision,
    effectiveDecision: entry.decision,
    amendedCommitSha: null,
    followup: { runId: followupRunId, packet: makeTestPacket().raw },
  };
  const lease = store.acquireRepositoryLease("/tmp/test-repo", "convergence", runId, "execute")!;
  store.persistConvergenceOperation(
    { runId, attempt: 1, phase: "autofix_started", autofixFingerprint: "fingerprint" },
    lease,
  );
  store.persistConvergenceOperation(
    { runId, attempt: 1, phase: "autofix_applied", autofixFingerprint: "fingerprint" },
    lease,
  );
  store.persistConvergenceOperation(
    { ...operation, phase: "decided", effectiveDecision: undefined, amendedCommitSha: undefined },
    lease,
  );
  store.persistConvergenceOperation(operation, lease);
  const campaign = {
    campaignId: runId,
    originalRunId: runId,
    originalIntent: "test",
    status: "open" as const,
    maxPasses: 3,
    passes: [],
    updatedAt: clock.nowIso(),
  };
  mkdirSync(join(tmp, "runs"), { recursive: true });
  writeFileSync(paths.runDir(followupRunId), "blocks packet directory");

  store.publishConvergence({
    operation: { ...operation, phase: "published" },
    campaign,
    entry,
    event: {
      at: clock.nowIso(),
      event: "super_review",
      pass: 1,
      verdict: "request_changes",
      proposedVerdict: "request_changes",
      findings: [],
    },
    followup: { runId: followupRunId, raw: makeTestPacket().raw },
    lease,
  });
  store.releaseRepositoryLease(lease);

  equal(store.readConvergenceOperation(runId, 1)?.phase, "published");
  equal(store.readCampaign(runId)?.status, "open");
  equal(store.readMeta(followupRunId).status, "queued");
  equal(existsSync(paths.packetFile(followupRunId)), false);
  equal(store.claimNextQueuedRun([], "pending-convergence"), undefined);

  await rm(paths.runDir(followupRunId), { force: true });
  const recovered = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  ok(existsSync(paths.packetFile(followupRunId)));
  equal(recovered.claimNextQueuedRun([], "recovered-convergence")?.runId, followupRunId);
  await cleanTemp(tmp);
});

test("store: follow-up admission commits its terminal review event atomically", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-followup-decision-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const runId = "20260101-000000-followup-decision";
  const parentRunId = "20260101-000000-parent";
  const campaign = {
    campaignId: "campaign-decision",
    originalRunId: parentRunId,
    originalIntent: "test",
    status: "open" as const,
    maxPasses: 3,
    passes: [],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  store.admitQueueWithCampaign(runId, makeTestPacket().raw, campaign, {
    runId: parentRunId,
    event: {
      at: "2026-01-01T00:00:00.000Z",
      event: "super_review",
      pass: 1,
      verdict: "request_changes",
      proposedVerdict: "request_changes",
      findings: [],
    },
  });

  equal(store.readMeta(runId).status, "queued");
  equal(store.readJournal(parentRunId).at(-1)?.event, "super_review");
  await cleanTemp(tmp);
});

test("store: readMetaIfExists returns undefined for absent run", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-meta-if-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  equal(store.readMetaIfExists("20990101-000000-absent"), undefined);
  await cleanTemp(tmp);
});

test("store: listRunIds returns sorted ids", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-list-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  strictEqual(store.listRunIds().length, 0);
  const meta1 = {
    runId: "20260101-000000-z",
    status: "queued" as const,
    attempt: 0,
    repo: "/tmp/r",
    base: "main",
    branch: "b",
    worktree: tmp,
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  const meta2 = {
    runId: "20260101-000000-a",
    status: "queued" as const,
    attempt: 0,
    repo: "/tmp/r",
    base: "main",
    branch: "b",
    worktree: tmp,
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta1);
  store.writeMeta(meta2);
  const ids = store.listRunIds();
  strictEqual(ids.length, 2);
  equal(ids[0], meta2.runId);
  equal(ids[1], meta1.runId);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Outcome ledger

test("store: initialLedger creates from packet outcomes", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-ledger-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = makeTestPacket();
  const ledger = store.initialLedger(packet);
  equal(ledger.runId, "20260101-000000-test");
  strictEqual(ledger.outcomes.length, 1);
  equal(ledger.outcomes[0]!.id, "test-outcome");
  equal(ledger.outcomes[0]!.status, "not_started");
  await cleanTemp(tmp);
});

test("store: ledger round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-ledger2-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const ledger = {
    runId: "20260101-000000-test",
    outcomes: [
      {
        id: "test-outcome",
        description: "A test outcome",
        status: "done" as const,
        evidence: ["evidence.txt"],
        updatedAt: clock.nowIso(),
      },
    ],
    updatedAt: clock.nowIso(),
  };
  store.writeLedger(ledger);
  const read = store.readLedger(ledger.runId);
  equal(read.runId, ledger.runId);
  equal(read.outcomes[0]!.status, "done");
  equal(read.outcomes[0]!.evidence[0], "evidence.txt");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Review state

test("store: review state round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-review-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const initial = store.initialReviewState("20260101-000000-test");
  equal(initial.runId, "20260101-000000-test");
  strictEqual(initial.obligations.length, 0);
  const replaced = store.replaceObligations(initial.runId, ["fix x", "  ", "fix y"]);
  equal(replaced.obligations.length, 2);
  equal(replaced.obligations[0], "fix x");
  equal(replaced.obligations[1], "fix y");
  ok(replaced.lastDecisionAt);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Decisions (jsonl)

test("store: decisions append and read", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-dec-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const d1 = {
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "daddy" as const,
    questionType: "other",
    question: "q1",
    status: "proceed",
    answer: "a1",
    evidence: [],
    constraints: [],
  };
  const d2 = {
    timestamp: "2026-01-01T00:00:01.000Z",
    source: "max" as const,
    questionType: "other",
    question: "q2",
    status: "proceed",
    answer: "a2",
    evidence: [],
    constraints: [],
  };
  store.appendDecision("20260101-000000-test", d1);
  store.appendDecision("20260101-000000-test", d2);
  const decisions = store.readDecisions("20260101-000000-test");
  strictEqual(decisions.length, 2);
  equal(decisions[0]!.question, "q1");
  equal(decisions[1]!.question, "q2");
  strictEqual(store.readDecisions("nonexistent-run").length, 0);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Checkpoints

test("store: checkpoints", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-ckp-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  equal(store.nextCheckpointNumber("20260101-000000-test"), 1);
  const c1 = {
    number: 1,
    reason: "checkpoint",
    summary: "s1",
    outcomes: [{ id: "o1", status: "done" as const, evidence: [] }],
    filesChanged: [],
    filesInspected: [],
    uncertainties: [],
    writtenAt: clock.nowIso(),
  };
  const c2 = {
    number: 2,
    reason: "checkpoint",
    summary: "s2",
    outcomes: [{ id: "o1", status: "done" as const, evidence: [] }],
    filesChanged: [],
    filesInspected: [],
    uncertainties: [],
    writtenAt: clock.nowIso(),
  };
  store.writeCheckpoint("20260101-000000-test", c1);
  store.writeCheckpoint("20260101-000000-test", c2);
  equal(store.nextCheckpointNumber("20260101-000000-test"), 3);
  const latest = store.latestCheckpoint("20260101-000000-test");
  equal(latest?.number, 2);
  equal(latest?.summary, "s2");
  equal(store.latestCheckpoint("nonexistent"), undefined);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Gate state

test("store: gate state round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-gate-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const state = {
    runId: "20260101-000000-test",
    phase: { phase: "cleared" } as const,
    expectedGlobs: ["src/**/*.ts"],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  };
  store.writeGateState(state.runId, state);
  const read = store.readGateState(state.runId);
  equal(read.runId, state.runId);
  equal(read.phase.phase, "cleared");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Report and Nits (markdown)

test("store: report read/write", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-rep-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const report = {
    status: "ready_for_review" as const,
    summary: "done",
    filesChanged: [],
    behaviourChanged: [],
    sourceOfTruthFollowed: [],
    outcomeClaims: [],
    verificationClaims: [],
    escalations: [],
    remainingUncertainty: [],
    regressionGuard: { tests: [] },
  };
  store.writeReport("20260101-000000-test", report, "# Report\n\ndone");
  equal(store.readReport("20260101-000000-test"), "# Report\n\ndone");
  equal(store.readReport("nonexistent"), "");
  await cleanTemp(tmp);
});

test("store: nits read/write", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-nits-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  store.writeNits("20260101-000000-test", "# Nits\n\nnone");
  equal(store.readNits("20260101-000000-test"), "# Nits\n\nnone");
  equal(store.readNits("nonexistent"), "");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Convergence (jsonl)

test("store: convergence round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-conv-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  const entry = makeValidConvergenceEntry();
  store.appendConvergence(entry.runId, entry);
  const entries = store.readConvergence(entry.runId);
  strictEqual(entries.length, 1);
  const first = entries[0]!;
  equal(first.runId, entry.runId);
  equal(first.kind, "reviewed");
  if (first.kind === "reviewed") {
    equal(first.decision.action, "stop");
  }
  strictEqual(store.readConvergence("nonexistent").length, 0);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Active run — multi-row

test("store: active run multi-row add/remove/list", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-active-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  deepEqual(store.listActiveRuns(), []);
  const run1 = {
    runId: "20260101-000000-test",
    runDir: join(tmp, "runs/20260101-000000-test"),
    worktree: join(tmp, "worktree"),
    babySessionId: "sess1",
    startedAt: clock.nowIso(),
  };
  store.addActiveRun(run1);
  let runs = store.listActiveRuns();
  equal(runs.length, 1);
  equal(runs[0]!.runId, run1.runId);
  const run2 = { ...run1, runId: "20260101-000000-test2", babySessionId: "sess2" };
  store.addActiveRun(run2);
  runs = store.listActiveRuns();
  equal(runs.length, 2);
  store.removeActiveRun("20260101-000000-test");
  runs = store.listActiveRuns();
  equal(runs.length, 1);
  equal(runs[0]!.runId, run2.runId);
  store.removeActiveRun("20260101-000000-test2");
  deepEqual(store.listActiveRuns(), []);
  await cleanTemp(tmp);
});

test("store: active run upsert (rotation replaces babySessionId)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-active-upsert-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const run = {
    runId: "20260101-000000-test",
    runDir: join(tmp, "runs/20260101-000000-test"),
    worktree: join(tmp, "worktree"),
    babySessionId: "sess1",
    startedAt: clock.nowIso(),
  };
  store.addActiveRun(run);
  const runRotated = { ...run, babySessionId: "sess2", startedAt: clock.nowIso() };
  store.addActiveRun(runRotated);
  const runs = store.listActiveRuns();
  equal(runs.length, 1);
  equal(runs[0]!.babySessionId, "sess2");
  equal(runs[0]!.startedAt, runRotated.startedAt);
  await cleanTemp(tmp);
});

test("store: active run json file is array", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-active-json-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const run1 = {
    runId: "20260101-000000-test",
    runDir: join(tmp, "runs/20260101-000000-test"),
    worktree: join(tmp, "worktree"),
    babySessionId: "sess1",
    startedAt: clock.nowIso(),
  };
  const run2 = { ...run1, runId: "20260101-000000-test2", babySessionId: "sess2" };
  store.addActiveRun(run1);
  store.addActiveRun(run2);
  const content = readFileSync(join(tmp, "active-run.json"), "utf-8");
  const parsed = JSON.parse(content);
  ok(Array.isArray(parsed));
  equal(parsed.length, 2);
  equal(parsed[0]!.runId, run1.runId);
  equal(parsed[1]!.runId, run2.runId);
  store.removeActiveRun("20260101-000000-test");
  const content2 = readFileSync(join(tmp, "active-run.json"), "utf-8");
  const parsed2 = JSON.parse(content2);
  equal(parsed2.length, 1);
  store.removeActiveRun("20260101-000000-test2");
  const content3 = readFileSync(join(tmp, "active-run.json"), "utf-8");
  const parsed3 = JSON.parse(content3);
  ok(Array.isArray(parsed3));
  equal(parsed3.length, 0);
  await cleanTemp(tmp);
});

test("store: active run projection stays current across adapter writers and leaves no shared temp file", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-active-cross-writer-"));
  const paths = makePaths(tmp);
  const first = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const second = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const run = {
    runId: "run",
    runDir: join(tmp, "runs/run"),
    worktree: join(tmp, "worktree"),
    babySessionId: "baby",
    startedAt: "now",
  };

  first.addActiveRun(run);
  second.removeActiveRun(run.runId);
  first.syncActiveRunProjection();

  deepEqual(JSON.parse(readFileSync(join(tmp, "active-run.json"), "utf-8")), []);
  deepEqual(
    readdirSync(tmp).filter((name) => name.includes("active-run.json.") && name.endsWith(".tmp")),
    [],
  );
  await cleanTemp(tmp);
});

test("store: active convergence multi-row add/remove/list", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-active-convergence-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  deepEqual(store.listActiveConvergences(), []);
  const convergence = {
    runId: "20260101-000000-test",
    startedAt: clock.nowIso(),
  };
  store.addActiveConvergence(convergence);
  let list = store.listActiveConvergences();
  equal(list.length, 1);
  equal(list[0]!.runId, convergence.runId);
  store.removeActiveConvergence("20260101-000000-test");
  deepEqual(store.listActiveConvergences(), []);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Campaign

test("store: campaign round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-camp-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  equal(store.readCampaign("test-campaign"), undefined);
  const campaign = {
    campaignId: "test-campaign",
    originalRunId: "20260101-000000-test",
    originalIntent: "do a thing",
    status: "open" as const,
    maxPasses: 5,
    passes: [],
    updatedAt: clock.nowIso(),
  };
  store.writeCampaign(campaign);
  const read = store.readCampaign("test-campaign");
  ok(read);
  equal(read!.campaignId, "test-campaign");
  equal(read!.originalIntent, "do a thing");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Queue — list

test("store: listQueue empty", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-qlist-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  strictEqual(store.listQueue().length, 0);
  await cleanTemp(tmp);
});

test("store: listQueue returns fresh packets", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-qlist2-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  const packet1 = `---
repo: /tmp/repo
base: main
compare_commit: main
summary: p1
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  const packet2 = `---
repo: /tmp/repo
base: main
compare_commit: main
summary: p2
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-b", packet2);
  store.admitQueue("20260101-000000-a", packet1);
  const entries = store.listQueue();
  strictEqual(entries.length, 2);
  equal(entries[0]!.runId, "20260101-000000-a");
  equal(entries[1]!.runId, "20260101-000000-b");
  await cleanTemp(tmp);
});

test("store: listQueue returns all queued runs in lexical order", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-qlist3-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  // Create a run dir with meta.status = "queued"
  const runId = "20260101-000000-requeued";
  const meta = {
    runId,
    status: "queued" as const,
    attempt: 0,
    repo: "/tmp/r",
    base: "main",
    branch: "b",
    worktree: join(tmp, "w"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  // Admit a fresh packet too
  const packet = `---
repo: /tmp/repo
base: main
compare_commit: main
summary: fresh
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-fresh", packet);
  const entries = store.listQueue();
  strictEqual(entries.length, 2);
  // Lexical order: 'f' < 'r' (both are fresh, so run_id sorts lexically)
  equal(entries[0]!.runId, "20260101-000000-fresh");
  ok(entries[0]!.admittedAt);
  equal(entries[1]!.runId, runId);
  await cleanTemp(tmp);
});

test("store: listQueue returns requeued runs before fresh runs", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-qlist-requeue-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  // Fresh runs (attempt=1)
  store.admitQueue("20260101-000000-fresh-a", makeTestPacket().raw);
  store.admitQueue("20260101-000000-fresh-b", makeTestPacket({ repo: "/tmp/other-repo" }).raw);
  // Requeued run (attempt=2) — should be first
  const requeuedMeta = {
    runId: "20260101-000000-requeued",
    status: "queued" as const,
    attempt: 2,
    repo: "/tmp/r",
    base: "main",
    branch: "b",
    worktree: join(tmp, "w"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(requeuedMeta);
  const entries = store.listQueue();
  strictEqual(entries.length, 3);
  // Requeued (attempt=2) comes first despite run_id ordering
  equal(entries[0]!.runId, "20260101-000000-requeued");
  // Fresh runs sorted lexically after
  equal(entries[1]!.runId, "20260101-000000-fresh-a");
  equal(entries[2]!.runId, "20260101-000000-fresh-b");
  await cleanTemp(tmp);
});

test("store: claimNextQueuedRun returns one run and marks it running", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-claim-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = makeTestPacket();
  store.admitQueue("20260101-000000-run-a", packet.raw);
  strictEqual(store.listQueue().length, 1);
  const claimed = store.claimNextQueuedRun([]);
  ok(claimed, "should claim a run");
  equal(claimed!.runId, "20260101-000000-run-a");
  // Run is now running — listQueue should be empty
  strictEqual(store.listQueue().length, 0);
  // Meta should show status: running
  const meta = store.readMeta("20260101-000000-run-a");
  equal(meta.status, "running");
  await cleanTemp(tmp);
});

test("store: claimNextQueuedRun second call returns undefined when queue empty", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-claim-dup-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.admitQueue("20260101-000000-run-a", makeTestPacket().raw);
  const first = store.claimNextQueuedRun([]);
  ok(first, "first claim should succeed");
  const second = store.claimNextQueuedRun([]);
  strictEqual(second, undefined, "second claim should return undefined");
  await cleanTemp(tmp);
});

test("store: claimNextQueuedRun skips excluded repos", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-claim-excl-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.admitQueue("20260101-000000-run-a", makeTestPacket().raw);
  const metaB = {
    runId: "20260101-000000-run-b",
    status: "queued" as const,
    attempt: 0,
    repo: "/tmp/other-repo",
    base: "main",
    branch: "b",
    worktree: join(tmp, "run-b", "worktree"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  mkdirSync(join(tmp, "run-b", "worktree"), { recursive: true });
  store.writeMeta(metaB);
  // Exclude repo-a — should get repo-b
  const claimed = store.claimNextQueuedRun(["/tmp/test-repo"]);
  ok(claimed, "should claim the non-excluded run");
  equal(claimed!.runId, "20260101-000000-run-b");
  await cleanTemp(tmp);
});

test("store: claimNextQueuedRun claims requeued before fresh", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-claim-prio-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  // Fresh runs
  store.admitQueue("20260101-000000-fresh-a", makeTestPacket().raw);
  store.admitQueue("20260101-000000-fresh-b", makeTestPacket({ repo: "/tmp/other-repo" }).raw);
  // Requeued run
  const requeuedMeta = {
    runId: "20260101-000000-requeued",
    status: "queued" as const,
    attempt: 3,
    repo: "/tmp/r",
    base: "main",
    branch: "b",
    worktree: join(tmp, "w"),
    stallRetries: 2,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(requeuedMeta);
  // Claim should pick requeued first
  const claimed = store.claimNextQueuedRun([]);
  ok(claimed, "should claim requeued run first");
  equal(claimed!.runId, "20260101-000000-requeued");
  // Next claim should pick a fresh run
  const next = store.claimNextQueuedRun([]);
  ok(next, "should claim a fresh run next");
  equal(next!.runId, "20260101-000000-fresh-a");
  await cleanTemp(tmp);
});

test("store: claimNextQueuedRun holds one lease per repository", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-claim-retry-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  // Queue two runs: run-a and run-b (both /tmp/test-repo, run-a sorts first).
  store.admitQueue("20260101-000000-run-a", makeTestPacket().raw);
  const metaB = {
    runId: "20260101-000000-run-b",
    status: "queued" as const,
    attempt: 0,
    repo: "/tmp/test-repo",
    base: "main",
    branch: "b",
    worktree: join(tmp, "run-b", "worktree"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  };
  mkdirSync(join(tmp, "run-b", "worktree"), { recursive: true });
  store.writeMeta(metaB);
  strictEqual(store.listQueue().length, 2);

  const claimed = store.claimNextQueuedRun([]);
  ok(claimed);
  equal(claimed.runId, "20260101-000000-run-a");
  const lease = store.listRepositoryLeases().at(0)!;
  equal(lease.repo, "/tmp/test-repo");
  equal(lease.ownerId, claimed.lease.ownerId);
  equal(lease.runId, "20260101-000000-run-a");
  equal(lease.purpose, "execute");
  equal(lease.epoch, 1);
  equal(lease.acquiredAt, claimed.admittedAt);
  strictEqual(store.claimNextQueuedRun([]), undefined);

  store.releaseRepositoryLease(claimed.lease);
  const next = store.claimNextQueuedRun([]);
  ok(next);
  equal(next.runId, "20260101-000000-run-b");
  await cleanTemp(tmp);
});

test("store: startup preserves live repository leases", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-lease-cutoff-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const live = store.acquireRepositoryLease("/tmp/live", "live-owner", "live-run", "accept")!;
  const reopened = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  deepEqual(reopened.listRepositoryLeases(), [live]);
  strictEqual(
    reopened.acquireRepositoryLease("/tmp/live", "other", "other-run", "execute"),
    undefined,
  );
  await cleanTemp(tmp);
});

test("store: repository lease epoch increments after expiry reclaim", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-lease-epoch-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const first = store.acquireRepositoryLease("/tmp/repo", "owner-a", "run-a", "execute")!;
  const db = new DatabaseSync(paths.dbFile);
  db.prepare("UPDATE repository_leases SET expires_at = ? WHERE repo = ?").run(
    "2000-01-01T00:00:00.000Z",
    first.repo,
  );
  db.prepare("UPDATE repository_lease_owners SET pid = 2147483647 WHERE owner_id = ?").run(
    first.ownerId,
  );
  db.close();

  const second = store.acquireRepositoryLease("/tmp/repo", "owner-b", "run-b", "execute")!;
  equal(second.epoch, first.epoch + 1);
  equal(second.ownerId, "owner-b");
  await cleanTemp(tmp);
});

test("store: an expired lease held by a live process cannot be reclaimed during a synchronous effect", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-lease-live-owner-"));
  const paths = makePaths(tmp);
  const first = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const second = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const lease = first.acquireRepositoryLease("/tmp/repo", "owner-a", "run-a", "execute")!;
  const db = new DatabaseSync(paths.dbFile);
  db.prepare("UPDATE repository_leases SET expires_at = ? WHERE repo = ?").run(
    "2000-01-01T00:00:00.000Z",
    lease.repo,
  );
  db.close();

  strictEqual(second.acquireRepositoryLease(lease.repo, "owner-b", "run-b", "execute"), undefined);
  equal(first.heartbeatRepositoryLease(lease)?.epoch, lease.epoch);
  await cleanTemp(tmp);
});

test("store: an expired lease from another process instance is reclaimable despite PID reuse", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-lease-pid-reuse-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const stale = store.acquireRepositoryLease("/tmp/repo", "owner-a", "run-a", "execute")!;
  const db = new DatabaseSync(paths.dbFile);
  db.prepare("UPDATE repository_leases SET expires_at = ? WHERE repo = ?").run(
    "2000-01-01T00:00:00.000Z",
    stale.repo,
  );
  db.prepare(
    "UPDATE repository_lease_owners SET process_instance_token = ? WHERE owner_id = ?",
  ).run("prior-process-instance", stale.ownerId);
  db.close();

  const current = store.acquireRepositoryLease(stale.repo, "owner-b", "run-b", "execute")!;
  equal(current.epoch, stale.epoch + 1);
  equal(current.ownerId, "owner-b");
  await cleanTemp(tmp);
});

test("store: stale release cannot delete a newer repository lease", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-lease-release-cas-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const stale = store.acquireRepositoryLease("/tmp/repo", "owner-a", "run-a", "execute")!;
  const db = new DatabaseSync(paths.dbFile);
  db.prepare("UPDATE repository_leases SET expires_at = ? WHERE repo = ?").run(
    "2000-01-01T00:00:00.000Z",
    stale.repo,
  );
  db.prepare("UPDATE repository_lease_owners SET pid = 2147483647 WHERE owner_id = ?").run(
    stale.ownerId,
  );
  db.close();
  const current = store.acquireRepositoryLease("/tmp/repo", "owner-b", "run-b", "execute")!;

  equal(store.releaseRepositoryLease(stale), false);
  equal(store.listRepositoryLeases().at(0)?.epoch, current.epoch);
  await cleanTemp(tmp);
});

test("store: stale heartbeat cannot renew a newer repository lease", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-lease-heartbeat-cas-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const stale = store.acquireRepositoryLease("/tmp/repo", "owner-a", "run-a", "execute")!;
  const db = new DatabaseSync(paths.dbFile);
  db.prepare("UPDATE repository_leases SET expires_at = ? WHERE repo = ?").run(
    "2000-01-01T00:00:00.000Z",
    stale.repo,
  );
  db.prepare("UPDATE repository_lease_owners SET pid = 2147483647 WHERE owner_id = ?").run(
    stale.ownerId,
  );
  db.close();
  const current = store.acquireRepositoryLease("/tmp/repo", "owner-b", "run-b", "execute")!;

  strictEqual(store.heartbeatRepositoryLease(stale), undefined);
  equal(store.listRepositoryLeases().at(0)?.epoch, current.epoch);
  await cleanTemp(tmp);
});

test("store: queue claim commits run transition and lease atomically", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-claim-atomic-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const runId = "20260101-000000-atomic";
  store.admitQueue(runId, makeTestPacket().raw);
  const db = new DatabaseSync(paths.dbFile);
  db.exec(
    "CREATE TRIGGER fail_lease BEFORE INSERT ON repository_leases BEGIN SELECT RAISE(ABORT, 'lease failed'); END;",
  );

  throws(() => store.claimNextQueuedRun([], "worker-a"), /lease failed/);
  equal(store.readMeta(runId).status, "queued");
  deepEqual(store.listRepositoryLeases(), []);
  db.close();
  await cleanTemp(tmp);
});

test("store: acceptance owners are isolated by repository lease", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-accept-owner-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  const first = store.acquireRepositoryLease("/tmp/repo", "accept-a", "run-a", "accept")!;

  strictEqual(store.acquireRepositoryLease("/tmp/repo", "accept-b", "run-b", "accept"), undefined);
  equal(store.releaseRepositoryLease({ ...first, ownerId: "accept-b" }), false);
  equal(store.listRepositoryLeases().at(0)?.ownerId, "accept-a");
  await cleanTemp(tmp);
});

test("store: an expired lease cannot be stolen while its child process owner is alive", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-live-process-lease-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  ok(child.pid);
  const startedAt = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(child.pid)], {
    encoding: "utf8",
  }).trim();
  ok(startedAt);

  const db = new DatabaseSync(paths.dbFile);
  db.prepare(
    "INSERT INTO repository_lease_owners(owner_id, pid, process_instance_token) VALUES (?, ?, ?)",
  ).run("child-owner", child.pid, `${child.pid}:${startedAt}`);
  db.prepare(
    "INSERT INTO repository_leases(repo, owner_id, run_id, purpose, epoch, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, 'execute', 1, ?, ?, ?)",
  ).run(
    "/tmp/repo",
    "child-owner",
    "child-run",
    "2025-01-01T00:00:00.000Z",
    "2025-01-01T00:00:00.000Z",
    "2025-01-01T00:00:01.000Z",
  );
  db.close();

  try {
    strictEqual(
      store.acquireRepositoryLease("/tmp/repo", "contender", "other-run", "execute"),
      undefined,
    );
    equal(store.listRepositoryLeases().at(0)?.ownerId, "child-owner");
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
  }

  const expiredDb = new DatabaseSync(paths.dbFile);
  expiredDb
    .prepare("UPDATE repository_leases SET expires_at = ? WHERE repo = ?")
    .run("2025-01-01T00:00:01.000Z", "/tmp/repo");
  expiredDb.close();
  ok(store.acquireRepositoryLease("/tmp/repo", "contender", "other-run", "execute"));
  await cleanTemp(tmp);
});

test("store: queued cancellation cannot overwrite a claim won by another connection", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-cancel-claim-race-"));
  const paths = makePaths(tmp);
  const clock = fixedClock();
  const cancelling = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const claiming = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const runId = "20260101-000000-cancel-race";
  cancelling.writeMeta({
    runId,
    status: "queued",
    attempt: 0,
    repo: "/tmp/repo",
    base: "main",
    branch: `meridian/${runId}`,
    worktree: join(tmp, "runs", runId, "worktree"),
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: clock.nowIso(),
  });

  equal(claiming.claimNextQueuedRun([])?.runId, runId);
  await rejects(async () => cancelling.archiveQueue(runId), /status conflict/);
  equal(cancelling.readMeta(runId).status, "running");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Queue — admit (constraint 1: explicit base vs no base split)

test("store: admitQueue rejects packet with no repo in frontmatter", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-no-repo-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = `---
base: main
compare_commit: main
summary: no repo
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  // Should be archived in the rejected table
  const rejected = store.readRejected("20260101-000000-test");
  ok(rejected, "archived packet should exist");
  match(rejected!.problems ?? "", /no repo/);
  // Nothing in queue
  strictEqual(store.listQueue().length, 0);
  await cleanTemp(tmp);
});

test("store: admitQueue with explicit base — headBranch NOT called", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-explicit-"));
  const clock = fixedClock();
  const repo = fakeRepo({ headBranch: "develop", branchExists: true });
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  const packet = `---
repo: ${tmp}/test-repo
base: stable-branch
compare_commit: main
summary: explicit base
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  strictEqual(repo.headBranchCallCount, 0, "headBranch should not be called when base is explicit");
  const admittedRaw = store.readQueuePacket("20260101-000000-test");
  match(admittedRaw!, /base: stable-branch/);
  await cleanTemp(tmp);
});

test("store: duplicate admission cannot replace run metadata or packet", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-duplicate-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const runId = "20260101-000000-duplicate";
  const original = makeTestPacket().raw;
  store.admitQueue(runId, original);
  ok(store.claimNextQueuedRun([]));

  const replacement = original.replace("test summary", "replacement summary");
  await rejects(async () => store.admitQueue(runId, replacement), /run already exists/);
  equal(store.readMeta(runId).status, "running");
  equal(store.readMeta(runId).attempt, 1);
  equal(store.readQueuePacket(runId), original);
  await cleanTemp(tmp);
});

test("store: admitQueue without base — headBranch called and stamped", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-nobase-"));
  const clock = fixedClock();
  const repo = fakeRepo({ headBranch: "develop", branchExists: true });
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  const packet = `---
repo: ${tmp}/test-repo
compare_commit: main
summary: no explicit base
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  strictEqual(repo.headBranchCallCount, 1, "headBranch should be called when base is absent");
  const admittedRaw = store.readQueuePacket("20260101-000000-test");
  match(admittedRaw!, /base: develop/);
  await cleanTemp(tmp);
});

test("store: admitQueue rejects when headBranch throws", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-throw-"));
  const clock = fixedClock();
  const repo = fakeRepo({ headBranchThrows: true });
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  const packet = `---
repo: /tmp/nowhere
compare_commit: main
summary: headBranch fails
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  strictEqual(repo.headBranchCallCount, 1, "headBranch should have been called");
  const rejected = store.readRejected("20260101-000000-test");
  ok(rejected, "archived packet should exist");
  match(rejected!.problems ?? "", /headBranch failed/);
  await cleanTemp(tmp);
});

test("store: admitQueue rejects invalid packet shape", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-badfm-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: missing outcomes
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  const rejected = store.readRejected("20260101-000000-test");
  ok(rejected, "archived packet should exist");
  match(rejected!.problems ?? "", /outcomes/);
  await cleanTemp(tmp);
});

test("store: admitQueue rejects when repoValid returns false", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-repoval-"));
  const clock = fixedClock();
  const repo = fakeRepo({ repoValid: false });
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  const packet = `---
repo: ${tmp}/test-repo
base: main
compare_commit: main
summary: repoValid fails
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  const rejected = store.readRejected("20260101-000000-test");
  ok(rejected, "archived packet should exist");
  match(rejected!.problems ?? "", /not a valid git repository/);
  strictEqual(store.listQueue().length, 0);
  await cleanTemp(tmp);
});

test("store: admitQueue stamps promoted:true from frontmatter", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-promoted-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = `---
repo: /tmp/test-repo
base: main
compare_commit: main
promoted: true
summary: promoted packet
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-promo", packet);
  const meta = store.readMetaIfExists("20260101-000000-promo");
  ok(meta, "meta should exist after admit");
  strictEqual(meta!.promoted, true, "promoted should be true from frontmatter");
  await cleanTemp(tmp);
});

test("store: admitQueue stamps babyModel from frontmatter", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-babymodel-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = `---
repo: /tmp/test-repo
base: main
compare_commit: main
baby_model: codestral-latest
summary: baby model packet
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-babymodel", packet);
  const meta = store.readMetaIfExists("20260101-000000-babymodel");
  ok(meta, "meta should exist after admit");
  strictEqual(meta!.babyModel, "codestral-latest", "babyModel should be set from frontmatter");
  await cleanTemp(tmp);
});

test("store: admitQueue omits babyModel when absent from frontmatter", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-nobabymodel-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: no baby model
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-nobabymodel", packet);
  const meta = store.readMetaIfExists("20260101-000000-nobabymodel");
  ok(meta, "meta should exist after admit");
  strictEqual(
    (meta as any).babyModel,
    undefined,
    "babyModel should be absent when frontmatter lacks baby_model",
  );
  await cleanTemp(tmp);
});

test("store: admitQueue defaults promoted:false when absent from frontmatter", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-nopromo-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: not promoted
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-nopromo", packet);
  const meta = store.readMetaIfExists("20260101-000000-nopromo");
  ok(meta, "meta should exist after admit");
  strictEqual(meta!.promoted, false, "promoted should default to false");
  await cleanTemp(tmp);
});

test("store: archiveQueue marks run stopped in SQLite", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-arch-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: archive me
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  ok(
    store.listQueue().some((q) => q.runId === "20260101-000000-test"),
    "should be queued after admit",
  );
  store.archiveQueue("20260101-000000-test");
  equal(
    store.listQueue().some((q) => q.runId === "20260101-000000-test"),
    false,
    "should not be queued after archive",
  );
  const meta = store.readMetaIfExists("20260101-000000-test");
  equal(meta?.status, "stopped");
  await cleanTemp(tmp);
});

test("store: archiveQueue is no-op when file absent", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-arch-noop-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  store.archiveQueue("nonexistent");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Staged-chain registry

test("store: staged write/read/list/remove", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-staged-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  const packet = `---
repo: /tmp/test-repo
compare_commit: main
summary: staged child
parent_run_id: 20260101-000000-parent
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  strictEqual(store.listStaged().length, 0);
  strictEqual(store.readStaged("20260101-000000-child"), undefined);
  store.writeStaged("20260101-000000-child", packet);
  equal(store.readStaged("20260101-000000-child"), packet);
  const staged = store.listStaged();
  strictEqual(staged.length, 1);
  equal(staged[0]!.runId, "20260101-000000-child");
  equal(staged[0]!.parentRunId, "20260101-000000-parent");
  equal(staged[0]!.repo, "/tmp/test-repo");
  store.removeStaged("20260101-000000-child");
  strictEqual(store.readStaged("20260101-000000-child"), undefined);
  strictEqual(store.listStaged().length, 0);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Journal (J3: lenient read)

test("store: journal append and read", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-jrnl-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const event = {
    at: clock.nowIso(),
    event: "run_started" as const,
    runId: "20260101-000000-test",
    attempt: 1,
  };
  store.appendJournal("20260101-000000-test", event);
  const events = store.readJournal("20260101-000000-test");
  strictEqual(events.length, 1);
  equal(events[0]!.event, "run_started");
  strictEqual(store.readJournal("nonexistent").length, 0);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Parity: contract tests over the SQLite adapter
// ---------------------------------------------------------------------------

const runContractTests = async (
  label: string,
  createStore: (tmp: string, repo: Repo, clock: Clock) => Store,
) => {
  // Meta round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-meta-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const meta = {
      runId: "20260101-000000-meta",
      status: "queued" as const,
      attempt: 0,
      repo: "/tmp/repo",
      base: "main",
      branch: "meridian/20260101-000000-meta",
      worktree: join(tmp, "worktree"),
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      promoted: false,
      pass: 1,
      updatedAt: clock.nowIso(),
    };
    store.writeMeta(meta);
    const read = store.readMeta(meta.runId);
    equal(read.runId, meta.runId);
    equal(read.status, "queued");
    equal(read.attempt, 0);
    await cleanTemp(tmp);
  }

  // readMetaIfExists returns undefined for absent run
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-meta-if-`));
    const store = createStore(tmp, fakeRepo(), fixedClock());
    equal(store.readMetaIfExists("20990101-000000-absent"), undefined);
    await cleanTemp(tmp);
  }

  // Outcome ledger round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-ledger-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const ledger = {
      runId: "20260101-000000-test",
      outcomes: [
        {
          id: "test-outcome",
          description: "A test outcome",
          status: "done" as const,
          evidence: ["evidence.txt"],
          updatedAt: clock.nowIso(),
        },
      ],
      updatedAt: clock.nowIso(),
    };
    store.writeLedger(ledger);
    const read = store.readLedger(ledger.runId);
    equal(read.runId, ledger.runId);
    equal(read.outcomes[0]!.status, "done");
    equal(read.outcomes[0]!.evidence[0], "evidence.txt");
    await cleanTemp(tmp);
  }

  // Review state round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-review-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const initial = store.initialReviewState("20260101-000000-test");
    equal(initial.runId, "20260101-000000-test");
    strictEqual(initial.obligations.length, 0);
    const replaced = store.replaceObligations(initial.runId, ["fix x", "  ", "fix y"]);
    equal(replaced.obligations.length, 2);
    equal(replaced.obligations[0], "fix x");
    equal(replaced.obligations[1], "fix y");
    ok(replaced.lastDecisionAt);
    await cleanTemp(tmp);
  }

  // Decisions append and read
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-dec-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const d1 = {
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "daddy" as const,
      questionType: "other",
      question: "q1",
      status: "proceed",
      answer: "a1",
      evidence: [],
      constraints: [],
    };
    store.appendDecision("20260101-000000-test", d1);
    const decisions = store.readDecisions("20260101-000000-test");
    strictEqual(decisions.length, 1);
    equal(decisions[0]!.question, "q1");
    await cleanTemp(tmp);
  }

  // Checkpoints
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-ckp-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    equal(store.nextCheckpointNumber("20260101-000000-test"), 1);
    const c1 = {
      number: 1,
      reason: "checkpoint",
      summary: "s1",
      outcomes: [{ id: "o1", status: "done" as const, evidence: [] }],
      filesChanged: [],
      filesInspected: [],
      uncertainties: [],
      writtenAt: clock.nowIso(),
    };
    const c2 = {
      number: 2,
      reason: "checkpoint",
      summary: "s2",
      outcomes: [{ id: "o1", status: "done" as const, evidence: [] }],
      filesChanged: [],
      filesInspected: [],
      uncertainties: [],
      writtenAt: clock.nowIso(),
    };
    store.writeCheckpoint("20260101-000000-test", c1);
    store.writeCheckpoint("20260101-000000-test", c2);
    equal(store.nextCheckpointNumber("20260101-000000-test"), 3);
    const latest = store.latestCheckpoint("20260101-000000-test");
    equal(latest?.number, 2);
    equal(latest?.summary, "s2");
    equal(store.latestCheckpoint("nonexistent"), undefined);
    await cleanTemp(tmp);
  }

  // Gate state round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-gate-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const state = {
      runId: "20260101-000000-test",
      phase: { phase: "cleared" } as const,
      expectedGlobs: ["src/**/*.ts"],
      suspiciousGlobs: [],
      baselineDiffStats: {},
      updatedAt: clock.nowIso(),
      mutationCommandPatterns: [],
    };
    store.writeGateState(state.runId, state);
    const read = store.readGateState(state.runId);
    equal(read.runId, state.runId);
    equal(read.phase.phase, "cleared");
    await cleanTemp(tmp);
  }

  // Report read/write
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-rep-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const report = {
      status: "ready_for_review" as const,
      summary: "done",
      filesChanged: [],
      behaviourChanged: [],
      sourceOfTruthFollowed: [],
      outcomeClaims: [],
      verificationClaims: [],
      escalations: [],
      remainingUncertainty: [],
      regressionGuard: { tests: [] },
    };
    store.writeReport("20260101-000000-test", report, "# Report\n\ndone");
    equal(store.readReport("20260101-000000-test"), "# Report\n\ndone");
    equal(store.readReport("nonexistent"), "");
    await cleanTemp(tmp);
  }

  // Nits read/write
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-nits-`));
    const store = createStore(tmp, fakeRepo(), fixedClock());
    store.writeNits("20260101-000000-test", "# Nits\n\nnone");
    equal(store.readNits("20260101-000000-test"), "# Nits\n\nnone");
    equal(store.readNits("nonexistent"), "");
    await cleanTemp(tmp);
  }

  // Convergence round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-conv-`));
    const store = createStore(tmp, fakeRepo(), fixedClock());
    const entry = makeValidConvergenceEntry();
    store.appendConvergence(entry.runId, entry);
    const entries = store.readConvergence(entry.runId);
    strictEqual(entries.length, 1);
    const first = entries[0]!;
    equal(first.runId, entry.runId);
    equal(first.kind, "reviewed");
    if (first.kind === "reviewed") {
      equal(first.decision.action, "stop");
    }
    await cleanTemp(tmp);
  }

  // Active run lifecycle — multi-row
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-active-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    deepEqual(store.listActiveRuns(), []);
    const run = {
      runId: "20260101-000000-test",
      runDir: join(tmp, "runs/20260101-000000-test"),
      worktree: join(tmp, "worktree"),
      babySessionId: "sess1",
      startedAt: clock.nowIso(),
    };
    store.addActiveRun(run);
    const list = store.listActiveRuns();
    ok(list.length > 0);
    equal(list[0]!.runId, run.runId);
    store.removeActiveRun("20260101-000000-test");
    deepEqual(store.listActiveRuns(), []);
    await cleanTemp(tmp);
  }

  // Active convergence lifecycle — multi-row
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-active-convergence-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    deepEqual(store.listActiveConvergences(), []);
    const convergence = {
      runId: "20260101-000000-test",
      startedAt: clock.nowIso(),
    };
    store.addActiveConvergence(convergence);
    const list = store.listActiveConvergences();
    ok(list.length > 0);
    equal(list[0]!.runId, convergence.runId);
    store.removeActiveConvergence("20260101-000000-test");
    deepEqual(store.listActiveConvergences(), []);
    await cleanTemp(tmp);
  }

  // Campaign round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-camp-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    equal(store.readCampaign("test-campaign"), undefined);
    const campaign = {
      campaignId: "test-campaign",
      originalRunId: "20260101-000000-test",
      originalIntent: "do a thing",
      status: "open" as const,
      maxPasses: 5,
      passes: [],
      updatedAt: clock.nowIso(),
    };
    store.writeCampaign(campaign);
    const read = store.readCampaign("test-campaign");
    ok(read);
    equal(read!.campaignId, "test-campaign");
    equal(read!.originalIntent, "do a thing");
    await cleanTemp(tmp);
  }

  // Queue — list empty
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-qlist-`));
    const store = createStore(tmp, fakeRepo(), fixedClock());
    strictEqual(store.listQueue().length, 0);
    await cleanTemp(tmp);
  }

  // Queue — multi-requeued ordering: requeued runs first in lexical order, then fresh
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-qlist2-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const packet = `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: packet
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
    // Write 3 requeued run metas in non-lexical order (z, a, b)
    // The file adapter sorts requeued lexically via listRunIds().sort()
    const zMeta = {
      runId: "20260101-000000-z",
      status: "queued" as const,
      attempt: 0,
      repo: "/tmp/r",
      base: "main",
      branch: "b",
      worktree: join(tmp, "w"),
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      promoted: false,
      pass: 1,
      updatedAt: clock.nowIso(),
    };
    const aMeta = {
      runId: "20260101-000000-a",
      status: "queued" as const,
      attempt: 0,
      repo: "/tmp/r",
      base: "main",
      branch: "b",
      worktree: join(tmp, "w"),
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      promoted: false,
      pass: 1,
      updatedAt: clock.nowIso(),
    };
    const bMeta = {
      runId: "20260101-000000-b",
      status: "queued" as const,
      attempt: 0,
      repo: "/tmp/r",
      base: "main",
      branch: "b",
      worktree: join(tmp, "w"),
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      promoted: false,
      pass: 1,
      updatedAt: clock.nowIso(),
    };
    store.writeMeta(zMeta);
    store.writeMeta(aMeta);
    store.writeMeta(bMeta);
    // Admit a fresh packet (goes through validation, writes meta + live packet)
    store.admitQueue("20260101-000000-fresh", packet);
    const entries = store.listQueue();
    strictEqual(entries.length, 4);
    // All queued runs in lexical order: a, b, fresh, z
    equal(entries[0]!.runId, "20260101-000000-a");
    equal(entries[1]!.runId, "20260101-000000-b");
    equal(entries[2]!.runId, "20260101-000000-fresh");
    equal(entries[3]!.runId, "20260101-000000-z");
    await cleanTemp(tmp);
  }

  // Queue — admit
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-adm-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const packet = `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: admit me
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
    store.admitQueue("20260101-000000-test", packet);
    const entries = store.listQueue();
    strictEqual(entries.length, 1);
    equal(entries[0]!.runId, "20260101-000000-test");
    await cleanTemp(tmp);
  }

  // Queue — archive
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-arch-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const packet = `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: archive me
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
    store.admitQueue("20260101-000000-test", packet);
    ok(store.listQueue().some((q) => q.runId === "20260101-000000-test"));
    store.archiveQueue("20260101-000000-test");
    equal(
      store.listQueue().some((q) => q.runId === "20260101-000000-test"),
      false,
    );
    const meta = store.readMetaIfExists("20260101-000000-test");
    equal(meta?.status, "stopped");
    await cleanTemp(tmp);
  }

  // Staged write/read/list/remove
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-staged-`));
    const store = createStore(tmp, fakeRepo(), fixedClock());
    const packet = `---
repo: /tmp/test-repo
compare_commit: main
summary: staged child
parent_run_id: 20260101-000000-parent
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
    strictEqual(store.listStaged().length, 0);
    strictEqual(store.readStaged("20260101-000000-child"), undefined);
    store.writeStaged("20260101-000000-child", packet);
    equal(store.readStaged("20260101-000000-child"), packet);
    const staged = store.listStaged();
    strictEqual(staged.length, 1);
    equal(staged[0]!.runId, "20260101-000000-child");
    equal(staged[0]!.parentRunId, "20260101-000000-parent");
    equal(staged[0]!.repo, "/tmp/test-repo");
    store.removeStaged("20260101-000000-child");
    strictEqual(store.readStaged("20260101-000000-child"), undefined);
    strictEqual(store.listStaged().length, 0);
    await cleanTemp(tmp);
  }

  // Journal append and read
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-jrnl-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const event = {
      at: clock.nowIso(),
      event: "run_started" as const,
      runId: "20260101-000000-test",
      attempt: 1,
    };
    store.appendJournal("20260101-000000-test", event);
    const events = store.readJournal("20260101-000000-test");
    strictEqual(events.length, 1);
    equal(events[0]!.event, "run_started");
    strictEqual(store.readJournal("nonexistent").length, 0);
    await cleanTemp(tmp);
  }

  // readJournalSince returns empty when no events
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-jrs-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    strictEqual(store.readJournalSince(0).length, 0);
    strictEqual(store.readJournalSince(999).length, 0);
    await cleanTemp(tmp);
  }

  // clearResumeArtifacts clears checkpoint, decisions, and review state
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-clear-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    store.writeCheckpoint("20260101-000000-test", {
      number: 1,
      reason: "checkpoint",
      summary: "s1",
      outcomes: [{ id: "o1", status: "done" as const, evidence: [] }],
      filesChanged: [],
      filesInspected: [],
      uncertainties: [],
      writtenAt: clock.nowIso(),
    });
    store.appendDecision("20260101-000000-test", {
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "daddy" as const,
      questionType: "other",
      question: "q1",
      status: "proceed",
      answer: "a1",
      evidence: [],
      constraints: [],
    });
    store.replaceObligations("20260101-000000-test", ["fix x"]);
    store.clearResumeArtifacts("20260101-000000-test");
    equal(store.latestCheckpoint("20260101-000000-test"), undefined);
    strictEqual(store.readDecisions("20260101-000000-test").length, 0);
    await rejects(async () => store.readReviewState("20260101-000000-test"));
    await cleanTemp(tmp);
  }
};

// Run contract tests against the SQLite adapter
test("store: parity — sqlite adapter", async () => {
  await runContractTests("sqlite", (tmp, repo, clock) =>
    SqliteStoreAdapter.create(makePaths(tmp), repo, clock),
  );
});

// ---------------------------------------------------------------------------
// SQLite-specific: WAL snapshot isolation
// ---------------------------------------------------------------------------

test("store: sqlite — WAL snapshot isolation", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-sqlite-wal-"));
  const dbPath = join(tmp, "data.db");

  // Connection A: writer
  const connA = new DatabaseSync(dbPath);
  connA.exec("PRAGMA journal_mode=WAL;");
  connA.exec("PRAGMA synchronous=NORMAL;");

  // Connection B: reader
  const connB = new DatabaseSync(dbPath);
  connB.exec("PRAGMA journal_mode=WAL;");
  connB.exec("PRAGMA synchronous=NORMAL;");

  // Create table and insert initial row (committed)
  connA.exec(`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  connA.prepare("INSERT INTO items (id, value) VALUES (?, ?)").run("1", "initial");

  // Writer begins a transaction and inserts a new row WITHOUT committing
  connA.exec("BEGIN");
  connA.prepare("INSERT INTO items (id, value) VALUES (?, ?)").run("2", "uncommitted");

  // Reader should NOT see the uncommitted row (WAL snapshot isolation)
  const beforeCommit = connB.prepare("SELECT id, value FROM items ORDER BY id").all();
  strictEqual(beforeCommit.length, 1);
  equal(beforeCommit[0]!.id, "1");
  equal(beforeCommit[0]!.value, "initial");

  // Commit the write
  connA.exec("COMMIT");

  // Reader should now see both rows
  const afterCommit = connB.prepare("SELECT id, value FROM items ORDER BY id").all();
  strictEqual(afterCommit.length, 2);
  equal(afterCommit[0]!.id, "1");
  equal(afterCommit[1]!.id, "2");
  equal(afterCommit[1]!.value, "uncommitted");

  connA.close();
  connB.close();
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// SQLite-specific: readJournalSince global seq ordering/resumption
// ---------------------------------------------------------------------------

test("store: sqlite — readJournalSince ordering across runIds", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-sqlite-jrs-"));
  const clock = fixedClock();
  const repo = fakeRepo();
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

  // Append events to two different runs
  const eventA1 = {
    at: "2026-01-01T00:00:01.000Z",
    event: "run_started" as const,
    runId: "run-a",
    attempt: 1,
  };
  const eventB1 = {
    at: "2026-01-01T00:00:02.000Z",
    event: "turn_ended" as const,
    runId: "run-b",
    messageId: "m1",
    tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    contextTokens: 150,
    text: "hello",
  };
  const eventA2 = {
    at: "2026-01-01T00:00:03.000Z",
    event: "turn_ended" as const,
    runId: "run-a",
    messageId: "m2",
    tokens: { input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    contextTokens: 250,
    text: "world",
  };

  store.appendJournal("run-a", eventA1);
  store.appendJournal("run-b", eventB1);
  store.appendJournal("run-a", eventA2);

  // readJournalSince(0) returns all events in seq order
  const all = store.readJournalSince(0);
  strictEqual(all.length, 3);
  equal(all[0]!.seq, 1);
  equal(all[0]!.runId, "run-a");
  equal(all[0]!.event.event, "run_started");
  equal(all[1]!.seq, 2);
  equal(all[1]!.runId, "run-b");
  equal(all[1]!.event.event, "turn_ended");
  equal(all[2]!.seq, 3);
  equal(all[2]!.runId, "run-a");
  equal(all[2]!.event.event, "turn_ended");

  // readJournalSince(1) returns events after seq 1 (resumption)
  const resumed = store.readJournalSince(1);
  strictEqual(resumed.length, 2);
  equal(resumed[0]!.seq, 2);
  equal(resumed[1]!.seq, 3);

  // readJournalSince(3) returns empty
  strictEqual(store.readJournalSince(3).length, 0);

  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Plans shelf — CRUD round-trip
// ---------------------------------------------------------------------------

test("store: plan CRUD round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-plans-crud-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

  const plan = {
    planId: "20260706-200000-test-plan",
    title: "Test Plan",
    raw: "---\nrepo: /tmp\n---\n\n# Body",
    tags: ["bug", "urgent"],
    createdAt: clock.nowIso(),
    updatedAt: clock.nowIso(),
  };
  store.writePlan(plan);

  const read = store.readPlan("20260706-200000-test-plan");
  ok(read, "plan should exist after write");
  equal(read!.planId, "20260706-200000-test-plan");
  equal(read!.title, "Test Plan");
  deepEqual(read!.tags, ["bug", "urgent"]);
  equal(read!.raw, "---\nrepo: /tmp\n---\n\n# Body");

  const listed = store.listPlans();
  strictEqual(listed.length, 1);
  equal(listed[0]!.planId, "20260706-200000-test-plan");

  store.deletePlan("20260706-200000-test-plan");
  equal(store.readPlan("20260706-200000-test-plan"), undefined, "plan deleted");

  await cleanTemp(tmp);
});

test("store: plan tags survive JSON round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-plans-tags-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

  store.writePlan({
    planId: "p1",
    title: "T",
    raw: "x",
    tags: ["a", "b", "c"],
    createdAt: clock.nowIso(),
    updatedAt: clock.nowIso(),
  });

  const read = store.readPlan("p1")!;
  deepEqual(read.tags, ["a", "b", "c"]);

  store.writePlan({
    ...read,
    tags: [],
  });
  deepEqual(store.readPlan("p1")!.tags, []);

  await cleanTemp(tmp);
});

test("store: plan queuedRunId is optional and round-trips when set", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-plans-queued-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

  store.writePlan({
    planId: "p1",
    title: "T",
    raw: "x",
    tags: [],
    createdAt: clock.nowIso(),
    updatedAt: clock.nowIso(),
  });
  ok(!store.readPlan("p1")!.queuedRunId, "no queuedRunId initially");

  store.writePlan({
    planId: "p1",
    title: "T",
    raw: "x",
    tags: [],
    queuedRunId: "20260706-200000-test-plan",
    createdAt: clock.nowIso(),
    updatedAt: clock.nowIso(),
  });
  equal(store.readPlan("p1")!.queuedRunId, "20260706-200000-test-plan");

  await cleanTemp(tmp);
});

test("store: plan list sorted by createdAt descending", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-plans-sort-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

  const t1 = clock.nowIso();
  const t2 = clock.nowIso();
  const t3 = clock.nowIso();

  store.writePlan({ planId: "old", title: "Old", raw: "", tags: [], createdAt: t1, updatedAt: t1 });
  store.writePlan({
    planId: "newest",
    title: "Newest",
    raw: "",
    tags: [],
    createdAt: t3,
    updatedAt: t3,
  });
  store.writePlan({ planId: "mid", title: "Mid", raw: "", tags: [], createdAt: t2, updatedAt: t2 });

  const listed = store.listPlans();
  equal(listed[0]!.planId, "newest");
  equal(listed[1]!.planId, "mid");
  equal(listed[2]!.planId, "old");

  await cleanTemp(tmp);
});

test("store: importing a plan does NOT create a queued run", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-plans-no-queue-"));
  const clock = fixedClock();
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

  store.writePlan({
    planId: "20260706-200000-draft",
    title: "Draft",
    raw: "---\nrepo: /tmp\nbase: main\n---\n\n# Body",
    tags: [],
    createdAt: clock.nowIso(),
    updatedAt: clock.nowIso(),
  });

  const queue = store.listQueue();
  strictEqual(queue.length, 0, "no queued runs after plan import");
  ok(!store.readMetaIfExists("20260706-200000-draft"), "no run meta exists for plan");

  await cleanTemp(tmp);
});
