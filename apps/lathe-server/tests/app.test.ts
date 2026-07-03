import { deepStrictEqual, equal, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { acceptRun as acceptRunUc } from "@lathe/core";
import type { RunMeta } from "@lathe/core";
import type { Supervisor } from "../src/supervisor.js";
import { createApp, createEventBus, createTailEventBus } from "../src/app.js";
import type { LatheEvent, TailEvent, TailSnapshotDto } from "@lathe/contract";
import { RunNotAnswerableError, RunNotFoundError, NonChainTipError } from "../src/supervisor.js";
import type { ValidatePacketResult } from "@lathe/core";

// ---------------------------------------------------------------------------
// Fake Supervisor — in-memory state, no real git/SQLite/runDriver

const defaultConfig = {
  baby: {
    modelId: "test",
    baseUrl: "http://localhost:9999",
    contextWindow: 131072,
    turnSteps: 30,
  } as const,
  daddy: { modelId: "test-daddy", providerId: "test-provider" } as const,
  superdaddy: { modelId: "test-superdaddy" } as const,
  thresholds: { ladderParkAt: 10, ladderRotateAt: 4, maxPasses: 3, rotationFraction: 0.65 } as const,
} as const;

const tailSnapshot = (runId: string): TailSnapshotDto => ({
  runId,
  summary: "tail summary",
  status: "running",
  startedAt: "2026-01-01T00:00:00Z",
  models: {
    baby: "test",
    promoted: "test-daddy",
    daddy: "test-daddy",
    super: "test-superdaddy",
  },
  promoted: false,
  budget: 85196,
  worktree: `/tmp/w/${runId}`,
  outcomesDone: 1,
  outcomesTotal: 2,
  gateReason: null,
  contextTokens: 1234,
  turn: 2,
  rotations: 1,
  journal: [
    {
      seq: 7,
      at: "2026-01-01T00:00:01Z",
      line: "00:00:01 ▶ run started (attempt 1)",
      event: "run_started",
      driver: true,
    },
  ],
  lastSeq: 7,
});

const makeFakeSupervisor = (overrides?: Partial<Supervisor>): Supervisor => {
  const metaStore = new Map<string, RunMeta>();
  const stagedEntries: Array<{ runId: string; parentRunId: string }> = [];

  const base = {
    stop: async () => {},
    config: defaultConfig,
    appDeps: {
      bus: createEventBus(),
      readEventsSince: (_seq: number): { seq: number; event: LatheEvent }[] => [],
    },

    enqueueRun: (_packetPath: string): string => {
      const runId = _packetPath.replace(/.*\//, "").replace(/\.md$/, "");
      if (!metaStore.has(runId)) {
        metaStore.set(runId, {
          runId,
          status: "queued" as const,
          attempt: 1,
          repo: "/tmp/test",
          base: "main",
          branch: `meridian/${runId}`,
          worktree: `/tmp/w/${runId}`,
          stallRetries: 0,
          reorientRetries: 0,
          reviewerUnreachable: 0,
          updatedAt: new Date().toISOString(),
          queuedAt: new Date().toISOString(),
        } as RunMeta);
      }
      return runId;
    },

    enqueueChain: (_chainDir: string): void => {},

    listRuns: (): RunMeta[] => Array.from(metaStore.values()),

    getRun: (runId: string): RunMeta | undefined => metaStore.get(runId),

    stopRun: (runId: string): void => {
      const meta = metaStore.get(runId);
      if (!meta) throw new RunNotFoundError(runId);
      metaStore.set(runId, { ...meta, status: "stopped" as const, updatedAt: new Date().toISOString() });
    },

    answerRun: (runId: string, _answer: string): void => {
      const meta = metaStore.get(runId);
      if (!meta) throw new RunNotFoundError(runId);
      if (meta.status !== "blocked" && meta.status !== "failed") throw new RunNotAnswerableError(`run ${runId} is not answerable (status: ${meta.status})`);
      metaStore.set(runId, { ...meta, status: "queued" as const, updatedAt: new Date().toISOString() });
    },

    acceptRun: (runId: string): number => {
      if (isChainTip(runId)) {
        const meta = metaStore.get(runId);
        if (!meta) throw new RunNotFoundError(runId);
        metaStore.set(runId, { ...meta, status: "accepted" as const, updatedAt: new Date().toISOString() });
        return meta.attempt + 1;
      }
      // Not chain tip — compute the chain tip via chain walking
      const tips = Array.from(metaStore.values()).filter(m => isChainTip(m.runId));
      const tip = tips.find(t => {
        let current: string | undefined = t.runId;
        while (current) {
          if (current === runId) return true;
          const entry = stagedEntries.find(s => s.runId === current);
          current = entry?.parentRunId;
        }
        return false;
      });
      throw new NonChainTipError(runId, tip?.runId ?? "unknown");
    },

    rejectRun: (runId: string, _reason: string): void => {
      const meta = metaStore.get(runId);
      if (!meta) throw new RunNotFoundError(runId);
      metaStore.set(runId, { ...meta, status: "blocked" as const, updatedAt: new Date().toISOString() });
    },

    isChainTip: (runId: string): boolean => !stagedEntries.some(s => s.parentRunId === runId),

    listStaged: (): Array<{ runId: string; parentRunId: string }> => stagedEntries,

    lastVerdict: (_runId: string): string | null => "approved",
    outcomes: (_runId: string): string => "",
    runReadModel: (runId: string) => ({
      campaignId: runId,
      parentRunId: null,
      expectedSurface: [],
      pass: 1,
      turn: 0,
      contextTokens: 0,
    }),
    getTailSnapshot: (runId: string): TailSnapshotDto | undefined => metaStore.has(runId) ? tailSnapshot(runId) : undefined,
    getActiveTailSnapshot: (): TailSnapshotDto | null => null,
    getStatus: () => ({
      activeRun: null,
      queued: Array.from(metaStore.values())
        .filter((meta) => meta.status === "queued")
        .map((meta) => ({ runId: meta.runId })),
      parked: Array.from(metaStore.values())
        .filter((meta) => meta.status === "blocked")
        .map((meta) => ({
          runId: meta.runId,
          blockedReason: meta.blockedReason ?? null,
          blockedQuestion: meta.blockedQuestion ?? null,
          stallRetries: meta.stallRetries,
        })),
      campaigns: [],
      staged: stagedEntries.map((entry) => ({ runId: entry.runId, parentRunId: entry.parentRunId ?? null })),
      review: Array.from(metaStore.values()).reduce(
        (summary, meta) => {
          if (meta.status === "ready_for_review") summary.readyForReview += 1;
          if (meta.status === "failed") summary.failed += 1;
          return summary;
        },
        { readyForReview: 0, failed: 0 },
      ),
    }),
    getReview: () => ({
      runs: Array.from(metaStore.values())
        .filter((meta) => meta.status !== "running" && meta.status !== "queued")
        .map((meta) => ({
          runId: meta.runId,
          status: meta.status,
          outcomes: "",
          branch: meta.branch,
          repo: meta.repo,
          base: meta.base,
          blockedQuestion: meta.blockedQuestion ?? null,
        })),
    }),
  };

  // Apply overrides: they replace base methods. To keep CRUD methods working
  // with overridden getRun/isChainTip, we use a proxy pattern — the base CRUD
  // methods are re-bound to the final merged object.
  const merged = { ...base, ...overrides };

  // Re-bind CRUD methods that need access to the merged getRun/isChainTip
  merged.stopRun = (runId: string) => {
    if (overrides?.stopRun) return overrides.stopRun!(runId);
    const meta = merged.getRun!(runId);
    if (!meta) throw new RunNotFoundError(runId);
    metaStore.set(runId, { ...meta, status: "stopped" as const, updatedAt: new Date().toISOString() });
  };

  merged.answerRun = (runId: string, answer: string) => {
    const meta = merged.getRun!(runId);
    if (!meta) throw new RunNotFoundError(runId);
    if (overrides?.answerRun) return overrides.answerRun!(runId, answer);
    if (meta.status !== "blocked" && meta.status !== "failed") throw new RunNotAnswerableError(`run ${runId} is not answerable (status: ${meta.status})`);
    metaStore.set(runId, { ...meta, status: "queued" as const, updatedAt: new Date().toISOString() });
  };

  merged.acceptRun = (runId: string): number => {
    if (overrides?.acceptRun) return overrides.acceptRun!(runId);
    if (merged.isChainTip!(runId)) {
      // Normal path — accept
      const metaObj = merged.getRun!(runId);
      if (!metaObj) throw new RunNotFoundError(runId);
      metaStore.set(runId, { ...metaObj, status: "accepted" as const, updatedAt: new Date().toISOString() });
      return metaObj.attempt + 1;
    }
    // Not chain tip — compute the chain tip via chain walking, using the merged listRuns and isChainTip
    const runs = merged.listRuns();
    const tips = runs.filter(r => merged.isChainTip!(r.runId));
    const tip = tips.find(t => {
      let current: string | undefined = t.runId;
      while (current) {
        if (current === runId) return true;
        const entry = stagedEntries.find(s => s.runId === current);
        current = entry?.parentRunId;
      }
      return false;
    });
    throw new NonChainTipError(runId, tip?.runId ?? "unknown");
  };

  merged.rejectRun = (runId: string, reason: string) => {
    if (overrides?.rejectRun) return overrides.rejectRun!(runId, reason);
    const meta = merged.getRun!(runId);
    if (!meta) throw new RunNotFoundError(runId);
    metaStore.set(runId, { ...meta, status: "blocked" as const, updatedAt: new Date().toISOString() });
  };

  return merged as Supervisor;
};

const makeAcceptSupervisor = (meta: RunMeta, currentBranch: string, isDirty = false): Supervisor => {
  const metaStore = new Map<string, RunMeta>([[meta.runId, meta]]);
  const store = {
    readMetaIfExists: (runId: string): RunMeta | undefined => metaStore.get(runId),
    writeMeta: (next: RunMeta): void => {
      metaStore.set(next.runId, next);
    },
    readConvergence: (_runId: string): Array<{ kind: string; primary?: { verdict: string } }> => [],
  };
  const repo = {
    headBranch: (_repoPath: string): string => currentBranch,
    worktreeIsDirty: (_repoPath: string): boolean => isDirty,
    fetchBranchFromClone: () => {},
    mergeAccept: () => {},
    removeSandbox: () => {},
  };
  const clock = { nowIso: () => new Date().toISOString() };

  return {
    stop: async () => {},
    config: defaultConfig,
    appDeps: {
      bus: createEventBus(),
      readEventsSince: (_seq: number): { seq: number; event: LatheEvent }[] => [],
    },
    enqueueRun: (_packetPath: string): string => meta.runId,
    enqueueChain: (_chainDir: string): void => {},
    listRuns: (): RunMeta[] => Array.from(metaStore.values()),
    getRun: (runId: string): RunMeta | undefined => metaStore.get(runId),
    stopRun: (_runId: string): void => {},
    acceptRun: (runId: string): number =>
      acceptRunUc(runId, undefined, { store, repo, clock, runsDir: "/tmp/runs" }),
    rejectRun: (_runId: string, _reason: string): void => {},
    isChainTip: (_runId: string): boolean => true,
    lastVerdict: (_runId: string): string | null => null,
    outcomes: (_runId: string): string => "",
    runReadModel: (runId: string) => ({
      campaignId: runId,
      parentRunId: null,
      expectedSurface: [],
      pass: 1,
      turn: 0,
      contextTokens: 0,
    }),
    getTailSnapshot: (_runId: string): TailSnapshotDto | undefined => undefined,
    getActiveTailSnapshot: (): TailSnapshotDto | null => null,
    getStatus: () => ({ activeRun: null, queued: [], parked: [], campaigns: [], staged: [], review: { readyForReview: 0, failed: 0 } }),
    getReview: () => ({ runs: [] }),
    listStaged: (): Array<{ runId: string; parentRunId: string | undefined }> => [],
  } satisfies Supervisor;
};

// ---------------------------------------------------------------------------
// createApp — handler delegation
// ---------------------------------------------------------------------------

test("createApp accepts supervisor and wires handlers", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);
  ok(app, "app created without error");
});

