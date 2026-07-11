import { deepEqual, equal, strictEqual, ok, rejects } from "node:assert";
import { mkdtemp as mkdtempP, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BridgePort } from "../src/application/ports/bridge.js";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import type { Store } from "../src/application/ports/store.js";
import {
  parkOrphanedRuns,
  recoverStaleActiveRuns,
  recoverStaleActiveConvergences,
  runLoop,
  type ExecuteRunCallback,
  type RunAbort,
  type ConvergeCallback,
  type WaitForWorkCallback,
} from "../src/application/use-cases/run-loop.js";
import { makePaths } from "../src/config/paths.js";
import { Config } from "../src/config/schemas.js";
import type { ActiveConvergence, ActiveRun, RunMeta } from "../src/domain/run.js";
import { SqliteStoreAdapter } from "../src/infrastructure/sqlite-store.js";

const forceStartupPhase = (dbFile: string, runId: string, operation: object): void => {
  const db = new DatabaseSync(dbFile);
  db.prepare(
    "UPDATE run_startup_operations SET operation = ? WHERE run_id = ? AND attempt = 1",
  ).run(JSON.stringify(operation), runId);
  db.close();
};

// ---------------------------------------------------------------------------
// Test helpers

const TS_COUNTER = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => new Date(Date.UTC(2026, 0, 1) + TS_COUNTER.n++ * 1_000).toISOString(),
});

const fakeRepo = (): Repo => ({
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
  repoValid: () => true,
  deleteBranch: () => {
    throw new Error("unimplemented");
  },
});

