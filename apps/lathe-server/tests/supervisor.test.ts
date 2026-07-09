import { equal, strictEqual, ok, throws, deepStrictEqual } from "node:assert";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config, Clock, Repo, Paths, RunMeta } from "@lathe/core";
import { makePaths, SqliteStoreAdapter, systemClock, buildRepo, Config as ConfigSchema } from "@lathe/core";
import type { Supervisor } from "../src/supervisor.js";
import { createSupervisor, NonChainTipError, TerminalRunError, RunNotFoundError, resolveSpeaker, _testSyncSubscriptions } from "../src/supervisor.js";
import { createEventBus } from "../src/app.js";

// ---------------------------------------------------------------------------
// Test helpers

const TS_COUNTER = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS_COUNTER.n++).padStart(2, "0")}.000Z`,
});

const fakeRepo = (_opts?: {
  headBranch?: string;
  branchExists?: boolean;
  headBranchThrows?: boolean;
  repoValid?: boolean;
}): Repo => ({
  createSandbox: () => { throw new Error("unimplemented"); },
  wipCommit: () => undefined,
  amendCommit: () => "",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => ({ added: 0, removed: 0 }),
  reviewableDiff: () => "",
  reviewableDiffAgainst: () => "",
  fetchBranchFromClone: () => { throw new Error("unimplemented"); },
  removeSandbox: () => { throw new Error("unimplemented"); },
  headBranch: () => "main",
  branchExists: () => true,
  repoValid: () => true,
  deleteBranch: () => { throw new Error("unimplemented"); },
});

const makeTestPaths = async (base?: string): Promise<Paths & { teardown: () => Promise<void> }> => {
  const root = base ?? await mkdtemp(join(tmpdir(), "lathe-supervisor-"));
  const paths = makePaths(root);
  const dirs = [paths.root, paths.runsDir];
  await Promise.all(dirs.map(d => mkdir(d, { recursive: true })));
  return { ...paths, teardown: async () => rm(root, { recursive: true, force: true }) };
};

const makeTestMeta = (partial: Partial<RunMeta>): RunMeta => ({
  runId: "test",
  status: "queued" as const,
  attempt: 1,
  repo: "/tmp/test-repo",
  base: "main",
  branch: "lathe/test",
  worktree: "/tmp/test-worktree",
  pass: 1,
  stallRetries: 0,
  reorientRetries: 0,
  reviewerUnreachable: 0,
  updatedAt: systemClock.nowIso(),
  ...partial,
});

const makeTestPacket = (): string => {
  return `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: test packet
outcomes:
  - id: test
    description: A test outcome
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