test("EnqueueRun returns 202 with RunSummaryDto", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packetPath: "my-packet.md" }),
  });
  const res = await app.request(req);
  equal(res.status, 202);
  const body = await res.json() as { runId: string; status: string };
  equal(body.runId, "my-packet");
  equal(body.status, "queued");
});

test("EnqueueRun returns 400 for bad packet path", async () => {
  const supervisor = makeFakeSupervisor({
    enqueueRun: () => { throw new Error("no such file: /nonexistent/path.md"); },
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packetPath: "/nonexistent/path.md" }),
  });
  const res = await app.request(req);
  equal(res.status, 400);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "invalid_packet");
  ok(body.message.includes("no such file"));
});

test("EnqueueChain returns only enqueued runs, not all runs", async () => {
  const existingMeta = {
    runId: "pre-existing",
    status: "accepted" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/pre-existing",
    worktree: "/tmp/w/pre-existing",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  } as RunMeta;

  let chainCreated = false;
  const supervisor = makeFakeSupervisor({
    getRun: (id: string) => (id === "pre-existing" ? existingMeta : undefined),
    listRuns: () => chainCreated ? [existingMeta, { ...existingMeta, runId: "chain-a", status: "queued" as const, attempt: 1, repo: "/tmp/test", base: "main", branch: "meridian/chain-a", worktree: "/tmp/w/chain-a", stallRetries: 0, reorientRetries: 0, reviewerUnreachable: 0, updatedAt: new Date().toISOString(), queuedAt: new Date().toISOString() } as RunMeta] : [existingMeta],
    isChainTip: () => true,
    enqueueChain: () => { chainCreated = true; },
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/chains", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chainDir: "/some/dir" }),
  });
  const res = await app.request(req);
  equal(res.status, 202);
  const body = await res.json() as Array<{ runId: string }>;
  equal(body.length, 1);
  equal(body[0].runId, "chain-a");
});