const makeMeta = (overrides: Partial<RunMeta>): RunMeta => ({
  runId: "20260101-000000-test",
  status: "queued" as const,
  attempt: 1,
  repo: "/tmp/repo",
  base: "main",
  branch: "meridian/test",
  worktree: "/tmp/worktree",
  pass: 1,
  stallRetries: 0,
  crashRetries: 0,
  reorientRetries: 0,
  promoted: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const packetRaw = (_runId: string): string => `---
repo: /tmp/repo
base: main
compare_commit: main
summary: startup recovery
outcomes:
  - id: recover
    description: Recover startup
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;

const replaceMeta = (store: Store, meta: RunMeta): void => {
  const current = store.readMeta(meta.runId);
  store.transitionRun({
    runId: meta.runId,
    expectedRevision: current.revision ?? 0,
    expectedStatuses: [current.status],
    meta,
  });
};

const cleanTemp = async (dir: string) => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

// ---------------------------------------------------------------------------
// Startup orphan parking

test("parkOrphanedRuns: running run is parked with its session evidence", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-orphan-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    const meta = makeMeta({
      runId: "20260101-000000-orphan",
      status: "running" as const,
      babySessionId: "baby-existing",
      daddySessionId: "daddy-existing",
    });
    store.writeMeta(meta);

    strictEqual(store.readMeta("20260101-000000-orphan").status, "running");

    parkOrphanedRuns(store, fakeRepo(), clock);

    const read = store.readMeta("20260101-000000-orphan");
    equal(read.status, "blocked");
    equal(read.blockedReason, "crashed");
    equal(read.babySessionId, "baby-existing");
    equal(read.daddySessionId, "daddy-existing");
    equal(store.listQueue().length, 0);
    await cleanTemp(tmp);
  })();
});

test("parkOrphanedRuns: a failed WIP commit cannot prevent parking and lease release", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-orphan-wip-failure-"));
  const clock = fixedClock();
  const repo = fakeRepo();
  repo.wipCommit = () => {
    throw new Error("git unavailable");
  };
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  const runId = "20260101-000000-orphan-wip-failure";
  store.writeMeta(makeMeta({ runId, status: "running", worktree: "/tmp/preserved" }));

  parkOrphanedRuns(store, repo, clock);

  const meta = store.readMeta(runId);
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "crashed");
  await cleanTemp(tmp);
});

test("parkOrphanedRuns: safe startup phase remains resumable with the same attempt", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-startup-resume-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const runId = "20260101-000000-startup-resume";
  store.admitQueue(runId, packetRaw(runId));
  const first = store.claimNextQueuedRun([], "worker-1")!;
  forceStartupPhase(paths.dbFile, runId, {
    runId,
    attempt: 1,
    phase: "sandbox_ready",
    updatedAt: fixedClock().nowIso(),
  });
  store.releaseRepositoryLease(first.lease);

  parkOrphanedRuns(store, fakeRepo(), fixedClock());
  equal(store.readMeta(runId).status, "running");
  const resumed = store.claimNextQueuedRun([], "worker-2");
  equal(resumed?.runId, runId);
  equal(store.readMeta(runId).attempt, 1);
  await cleanTemp(tmp);
});

test("parkOrphanedRuns: setup_started is parked rather than replayed", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-setup-ambiguous-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const runId = "20260101-000000-setup-ambiguous";
  store.admitQueue(runId, packetRaw(runId));
  const claimed = store.claimNextQueuedRun([], "worker-1")!;
  forceStartupPhase(paths.dbFile, runId, {
    runId,
    attempt: 1,
    phase: "setup_started",
    updatedAt: fixedClock().nowIso(),
  });
  store.releaseRepositoryLease(claimed.lease);

  parkOrphanedRuns(store, fakeRepo(), fixedClock());
  const meta = store.readMeta(runId);
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "crashed");
  ok(meta.blockedQuestion?.includes("will not be replayed"));
  await cleanTemp(tmp);
});

test("parkOrphanedRuns: ambiguous session creation is parked rather than replayed", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-session-ambiguous-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  const runId = "20260101-000000-session-ambiguous";
  store.admitQueue(runId, packetRaw(runId));
  const claimed = store.claimNextQueuedRun([], "worker-1")!;
  forceStartupPhase(paths.dbFile, runId, {
    runId,
    attempt: 1,
    phase: "planner_session_started",
    updatedAt: fixedClock().nowIso(),
  });
  store.releaseRepositoryLease(claimed.lease);

  parkOrphanedRuns(store, fakeRepo(), fixedClock());

  const meta = store.readMeta(runId);
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "crashed");
  ok(meta.blockedQuestion?.includes("session creation"));
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// recoverStaleActiveRuns — clear stale active_run pointers on boot

test("recoverStaleActiveRuns: active pointer with queued meta → pointer cleared", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stale-queued-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    const meta = makeMeta({ runId: "20260101-000000-stale", status: "queued" as const });
    store.writeMeta(meta);
    store.addActiveRun({
      runId: "20260101-000000-stale",
      runDir: join(tmp, "runs", "20260101-000000-stale"),
      worktree: join(tmp, "runs", "20260101-000000-stale", "worktree"),
      babySessionId: "ses_stale",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    ok(store.listActiveRuns().length === 1, "active pointer exists before recovery");

    recoverStaleActiveRuns(store);

    equal(store.listActiveRuns().length, 0, "active pointer cleared after recovery");
    equal(store.readMeta("20260101-000000-stale").status, "queued", "meta untouched");
    await cleanTemp(tmp);
  })();
});

test("recoverStaleActiveRuns: active pointer with running meta → pointer NOT cleared", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stale-running-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    const meta = makeMeta({ runId: "20260101-000000-live", status: "running" as const });
    store.writeMeta(meta);
    store.addActiveRun({
      runId: "20260101-000000-live",
      runDir: join(tmp, "runs", "20260101-000000-live"),
      worktree: join(tmp, "runs", "20260101-000000-live", "worktree"),
      babySessionId: "ses_live",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    recoverStaleActiveRuns(store);

    equal(store.listActiveRuns().length, 1, "active pointer preserved for running run");
    await cleanTemp(tmp);
  })();
});

test("recoverStaleActiveRuns: active pointer with missing run → pointer cleared", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stale-missing-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.addActiveRun({
      runId: "20260101-000000-gone",
      runDir: join(tmp, "runs", "20260101-000000-gone"),
      worktree: join(tmp, "runs", "20260101-000000-gone", "worktree"),
      babySessionId: "ses_gone",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    ok(store.readMetaIfExists("20260101-000000-gone") === undefined, "no run meta");

    recoverStaleActiveRuns(store);

    equal(store.listActiveRuns().length, 0, "orphaned active pointer cleared");
    await cleanTemp(tmp);
  })();
});

test("recoverStaleActiveRuns: after cleanup, queued run is claimable (no self-exclusion)", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stale-claim-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    const meta = makeMeta({
      runId: "20260101-000000-reclaim",
      status: "queued" as const,
      repo: "/tmp/repo",
    });
    store.writeMeta(meta);
    store.addActiveRun({
      runId: "20260101-000000-reclaim",
      runDir: join(tmp, "runs", "20260101-000000-reclaim"),
      worktree: join(tmp, "runs", "20260101-000000-reclaim", "worktree"),
      babySessionId: "ses_reclaim",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    recoverStaleActiveRuns(store);

    // claimNextQueuedRun uses excludedRepos derived from listActiveRuns.
    // After cleanup, there should be no excluded repos, so the queued run is claimable.
    const excludedRepos = store
      .listActiveRuns()
      .map((r) => store.readMetaIfExists(r.runId)?.repo)
      .filter((r): r is string => r !== undefined);

    const claimed = store.claimNextQueuedRun(excludedRepos);
    ok(claimed, "queued run claimed after stale active pointer cleanup");
    equal(claimed!.runId, "20260101-000000-reclaim");
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// recoverStaleActiveConvergences — clear ALL active_convergence pointers on boot

test("recoverStaleActiveConvergences: clears stale convergence pointer", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stale-conv-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.addActiveConvergence({
      runId: "20260101-000000-conv-stale",
      startedAt: "2026-01-01T00:00:00.000Z",
    });

    equal(store.listActiveConvergences().length, 1, "convergence pointer exists before recovery");

    recoverStaleActiveConvergences(store);

    equal(store.listActiveConvergences().length, 0, "convergence pointer cleared after recovery");
    await cleanTemp(tmp);
  })();
});

test("recoverStaleActiveConvergences: empty when no convergences exist", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stale-conv-empty-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    recoverStaleActiveConvergences(store);

    equal(store.listActiveConvergences().length, 0, "no convergences after recovery");
    await cleanTemp(tmp);
  })();
});

test("recoverStaleActiveConvergences: multiple convergences all cleared", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stale-conv-multi-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.addActiveConvergence({
      runId: "20260101-000000-conv-a",
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    store.addActiveConvergence({
      runId: "20260101-000000-conv-b",
      startedAt: "2026-01-01T00:00:01.000Z",
    });
    store.addActiveConvergence({
      runId: "20260101-000000-conv-c",
      startedAt: "2026-01-01T00:00:02.000Z",
    });

    equal(store.listActiveConvergences().length, 3, "3 convergence pointers before recovery");

    recoverStaleActiveConvergences(store);

    equal(store.listActiveConvergences().length, 0, "all convergence pointers cleared");
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// runLoop lifecycle tests

test("runLoop: startup failure after bridge bind always closes the bridge", async () => {
  let closed = false;
  const bridge: BridgePort = {
    bind: async () => ({ byRunId: new Map() }),
    clearActive: () => undefined,
    close: () => {
      closed = true;
    },
  };

  await rejects(
    () =>
      runLoop(
        Config.parse({}),
        {} as Store,
        fakeRepo(),
        {
          holdPowerAssertion: async () => {
            throw new Error("caffeinate failed");
          },
        },
        fixedClock(),
        bridge,
        async () => {},
        async () => {},
        async () => {},
      ),
    /caffeinate failed/,
  );
  equal(closed, true);
});

test("runLoop: incomplete accepted cleanup is reported without blocking readiness", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-acceptance-recovery-"));
  const clock = fixedClock();
  const repo = fakeRepo();
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  const runId = "20260101-000000-accepted";
  const meta = makeMeta({ runId, status: "ready_for_review", campaignId: runId });
  store.writeMeta(meta);
  const operation = {
    campaignId: runId,
    phase: "prepared" as const,
    tipRunId: runId,
    acceptedInto: meta.branch,
    expectedTipSha: "head",
    members: [
      {
        runId,
        revision: meta.revision ?? 0,
        status: "ready_for_review" as const,
        repo: meta.repo,
        branch: meta.branch,
        worktree: meta.worktree,
        base: meta.base,
        pass: meta.pass ?? 1,
      },
    ],
    cleanedSandboxes: [],
    cleanedBranches: [],
    updatedAt: clock.nowIso(),
  };
  store.persistAcceptanceOperation(operation);
  const fetched = { ...operation, phase: "fetched" as const };
  store.persistAcceptanceOperation(fetched);
  const lease = store.acquireRepositoryLease(meta.repo, "accept-fixture", runId, "accept")!;
  store.commitAcceptanceOperation(fetched, lease);
  store.releaseRepositoryLease(lease);

  let ready = false;
  const stop = new AbortController();
  await runLoop(
    Config.parse({ stateRoot: tmp }),
    store,
    repo,
    { holdPowerAssertion: async () => {} },
    clock,
    { bind: async () => ({ byRunId: new Map() }), clearActive: () => {}, close: () => {} },
    async () => {},
    async () => {},
    async () => stop.abort(),
    {
      stopSignal: stop.signal,
      onReady: () => {
        ready = true;
      },
    },
  );
  equal(ready, true);
  equal(store.readAcceptanceOperation(runId)?.phase, "accepted");
  equal(store.listRepositoryLeases().length, 0);
  ok(
    store
      .readJournal(runId)
      .some(
        (event) =>
          event.event === "driver_note" &&
          event.note.includes("cleanup") &&
          event.note.includes("retry"),
      ),
  );
  await cleanTemp(tmp);
});

test("runLoop: busy acceptance cleanup does not wait or block readiness", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-acceptance-shutdown-"));
  const clock = fixedClock();
  const repo = fakeRepo();
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  const runId = "20260101-000000-accepted";
  const meta = makeMeta({ runId, status: "ready_for_review", campaignId: runId });
  store.writeMeta(meta);
  const operation = {
    campaignId: runId,
    phase: "prepared" as const,
    tipRunId: runId,
    acceptedInto: meta.branch,
    expectedTipSha: "head",
    members: [
      {
        runId,
        revision: meta.revision ?? 0,
        status: "ready_for_review" as const,
        repo: meta.repo,
        branch: meta.branch,
        worktree: meta.worktree,
        base: meta.base,
        pass: meta.pass ?? 1,
      },
    ],
    cleanedSandboxes: [],
    cleanedBranches: [],
    updatedAt: clock.nowIso(),
  };
  store.persistAcceptanceOperation(operation);
  const fetched = { ...operation, phase: "fetched" as const };
  store.persistAcceptanceOperation(fetched);
  const acceptanceLease = store.acquireRepositoryLease(
    meta.repo,
    "accept-fixture",
    runId,
    "accept",
  )!;
  store.commitAcceptanceOperation(fetched, acceptanceLease);
  store.releaseRepositoryLease(acceptanceLease);
  ok(store.acquireRepositoryLease(meta.repo, "live-owner", "other-run", "execute"));
  const stop = new AbortController();
  let ready = false;

  await runLoop(
    Config.parse({ stateRoot: tmp }),
    store,
    repo,
    { holdPowerAssertion: async () => {} },
    clock,
    { bind: async () => ({ byRunId: new Map() }), clearActive: () => {}, close: () => {} },
    async () => {},
    async () => {},
    async () => {},
    {
      stopSignal: stop.signal,
      onReady: () => {
        ready = true;
        stop.abort();
      },
    },
  );

  equal(ready, true);
  equal(store.readAcceptanceOperation(runId)?.phase, "accepted");
  ok(
    store
      .readJournal(runId)
      .some((event) => event.event === "driver_note" && event.note.includes("repository is busy")),
  );
  await cleanTemp(tmp);
});

test("runLoop: drain queue before waiting", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-lifecycle-drain-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    // Seed 2 queued runs.
    store.writeMeta(makeMeta({ runId: "20260101-000000-a", status: "queued" as const }));
    store.writeMeta(makeMeta({ runId: "20260101-000000-b", status: "queued" as const }));

    let executeRunCallCount = 0;
    const executeRun: ExecuteRunCallback = async (runId, meta, ref, clock) => {
      executeRunCallCount++;
      const m = store.readMeta(runId);
      replaceMeta(store, { ...m, status: "accepted" as const, updatedAt: clock.nowIso() });
      if (executeRunCallCount >= 2) {
        process.emit("SIGINT" as NodeJS.Signals);
      }
    };

    let waitForWorkCalled = false;
    const waitForWork: WaitForWorkCallback = async () => {
      waitForWorkCalled = true;
    };

    const convergeStep: ConvergeCallback = async () => {};

    const bridge: BridgePort = {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: (_ref, _runId) => undefined,
      close: () => undefined,
    };

    await runLoop(
      Config.parse({}),
      store,
      fakeRepo(),
      { holdPowerAssertion: async () => {} },
      clock,
      bridge,
      executeRun,
      convergeStep,
      waitForWork,
    );

    strictEqual(executeRunCallCount, 2);
    strictEqual(waitForWorkCalled, false);
    await cleanTemp(tmp);
  })();
});

test("runLoop crash branch: thrown executeRun parks for operator action", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-crash-queue-"));
    const clock = fixedClock();
    const stopController = new AbortController();
    let wipCommitCalls = 0;
    const repo: Repo = {
      createSandbox: () => undefined,
      wipCommit: () => {
        wipCommitCalls++;
        stopController.abort();
        return "sha-crash";
      },
      amendCommit: () => "sha-amend",
      worktreeIsDirty: () => false,
      diffStat: () => "",
      readDiffStats: () => ({}),
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
      fetchBranchFromClone: () => undefined,
      removeSandbox: () => undefined,
      headBranch: () => "main",
      branchExists: () => true,
      repoValid: () => true,
      deleteBranch: () => undefined,
    };
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
    const runId = "20260101-000000-crash-queue";
    store.writeMeta(
      makeMeta({
        runId,
        status: "queued" as const,
        crashRetries: 0,
        worktree: join(tmp, "runs", runId, "worktree"),
      }),
    );

    let executeRunCalls = 0;
    const executeRun: ExecuteRunCallback = async () => {
      executeRunCalls++;
      throw new Error("boom");
    };

    await runLoop(
      Config.parse({}),
      store,
      repo,
      { holdPowerAssertion: async () => {} },
      clock,
      {
        bind: () => Promise.resolve({ byRunId: new Map() }),
        clearActive: (_ref, _runId) => undefined,
        close: () => undefined,
      },
      executeRun,
      async () => {},
      async () => {},
      { stopSignal: stopController.signal },
    );

    const meta = store.readMeta(runId);
    equal(executeRunCalls, 1);
    equal(meta.status, "blocked");
    equal(meta.crashRetries, 0);
    equal(meta.blockedReason, "crashed");
    equal(wipCommitCalls, 1);
    await cleanTemp(tmp);
  })();
});

test("runLoop: operator cancellation stops without crash recovery", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-operator-cancel-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const abortMap = new Map<string, RunAbort>();
  const runId = "20260101-000000-operator-cancel";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "queued", crashRetries: 0 }));

  const executeRun: ExecuteRunCallback = async () => {
    const active = abortMap.get(runId);
    ok(active);
    active.cause = "operator_cancel";
    active.controller.abort();
    throw new DOMException("cancelled", "AbortError");
  };

  await runLoop(
    Config.parse({}),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: () => undefined,
      close: () => undefined,
    },
    executeRun,
    async () => {},
    async () => stopController.abort(),
    { stopSignal: stopController.signal, abortMap },
  );

  const meta = store.readMeta(runId);
  equal(meta.status, "stopped");
  equal(meta.crashRetries, 0);
  await cleanTemp(tmp);
});

test("runLoop: operator cancellation during setup_started parks ambiguous setup", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-setup-cancel-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const abortMap = new Map<string, RunAbort>();
  const runId = "20260101-000000-setup-cancel";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.admitQueue(runId, packetRaw(runId));

  await runLoop(
    Config.parse({ stateRoot: tmp }),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    { bind: async () => ({ byRunId: new Map() }), clearActive: () => {}, close: () => {} },
    async (id, _meta, _ref, _clock, _signal, lease) => {
      store.persistRunStartup(
        { runId: id, attempt: 1, phase: "setup_started", updatedAt: clock.nowIso() },
        lease,
      );
      const active = abortMap.get(id)!;
      active.cause = "operator_cancel";
      active.controller.abort();
      throw new DOMException("cancelled", "AbortError");
    },
    async () => {},
    async () => stopController.abort(),
    { stopSignal: stopController.signal, abortMap },
  );

  const meta = store.readMeta(runId);
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "crashed");
  ok(meta.blockedQuestion?.includes("setup"));
  await cleanTemp(tmp);
});

test("runLoop: daemon shutdown during setup_started parks ambiguous setup", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-setup-shutdown-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const abortMap = new Map<string, RunAbort>();
  const runId = "20260101-000000-setup-shutdown";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.admitQueue(runId, packetRaw(runId));

  await runLoop(
    Config.parse({ stateRoot: tmp }),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    { bind: async () => ({ byRunId: new Map() }), clearActive: () => {}, close: () => {} },
    async (id, _meta, _ref, _clock, _signal, lease) => {
      store.persistRunStartup(
        { runId: id, attempt: 1, phase: "setup_started", updatedAt: clock.nowIso() },
        lease,
      );
      const active = abortMap.get(id)!;
      active.cause = "daemon_shutdown";
      active.controller.abort();
      throw new DOMException("cancelled", "AbortError");
    },
    async () => {},
    async () => stopController.abort(),
    { stopSignal: stopController.signal, abortMap },
  );

  const meta = store.readMeta(runId);
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "crashed");
  ok(meta.blockedQuestion?.includes("setup"));
  await cleanTemp(tmp);
});

test("runLoop: repository lease loss abandons ownership without mutation and worker continues", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-lease-loss-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const runA = "20260101-000000-lease-a";
  const runB = "20260101-000000-lease-b";
  const repo = fakeRepo();
  let repoMutations = 0;
  repo.wipCommit = () => {
    repoMutations++;
    return undefined;
  };
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  store.writeMeta(makeMeta({ runId: runA, status: "queued", repo: "/tmp/repo-a" }));
  store.writeMeta(makeMeta({ runId: runB, status: "queued", repo: "/tmp/repo-b" }));
  const heartbeat = store.heartbeatRepositoryLease.bind(store);
  store.heartbeatRepositoryLease = (lease) => (lease.runId === runA ? undefined : heartbeat(lease));
  let transitionedAfterLoss = 0;
  const transitionRun = store.transitionRun.bind(store);
  let leaseLost = false;
  store.transitionRun = (transition) => {
    if (leaseLost && transition.runId === runA) {
      transitionedAfterLoss++;
    }
    return transitionRun(transition);
  };
  const abortMap = new Map<string, RunAbort>();
  let observedCause: RunAbort["cause"];

  await runLoop(
    Config.parse({ stateRoot: tmp }),
    store,
    repo,
    { holdPowerAssertion: async () => {} },
    clock,
    { bind: async () => ({ byRunId: new Map() }), clearActive: () => {}, close: () => {} },
    async (runId, _meta, _ref, _clock, signal) => {
      if (runId === runA) {
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        leaseLost = true;
        observedCause = abortMap.get(runId)?.cause;
        throw signal!.reason;
      }
      replaceMeta(store, { ...store.readMeta(runId), status: "accepted" });
      stopController.abort();
    },
    async () => {},
    async () => {},
    { stopSignal: stopController.signal, abortMap, heartbeatIntervalMs: 1 },
  );

  equal(store.readMeta(runA).status, "running");
  equal(store.readMeta(runB).status, "accepted");
  equal(transitionedAfterLoss, 0);
  equal(repoMutations, 0);
  equal(observedCause, "repository_lease_lost");
  await cleanTemp(tmp);
});

test("runLoop: startup resumes an unpublished durable convergence operation", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-convergence-recovery-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const runId = "20260101-000000-convergence-recovery";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "ready_for_review", repo: "/tmp/recovery-repo" }));
  store.readConvergenceOperation = () => ({
    runId,
    attempt: 1,
    phase: "autofix_applied",
    autofixFingerprint: "fingerprint",
  });
  store.appendDecision(runId, {
    timestamp: clock.nowIso(),
    source: "max",
    questionType: "convergence_retry",
    currentSlice: "attempt:1",
    question: "Reviewer transport failed",
    evidence: [],
    status: "proceed",
    answer: "retry",
    constraints: [],
  });
  let recovered = 0;
  const abortMap = new Map<string, RunAbort>();

  await runLoop(
    Config.parse({ stateRoot: tmp }),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    { bind: async () => ({ byRunId: new Map() }), clearActive: () => {}, close: () => {} },
    async () => {},
    async (id, signal, lease) => {
      equal(id, runId);
      equal(lease?.purpose, "execute");
      ok(abortMap.has(runId));
      stopController.abort();
      equal(signal?.aborted, true);
      recovered++;
    },
    async () => {},
    { stopSignal: stopController.signal, abortMap },
  );

  equal(recovered, 1);
  equal(store.listRepositoryLeases().length, 0);
  await cleanTemp(tmp);
});

test("runLoop: startup does not replay an unmarked convergence operation", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-convergence-unmarked-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const runId = "20260101-000000-convergence-unmarked";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "ready_for_review" }));
  store.readConvergenceOperation = () => ({
    runId,
    attempt: 1,
    phase: "autofix_applied",
    autofixFingerprint: "fingerprint",
  });
  let convergenceCalls = 0;

  await runLoop(
    Config.parse({ stateRoot: tmp }),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    { bind: async () => ({ byRunId: new Map() }), clearActive: () => {}, close: () => {} },
    async () => {},
    async () => {
      convergenceCalls++;
    },
    async () => stopController.abort(),
    { stopSignal: stopController.signal },
  );

  equal(convergenceCalls, 0);
  await cleanTemp(tmp);
});

test("runLoop: startup resumes a durable decided convergence operation", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-convergence-decided-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const runId = "20260101-000000-convergence-decided";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "ready_for_review" }));
  store.readConvergenceOperation = () =>
    ({ runId, attempt: 1, phase: "decided" }) as NonNullable<
      ReturnType<Store["readConvergenceOperation"]>
    >;
  let convergenceCalls = 0;

  await runLoop(
    Config.parse({ stateRoot: tmp }),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    { bind: async () => ({ byRunId: new Map() }), clearActive: () => {}, close: () => {} },
    async () => {},
    async () => {
      convergenceCalls++;
      stopController.abort();
    },
    async () => {},
    { stopSignal: stopController.signal },
  );

  equal(convergenceCalls, 1);
  await cleanTemp(tmp);
});

test("runLoop: explicit convergence retry failure parks only that run and worker continues", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-convergence-retry-failure-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const retryRunId = "20260101-000000-retry-failure";
  const unrelatedRunId = "20260101-000001-unrelated";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId: retryRunId, status: "ready_for_review" }));
  store.writeMeta(makeMeta({ runId: unrelatedRunId, status: "queued" }));
  const readOperation = store.readConvergenceOperation.bind(store);
  store.readConvergenceOperation = (runId, attempt) =>
    runId === retryRunId
      ? {
          runId,
          attempt,
          phase: "autofix_applied",
          autofixFingerprint: "fingerprint",
        }
      : readOperation(runId, attempt);
  let unrelatedExecutions = 0;

  await runLoop(
    Config.parse({ stateRoot: tmp, concurrency: { maxWorkers: 2 } }),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    { bind: async () => ({ byRunId: new Map() }), clearActive: () => {}, close: () => {} },
    async (runId) => {
      equal(runId, unrelatedRunId);
      unrelatedExecutions++;
      replaceMeta(store, { ...store.readMeta(runId), status: "accepted" });
      stopController.abort();
    },
    async (runId) => {
      equal(runId, retryRunId);
      throw new Error("review transport still unavailable");
    },
    async () => {},
    {
      stopSignal: stopController.signal,
      onReady: () => {
        store.appendDecision(retryRunId, {
          timestamp: clock.nowIso(),
          source: "max",
          questionType: "convergence_retry",
          currentSlice: "attempt:1",
          question: "Retry convergence",
          evidence: [],
          status: "proceed",
          answer: "retry",
          constraints: [],
        });
      },
    },
  );

  equal(unrelatedExecutions, 1);
  equal(store.readMeta(unrelatedRunId).status, "accepted");
  const retryMeta = store.readMeta(retryRunId);
  equal(retryMeta.status, "blocked");
  equal(retryMeta.blockedReason, "crashed");
  ok(retryMeta.blockedQuestion?.includes("review transport still unavailable"));
  await cleanTemp(tmp);
});

test("runLoop: operator cancellation during convergence stops the run", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-convergence-cancel-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const abortMap = new Map<string, RunAbort>();
  const runId = "20260101-000000-convergence-cancel";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "queued", crashRetries: 0 }));

  const executeRun: ExecuteRunCallback = async (id) => {
    const meta = store.readMeta(id);
    replaceMeta(store, { ...meta, status: "ready_for_review", updatedAt: clock.nowIso() });
  };
  const convergeStep: ConvergeCallback = async (id, signal) => {
    const active = abortMap.get(id);
    ok(active);
    active.cause = "operator_cancel";
    active.controller.abort();
    equal(signal?.aborted, true);
  };

  await runLoop(
    Config.parse({}),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: () => undefined,
      close: () => undefined,
    },
    executeRun,
    convergeStep,
    async () => stopController.abort(),
    { stopSignal: stopController.signal, abortMap },
  );

  const meta = store.readMeta(runId);
  equal(meta.status, "stopped");
  equal(meta.crashRetries, 0);
  await cleanTemp(tmp);
});

test("runLoop: late cancellation cannot overwrite an accepted convergence decision", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-convergence-terminal-cancel-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const abortMap = new Map<string, RunAbort>();
  const runId = "20260101-000000-convergence-terminal-cancel";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "queued" }));

  await runLoop(
    Config.parse({}),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: () => undefined,
      close: () => undefined,
    },
    async (id) => {
      replaceMeta(store, { ...store.readMeta(id), status: "ready_for_review" });
    },
    async (id) => {
      replaceMeta(store, { ...store.readMeta(id), status: "accepted" });
      const active = abortMap.get(id);
      ok(active);
      active.cause = "operator_cancel";
      active.controller.abort();
    },
    async () => stopController.abort(),
    { stopSignal: stopController.signal, abortMap },
  );

  equal(store.readMeta(runId).status, "accepted");
  await cleanTemp(tmp);
});

test("runLoop: convergence failure parks the run without clearing the bridge", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-convergence-failure-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const runId = "20260101-000000-convergence-failure";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "queued" }));
  let clearCalls = 0;

  await runLoop(
    Config.parse({}),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: () => {
        clearCalls++;
      },
      close: () => undefined,
    },
    async (id) => {
      const meta = store.readMeta(id);
      replaceMeta(store, { ...meta, status: "ready_for_review", updatedAt: clock.nowIso() });
    },
    async () => {
      stopController.abort();
      throw new Error("campaign unavailable");
    },
    async () => {},
    { stopSignal: stopController.signal },
  );

  const meta = store.readMeta(runId);
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "crashed");
  ok(meta.blockedQuestion?.includes("campaign unavailable"));
  equal(clearCalls, 0);
  await cleanTemp(tmp);
});

test("runLoop: convergence failure preserves human-owned escalation", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-convergence-escalation-failure-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const runId = "20260101-000000-convergence-escalation-failure";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "queued" }));

  await runLoop(
    Config.parse({}),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: () => undefined,
      close: () => undefined,
    },
    async (id) => {
      const meta = store.readMeta(id);
      replaceMeta(store, { ...meta, status: "ready_for_review", updatedAt: clock.nowIso() });
    },
    async (id) => {
      const meta = store.readMeta(id);
      replaceMeta(store, {
        ...meta,
        status: "blocked",
        blockedReason: "human_decision",
        blockedQuestion: "choose policy",
        updatedAt: clock.nowIso(),
      });
      stopController.abort();
      throw new Error("ledger unavailable");
    },
    async () => {},
    { stopSignal: stopController.signal },
  );

  const meta = store.readMeta(runId);
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "human_decision");
  equal(meta.blockedQuestion, "choose policy");
  ok(
    store
      .readJournal(runId)
      .some((event) => event.event === "driver_note" && event.note.includes("ledger unavailable")),
  );
  await cleanTemp(tmp);
});

test("runLoop: convergence failure preserves operator rejection", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-convergence-rejection-failure-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const runId = "20260101-000000-convergence-rejection-failure";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "queued" }));

  await runLoop(
    Config.parse({}),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: () => undefined,
      close: () => undefined,
    },
    async (id) => {
      const meta = store.readMeta(id);
      replaceMeta(store, { ...meta, status: "ready_for_review", updatedAt: clock.nowIso() });
    },
    async (id) => {
      const meta = store.readMeta(id);
      replaceMeta(store, {
        ...meta,
        status: "blocked",
        blockedReason: "stop_condition",
        blockedQuestion: "change the implementation",
        updatedAt: clock.nowIso(),
      });
      stopController.abort();
      throw new Error("run changed during convergence");
    },
    async () => {},
    { stopSignal: stopController.signal },
  );

  const meta = store.readMeta(runId);
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "stop_condition");
  equal(meta.blockedQuestion, "change the implementation");
  ok(
    store
      .readJournal(runId)
      .some(
        (event) =>
          event.event === "driver_note" && event.note.includes("run changed during convergence"),
      ),
  );
  await cleanTemp(tmp);
});

test("runLoop: keeps one cancellation owner across execution and convergence", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-continuous-owner-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const abortMap = new Map<string, RunAbort>();
  const runId = "20260101-000000-continuous-owner";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "queued" }));
  let executionOwner: RunAbort | undefined;

  await runLoop(
    Config.parse({}),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: () => undefined,
      close: () => undefined,
    },
    async (id) => {
      executionOwner = abortMap.get(id);
      const meta = store.readMeta(id);
      replaceMeta(store, { ...meta, status: "ready_for_review", updatedAt: clock.nowIso() });
    },
    async (id) => {
      equal(abortMap.get(id), executionOwner);
      stopController.abort();
    },
    async () => {},
    { stopSignal: stopController.signal, abortMap },
  );

  await cleanTemp(tmp);
});

test("runLoop: operator cancellation retained after execution skips convergence", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-cancel-before-convergence-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const abortMap = new Map<string, RunAbort>();
  const runId = "20260101-000000-cancel-before-convergence";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "queued" }));
  let convergenceCalls = 0;

  await runLoop(
    Config.parse({}),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: () => undefined,
      close: () => undefined,
    },
    async (id) => {
      const active = abortMap.get(id);
      ok(active);
      active.cause = "operator_cancel";
      active.controller.abort();
      const meta = store.readMeta(id);
      replaceMeta(store, { ...meta, status: "ready_for_review", updatedAt: clock.nowIso() });
    },
    async () => {
      convergenceCalls++;
    },
    async () => stopController.abort(),
    { stopSignal: stopController.signal, abortMap },
  );

  equal(convergenceCalls, 0);
  equal(store.readMeta(runId).status, "stopped");
  await cleanTemp(tmp);
});

test("runLoop: external shutdown aborts active execution", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-external-shutdown-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const runId = "20260101-000000-external-shutdown";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "queued" }));
  let observedAbort = false;

  await runLoop(
    Config.parse({}),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: () => undefined,
      close: () => undefined,
    },
    async (_id, _meta, _ref, _clock, signal) => {
      setTimeout(() => stopController.abort(), 0);
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => resolve(), { once: true }),
      );
      observedAbort = signal?.aborted === true;
      throw new DOMException("shutdown", "AbortError");
    },
    async () => {},
    async () => {},
    { stopSignal: stopController.signal },
  );

  equal(observedAbort, true);
  equal(store.readMeta(runId).status, "stopped");
  await cleanTemp(tmp);
});

test("runLoop: daemon shutdown before convergence is recovered on restart", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-convergence-shutdown-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const runId = "20260101-000000-convergence-shutdown";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "queued" }));
  let convergenceCalls = 0;

  await runLoop(
    Config.parse({}),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: () => undefined,
      close: () => undefined,
    },
    async (id) => {
      const meta = store.readMeta(id);
      replaceMeta(store, { ...meta, status: "ready_for_review", updatedAt: clock.nowIso() });
      stopController.abort();
    },
    async () => {
      convergenceCalls++;
    },
    async () => {},
    { stopSignal: stopController.signal },
  );

  equal(convergenceCalls, 0);
  equal(store.readMeta(runId).status, "ready_for_review");

  const restartController = new AbortController();
  await runLoop(
    Config.parse({}),
    store,
    fakeRepo(),
    { holdPowerAssertion: async () => {} },
    clock,
    {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: () => undefined,
      close: () => undefined,
    },
    async () => {
      throw new Error("execution must not restart");
    },
    async () => {
      convergenceCalls++;
    },
    async () => {},
    { stopSignal: restartController.signal, onReady: () => restartController.abort() },
  );

  equal(convergenceCalls, 1);
  await cleanTemp(tmp);
});

test("runLoop crash branch: existing retry metadata does not trigger a retry", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-crash-block-"));
    const clock = fixedClock();
    const stopController = new AbortController();
    let wipCommitCalls = 0;
    const repo: Repo = {
      createSandbox: () => undefined,
      wipCommit: () => {
        wipCommitCalls++;
        stopController.abort();
        return "sha-crash";
      },
      amendCommit: () => "sha-amend",
      worktreeIsDirty: () => false,
      diffStat: () => "",
      readDiffStats: () => ({}),
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
      fetchBranchFromClone: () => undefined,
      removeSandbox: () => undefined,
      headBranch: () => "main",
      branchExists: () => true,
      repoValid: () => true,
      deleteBranch: () => undefined,
    };
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
    const runId = "20260101-000000-crash-block";
    store.writeMeta(
      makeMeta({
        runId,
        status: "queued" as const,
        crashRetries: 2,
        worktree: join(tmp, "runs", runId, "worktree"),
      }),
    );

    const executeRun: ExecuteRunCallback = async () => {
      throw new Error("boom");
    };

    await runLoop(
      Config.parse({}),
      store,
      repo,
      { holdPowerAssertion: async () => {} },
      clock,
      {
        bind: () => Promise.resolve({ byRunId: new Map() }),
        clearActive: (_ref, _runId) => undefined,
        close: () => undefined,
      },
      executeRun,
      async () => {},
      async () => {},
      { stopSignal: stopController.signal },
    );

    const meta = store.readMeta(runId);
    equal(meta.status, "blocked");
    equal(meta.blockedReason, "crashed");
    equal(meta.crashRetries, 2);
    equal(wipCommitCalls, 1);
    await cleanTemp(tmp);
  })();
});

test("runLoop crash path clears active run pointer on executeRun throw", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-crash-cleanup-"));
    const clock = fixedClock();
    const runId = "20260101-000000-crash-cleanup";
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    // Queue the run so runLoop will call executeRun on it
    store.writeMeta(
      makeMeta({
        runId,
        status: "queued" as const,
        worktree: join(tmp, "runs", runId, "worktree"),
      }),
    );

    // stopSignal is passed but NOT aborted — this keeps stopRequested=false
    // so the crash path's removeActiveRun executes. waitForWork aborts it
    // after a tick to exit the loop.
    const stopController = new AbortController();
    const waitForWork = async (_signal: AbortSignal) => {
      // Abort the signal synchronously to break the loop (runLoop checks
      // stopRequested after waitForWork returns). This fires after executeRun
      // has already crashed and removeActiveRun was called.
      stopController.abort();
    };

    let executeRunCalls = 0;
    const executeRun: ExecuteRunCallback = async (runIdArg) => {
      executeRunCalls++;
      // Simulate what real executeRun does before crashing: set the active run.
      store.addActiveRun({
        runId: runIdArg,
        runDir: join(tmp, "runs", runIdArg),
        worktree: join(tmp, "runs", runIdArg, "worktree"),
        babySessionId: "test-session",
        startedAt: clock.nowIso(),
      });
      throw new Error("crash boom");
    };

    await runLoop(
      Config.parse({}),
      store,
      fakeRepo(),
      { holdPowerAssertion: async () => {} },
      clock,
      {
        bind: () => Promise.resolve({ byRunId: new Map() }),
        clearActive: (_ref, _runId) => undefined,
        close: () => undefined,
      },
      executeRun,
      async () => {},
      waitForWork,
      { stopSignal: stopController.signal },
    );

    // Every crash in the loop path calls removeActiveRun (stopRequested was never true at crash time),
    // so the active run should be cleared by the time the loop exits.
    ok(executeRunCalls > 0);
    deepEqual(store.listActiveRuns(), []);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// runLoop: repo affinity is owned by the atomic store claim

test("runLoop: repository affinity is delegated to the atomic store claim", () => {
  return (async () => {
    const clock = fixedClock();

    let capturedExcludedRepos: string[] = [];

    const mockStore: Store = {
      // Startup recovery sweeps — empty, so no ops.
      listRunIds: () => [],
      readMetaIfExists: (runId) => {
        if (runId === "20260101-000000-active-a") {
          return {
            runId: "20260101-000000-active-a",
            status: "running" as const,
            attempt: 1,
            repo: "/tmp/active-repo",
            base: "main",
            branch: "b",
            worktree: "/tmp/worktree/active-a",
            updatedAt: clock.nowIso(),
          } as RunMeta;
        }
        if (runId === "20260101-000000-converge-x") {
          return {
            runId: "20260101-000000-converge-x",
            status: "running" as const,
            attempt: 1,
            repo: "/tmp/convergence-repo",
            base: "main",
            branch: "b",
            worktree: "/tmp/worktree/converge-x",
            updatedAt: clock.nowIso(),
          } as RunMeta;
        }
        return undefined;
      },
      writeMeta: () => {
        throw new Error("writeMeta should not be called");
      },
      transitionRun: () => {
        throw new Error("transitionRun should not be called");
      },
      readRunStartup: () => undefined,
      persistRunStartup: () => {},
      initializeRunStartup: () => {},
      activateRunStartup: (_operation, transition) => transition.meta,
      acceptCampaign: () => [],
      readAcceptanceOperation: () => undefined,
      persistAcceptanceOperation: () => {},
      commitAcceptanceOperation: () => [],
      answerRun: (transition) => transition.meta,
      listStaged: () => [],
      readCampaign: () => undefined,
      listActiveRuns: () => [
        {
          runId: "20260101-000000-active-a",
          runDir: "/tmp/runs/active-a",
          worktree: "/tmp/worktree/active-a",
          babySessionId: "sess1",
          startedAt: clock.nowIso(),
        } as ActiveRun,
      ],
      syncActiveRunProjection: () => {},
      listActiveConvergences: () => [
        {
          runId: "20260101-000000-converge-x",
          startedAt: clock.nowIso(),
        } as ActiveConvergence,
      ],
      claimNextQueuedRun: (excludedRepos) => {
        capturedExcludedRepos = [...excludedRepos];
        // Return undefined so runLoop goes to the wait path.
        return undefined;
      },
      acquireRepositoryLease: () => undefined,
      admitQueueWithCampaign: () => {},
      heartbeatRepositoryLease: (lease) => lease,
      releaseRepositoryLease: () => false,
      listRepositoryLeases: () => [],
      // Unused stubs (not called with stopSignal + empty queue).
      readMeta: () => {
        throw new Error("readMeta should not be called");
      },
      listMeta: () => [],
      initialLedger: () => {
        throw new Error("not called");
      },
      readLedger: () => {
        throw new Error("not called");
      },
      listLedgers: () => [],
      writeLedger: () => {
        throw new Error("not called");
      },
      initialReviewState: () => {
        throw new Error("not called");
      },
      readReviewState: () => {
        throw new Error("not called");
      },
      replaceObligations: () => {
        throw new Error("not called");
      },
      appendDecision: () => {
        throw new Error("not called");
      },
      readDecisions: () => [],
      latestCheckpoint: () => undefined,
      writeCheckpoint: () => {
        throw new Error("not called");
      },
      nextCheckpointNumber: () => 1,
      readGateState: () => {
        throw new Error("not called");
      },
      writeGateState: () => {
        throw new Error("not called");
      },
      readReport: () => "",
      writeReport: () => {
        throw new Error("not called");
      },
      readNits: () => "",
      writeNits: () => {
        throw new Error("not called");
      },
      appendConvergence: () => {
        throw new Error("not called");
      },
      readConvergence: () => [],
      readConvergenceOperation: () => undefined,
      persistConvergenceOperation: () => {},
      publishConvergence: () => undefined,
      addActiveRun: () => {
        throw new Error("not called");
      },
      removeActiveRun: () => {
        throw new Error("not called");
      },
      addActiveConvergence: () => {
        throw new Error("not called");
      },
      removeActiveConvergence: () => {
        // Called by recoverStaleActiveConvergences at boot — no-op so the
        // mock store still returns the convergence for excludedRepos testing.
      },
      writeCampaign: () => {
        throw new Error("not called");
      },
      listCampaigns: () => [],
      listRunsByCampaign: () => [],
      listQueue: () => [],
      admitQueue: () => {
        throw new Error("not called");
      },
      archiveQueue: () => {
        throw new Error("not called");
      },
      readQueuePacket: () => undefined,
      readStaged: () => undefined,
      writeStaged: () => {
        throw new Error("not called");
      },
      removeStaged: () => {
        throw new Error("not called");
      },
      appendJournal: () => {
        throw new Error("not called");
      },
      readJournal: () => [],
      readJournalWithSeq: () => [],
      readJournalSinceForRun: () => [],
      readRecentJournal: () => [],
      readRecentJournalWithSeq: () => [],
      readJournalStats: () => ({ turn: 0, contextTokens: 0, rotations: 0 }),
      latestJournalSeq: () => 0,
      readJournalSince: () => [],
      clearResumeArtifacts: () => {
        throw new Error("not called");
      },
      listPlans: () => [],
      readPlan: () => undefined,
      writePlan: () => {
        throw new Error("not called");
      },
      deletePlan: () => {
        throw new Error("not called");
      },
    };

    const stopController = new AbortController();
    const waitForWork = async (_signal: AbortSignal) => {
      // Abort the signal synchronously to break the loop (runLoop checks
      // stopRequested after waitForWork returns). This fires after the abort
      // listener is registered by runLoop, so stopRequested becomes true and
      // runLoop exits cleanly.
      stopController.abort();
    };

    await runLoop(
      Config.parse({}),
      mockStore,
      fakeRepo(),
      { holdPowerAssertion: async () => {} },
      clock,
      {
        bind: () => Promise.resolve({ byRunId: new Map() }),
        clearActive: (_ref, _runId) => undefined,
        close: () => undefined,
      },
      async () => {
        throw new Error("executeRun should not be called — no claim");
      },
      async () => {
        throw new Error("convergeStep should not be called — no claim");
      },
      waitForWork,
      { stopSignal: stopController.signal },
    );

    // The run loop no longer makes a stale pre-claim repository snapshot.
    deepEqual(capturedExcludedRepos, []);
  })();
});

// ---------------------------------------------------------------------------
// Worker-pool: two workers claim different-repo runs concurrently
// ---------------------------------------------------------------------------

test("runLoop: one worker failure shuts down and awaits sibling workers", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "runloop-worker-failure-"));
  const clock = fixedClock();
  const stopController = new AbortController();
  const abortMap = new Map<string, RunAbort>();
  const runId = "20260101-000000-worker-failure";
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  store.writeMeta(makeMeta({ runId, status: "queued" }));
  const claimNext = store.claimNextQueuedRun.bind(store);
  let claimCalls = 0;
  store.claimNextQueuedRun = (...args) => {
    claimCalls++;
    if (claimCalls === 2) {
      throw new Error("claim failed");
    }
    return claimNext(...args);
  };
  let siblingSettled = false;

  await rejects(
    runLoop(
      Config.parse({ concurrency: { maxWorkers: 2 } }),
      store,
      fakeRepo(),
      { holdPowerAssertion: async () => {} },
      clock,
      {
        bind: () => Promise.resolve({ byRunId: new Map() }),
        clearActive: () => undefined,
        close: () => undefined,
      },
      async (_id, _meta, _ref, _clock, signal) => {
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        siblingSettled = true;
        throw signal!.reason;
      },
      async () => {},
      async () => {},
      { stopSignal: stopController.signal, abortMap },
    ),
    /claim failed/,
  );

  equal(siblingSettled, true);
  equal(claimCalls, 2);
  equal(abortMap.size, 0);
  await cleanTemp(tmp);
});

test("runLoop with maxWorkers=2: two workers claim different-repo runs", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-two-workers-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    // Seed 2 queued runs with different repos.
    store.writeMeta(
      makeMeta({ runId: "20260101-000000-repo-a", status: "queued" as const, repo: "/tmp/repo-a" }),
    );
    store.writeMeta(
      makeMeta({ runId: "20260101-000000-repo-b", status: "queued" as const, repo: "/tmp/repo-b" }),
    );

    let executeRunCallCount = 0;
    let completedRunCount = 0;
    let releaseExecutions!: () => void;
    const executionBarrier = new Promise<void>((resolve) => {
      releaseExecutions = resolve;
    });
    const stopController = new AbortController();
    const executeRun: ExecuteRunCallback = async (runId, meta, ref, clock) => {
      executeRunCallCount++;
      if (executeRunCallCount === 2) {
        releaseExecutions();
      }
      await executionBarrier;
      const m = store.readMeta(runId);
      replaceMeta(store, { ...m, status: "accepted" as const, updatedAt: clock.nowIso() });
      completedRunCount++;
      if (completedRunCount === 2) {
        stopController.abort();
      }
    };

    const waitForWork: WaitForWorkCallback = async () => {};

    const convergeStep: ConvergeCallback = async () => {};

    const bridge: BridgePort = {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: (_ref, _runId) => undefined,
      close: () => undefined,
    };

    await runLoop(
      Config.parse({ concurrency: { maxWorkers: 2 } }),
      store,
      fakeRepo(),
      { holdPowerAssertion: async () => {} },
      clock,
      bridge,
      executeRun,
      convergeStep,
      waitForWork,
      { stopSignal: stopController.signal },
    );

    strictEqual(executeRunCallCount, 2, "both runs should be claimed and executed");
    await cleanTemp(tmp);
  })();
});