test body
`;
};

const withSupervisor = async (
  fn: (supervisor: Supervisor, paths: Paths & { teardown: () => Promise<void> }) => Promise<void>,
  base?: string,
): Promise<void> => {
  const paths = await makeTestPaths(base);
  let supervisor: Supervisor | undefined;
  try {
    const config = ConfigSchema.parse({}) as Config;
    supervisor = createSupervisor(config, paths, { startDriver: false });
    await fn(supervisor, paths);
  } finally {
    if (supervisor) {
      await supervisor.stop();
    }
    await paths.teardown();
  }
};

// ---------------------------------------------------------------------------
// createSupervisor construction

test("createSupervisor constructs with a temp paths dir", async () => {
  await withSupervisor(async (supervisor, paths) => {
    equal(typeof supervisor.stop, "function");
    ok("bus" in supervisor.appDeps);
    ok(typeof supervisor.appDeps.readEventsSince === "function");
    ok(typeof supervisor.enqueueRun === "function");
    ok(typeof supervisor.listRuns === "function");
    ok(typeof supervisor.getRun === "function");
    ok(typeof supervisor.stopRun === "function");
    ok(typeof supervisor.acceptRun === "function");
    ok(typeof supervisor.rejectRun === "function");
  });
});

// ---------------------------------------------------------------------------
// stopRun — not found

test("stopRun throws RunNotFoundError for unknown runId", async () => {
  await withSupervisor(async (supervisor) => {
    throws(
      () => supervisor.stopRun("nonexistent"),
      (err: Error) => err instanceof RunNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// stopRun — terminal run

test("stopRun throws TerminalRunError for a terminal run", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const runId = "test-terminal";
    const meta = makeTestMeta({
      runId,
      status: "failed",
      queuedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:02:00.000Z",
    });
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);
    store.writeMeta(meta);

    throws(
      () => supervisor.stopRun(runId),
      (err: Error) => err instanceof TerminalRunError && err.message.includes("already terminal"),
    );
  });
});

// ---------------------------------------------------------------------------
// stopRun — queued run (admitted, has meta with status "queued")

test("stopRun archives a queued run (meta status queued)", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);

    const runId = "20260101-000000-queued-meta";
    const packet = makeTestPacket();
    store.admitQueue(runId, packet);

    ok(store.readMetaIfExists(runId), "admitQueue should have written meta");
    ok(store.listQueue().some(q => q.runId === runId), "run should be in the queue");

    // No exception means success.
    supervisor.stopRun(runId);

    // Run should no longer be in the queue (status flipped to stopped).
    equal(store.listQueue().some(q => q.runId === runId), false);
  });
});

// ---------------------------------------------------------------------------
// stopRun — running run (no abortMap entry — fires silently)

test("stopRun for a running run does not throw when no abortMap entry", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);

    const runId = "running-no-abort";
    store.writeMeta(makeTestMeta({
      runId,
      status: "running",
      queuedAt: systemClock.nowIso(),
      startedAt: systemClock.nowIso(),
      updatedAt: systemClock.nowIso(),
    }));

    // No exception: stopRun fires abortMap.get(runId) which is undefined
    // in this test — the supervisor's private abortMap has no entry.
    // The run status should remain "running" (no state change for running stop).
    supervisor.stopRun(runId);
    const after = supervisor.getRun(runId);
    equal(after!.status, "running");
  });
});

// ---------------------------------------------------------------------------
// listRuns / getRun

test("listRuns returns stored meta entries", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);

    store.writeMeta(makeTestMeta({
      runId: "run-a",
      status: "queued",
      queuedAt: systemClock.nowIso(),
      updatedAt: systemClock.nowIso(),
    }));
    store.writeMeta(makeTestMeta({
      runId: "run-b",
      status: "running",
      queuedAt: systemClock.nowIso(),
      startedAt: systemClock.nowIso(),
      updatedAt: systemClock.nowIso(),
    }));

    const runs = supervisor.listRuns();
    equal(runs.length, 2);
    strictEqual(runs.map(r => r.runId).sort().join(","), "run-a,run-b");
  });
});

test("getRun returns a stored meta, undefined for absent", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);

    const runId = "get-test";
    store.writeMeta(makeTestMeta({
      runId,
      status: "queued",
      queuedAt: systemClock.nowIso(),
      updatedAt: systemClock.nowIso(),
    }));

    const found = supervisor.getRun(runId);
    ok(found);
    equal(found!.runId, runId);

    strictEqual(supervisor.getRun("does-not-exist"), undefined);
  });
});

// ---------------------------------------------------------------------------
// acceptRun — chain-tip guard (fake supervisor — real supervisor owns its store)

test("acceptRun throws NonChainTipError for a non-chain-tip run", async () => {
  const stagedEntries: Array<{ runId: string; parentRunId: string }> = [];
  const metaStore = new Map<string, RunMeta>();
  const runId = "parent-run";
  metaStore.set(runId, makeTestMeta({
    runId,
    status: "ready_for_review",
    queuedAt: systemClock.nowIso(),
    updatedAt: systemClock.nowIso(),
  } as Partial<RunMeta>));

  const fakeSup: Supervisor = {
    stop: async () => {},
    config: testConfig,
    appDeps: { bus: createEventBus(), readEventsSince: () => [] },
    enqueueRun: (_p: string) => "enqueued",
    enqueueChain: () => {},
    listRuns: () => Array.from(metaStore.values()),
    getRun: (id: string) => metaStore.get(id),
    stopRun: () => {},
    answerRun: () => {},
    isChainTip: (id: string) => !stagedEntries.some(s => s.parentRunId === id),
    lastVerdict: () => null,
    listStaged: () => stagedEntries,
    outcomes: () => "",
    runReadModel: (runId: string) => ({ campaignId: runId, parentRunId: null, expectedSurface: [], pass: 1, turn: 0, contextTokens: 0 }),
    getStatus: () => ({ activeRuns: [], queued: [], parked: [], campaigns: [], staged: [], review: { readyForReview: 0, failed: 0 } }),
    getReview: () => ({ runs: [] }),
    getTailSnapshot: () => undefined,
    getActiveTailSnapshot: () => null,
    acceptRun: (id: string): number => {
      if (stagedEntries.some(s => s.parentRunId === id)) {
        throw new NonChainTipError(id, "unknown");
      }
      const meta = metaStore.get(id);
      if (!meta) throw new RunNotFoundError(id);
      metaStore.set(id, { ...meta, status: "accepted" as const, updatedAt: systemClock.nowIso() });
      return meta.attempt + 1;
    },
    rejectRun: () => {},
  };

  stagedEntries.push({ runId: "child-run", parentRunId: runId });
  throws(
    () => fakeSup.acceptRun(runId),
    (err: Error) => err instanceof NonChainTipError && err.message.includes("not a chain tip"),
  );
});

// ---------------------------------------------------------------------------
// readEventsSince — returns projected events with correct runId

test("readEventsSince returns projected events from the journal", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);

    const runId = "test-events";
    store.writeMeta(makeTestMeta({
      runId,
      status: "running",
      queuedAt: systemClock.nowIso(),
      startedAt: systemClock.nowIso(),
      updatedAt: systemClock.nowIso(),
    }));

    const event = { event: "run_started" as const, runId, attempt: 1, at: systemClock.nowIso() };
    store.appendJournal(runId, event);

    const events = supervisor.appDeps.readEventsSince(-1);
    equal(events.length, 1);
    equal(events[0].event.kind, "run.state");
  });
});

test("readTailEventsSince replays cheap journal rows and one final stats event", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const store = SqliteStoreAdapter.create(paths, fakeRepo(), systemClock);
    const runId = "test-tail-replay";
    store.writeMeta(makeTestMeta({
      runId,
      status: "running",
      queuedAt: systemClock.nowIso(),
      startedAt: systemClock.nowIso(),
      updatedAt: systemClock.nowIso(),
    }));

    store.appendJournal(runId, { event: "run_started", runId, attempt: 1, at: systemClock.nowIso() });
    store.appendJournal(runId, {
      event: "super_review",
      at: systemClock.nowIso(),
      verdict: "accept",
      pass: 2,
      findings: ["looks good"],
    });

    const events = supervisor.appDeps.readTailEventsSince?.(-1, runId) ?? [];
    deepStrictEqual(events.map((event) => event.kind), ["tail.journal", "tail.journal", "tail.super.verdict", "tail.stats"]);
    equal(events.filter((event) => event.kind === "tail.stats").length, 1);
    equal(events[0]?.kind, "tail.journal");
    equal(events[1]?.kind, "tail.journal");
    equal(events[2]?.kind, "tail.super.verdict");
    equal(events[3]?.kind, "tail.stats");
    if (events[3]?.kind === "tail.stats") {
      equal(events[3].status, "running");
      equal(events[3].seq, 2);
    }
  });
});

test("runReadModel derives packet and latest journal fields", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const store = createStore(paths);
    const runId = "20260101-000200-read-model";
    store.admitQueue(runId, `---
