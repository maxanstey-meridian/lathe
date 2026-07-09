import { deepEqual, equal, strictEqual, ok } from "node:assert";
import { mkdtemp as mkdtempP, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BridgePort } from "../src/application/ports/bridge.js";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import type { Store } from "../src/application/ports/store.js";
import {
  recoverOrphanedRuns,
  recoverStaleActiveRuns,
  recoverStaleActiveConvergences,
  recoverStalledRun,
  recoverStalledRunsAtStartup,
  runLoop,
  type ExecuteRunCallback,
  type ConvergeCallback,
  type WaitForWorkCallback,
} from "../src/application/use-cases/run-loop.js";
import { makePaths } from "../src/config/paths.js";
import { Config } from "../src/config/schemas.js";
import { decideCrashRecovery } from "../src/domain/liveness.js";
import type { ActiveConvergence, ActiveRun, RunMeta } from "../src/domain/run.js";
import { SqliteStoreAdapter } from "../src/infrastructure/sqlite-store.js";

// ---------------------------------------------------------------------------
// Test helpers

const TS_COUNTER = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS_COUNTER.n++).padStart(2, "0")}.000Z`,
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
  reviewerUnreachable: 0,
  promoted: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const cleanTemp = async (dir: string) => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

// ---------------------------------------------------------------------------
// recoverOrphanedRuns (R8)

test("recoverOrphanedRuns: running run → queued + wip commit", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-orphan-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    const meta = makeMeta({ runId: "20260101-000000-orphan", status: "running" as const });
    store.writeMeta(meta);

    strictEqual(store.readMeta("20260101-000000-orphan").status, "running");

    recoverOrphanedRuns(store, fakeRepo(), clock);

    const read = store.readMeta("20260101-000000-orphan");
    equal(read.status, "queued");
  })();
});

test("recoverOrphanedRuns: multiple running runs → all queued", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-orphan2-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(makeMeta({ runId: "20260101-000000-a", status: "running" as const }));
    store.writeMeta(makeMeta({ runId: "20260101-000000-b", status: "running" as const }));
    store.writeMeta(makeMeta({ runId: "20260101-000000-c", status: "queued" as const }));

    recoverOrphanedRuns(store, fakeRepo(), clock);

    equal(store.readMeta("20260101-000000-a").status, "queued");
    equal(store.readMeta("20260101-000000-b").status, "queued");
    equal(store.readMeta("20260101-000000-c").status, "queued");
    await cleanTemp(tmp);
  })();
});

test("recoverOrphanedRuns: non-running runs left alone", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-orphan3-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-wedged",
        status: "blocked" as const,
        blockedReason: "wedged" as const,
      }),
    );
    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-crashed",
        status: "blocked" as const,
        blockedReason: "crashed" as const,
      }),
    );
    store.writeMeta(makeMeta({ runId: "20260101-000000-failed", status: "failed" as const }));

    recoverOrphanedRuns(store, fakeRepo(), clock);

    equal(store.readMeta("20260101-000000-wedged").blockedReason, "wedged");
    equal(store.readMeta("20260101-000000-crashed").blockedReason, "crashed");
    equal(store.readMeta("20260101-000000-failed").status, "failed");
    await cleanTemp(tmp);
  })();
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
// recoverStalledRun (R10) — singular, post-run

test("recoverStalledRun: wedged with retries below cap → requeued", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stall-1-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-wedged",
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 0,
      }),
    );

    recoverStalledRun(store, "20260101-000000-wedged", 2, clock);

    const read = store.readMeta("20260101-000000-wedged");
    equal(read.status, "queued");
    equal(read.stallRetries, 1);
    equal(read.blockedReason, undefined);
    equal(read.blockedQuestion, undefined);
    await cleanTemp(tmp);
  })();
});

test("recoverStalledRun: wedged at cap (not yet promoted) → promote + requeue", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stall-2-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-wedged",
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 2,
        blockedQuestion: "stalled on turn 5",
      }),
    );

    const decision = recoverStalledRun(store, "20260101-000000-wedged", 2, clock);

    equal(decision.action, "promote");
    const read = store.readMeta("20260101-000000-wedged");
    equal(read.status, "queued");
    equal(read.promoted, true);
    equal(read.stallRetries, 0); // fresh retry budget on the strong model
    equal(read.blockedReason, undefined);
    await cleanTemp(tmp);
  })();
});

test("recoverStalledRun: wedged at cap AFTER promotion → escalate to human_decision", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stall-2b-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-wedged",
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 2,
        promoted: true,
        blockedQuestion: "stalled on turn 5",
      }),
    );

    const decision = recoverStalledRun(store, "20260101-000000-wedged", 2, clock);

    equal(decision.action, "escalate");
    const read = store.readMeta("20260101-000000-wedged");
    equal(read.status, "blocked");
    equal(read.blockedReason, "human_decision");
    ok(read.blockedQuestion?.includes("strong model"));
    await cleanTemp(tmp);
  })();
});

test("recoverStalledRun: crashed run → left alone", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stall-3-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-crashed",
        status: "blocked" as const,
        blockedReason: "crashed" as const,
        stallRetries: 0,
      }),
    );

    recoverStalledRun(store, "20260101-000000-crashed", 2, clock);

    const read = store.readMeta("20260101-000000-crashed");
    equal(read.status, "blocked");
    equal(read.blockedReason, "crashed");
    await cleanTemp(tmp);
  })();
});

test("recoverStalledRun: queued run → left alone", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stall-4-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(makeMeta({ runId: "20260101-000000-queued", status: "queued" as const }));

    recoverStalledRun(store, "20260101-000000-queued", 2, clock);

    const read = store.readMeta("20260101-000000-queued");
    equal(read.status, "queued");
    await cleanTemp(tmp);
  })();
});

test("recoverStalledRun: run with human_decision → left alone", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stall-5-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-human",
        status: "blocked" as const,
        blockedReason: "human_decision" as const,
        stallRetries: 0,
      }),
    );

    recoverStalledRun(store, "20260101-000000-human", 2, clock);

    const read = store.readMeta("20260101-000000-human");
    equal(read.status, "blocked");
    equal(read.blockedReason, "human_decision");
    await cleanTemp(tmp);
  })();
});

test("recoverStalledRun: absent run → no-op", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-stall-6-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    // Should not throw
    recoverStalledRun(store, "20260101-000000-absent", 2, clock);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// recoverStalledRunsAtStartup (R10)

test("recoverStalledRunsAtStartup: wedged below cap → requeued", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-startup-1-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-w1",
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 0,
      }),
    );
    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-w2",
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 1,
      }),
    );
    store.writeMeta(makeMeta({ runId: "20260101-000000-ok", status: "queued" as const }));

    recoverStalledRunsAtStartup(store, 2, clock);

    equal(store.readMeta("20260101-000000-w1").status, "queued");
    equal(store.readMeta("20260101-000000-w1").stallRetries, 1);
    equal(store.readMeta("20260101-000000-w2").status, "queued");
    equal(store.readMeta("20260101-000000-w2").stallRetries, 2);
    equal(store.readMeta("20260101-000000-ok").status, "queued");
    await cleanTemp(tmp);
  })();
});

test("recoverStalledRunsAtStartup: wedged at cap (not yet promoted) → promote + requeue", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-startup-2-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-wedged",
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 2,
      }),
    );

    recoverStalledRunsAtStartup(store, 2, clock);

    const read = store.readMeta("20260101-000000-wedged");
    equal(read.status, "queued");
    equal(read.promoted, true);
    equal(read.blockedReason, undefined);
    await cleanTemp(tmp);
  })();
});

test("recoverStalledRunsAtStartup: wedged at cap AFTER promotion → escalate", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-startup-2b-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-wedged",
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 2,
        promoted: true,
      }),
    );

    recoverStalledRunsAtStartup(store, 2, clock);

    const read = store.readMeta("20260101-000000-wedged");
    equal(read.status, "blocked");
    equal(read.blockedReason, "human_decision");
    ok(read.blockedQuestion?.includes("promoted"));
    await cleanTemp(tmp);
  })();
});

test("recoverStalledRunsAtStartup: crashed runs left alone", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-startup-3-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-crashed",
        status: "blocked" as const,
        blockedReason: "crashed" as const,
        stallRetries: 0,
      }),
    );

    recoverStalledRunsAtStartup(store, 2, clock);

    const read = store.readMeta("20260101-000000-crashed");
    equal(read.status, "blocked");
    equal(read.blockedReason, "crashed");
    await cleanTemp(tmp);
  })();
});

test("recoverStalledRunsAtStartup: no wedged runs → no-op", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-startup-4-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(makeMeta({ runId: "20260101-000000-ok", status: "queued" as const }));
    store.writeMeta(makeMeta({ runId: "20260101-000000-running", status: "running" as const }));

    recoverStalledRunsAtStartup(store, 2, clock);

    equal(store.readMeta("20260101-000000-ok").status, "queued");
    equal(store.readMeta("20260101-000000-running").status, "running");
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// Combined: orphan + stalled startup sweep (typical boot sequence)

test("recoverOrphanedRuns + recoverStalledRunsAtStartup: mixed states at startup", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-combined-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    // Orphaned: running
    store.writeMeta(makeMeta({ runId: "20260101-000000-orphan", status: "running" as const }));
    // Stalled wedged: blocked/wedged with retries under cap
    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-wedged",
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 0,
      }),
    );
    // Crashed: blocked/crashed — should be left alone
    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-crashed",
        status: "blocked" as const,
        blockedReason: "crashed" as const,
      }),
    );
    // Already queued: should stay queued
    store.writeMeta(makeMeta({ runId: "20260101-000000-queued", status: "queued" as const }));

    // Typical startup sequence: orphan first, then stalled
    recoverOrphanedRuns(store, fakeRepo(), clock);
    recoverStalledRunsAtStartup(store, 2, clock);

    equal(store.readMeta("20260101-000000-orphan").status, "queued");
    equal(store.readMeta("20260101-000000-wedged").status, "queued");
    equal(store.readMeta("20260101-000000-crashed").blockedReason, "crashed");
    equal(store.readMeta("20260101-000000-queued").status, "queued");
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// recoverStalledRun: wedged with 0 maxStallRetries → immediate escalate

test("recoverStalledRun: maxStallRetries=0 + promoteAtCap disabled → escalate immediately", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-no-retry-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-wedged",
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 0,
      }),
    );

    // promoteAtCap=false → no promoted attempt, escalate straight to Max.
    const decision = recoverStalledRun(store, "20260101-000000-wedged", 0, clock, false);

    equal(decision.action, "escalate");
    const read = store.readMeta("20260101-000000-wedged");
    equal(read.status, "blocked");
    equal(read.blockedReason, "human_decision");
    await cleanTemp(tmp);
  })();
});

test("recoverStalledRun: maxStallRetries=0 with promoteAtCap → promote once before escalating", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-no-retry-promote-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-wedged",
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 0,
      }),
    );

    const decision = recoverStalledRun(store, "20260101-000000-wedged", 0, clock);

    equal(decision.action, "promote");
    const read = store.readMeta("20260101-000000-wedged");
    equal(read.status, "queued");
    equal(read.promoted, true);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// runLoop lifecycle tests

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
      store.writeMeta({ ...m, status: "accepted" as const, updatedAt: clock.nowIso() });
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

test("runLoop: wedged run → recoverStalledRun → requeued", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-lifecycle-wedged-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    // Seed a queued run.
    store.writeMeta(
      makeMeta({ runId: "20260101-000000-w", status: "queued" as const, attempt: 1 }),
    );

    let executeRunCallCount = 0;
    const executeRun: ExecuteRunCallback = async (runId, meta, ref, clock) => {
      executeRunCallCount++;
      if (executeRunCallCount === 1) {
        // First call: park as wedged.
        store.writeMeta({
          ...store.readMeta(runId),
          status: "blocked" as const,
          blockedReason: "wedged" as const,
          blockedQuestion: "stalled on turn 3",
          updatedAt: clock.nowIso(),
        });
      } else {
        // Second call: accept + trigger stop.
        store.writeMeta({
          ...store.readMeta(runId),
          status: "accepted" as const,
          updatedAt: clock.nowIso(),
        });
        process.emit("SIGINT" as NodeJS.Signals);
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

    const finalMeta = store.readMeta("20260101-000000-w");
    equal(finalMeta.status, "accepted");
    equal(finalMeta.stallRetries, 1);
    await cleanTemp(tmp);
  })();
});

test("runLoop: blocked recovery uses override model label", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-blocked-promo-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
    const runId = "20260101-000000-blocked-promo";

    store.writeMeta(
      makeMeta({
        runId,
        status: "queued" as const,
        babyModel: "registry-fast",
      }),
    );

    const stopController = new AbortController();
    const executeRun: ExecuteRunCallback = async (id, _meta, _ref, runClock) => {
      const meta = store.readMeta(id);
      store.writeMeta({
        ...meta,
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 2,
        updatedAt: runClock.nowIso(),
      });
      stopController.abort();
    };
    const convergeStep: ConvergeCallback = async () => {};
    const waitForWork: WaitForWorkCallback = async () => {};
    const bridge: BridgePort = {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: (_ref, _runId) => undefined,
      close: () => undefined,
    };

    const config = Config.parse({
      baby: {
        models: {
          "registry-fast": {
            providerId: "alt-provider",
            modelId: "alt-model",
            baseUrl: "http://alt-provider.local/v1",
            contextWindow: 200_000,
          },
        },
      },
    });

    await runLoop(
      config,
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

    const journal = store.readJournal(runId);
    const promoEvent = journal.find((e) => e.event === "model_promoted");
    ok(promoEvent, "startup promotion should be journaled");
    if (promoEvent?.event === "model_promoted") {
      equal(promoEvent.from, "alt-provider/alt-model");
    }

    await cleanTemp(tmp);
  })();
});

test("runLoop: post-run promotion uses override model label", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-postrun-promo-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
    const runId = "20260101-000000-postrun-promo";

    store.writeMeta(
      makeMeta({
        runId,
        status: "queued" as const,
        babyModel: "registry-fast",
      }),
    );

    const stopController = new AbortController();
    const executeRun: ExecuteRunCallback = async (id, _meta, _ref, runClock) => {
      const meta = store.readMeta(id);
      store.writeMeta({ ...meta, status: "accepted" as const, updatedAt: runClock.nowIso() });
    };
    const convergeStep: ConvergeCallback = async (id) => {
      const meta = store.readMeta(id);
      store.writeMeta({
        ...meta,
        status: "blocked" as const,
        blockedReason: "wedged" as const,
        stallRetries: 2,
        updatedAt: clock.nowIso(),
      });
      stopController.abort();
    };
    const waitForWork: WaitForWorkCallback = async () => {};
    const bridge: BridgePort = {
      bind: () => Promise.resolve({ byRunId: new Map() }),
      clearActive: (_ref, _runId) => undefined,
      close: () => undefined,
    };

    const config = Config.parse({
      baby: {
        models: {
          "registry-fast": {
            providerId: "alt-provider",
            modelId: "alt-model",
            baseUrl: "http://alt-provider.local/v1",
            contextWindow: 200_000,
          },
        },
      },
    });

    await runLoop(
      config,
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

    const journal = store.readJournal(runId);
    const promoEvent = journal.find((e) => e.event === "model_promoted");
    ok(promoEvent, "post-run promotion should be journaled");
    if (promoEvent?.event === "model_promoted") {
      equal(promoEvent.from, "alt-provider/alt-model");
    }

    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// decideCrashRecovery usage in run-loop crash branch

test("runLoop crash branch: decideCrashRecovery requeue under cap → queued", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "runloop-crash-retry-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    store.writeMeta(
      makeMeta({
        runId: "20260101-000000-c",
        status: "blocked" as const,
        blockedReason: "crashed" as const,
        crashRetries: 0,
      }),
    );

    const decision = decideCrashRecovery(
      { status: "blocked", blockedReason: "crashed", crashRetries: 0 },
      2,
    );

    equal(decision.action, "requeue");
    if (decision.action === "requeue") {
      equal(decision.crashRetries, 1);
    }

    const read = store.readMeta("20260101-000000-c");
    equal(read.status, "blocked"); // run-loop would change this to queued
    equal(read.blockedReason, "crashed");

    await cleanTemp(tmp);
  })();
});

test("runLoop crash branch: decideCrashRecovery escalate at cap", () => {
  return (async () => {
    const decision = decideCrashRecovery(
      { status: "blocked", blockedReason: "crashed", crashRetries: 2 },
      2,
    );

    equal(decision.action, "escalate");
    if (decision.action === "escalate") {
      equal(decision.crashRetries, 2);
    }
  })();
});

test("runLoop crash branch: decideCrashRecovery ignores non-crashed reasons", () => {
  return (async () => {
    for (const reason of ["wedged", "human_decision"] as const) {
      const decision = decideCrashRecovery(
        { status: "blocked", blockedReason: reason, crashRetries: 0 },
        2,
      );
      equal(decision.action, "none", `${reason} should not be handled by crash recovery`);
    }
  })();
});

test("runLoop crash branch: thrown executeRun requeues crashed run under cap", () => {
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
    equal(meta.status, "queued");
    equal(meta.crashRetries, 1);
    equal(meta.blockedReason, undefined);
    equal(wipCommitCalls, 1);
    await cleanTemp(tmp);
  })();
});

test("runLoop crash branch: thrown executeRun escalates crashed run at cap", () => {
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
// runLoop: repo-affinity wiring — excludedRepos from active runs + convergences

test("runLoop: excludedRepos is built from listActiveRuns and listActiveConvergences", () => {
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
      initMetaFromQueue: () => undefined,
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

    // Verify: excludedRepos contains the repos from active runs and active convergences.
    deepEqual(
      capturedExcludedRepos.sort(),
      ["/tmp/active-repo", "/tmp/convergence-repo"].sort(),
      "excludedRepos should contain repos from active runs and active convergences",
    );
  })();
});

// ---------------------------------------------------------------------------
// Worker-pool: two workers claim different-repo runs concurrently
// ---------------------------------------------------------------------------

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
    const stopController = new AbortController();
    const executeRun: ExecuteRunCallback = async (runId, meta, ref, clock) => {
      executeRunCallCount++;
      const m = store.readMeta(runId);
      store.writeMeta({ ...m, status: "accepted" as const, updatedAt: clock.nowIso() });
      if (executeRunCallCount >= 2) {
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