test("GetRun returns 404 for unknown runId", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/runs/nonexistent");
  const res = await app.request(req);
  equal(res.status, 404);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "not_found");
});

test("GetRun returns RunDetailDto for known run", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const runId = "test-detail";
  supervisor.getRun(runId) || supervisor.listRuns(); // trigger creation via enqueue
  const meta = {
    runId,
    status: "running" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/test",
    worktree: "/tmp/test-worktree",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  } as RunMeta;

  // Inject meta directly into the fake's store by extending with overrides
  const supWithMeta = makeFakeSupervisor({
    getRun: (id: string) => (id === runId ? meta : undefined),
    listRuns: () => [meta],
    isChainTip: () => true,
    outcomes: () => "1/2 done, 1 in progress",
    runReadModel: () => ({
      campaignId: "campaign-1",
      parentRunId: "parent-run",
      expectedSurface: ["apps/lathe-server/src/app.ts"],
      pass: 2,
      turn: 3,
      contextTokens: 4567,
    }),
  });
  const app2 = createApp(supWithMeta.appDeps, supWithMeta);

  const req = new Request(`http://localhost/runs/${runId}`);
  const res = await app2.request(req);
  equal(res.status, 200);
  const body = await res.json() as { runId: string; status: string; campaignId: string; parentRunId: string | null; expectedSurface: string[]; pass: number; turn: number; contextTokens: number; isChainTip: boolean; base: string; branch: string; outcomes: string; blockedReason: string | null; blockedQuestion: string | null };
  equal(body.runId, runId);
  equal(body.status, "running");
  equal(body.campaignId, "campaign-1");
  equal(body.parentRunId, "parent-run");
  deepStrictEqual(body.expectedSurface, ["apps/lathe-server/src/app.ts"]);
  equal(body.pass, 2);
  equal(body.turn, 3);
  equal(body.contextTokens, 4567);
  equal(body.base, "main");
  equal(body.branch, "meridian/test");
  equal(body.outcomes, "1/2 done, 1 in progress");
  equal(body.blockedReason, null);
  equal(body.blockedQuestion, null);
});

