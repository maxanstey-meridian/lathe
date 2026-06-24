import { equal, strictEqual, ok, throws, deepStrictEqual } from "node:assert";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { readdirSync, writeFileSync as writeFileSyncSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Config, Clock, Repo, Paths, RunMeta } from "@lathe/core";
import { makePaths, StoreAdapter, systemClock, buildRepo, Config as ConfigSchema } from "@lathe/core";
import type { Supervisor } from "../src/supervisor.js";
import { createSupervisor, NonChainTipError, TerminalRunError, RunNotFoundError } from "../src/supervisor.js";

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

/**
 * Factory: creates a supervisor (which starts runDriver) and returns a
 * teardown that calls stop(). The 10s timeout in stop() prevents hanging.
 */
const withSupervisor = async (
  fn: (supervisor: Supervisor, paths: Paths & { teardown: () => Promise<void> }) => Promise<void>,
  base?: string,
): Promise<void> => {
  const paths = await makeTestPaths(base);
  let supervisor: Supervisor | undefined;
  try {
    const config = ConfigSchema.parse({}) as Config;
    supervisor = createSupervisor(config, paths);
    await fn(supervisor, paths);
  } finally {
    if (supervisor) {
      try {
        await supervisor.stop();
      } catch {
        // stop() has a 10s timeout — we don't need to handle it.
      }
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
    const store = StoreAdapter.create(paths, repo, systemClock);
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
    const store = StoreAdapter.create(paths, repo, systemClock);

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
    const store = StoreAdapter.create(paths, repo, systemClock);

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
    const store = StoreAdapter.create(paths, repo, systemClock);

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
    const store = StoreAdapter.create(paths, repo, systemClock);

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
    const store = StoreAdapter.create(paths, repo, systemClock);

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
// acceptRun — chain-tip guard

test("acceptRun throws NonChainTipError for a non-chain-tip run", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const runId = "parent-run";
    const repo = fakeRepo();
    const store = StoreAdapter.create(paths, repo, systemClock);

    store.writeMeta(makeTestMeta({
      runId,
      status: "ready_for_review",
      queuedAt: systemClock.nowIso(),
      updatedAt: systemClock.nowIso(),
    }));

    store.writeStaged("20260101-000000-child-run", `---
repo: /tmp/test-repo
outcomes:
  - id: test
    description: test
    type: string
expected_surface:
  - test.md
verification:
  - command: echo ok
parent_run_id: ${runId}
---
child body
`);

    throws(
      () => supervisor.acceptRun(runId),
      (err: Error) => err instanceof NonChainTipError && err.message.includes("not a chain tip"),
    );
  });
});

// ---------------------------------------------------------------------------
// readEventsSince — returns projected events with correct runId

test("readEventsSince returns projected events from the journal", async () => {
  await withSupervisor(async (supervisor, paths) => {
    const repo = fakeRepo();
    const store = StoreAdapter.create(paths, repo, systemClock);

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

const createStore = (paths: Paths) => StoreAdapter.create(paths, fakeRepo(), systemClock);