repo: /tmp/test-repo
base: main
compare_commit: main
campaign_id: campaign-a
parent_run_id: parent-a
pass: 3
outcomes:
  - id: test
    description: A test outcome
expected_surface:
  - apps/lathe-server/src/app.ts
verification:
  - command: echo ok
---

body
`);
    store.appendJournal(runId, {
      event: "turn_ended",
      at: systemClock.nowIso(),
      turn: 2,
      messageId: "m1",
      tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
      contextTokens: 123,
      text: "first",
    });
    store.appendJournal(runId, {
      event: "turn_ended",
      at: systemClock.nowIso(),
      turn: 4,
      messageId: "m2",
      tokens: { input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
      contextTokens: 456,
      text: "latest",
    });

    const model = supervisor.runReadModel(runId);
    equal(model.campaignId, "campaign-a");
    equal(model.parentRunId, "parent-a");
    deepStrictEqual(model.expectedSurface, ["apps/lathe-server/src/app.ts"]);
    equal(model.pass, 3);
    equal(model.turn, 4);
    equal(model.contextTokens, 456);
  });
});

// ---------------------------------------------------------------------------
// rejectRun — queued run — archives via queue check

test("rejectRun archives a queued run (admitted)", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const runId = "20260101-000100-reject-queued";
    const store = createStore(paths);
    store.admitQueue(runId, makeTestPacket());

    ok(store.listQueue().some(q => q.runId === runId), "run should be in the queue");

    supervisor.rejectRun(runId, "not needed");

    equal(store.listQueue().some(q => q.runId === runId), false);
  });
});

const createStore = (paths: Paths) => SqliteStoreAdapter.create(paths, fakeRepo(), systemClock);

const testConfig = {
  baby: { modelId: "test", baseUrl: "http://localhost:9999", contextWindow: 131072, turnSteps: 30 } as const,
  daddy: { modelId: "test-daddy", provider: "test-provider" } as const,
  superdaddy: { modelId: "test-superdaddy" } as const,
  thresholds: { ladderParkAt: 10, ladderRotateAt: 4, maxPasses: 3, rotationFraction: 0.65 } as const,
} as const;

// ---------------------------------------------------------------------------
// NonChainTipError — chainTip is set by supervisor

test("acceptRun throws NonChainTipError with chainTip for a non-chain-tip run", async () => {
  const stagedEntries: Array<{ runId: string; parentRunId: string }> = [];
  const parentRunId = "parent-chain-tip";
  const childRunId = "child-chain-tip";
  stagedEntries.push({ runId: childRunId, parentRunId: parentRunId });

  const supervisor: Supervisor = {
    stop: async () => {},
    config: testConfig,
    appDeps: { bus: createEventBus(), readEventsSince: () => [] },
    enqueueRun: (_p: string) => "enqueued",
    enqueueChain: () => {},
    listRuns: () => [],
    getRun: () => undefined,
    stopRun: () => {},
    answerRun: () => {},
    isChainTip: (id: string) => id === childRunId,
    lastVerdict: () => null,
    listStaged: () => stagedEntries,
    outcomes: () => "",
    runReadModel: (runId: string) => ({ campaignId: runId, parentRunId: null, expectedSurface: [], pass: 1, turn: 0, contextTokens: 0 }),
    getStatus: () => ({ activeRuns: [], queued: [], parked: [], campaigns: [], staged: [], review: { readyForReview: 0, failed: 0 } }),
    getReview: () => ({ runs: [] }),
    getTailSnapshot: () => undefined,
    getActiveTailSnapshot: () => null,
    acceptRun: (id: string): number => {
      if (stagedEntries.some(s => s.parentRunId === id)) {
        throw new NonChainTipError(id, childRunId);
      }
      return 0;
    },
    rejectRun: () => {},
  };

  try {
    supervisor.acceptRun(parentRunId);
    throw new Error("expected NonChainTipError");
  } catch (err) {
    ok(err instanceof NonChainTipError, "throws NonChainTipError");
    equal(err.chainTip, childRunId, `chainTip is ${childRunId}`);
  }
});

// ---------------------------------------------------------------------------
// Multi-chain: NonChainTipError names the correct chain's tip

test("acceptRun throws NonChainTipError with correct chainTip when multiple chains exist", async () => {
  const stagedEntries: Array<{ runId: string; parentRunId: string }> = [];
  stagedEntries.push({ runId: "b-child-chain", parentRunId: "b-chain" });

  const supervisor: Supervisor = {
    stop: async () => {},
    config: testConfig,
    appDeps: { bus: createEventBus(), readEventsSince: () => [] },
    enqueueRun: (_p: string) => "enqueued",
    enqueueChain: () => {},
    listRuns: () => [],
    getRun: () => undefined,
    stopRun: () => {},
    answerRun: () => {},
    isChainTip: (id: string) => id === "a-chain" || id === "b-child-chain",
    lastVerdict: () => null,
    listStaged: () => stagedEntries,
    outcomes: () => "",
    runReadModel: (runId: string) => ({ campaignId: runId, parentRunId: null, expectedSurface: [], pass: 1, turn: 0, contextTokens: 0 }),
    getStatus: () => ({ activeRuns: [], queued: [], parked: [], campaigns: [], staged: [], review: { readyForReview: 0, failed: 0 } }),
    getReview: () => ({ runs: [] }),
    getTailSnapshot: () => undefined,
    getActiveTailSnapshot: () => null,
    acceptRun: (id: string): number => {
      if (stagedEntries.some(s => s.parentRunId === id)) {
        throw new NonChainTipError(id, "b-child-chain");
      }
      return 0;
    },
    rejectRun: () => {},
  };

  try {
    supervisor.acceptRun("b-chain");
    throw new Error("expected NonChainTipError");
  } catch (err) {
    ok(err instanceof NonChainTipError, "throws NonChainTipError");
    equal(err.chainTip, "b-child-chain", `chainTip is b-child-chain, not a-chain`);
  }
});

// ---------------------------------------------------------------------------
// acceptRun — chain-tip guard exercised through the REAL createSupervisor(...),
// not a hand-rolled fake. Seeds two runs + a staged child off the parent on the
// supervisor's own store (shared paths), then asserts accepting the mid-chain
// parent is refused and that findChainTip walks the staged ancestry to name the
// child as the tip. Covers supervisor.ts findChainTip + the acceptRun guard.

test("acceptRun (real supervisor) refuses a mid-chain run and names the chain tip", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);

    const parentRunId = "20260101-000000-parent";
    const childRunId = "20260101-000100-child";

    // Two runs with meta (so both are listRunIds candidates)...
    store.writeMeta(
      makeTestMeta({ runId: parentRunId, status: "ready_for_review", updatedAt: systemClock.nowIso() }),
    );
    store.writeMeta(
      makeTestMeta({ runId: childRunId, status: "ready_for_review", updatedAt: systemClock.nowIso() }),
    );

    // ...and a staged child that forks off the parent — so the parent is NOT the
    // chain tip and the child IS.
    store.writeStaged(
      childRunId,
      [
        "---",
        "repo: /tmp/test-repo",
        `base: meridian/${parentRunId}`,
        "compare_commit: main",
        `parent_run_id: ${parentRunId}`,
        "outcomes:",
        "  - id: child-outcome",
        "    description: child work",
        "expected_surface:",
        "  - src/x.ts",
        "verification:",
        "  - command: echo ok",
        "---",
        "",
        "child body",
        "",
      ].join("\n"),
    );

    try {
      supervisor.acceptRun(parentRunId);
      throw new Error("expected NonChainTipError");
    } catch (err) {
      ok(err instanceof NonChainTipError, "real acceptRun must throw NonChainTipError for a mid-chain run");
      equal(err.chainTip, childRunId, "findChainTip walks the staged ancestry to the real tip");
    }
  });
});

// ---------------------------------------------------------------------------
// Multi-run supervisor branches — direct regression for the new contract shape
// ---------------------------------------------------------------------------

test("getStatus returns multiple active runs", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);

    const runA = "20260101-000000-a";
    const runB = "20260101-000000-b";
    const now = systemClock.nowIso();
    store.writeMeta(makeTestMeta({ runId: runA, status: "running", queuedAt: now, startedAt: now, updatedAt: now }));
    store.writeMeta(makeTestMeta({ runId: runB, status: "running", queuedAt: now, startedAt: now, updatedAt: now }));
    store.addActiveRun({ runId: runA, babySessionId: "sess-a", runDir: "/tmp/a", worktree: "/tmp/a", startedAt: now });
    store.addActiveRun({ runId: runB, babySessionId: "sess-b", runDir: "/tmp/b", worktree: "/tmp/b", startedAt: now });

    const status = supervisor.getStatus();
    equal(status.activeRuns.length, 2, "should have 2 active runs");
    ok(status.activeRuns.some((r) => r.runId === runA), `activeRuns includes ${runA}`);
    ok(status.activeRuns.some((r) => r.runId === runB), `activeRuns includes ${runB}`);
  });
});

test("resolveSpeaker matches a non-first active run baby session", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);

    const runA = "20260101-000000-a";
    const runB = "20260101-000000-b";
    const now = systemClock.nowIso();
    // First active run (lexically first run_id)
    store.writeMeta(makeTestMeta({ runId: runA, status: "running", queuedAt: now, startedAt: now, updatedAt: now }));
    store.writeMeta(makeTestMeta({ runId: runB, status: "running", queuedAt: now, startedAt: now, updatedAt: now }));
    store.addActiveRun({ runId: runB, babySessionId: "session-b", runDir: "/tmp/b", worktree: "/tmp/b", startedAt: now });

    // resolveSpeaker should return "baby" when runB and session-b match
    equal(resolveSpeaker(store, runB, "session-b"), "baby", "speaker matches runB session-b");
    // resolveSpeaker should return undefined when session-a is passed with runB
    equal(resolveSpeaker(store, runB, "session-a"), undefined, "speaker rejects wrong session");
    // resolveSpeaker should return undefined for runA with session-b (runA has no babySessionId)
    equal(resolveSpeaker(store, runA, "session-b"), undefined, "speaker rejects run without session");
  });
});

test("_testSyncSubscriptions wires all active runs and convergences", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);

    const runA = "20260101-000000-a";
    const runB = "20260101-000000-b";
    const runC = "20260101-000000-c";
    const now = systemClock.nowIso();
    store.writeMeta(makeTestMeta({ runId: runA, status: "running", queuedAt: now, startedAt: now, updatedAt: now }));
    store.writeMeta(makeTestMeta({ runId: runB, status: "running", queuedAt: now, startedAt: now, updatedAt: now }));
    store.writeMeta(makeTestMeta({ runId: runC, status: "running", queuedAt: now, startedAt: now, updatedAt: now }));

    // Seed active_run rows
    store.addActiveRun({ runId: runA, babySessionId: "sess-a", runDir: "/tmp/a", worktree: "/tmp/a", startedAt: now });
    store.addActiveRun({ runId: runB, babySessionId: "sess-b", runDir: "/tmp/b", worktree: "/tmp/b", startedAt: now });
    // Seed active_convergence row for runC
    store.addActiveConvergence({ runId: runC, startedAt: now });

    const ensured: string[] = [];
    const closed: string[] = [];
    const subscriptions = new Map<string, { close: () => void }[]>();

    // Seed one existing subscription that should be closed (runX not in active set)
    subscriptions.set("runX", [{ close: () => { closed.push("runX"); } }]);

    const ensureRun = (meta: RunMeta): void => { ensured.push(meta.runId); };
    const closeRun = (runId: string): void => { closed.push(runId); };

    _testSyncSubscriptions(store, subscriptions, ensureRun, closeRun);

    // Should have ensured all 3 active runs/convergences
    equal(ensured.length, 3, "ensureRun called for all active runs and convergences");
    ok(ensured.includes(runA), `ensured ${runA}`);
    ok(ensured.includes(runB), `ensured ${runB}`);
    ok(ensured.includes(runC), `ensured ${runC}`);

    // Should have closed the stale subscription
    ok(closed.includes("runX"), "closed stale subscription runX");
  });
});