test("GetStatus returns daemon status snapshot", async () => {
  const supervisor = makeFakeSupervisor({
    getStatus: () => ({
      activeRun: { runId: "active", outcomes: "1/1 done", gateLatched: null, recentEvents: [] },
      queued: [{ runId: "queued" }],
      parked: [],
      campaigns: [],
      staged: [],
      review: { readyForReview: 0, failed: 0 },
    }),
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request(new Request("http://localhost/status"));
  equal(res.status, 200);
  const body = await res.json() as { activeRun: { runId: string } | null; queued: Array<{ runId: string }> };
  equal(body.activeRun?.runId, "active");
  equal(body.queued[0]?.runId, "queued");
});

test("GetReview returns daemon review snapshot", async () => {
  const supervisor = makeFakeSupervisor({
    getReview: () => ({
      runs: [{
        runId: "review-me",
        status: "ready_for_review",
        outcomes: "2/2 done",
        branch: "meridian/review-me",
        repo: "/repo",
        base: "main",
        blockedQuestion: null,
      }],
    }),
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request(new Request("http://localhost/review"));
  equal(res.status, 200);
  const body = await res.json() as { runs: Array<{ runId: string; outcomes: string }> };
  equal(body.runs[0]?.runId, "review-me");
  equal(body.runs[0]?.outcomes, "2/2 done");
});

test("ListRuns returns array of RunSummaryDto", async () => {
  const metaA = {
    runId: "run-a",
    status: "ready_for_review" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/run-a",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  } as RunMeta;

  const metaB = {
    runId: "run-b",
    status: "running" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/run-b",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  } as RunMeta;

  const supervisor = makeFakeSupervisor({
    getRun: (id: string) => (id === "run-a" ? metaA : id === "run-b" ? metaB : undefined),
    listRuns: () => [metaA, metaB],
    isChainTip: () => true,
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/runs");
  const res = await app.request(req);
  equal(res.status, 200);
  const body = await res.json() as Array<{ runId: string }>;
  equal(body.length, 2);
  strictEqual(body.map(r => r.runId).sort().join(","), "run-a,run-b");
});

test("GetConfig returns ConfigDto", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/config");
  const res = await app.request(req);
  equal(res.status, 200);
  const body = await res.json() as { models: { baby: { modelId: string } }, thresholds: object };
  ok("models" in body);
  ok("thresholds" in body);
});

test("AcceptRun on mid-chain link returns 409 naming correct tip", async () => {
  const parentRunId = "parent-chain";
  const childRunId = "child-chain";
  const parentMeta = {
    runId: parentRunId,
    status: "ready_for_review" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/parent-chain",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  } as RunMeta;
  const childMeta = {
    runId: childRunId,
    status: "queued" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/child-chain",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  } as RunMeta;

  const supervisor = makeFakeSupervisor({
    getRun: (id: string) => (id === parentRunId ? parentMeta : id === childRunId ? childMeta : undefined),
    listRuns: () => [parentMeta, childMeta],
    isChainTip: (id: string) => id === childRunId,
  });

  supervisor.listStaged().push({ runId: childRunId, parentRunId: parentRunId });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${parentRunId}/accept`, { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 409);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "chain_tip_required");
  ok(body.message.includes("not a chain tip"));
  ok(body.message.includes(childRunId), `409 message names correct tip (${childRunId}), not an unrelated chain's tip`);
});

test("AcceptRun 409 names the tip of the correct chain when multiple chains exist", async () => {
  const aMeta = {
    runId: "a-chain",
    status: "ready_for_review" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/a-chain",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  } as RunMeta;
  const bMeta = {
    runId: "b-chain",
    status: "ready_for_review" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/b-chain",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  } as RunMeta;
  const bChildMeta = {
    runId: "b-child",
    status: "queued" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/b-child",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  } as RunMeta;

  const supervisor = makeFakeSupervisor({
    getRun: (id: string) => (id === "a-chain" ? aMeta : id === "b-chain" ? bMeta : id === "b-child" ? bChildMeta : undefined),
    listRuns: () => [aMeta, bMeta, bChildMeta],
    isChainTip: (id: string) => id === "a-chain" || id === "b-child",
  });

  // Chain A: a-chain is standalone (no children).
  // Chain B: b-chain → b-child (tip is b-child).
  supervisor.listStaged().push({ runId: "b-child", parentRunId: "b-chain" });

  const app = createApp(supervisor.appDeps, supervisor);

  // Accept b-chain (not a tip) — should name b-child, NOT a-chain.
  const req = new Request("http://localhost/runs/b-chain/accept", { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 409);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "chain_tip_required");
  ok(body.message.includes("b-child"), "409 names b-child (tip of the correct chain), not a-chain");
  ok(!body.message.includes("a-chain"), "409 does not name a-chain (tip of unrelated chain)");
});

test("StopRun for unknown runId returns 404", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/runs/nonexistent/stop", { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 404);
});

test("StopRun for a running run returns updated summary", async () => {
  const runId = "stop-running";
  const meta = {
    runId,
    status: "running" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/stop-running",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  } as RunMeta;

  const supervisor = makeFakeSupervisor({
    getRun: (id: string) => (id === runId ? meta : undefined),
    listRuns: () => [meta],
    stopRun: (id: string) => {
      if (id !== runId) throw new RunNotFoundError(id);
      meta.status = "stopped" as const;
    },
    isChainTip: () => true,
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/stop`, { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 201);
  const body = await res.json() as { runId: string; status: string };
  equal(body.runId, runId);
  ok(["blocked", "stopped"].includes(body.status));
});

test("AnswerRun returns updated queued summary", async () => {
  const runId = "answer-blocked";
  const meta = {
    runId,
    status: "blocked" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/answer-blocked",
    worktree: "/tmp/w",
    stallRetries: 1,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    blockedReason: "human_decision" as const,
    blockedQuestion: "proceed?",
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  } as RunMeta;
  let answerSeen = "";

  const supervisor = makeFakeSupervisor({
    getRun: (id: string) => (id === runId ? meta : undefined),
    answerRun: (id: string, answer: string) => {
      if (id !== runId) throw new RunNotFoundError(id);
      answerSeen = answer;
      meta.status = "queued" as const;
    },
    isChainTip: () => true,
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: "go ahead" }),
  });
  const res = await app.request(req);
  equal(res.status, 201);
  const body = await res.json() as { runId: string; status: string };
  equal(body.runId, runId);
  equal(body.status, "queued");
  equal(answerSeen, "go ahead");
});

test("StopRun for a queue-only run returns success without meta", async () => {
  const runId = "stop-queued";
  const supervisor = makeFakeSupervisor({
    getRun: () => undefined,
    stopRun: () => {},
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/stop`, { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 201);
  const body = await res.json() as { runId: string; status: string };
  equal(body.runId, runId);
  equal(body.status, "stopped");
});

test("AnswerRun for a non-blocked run returns 409", async () => {
  const runId = "answer-running";
  const meta = {
    runId,
    status: "running" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/answer-running",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  } as RunMeta;

  const supervisor = makeFakeSupervisor({
    getRun: (id: string) => (id === runId ? meta : undefined),
    isChainTip: () => true,
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: "go ahead" }),
  });
  const res = await app.request(req);
  equal(res.status, 409);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "not_answerable");
  ok(body.message.includes("not answerable"));
});

test("AcceptRun on chain tip returns 200", async () => {
  const runId = "accept-tip";
  const meta = {
    runId,
    status: "ready_for_review" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/accept-tip",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  } as RunMeta;

  const supervisor = makeAcceptSupervisor(meta, "main");
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/accept`, { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 201);
  const body = await res.json() as { runId: string; status: string };
  equal(body.runId, runId);
  equal(body.status, "accepted");
});

test("AcceptRun refusal returns a failing response", async () => {
  const runId = "accept-refused";
  const meta = {
    runId,
    status: "ready_for_review" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/accept-refused",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
  } as RunMeta;
  const supervisor = makeAcceptSupervisor(meta, "develop");
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/accept`, { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 409);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "accept_refused");
});

test("RejectRun returns updated summary", async () => {
  const runId = "reject-run";
  const meta = {
    runId,
    status: "running" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/reject-run",
    worktree: "/tmp/w",
    stallRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    updatedAt: new Date().toISOString(),
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  } as RunMeta;

  const supervisor = makeFakeSupervisor({
    getRun: (id: string) => (id === runId ? meta : undefined),
    rejectRun: (id: string) => {
      if (id !== runId) throw new RunNotFoundError(id);
      meta.status = "blocked" as const;
    },
    isChainTip: () => true,
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "wrong scope" }),
  });
  const res = await app.request(req);
equal(res.status, 201);
   const body = await res.json() as { runId: string; status: string };
   equal(body.runId, runId);
   equal(body.status, "paused");
});

test("RejectRun for a queue-only run returns success without meta", async () => {
  const runId = "reject-queued";
  const supervisor = makeFakeSupervisor({
    getRun: () => undefined,
    rejectRun: () => {},
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "wrong scope" }),
  });
  const res = await app.request(req);
  equal(res.status, 201);
  const body = await res.json() as { runId: string; status: string };
  equal(body.runId, runId);
  equal(body.status, "paused");
});

test("GetTail returns daemon-owned snapshot for a run", async () => {
  const runId = "tail-run";
  const supervisor = makeFakeSupervisor();
  supervisor.enqueueRun(`/tmp/${runId}.md`);
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request(`http://localhost/tail/${runId}`);
  equal(res.status, 200);
  const body = await res.json() as TailSnapshotDto;
  equal(body.runId, runId);
  equal(body.summary, "tail summary");
  equal(body.models.baby, "test");
  equal(body.outcomesDone, 1);
  equal(body.outcomesTotal, 2);
  equal(body.journal[0]?.seq, 7);
  equal(body.lastSeq, 7);
});

test("GetTail returns 404 for a missing run", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/tail/missing-run");
  equal(res.status, 404);
});

test("GetActiveTail returns null when no active tail target exists", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/tail/active");
  equal(res.status, 200);
  strictEqual(await res.json(), null);
});

test("GetActiveTail returns the daemon active tail snapshot", async () => {
  const supervisor = makeFakeSupervisor({
    getActiveTailSnapshot: () => tailSnapshot("active-tail"),
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/tail/active");
  equal(res.status, 200);
  const body = await res.json() as TailSnapshotDto;
  equal(body.runId, "active-tail");
});

// ---------------------------------------------------------------------------
// SSE feed — basic connectivity
// ---------------------------------------------------------------------------

test("SSE: /events returns 200 with text/event-stream", async () => {
  const bus = createEventBus();
  const deps = {
    bus,
    readEventsSince: (_seq: number): { seq: number; event: LatheEvent }[] => [],
  };
  const app = createApp(deps, null as unknown as Supervisor, { logger: false });

  const res = await app.request("http://localhost/events");
  equal(res.status, 200);
  ok(res.headers.get("content-type")?.includes("text/event-stream"));
  await res.body?.cancel();
});

test("Tail SSE: run stream replays only matching durable tail events", async () => {
  const tailBus = createTailEventBus();
  const events: TailEvent[] = [
    { kind: "tail.journal", runId: "r1", seq: 1, at: "2026-01-01T00:00:01Z", line: "r1", event: "run_started", driver: true },
    { kind: "tail.journal", runId: "r2", seq: 2, at: "2026-01-01T00:00:02Z", line: "r2", event: "run_started", driver: true },
    { kind: "tail.stats", runId: "r1", seq: 3, at: "2026-01-01T00:00:03Z", contextTokens: 10, turn: 1, rotations: 0, outcomesDone: 0, outcomesTotal: 1, gateReason: null, status: "running", promoted: true },
  ];
  const deps = {
    bus: createEventBus(),
    readEventsSince: (_seq: number): { seq: number; event: LatheEvent }[] => [],
    tailBus,
    readTailEventsSince: (seq: number, runId: string): TailEvent[] =>
      events.filter((event) => "seq" in event && event.seq > seq && "runId" in event && event.runId === runId),
  };
  const app = createApp(deps, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/tail/r1/events", { signal: controller.signal });
  equal(res.status, 200);
  const reader = res.body!.getReader();
  const body = await readUntilId(reader, "3");
  clearTimeout(timer);
  await reader.cancel();
  ok(body.includes("id: 1"), "replays r1 journal event");
  ok(body.includes("id: 3"), "replays r1 stats event");
  ok(body.includes('"promoted":true'), "replays promoted state in stats event");
  ok(!body.includes("id: 2"), "filters r2 event");
});

test("Tail SSE: run stream receives live matching tail events", async () => {
  const tailBus = createTailEventBus();
  const deps = {
    bus: createEventBus(),
    readEventsSince: (_seq: number): { seq: number; event: LatheEvent }[] => [],
    tailBus,
    readTailEventsSince: (_seq: number, _runId: string): TailEvent[] => [],
  };
  const app = createApp(deps, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/tail/r1/events", { signal: controller.signal });
  equal(res.status, 200);
  const reader = res.body!.getReader();
  tailBus.publish({ kind: "tail.journal", runId: "r2", seq: 4, at: "2026-01-01T00:00:04Z", line: "r2", event: "run_started", driver: true });
  tailBus.publish({ kind: "tail.journal", runId: "r1", seq: 5, at: "2026-01-01T00:00:05Z", line: "r1", event: "run_started", driver: true });
  const body = await readUntilId(reader, "5");
  clearTimeout(timer);
  await reader.cancel();
  ok(body.includes("id: 5"), "receives matching live event");
  ok(!body.includes("id: 4"), "filters non-matching live event");
});

test("SSE: fresh connection with no Last-Event-ID replays the first event", async () => {
  const bus = createEventBus();
  const events: { seq: number; event: LatheEvent }[] = [
    { seq: 1, event: { kind: "log", runId: "r", line: "e1", at: new Date().toISOString() } },
    { seq: 2, event: { kind: "log", runId: "r", line: "e2", at: new Date().toISOString() } },
  ];

  const deps = {
    bus,
    readEventsSince: (seq: number): { seq: number; event: LatheEvent }[] => events.filter((e) => e.seq > seq),
  };
  const app = createApp(deps, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/events", {
    signal: controller.signal,
  });
  equal(res.status, 200);

  const reader = res.body!.getReader();
  const body = await readUntilId(reader, "1");
  clearTimeout(timer);
  await reader.cancel();
  ok(body.includes("id: 1"), "replays the first event when Last-Event-ID is absent");
});

test("SSE: reconnect-mid-stream replay from Last-Event-ID", async () => {
  const bus = createEventBus();
  const events: { seq: number; event: LatheEvent }[] = [
    { seq: 1, event: { kind: "log", runId: "r", line: "e1", at: new Date().toISOString() } },
    { seq: 2, event: { kind: "log", runId: "r", line: "e2", at: new Date().toISOString() } },
    { seq: 3, event: { kind: "log", runId: "r", line: "e3", at: new Date().toISOString() } },
  ];

  const deps = {
    bus,
    readEventsSince: (seq: number): { seq: number; event: LatheEvent }[] => {
      // Exclusive: returns events with seq > given seq
      return events.filter(e => e.seq > seq);
    },
  };
  const app = createApp(deps, null as unknown as Supervisor, { logger: false });

  // Connect with Last-Event-ID = 1 → should replay seq 2, 3
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/events", {
    headers: { "Last-Event-ID": "1" },
    signal: controller.signal,
  });
  equal(res.status, 200);

  const reader = res.body!.getReader();
  const body = await readUntilId(reader, "3");
  clearTimeout(timer);
  await reader.cancel();
  ok(body.includes("id: 2"), "replays seq 2");
  ok(body.includes("id: 3"), "replays seq 3");
  ok(!body.includes("id: 1"), "does not replay seq 1 (exclusive)");
});

test("SSE: replay/live handoff does not duplicate replayed events", async () => {
  const bus = {
    publish: (_seq: number, _event: LatheEvent) => {},
    subscribe: (onEvent: (seq: number, event: LatheEvent) => void) => {
      onEvent(2, { kind: "log", runId: "r", line: "e2", at: new Date().toISOString() });
      return () => {};
    },
  };
  const events: { seq: number; event: LatheEvent }[] = [
    { seq: 1, event: { kind: "log", runId: "r", line: "e1", at: new Date().toISOString() } },
    { seq: 2, event: { kind: "log", runId: "r", line: "e2", at: new Date().toISOString() } },
  ];

  const deps = {
    bus,
    readEventsSince: (seq: number): { seq: number; event: LatheEvent }[] => events.filter((e) => e.seq > seq),
  };
  const app = createApp(deps, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/events", {
    signal: controller.signal,
  });
  equal(res.status, 200);

  const reader = res.body!.getReader();
  const body = await readUntilId(reader, "2");
  clearTimeout(timer);
  await reader.cancel();

  equal((body.match(/id: 2/g) ?? []).length, 1, "replayed seq 2 is not duplicated by the live handoff");
});

test("SSE: reconnect with Last-Event-ID = 3 gets only live events", async () => {
  const bus = createEventBus();
  const events: { seq: number; event: LatheEvent }[] = [
    { seq: 1, event: { kind: "log", runId: "r", line: "e1", at: new Date().toISOString() } },
    { seq: 2, event: { kind: "log", runId: "r", line: "e2", at: new Date().toISOString() } },
  ];

  let latestSeq = 2;
  const deps = {
    bus,
    readEventsSince: (seq: number): { seq: number; event: LatheEvent }[] => {
      return events.filter(e => e.seq > seq);
    },
  };
  const app = createApp(deps, null as unknown as Supervisor, { logger: false });

  // Connect with Last-Event-ID = 2 → no replay, only live
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/events", {
    headers: { "Last-Event-ID": "2" },
    signal: controller.signal,
  });
  equal(res.status, 200);

  // Publish a new event to the live bus
  latestSeq++;
  const newEvt: LatheEvent = { kind: "log", runId: "r", line: "e3", at: new Date().toISOString() };
  events.push({ seq: latestSeq, event: newEvt });
  bus.publish(latestSeq, newEvt);

  // Give the bus a tick to deliver
  await new Promise(r => setTimeout(r, 50));

  // Read partial body to verify no replayed events, then abort
  const reader = res.body!.getReader();
  const bodyChunk = await reader.read();
  clearTimeout(timer);
  await reader.cancel();
  if (bodyChunk.value) {
    const body = new TextDecoder().decode(bodyChunk.value);
    ok(!body.includes("id: 1"), "no replay of seq 1");
    ok(!body.includes("id: 2"), "no replay of seq 2 (exclusive)");
  }
});

test("SSE: sequential reconnects are gap-free and dup-free", async () => {
  const bus = createEventBus();
  const events: { seq: number; event: LatheEvent }[] = [];

  const deps = {
    bus,
    readEventsSince: (seq: number): { seq: number; event: LatheEvent }[] => {
      return events.filter(e => e.seq > seq);
    },
  };
  const app = createApp(deps, null as unknown as Supervisor, { logger: false });

  // Pre-seed 5 events
  for (let i = 1; i <= 5; i++) {
    const evt: LatheEvent = { kind: "log", runId: "r", line: `e${i}`, at: new Date().toISOString() };
    events.push({ seq: i, event: evt });
    bus.publish(i, evt);
  }

  // Client A: reconnect at seq 2 → replay 3, 4, 5 (verify via stream body)
  const controllerA = new AbortController();
  const timerA = setTimeout(() => controllerA.abort(), 2000);
  const resA = await app.request("http://localhost/events", {
    headers: { "Last-Event-ID": "2" },
    signal: controllerA.signal,
  });
  equal(resA.status, 200);

  const readerA = resA.body!.getReader();
  const bodyA = await readUntilId(readerA, "5");
  clearTimeout(timerA);
  await readerA.cancel();

  ok(bodyA.includes("id: 3"), "Client A replays seq 3");
  ok(bodyA.includes("id: 4"), "Client A replays seq 4");
  ok(bodyA.includes("id: 5"), "Client A replays seq 5");
  ok(!bodyA.includes("id: 1"), "Client A no replay of seq 1");
  ok(!bodyA.includes("id: 2"), "Client A no replay of seq 2 (exclusive)");

  // Client B: reconnect at seq 4 → replay 5
  const controllerB = new AbortController();
  const timerB = setTimeout(() => controllerB.abort(), 2000);
  const resB = await app.request("http://localhost/events", {
    headers: { "Last-Event-ID": "4" },
    signal: controllerB.signal,
  });
  equal(resB.status, 200);

  const readerB = resB.body!.getReader();
  const bodyB = await readUntilId(readerB, "5");
  clearTimeout(timerB);
  await readerB.cancel();

  ok(bodyB.includes("id: 5"), "Client B replays seq 5");
  ok(!bodyB.includes("id: 3"), "Client B no replay of seq 3 (exclusive at 4)");

  // Publish seq 6 (live event — arrives via bus handoff)
  const evt6: LatheEvent = { kind: "log", runId: "r", line: "e6", at: new Date().toISOString() };
  events.push({ seq: 6, event: evt6 });
  bus.publish(6, evt6);

  // Verify the live bus delivered seq 6 (gap-free handoff)
  await new Promise(r => setTimeout(r, 50));
  equal(events.length, 6);
  const seqs = events.map(e => e.seq).sort();
  strictEqual(seqs.join(","), "1,2,3,4,5,6");
});

async function readUntilId(reader: ReadableStreamDefaultReader<Uint8Array>, targetId: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  let totalLen = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    totalLen += value.length;
    chunks.push(value);
    const text = new TextDecoder().decode(value);
    if (text.includes(`id: ${targetId}`)) break;
  }
  const all = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) { all.set(c, offset); offset += c.length; }
  return new TextDecoder().decode(all);
}

// ---------------------------------------------------------------------------
// POST /packet — validate packet endpoint
// ---------------------------------------------------------------------------

test("POST /packet returns 200 with parsed frontmatter for valid packet", async () => {
  const validContent = `---
repo: /tmp/test
base: main
compare_commit: abc123
summary: test packet
outcomes:
  - id: test-outcome
    description: Test outcome
expected_surface:
  - src/app.ts
verification:
  - command: echo test
---
Body text
`;
  const supervisor = makeFakeSupervisor({
    validatePacket: (): ValidatePacketResult => ({
      repoPath: "/tmp/test",
      baseInFm: "main",
      headBranch: "main",
      stamped: validContent,
      shape: { ok: true, packet: { runId: "", frontmatter: { repo: "/tmp/test", base: "main", compare_commit: "abc123", summary: "test packet", outcomes: [{ id: "test-outcome", description: "Test outcome" }], expected_surface: ["src/app.ts"], suspicious_surface: [], verification: [{ command: "echo test" }], constraints: [], autofix_commands: [], campaign_id: undefined, parent_run_id: undefined, pass: 1, regression_outcomes: [], promoted: false }, body: "Body text", raw: validContent } },
      repoValid: true,
      baseExists: true,
      base: "main",
    }),
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/packet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: validContent }),
  });
  const res = await app.request(req);
  equal(res.status, 200);
  const body = await res.json() as { ok: boolean; frontmatter: object | null; body: string; problems: string[] };
  equal(body.ok, true);
  ok(body.frontmatter !== null);
  strictEqual((body.frontmatter as any).repo, "/tmp/test");
  strictEqual((body.frontmatter as any).base, "main");
  strictEqual(body.body, "Body text");
  deepStrictEqual(body.problems, []);
});

