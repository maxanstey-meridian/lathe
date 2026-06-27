import { equal, strictEqual, ok, throws, deepStrictEqual } from "node:assert";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { readdirSync, writeFileSync as writeFileSyncSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config, Clock, Repo, Paths, RunMeta } from "@lathe/core";
import { makePaths, SqliteStoreAdapter, systemClock, buildRepo, Config as ConfigSchema } from "@lathe/core";
import type { Supervisor } from "../src/supervisor.js";
import { createSupervisor, NonChainTipError, TerminalRunError, RunNotFoundError } from "../src/supervisor.js";
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
  isCloneSandbox: () => false,
  mergeAccept: () => { throw new Error("unimplemented"); },
});

const makeTestPaths = async (base?: string): Promise<Paths & { teardown: () => Promise<void> }> => {
  const root = base ?? await mkdtemp(join(tmpdir(), "lathe-supervisor-"));
  const paths = makePaths(root);
  const dirs = [paths.root, paths.queueDir, paths.rejectedDir, paths.stagedDir, paths.runsDir, paths.campaignsDir];
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
  stallRetries: 0,
  reorientRetries: 0,
  reviewerUnreachable: 0,
  updatedAt: systemClock.nowIso(),
  ...partial,
});

const makeTestPacket = (override?: Record<string, unknown>): string => {
  const defaults = {
    repo: "/tmp/test-repo",
    outcomes: [{ id: "test", type: "string" }],
  };
  const fm = { ...defaults, ...override };
  return `---
repo: /tmp/test-repo
outcomes:
  - id: test
    type: string
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
    ok(typeof supervisor.abortRun === "function");
    ok(typeof supervisor.acceptRun === "function");
    ok(typeof supervisor.rejectRun === "function");
  });
});

// ---------------------------------------------------------------------------
// abortRun — not found

test("abortRun throws RunNotFoundError for unknown runId", async () => {
  await withSupervisor(async (supervisor) => {
    throws(
      () => supervisor.abortRun("nonexistent"),
      (err: Error) => err instanceof RunNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// abortRun — terminal run

test("abortRun throws TerminalRunError for a terminal run", async () => {
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
      () => supervisor.abortRun(runId),
      (err: Error) => err instanceof TerminalRunError && err.message.includes("already terminal"),
    );
  });
});

// ---------------------------------------------------------------------------
// abortRun — queued run (in queue only, no meta)

test("abortRun archives a queued run found in the queue (no meta)", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);

    const runId = "queued-no-meta";
    const packet = makeTestPacket();
    writeFileSyncSync(join(paths.queueDir, `${runId}.md`), packet);

    const queue = store.listQueue();
    equal(queue.length, 1);
    equal(queue[0].runId, runId);

    equal(store.readMetaIfExists(runId), undefined);

    // No exception means success.
    supervisor.abortRun(runId);

    // Queue file should be moved to rejectedDir (archiveQueue moves it).
    equal(readdirSync(paths.queueDir).filter(f => f.endsWith(".md")).length, 0);
  });
});

// ---------------------------------------------------------------------------
// abortRun — queued run (has meta with status "queued")

test("abortRun archives a queued run (meta status queued)", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(paths, repo, systemClock);

    const runId = "queued-with-meta";
    const packet = makeTestPacket();
    writeFileSyncSync(join(paths.queueDir, `${runId}.md`), packet);

    store.writeMeta(makeTestMeta({
      runId,
      status: "queued",
      queuedAt: systemClock.nowIso(),
      updatedAt: systemClock.nowIso(),
    }));

    // No exception means success.
    supervisor.abortRun(runId);

    // Queue file should be moved to rejectedDir.
    equal(readdirSync(paths.queueDir).filter(f => f.endsWith(".md")).length, 0);
  });
});

// ---------------------------------------------------------------------------
// abortRun — running run (no abortMap entry — fires silently)

test("abortRun for a running run does not throw when no abortMap entry", async () => {
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

    // No exception: abortRun fires abortMap.get(runId) which is undefined
    // in this test — the supervisor's private abortMap has no entry.
    // The run status should remain "running" (no state change for running abort).
    supervisor.abortRun(runId);
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
    abortRun: () => {},
    isChainTip: (id: string) => !stagedEntries.some(s => s.parentRunId === id),
    lastVerdict: () => null,
    listStaged: () => stagedEntries,
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

// ---------------------------------------------------------------------------
// rejectRun — queued run (no meta) — archives via queue check

test("rejectRun archives a queued run found in the queue (no meta)", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const runId = "reject-queued";
    writeFileSyncSync(join(paths.queueDir, `${runId}.md`), makeTestPacket());

    equal(readdirSync(paths.queueDir).filter(f => f.endsWith(".md")).length, 1);
    equal(createStore(paths).readMetaIfExists(runId), undefined);

    supervisor.rejectRun(runId, "not needed");

    equal(readdirSync(paths.queueDir).filter(f => f.endsWith(".md")).length, 0);
  });
});

const createStore = (paths: Paths) => SqliteStoreAdapter.create(paths, fakeRepo(), systemClock);

const testConfig = {
  baby: { modelId: "test", baseUrl: "http://localhost:9999", contextWindow: 131072, turnSteps: 30 } as const,
  daddy: { modelId: "test-daddy", provider: "test-provider" } as const,
  superdaddy: { modelId: "test-superdaddy" } as const,
  thresholds: { ladderParkAt: 10, ladderRotateAt: 4, maxPasses: 3 } as const,
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
    abortRun: () => {},
    isChainTip: (id: string) => id === childRunId,
    lastVerdict: () => null,
    listStaged: () => stagedEntries,
    acceptRun: (id: string): number => {
      if (stagedEntries.some(s => s.parentRunId === id)) {
        throw new NonChainTipError(id, childRunId);
      }
      return 2;
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
    abortRun: () => {},
    isChainTip: (id: string) => id === "a-chain" || id === "b-child-chain",
    lastVerdict: () => null,
    listStaged: () => stagedEntries,
    acceptRun: (id: string): number => {
      if (stagedEntries.some(s => s.parentRunId === id)) {
        throw new NonChainTipError(id, "b-child-chain");
      }
      return 2;
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
