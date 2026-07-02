import { equal, strictEqual, ok } from "node:assert";
import { mkdtemp as mkdtempP, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BridgePort } from "../src/application/ports/bridge.js";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import {
  recoverOrphanedRuns,
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
import type { RunMeta } from "../src/domain/run.js";
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
  fetchBranchFromClone: () => {
    throw new Error("unimplemented");
  },
  removeSandbox: () => {
    throw new Error("unimplemented");
  },
  headBranch: () => "main",
  branchExists: () => true,
  repoValid: () => true,
  mergeAccept: () => {
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
      bind: () => Promise.resolve({ current: undefined }),
      clearActive: () => undefined,
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
      bind: () => Promise.resolve({ current: undefined }),
      clearActive: () => undefined,
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
    equal(decision.crashRetries, 1);

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
    equal(decision.crashRetries, 2);
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
      fetchBranchFromClone: () => undefined,
      removeSandbox: () => undefined,
      headBranch: () => "main",
      branchExists: () => true,
      repoValid: () => true,
      mergeAccept: () => undefined,
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
        bind: () => Promise.resolve({ current: undefined }),
        clearActive: () => undefined,
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
      fetchBranchFromClone: () => undefined,
      removeSandbox: () => undefined,
      headBranch: () => "main",
      branchExists: () => true,
      repoValid: () => true,
      mergeAccept: () => undefined,
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
        bind: () => Promise.resolve({ current: undefined }),
        clearActive: () => undefined,
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