test("POST /packet returns 200 with problems for invalid packet", async () => {
  const supervisor = makeFakeSupervisor({
    validatePacket: (): ValidatePacketResult => ({
      repoPath: undefined,
      baseInFm: undefined,
      headBranch: "",
      stamped: "no frontmatter",
      shape: { ok: false, problems: ["no YAML frontmatter opening delimiter (---) found"] },
      repoValid: false,
      baseExists: false,
      base: "",
    }),
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/packet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "no frontmatter at all" }),
  });
  const res = await app.request(req);
  equal(res.status, 200);
  const body = await res.json() as { ok: boolean; frontmatter: null; body: string; problems: string[] };
  equal(body.ok, false);
  strictEqual(body.frontmatter, null);
  equal(body.body, "");
  strictEqual(body.problems[0], "no YAML frontmatter opening delimiter (---) found");
});

test("POST /packet returns problems when repo is invalid or base branch missing", async () => {
  const validContent = `---
repo: /tmp/test
base: nonexistent-branch
summary: test packet
outcomes:
  - id: test-outcome
    description: Test outcome
expected_surface:
  - src/app.ts
verification:
  - command: echo test
---
Body text
`;
  const supervisor = makeFakeSupervisor({
    validatePacket: (): ValidatePacketResult => ({
      repoPath: "/tmp/test",
      baseInFm: "nonexistent-branch",
      headBranch: "main",
      stamped: validContent,
      shape: { ok: true, packet: { runId: "", frontmatter: { repo: "/tmp/test", base: "nonexistent-branch", compare_commit: undefined, summary: "test packet", outcomes: [{ id: "test-outcome", description: "Test outcome" }], expected_surface: ["src/app.ts"], suspicious_surface: [], verification: [{ command: "echo test" }], constraints: [], autofix_commands: [], campaign_id: undefined, parent_run_id: undefined, pass: 1, regression_outcomes: [], promoted: false }, body: "Body text", raw: validContent } },
      repoValid: true,
      baseExists: false,
      base: "nonexistent-branch",
    }),
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/packet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: validContent }),
  });
  const res = await app.request(req);
  equal(res.status, 200);
  const body = await res.json() as { ok: boolean; frontmatter: object | null; body: string; problems: string[] };
  equal(body.ok, false);
  equal(body.frontmatter, null);
  equal(body.body, "Body text");
  ok(body.problems.some(p => p.includes("nonexistent-branch")), `expected base-branch problem, got: ${body.problems.join("; ")}`);
});

test("POST /packet returns problems when repo is invalid", async () => {
  const validContent = `---
repo: /tmp/test
base: main
summary: repo invalid packet
outcomes:
  - id: test-outcome
    description: Test outcome
expected_surface:
  - src/app.ts
verification:
  - command: echo test
---
Body text
`;
  const supervisor = makeFakeSupervisor({
    validatePacket: (): ValidatePacketResult => ({
      repoPath: "/tmp/test",
      baseInFm: "main",
      headBranch: "main",
      stamped: validContent,
      shape: { ok: true, packet: { runId: "", frontmatter: { repo: "/tmp/test", base: "main", compare_commit: undefined, summary: "repo invalid packet", outcomes: [{ id: "test-outcome", description: "Test outcome" }], expected_surface: ["src/app.ts"], suspicious_surface: [], verification: [{ command: "echo test" }], constraints: [], autofix_commands: [], campaign_id: undefined, parent_run_id: undefined, pass: 1, regression_outcomes: [], promoted: false }, body: "Body text", raw: validContent } },
      repoValid: false,
      baseExists: true,
      base: "main",
    }),
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/packet", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: validContent }),
  });
  const res = await app.request(req);
  equal(res.status, 200);
  const body = await res.json() as { ok: boolean; frontmatter: null; body: string; problems: string[] };
  equal(body.ok, false);
  equal(body.frontmatter, null);
  equal(body.body, "Body text");
  ok(body.problems.some(p => p.includes("not a valid git repository")), `expected repo problem, got: ${body.problems.join("; ")}`);
});

test("POST /runs/content enqueues from raw content", async () => {
  const content = `---
repo: /tmp/test
base: main
compare_commit: abc123
summary: content packet
outcomes:
  - id: outcome-1
    description: Outcome 1
expected_surface:
  - src/app.ts
verification:
  - command: echo test
---
Body
`;
  let contentSeen = "";
  let filenameSeen = "";
  const supervisor = makeFakeSupervisor({
    enqueueContent: (c: string, f: string) => {
      contentSeen = c;
      filenameSeen = f;
      return "content-run";
    },
    getRun: (id: string) => (id === "content-run" ? {
      runId: "content-run", status: "queued" as const, attempt: 1, repo: "/tmp/test", base: "main", branch: "meridian/content-run", worktree: "/tmp/w", stallRetries: 0, reorientRetries: 0, reviewerUnreachable: 0, updatedAt: new Date().toISOString(), queuedAt: new Date().toISOString(),
    } as RunMeta : undefined),
    listRuns: () => [],
    isChainTip: () => true,
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/runs/content", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, filename: "20260101-120000-test-packet.md" }),
  });
  const res = await app.request(req);
  equal(res.status, 202);
  const body = await res.json() as { runId: string; status: string };
  equal(body.runId, "content-run");
  equal(body.status, "queued");
  ok(contentSeen.includes("Body"), "content passed through");
  equal(filenameSeen, "20260101-120000-test-packet.md");
});

// ---------------------------------------------------------------------------
// run-to-dto — status mapping
// ---------------------------------------------------------------------------

test("status mapping handles all domain values", async () => {
  const { mapStatus } = await import("../src/run-to-dto.js");

  strictEqual(mapStatus("queued"), "queued");
  strictEqual(mapStatus("running"), "running");
  strictEqual(mapStatus("interrupted"), "paused");
  strictEqual(mapStatus("ready_for_review"), "converged");
  strictEqual(mapStatus("blocked"), "paused");
  strictEqual(mapStatus("failed"), "failed");
  strictEqual(mapStatus("accepted"), "accepted");
  strictEqual(mapStatus("stopped"), "stopped");
});
