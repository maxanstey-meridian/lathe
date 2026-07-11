import { deepStrictEqual, equal, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import { Config } from "@lathe/core";
import type { RunMeta } from "@lathe/core";
import type { Supervisor } from "../src/supervisor.js";
import { createApp } from "../src/app.js";
import { createEventBus, createTailEventBus } from "../src/server-host.js";
import type { LatheEvent, TailEvent, TailSnapshotDto, SettingsDto, DecisionDto, OutcomeLedgerDto, ConvergenceLogEntryDto } from "@lathe/contract";
import { RunCancellationConflictError, RunLifecycleConflictError, RunNotAnswerableError, RunNotFoundError, NonChainTipError } from "../src/supervisor.js";
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
  panes: {
    baby: [{ text: "restored baby", style: "text" }],
    daddy: [],
    super: [],
  },
  acceptanceReviewLines: [],
  driverCommands: [],
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
  let currentConfig = overrides?.config ?? defaultConfig;
  const startupConfig = currentConfig;

  const base = {
    stop: async () => {},
    get config() { return currentConfig; },
    get settings() { return currentConfig; },
    get restartRequired() { return JSON.stringify(currentConfig) !== JSON.stringify(startupConfig); },
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

    stopRun: (runId: string): "stopped" => {
      const meta = metaStore.get(runId);
      if (!meta) throw new RunNotFoundError(runId);
      metaStore.set(runId, { ...meta, status: "stopped" as const, updatedAt: new Date().toISOString() });
      return "stopped";
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
    prepareTailSnapshot: async (runId: string): Promise<TailSnapshotDto | undefined> => metaStore.has(runId) ? tailSnapshot(runId) : undefined,
    prepareActiveTailSnapshot: async (): Promise<TailSnapshotDto | null> => null,
    resolveActiveTailRunId: (): string | null => null,
    getStatus: () => ({
      activeRuns: [],
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

    writeConfig: (raw: unknown) => Config.parse(raw),
    getDecisions: () => [],
    getLedger: () => ({ outcomes: [] }),
    getReport: () => "",
    getConvergence: () => [],
  };

  // Apply overrides: they replace base methods. To keep CRUD methods working
  // with overridden getRun/isChainTip, we use a proxy pattern — the base CRUD
  // methods are re-bound to the final merged object.
  const merged = { ...base, ...overrides };
  Object.defineProperty(merged, "config", { get: () => currentConfig });
  Object.defineProperty(merged, "settings", { get: () => currentConfig });
  Object.defineProperty(merged, "restartRequired", { get: () => JSON.stringify(currentConfig) !== JSON.stringify(startupConfig) });
  merged.writeConfig = (raw: unknown) => {
    currentConfig = Config.parse(raw);
    return currentConfig;
  };

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
    listActiveRuns: () => [],
    listActiveConvergences: () => [],
  };
  const repo = {
    headBranch: (_repoPath: string): string => currentBranch,
    worktreeIsDirty: (_repoPath: string): boolean => isDirty,
    fetchBranchFromClone: () => {},
    deleteBranch: () => {},
    removeSandbox: () => {},
  };
  const clock = { nowIso: () => new Date().toISOString() };

  return {
    stop: async () => {},
    config: defaultConfig,
    settings: defaultConfig,
    restartRequired: false,
    appDeps: {
      bus: createEventBus(),
      readEventsSince: (_seq: number): { seq: number; event: LatheEvent }[] => [],
    },
    enqueueRun: (_packetPath: string): string => meta.runId,
    enqueueChain: (_chainDir: string): void => {},
    listRuns: (): RunMeta[] => Array.from(metaStore.values()),
    getRun: (runId: string): RunMeta | undefined => metaStore.get(runId),
    stopRun: (_runId: string): "stopped" => "stopped",
    acceptRun: (runId: string): number => {
      const current = metaStore.get(runId);
      if (!current) throw new RunNotFoundError(runId);
      if (current.status !== "ready_for_review") return 1;
      metaStore.set(runId, { ...current, status: "accepted", updatedAt: clock.nowIso() });
      return 0;
    },
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
    prepareTailSnapshot: async (_runId: string): Promise<TailSnapshotDto | undefined> => undefined,
    prepareActiveTailSnapshot: async (): Promise<TailSnapshotDto | null> => null,
    resolveActiveTailRunId: (): string | null => null,
    getStatus: () => ({ activeRuns: [], queued: [], parked: [], campaigns: [], staged: [], review: { readyForReview: 0, failed: 0 } }),
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

test("EnqueueRun returns 500 when getRun misses after enqueue", async () => {
  const supervisor = makeFakeSupervisor({
    getRun: () => undefined,
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packetPath: "my-packet.md" }),
  });
  const res = await app.request(req);
  equal(res.status, 500);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "internal_error");
  equal(body.message, "enqueue succeeded but run not found");
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
      activeRuns: [{ runId: "active", outcomes: "1/1 done", gateLatched: null, recentEvents: [] }],
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
  const body = await res.json() as { activeRuns: Array<{ runId: string }>; queued: Array<{ runId: string }> };
  equal(body.activeRuns[0]?.runId, "active");
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

test("StopRun maps an ownerless running cancellation conflict to 409", async () => {
  const supervisor = makeFakeSupervisor({
    stopRun: (runId) => { throw new RunCancellationConflictError(runId); },
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request(new Request("http://localhost/runs/ownerless/stop", { method: "POST" }));
  equal(res.status, 409);
  deepStrictEqual(await res.json(), {
    code: "cancellation_conflict",
    message: "run ownerless is running without an active cancellation owner",
  });
});

test("unhealthy supervisor gates driver mutations but leaves diagnostics and restart reachable", async () => {
  let restartCalled = false;
  let queuedStopCalled = false;
  const supervisor = makeFakeSupervisor({
    health: () => ({ healthy: false, detail: "driver exploded" }),
    config: Config.parse({
      idleTimeoutMs: false,
      baby: {
        models: {
          large: {
            providerId: "omlx",
            modelId: "large-model",
            baseUrl: "http://localhost:8000/v1",
            contextWindow: 200_000,
          },
        },
      },
      superdaddy: { baseUrl: null, headerTimeoutMs: false },
      repos: {
        repo: {
          setup: { commands: [{ command: "pnpm install", dir: "." }] },
        },
      },
    }),
    getRun: (runId) => runId === "queued" ? ({ runId, status: "queued" } as RunMeta) : undefined,
    stopRun: (runId) => { queuedStopCalled = runId === "queued"; return "stopped"; },
  });
  const app = createApp(supervisor.appDeps, supervisor, {
    onRestart: () => { restartCalled = true; },
  });

  const mutation = await app.request(new Request("http://localhost/runs/content", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "packet", filename: "packet.md" }),
  }));
  equal(mutation.status, 503);
  deepStrictEqual(await mutation.json(), {
    code: "supervisor_unhealthy",
    message: "run driver unavailable: driver exploded",
  });

  const queuedStop = await app.request(new Request("http://localhost/runs/queued/stop", { method: "POST" }));
  equal(queuedStop.status, 202);
  equal(queuedStopCalled, true);

  const ownedStop = await app.request(new Request("http://localhost/runs/running/stop", { method: "POST" }));
  equal(ownedStop.status, 503);

  const status = await app.request(new Request("http://localhost/status"));
  equal(status.status, 200);

  const settings = await app.request(new Request("http://localhost/settings"));
  equal(settings.status, 200);
  const settingsBody = await settings.json() as { settings: SettingsDto };
  equal(settingsBody.settings.idleTimeoutMs, false);
  equal(settingsBody.settings.superdaddy.baseUrl, null);
  equal(settingsBody.settings.superdaddy.headerTimeoutMs, false);
  equal(settingsBody.settings.baby.models.large?.modelId, "large-model");
  deepStrictEqual(settingsBody.settings.repos.repo?.setup.commands, [{ command: "pnpm install", dir: "." }]);

  const restart = await app.request(new Request("http://localhost/restart", { method: "POST" }));
  equal(restart.status, 200);
  equal(restartCalled, true);
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
      return "cancellation_requested";
    },
    isChainTip: () => true,
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/stop`, { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 202);
  const body = await res.json() as { runId: string; status: string; cancellationRequested: boolean };
  equal(body.runId, runId);
  equal(body.status, "cancellation_requested");
  equal(body.cancellationRequested, true);
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

test("AnswerRun rejects a whitespace-only decision", async () => {
  let called = false;
  const supervisor = makeFakeSupervisor({
    answerRun: () => {
      called = true;
    },
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/runs/answer-blocked/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: "   " }),
  });

  equal(res.status, 400);
  deepStrictEqual(await res.json(), { code: "invalid_answer", message: "decision must not be empty" });
  equal(called, false);
});

test("StopRun for a queue-only run returns success without meta", async () => {
  const runId = "stop-queued";
  const supervisor = makeFakeSupervisor({
    getRun: () => undefined,
    stopRun: () => "stopped",
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/stop`, { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 202);
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

test("AnswerRun maps a lifecycle CAS conflict to 409", async () => {
  const supervisor = makeFakeSupervisor({
    getRun: (runId) => ({
      runId,
      status: "blocked",
      attempt: 1,
      repo: "/tmp/test",
      base: "main",
      branch: `meridian/${runId}`,
      worktree: `/tmp/w/${runId}`,
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      promoted: false,
      updatedAt: new Date().toISOString(),
    }),
    answerRun: () => {
      throw new RunLifecycleConflictError("run changed during answer");
    },
  });
  const app = createApp(supervisor.appDeps, supervisor);
  const response = await app.request("http://localhost/runs/test-run/answer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer: "continue" }),
  });
  equal(response.status, 409);
  deepStrictEqual(await response.json(), {
    code: "lifecycle_conflict",
    message: "run changed during answer",
  });
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
    status: "blocked" as const,
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
  const supervisor = makeAcceptSupervisor(meta, "main");
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
   equal(body.status, "blocked");
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
  equal(body.status, "blocked");
});

test("RejectRun maps a lifecycle CAS conflict to 409", async () => {
  const runId = "reject-conflict";
  const supervisor = makeFakeSupervisor({
    rejectRun: () => {
      throw new RunLifecycleConflictError("run changed during transition");
    },
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request(new Request(`http://localhost/runs/${runId}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: "wrong scope" }),
  }));

  equal(res.status, 409);
  equal((await res.json() as { code: string }).code, "lifecycle_conflict");
});

test("RequeueRun maps a lifecycle CAS conflict to 409", async () => {
  const runId = "requeue-conflict";
  const supervisor = makeFakeSupervisor({
    requeueRun: () => {
      throw new RunLifecycleConflictError("run changed during transition");
    },
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request(new Request(`http://localhost/runs/${runId}/requeue`, {
    method: "POST",
  }));

  equal(res.status, 409);
  equal((await res.json() as { code: string }).code, "lifecycle_conflict");
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
  deepStrictEqual(body.panes.baby, [{ text: "restored baby", style: "text" }]);
});

test("GetTail returns 404 for a missing run", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/tail/missing-run");
  equal(res.status, 404);
});

test("GetTail awaits snapshot hydration before responding", async () => {
  let release: ((snapshot: TailSnapshotDto) => void) | undefined;
  const hydrated = new Promise<TailSnapshotDto>((resolve) => { release = resolve; });
  const supervisor = makeFakeSupervisor({ prepareTailSnapshot: async () => hydrated });
  const app = createApp(supervisor.appDeps, supervisor);
  let settled = false;
  const pending = app.request("http://localhost/tail/run").finally(() => { settled = true; });
  await Promise.resolve();
  equal(settled, false);
  release?.(tailSnapshot("run"));
  equal((await pending).status, 200);
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
    prepareActiveTailSnapshot: async () => tailSnapshot("active-tail"),
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

test("Tail SSE: replay preserves distinct events sharing one journal sequence", async () => {
  const events: TailEvent[] = [
    { kind: "tail.journal", runId: "r1", seq: 4, at: "2026-01-01T00:00:04Z", line: "review", event: "super_review", driver: true },
    { kind: "tail.super.verdict", runId: "r1", seq: 4, at: "2026-01-01T00:00:04Z", verdict: "accept", pass: 1, findings: [], lines: ["accepted"] },
  ];
  const app = createApp({
    bus: createEventBus(),
    readEventsSince: () => [],
    tailBus: createTailEventBus(),
    readTailEventsSince: () => events,
  }, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/tail/r1/events", { signal: controller.signal });
  const reader = res.body!.getReader();
  const chunks: string[] = [];
  while (chunks.join("").split("id: 4").length - 1 < 2) {
    const chunk = await reader.read();
    if (chunk.done || !chunk.value) break;
    chunks.push(new TextDecoder().decode(chunk.value));
  }
  clearTimeout(timer);
  await reader.cancel();
  const body = chunks.join("");
  ok(body.includes("event: tail.journal"));
  ok(body.includes("event: tail.super.verdict"));
});

test("Tail SSE: events observed while preparing the snapshot are not appended twice", async () => {
  const tailBus = createTailEventBus();
  const app = createApp({
    bus: createEventBus(),
    readEventsSince: () => [],
    tailBus,
    readTailEventsSince: () => [],
    prepareTailSnapshot: async () => {
      tailBus.publish({ kind: "tail.journal", runId: "r1", seq: 8, at: "2026-01-01T00:00:08Z", line: "captured", event: "run_started", driver: true });
      return { snapshot: { ...tailSnapshot("r1"), lastSeq: 8 }, revision: tailBus.revision() };
    },
  }, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/tail/r1/events", { signal: controller.signal });
  const reader = res.body!.getReader();
  await reader.read();
  tailBus.publish({ kind: "tail.journal", runId: "r1", seq: 9, at: "2026-01-01T00:00:09Z", line: "live", event: "run_started", driver: true });
  const body = await readUntilId(reader, "9");
  clearTimeout(timer);
  await reader.cancel();
  ok(!body.includes("id: 8"));
  ok(body.includes("id: 9"));
});

test("Tail SSE: an unsequenced event newer than the prepared snapshot revision is delivered", async () => {
  const tailBus = createTailEventBus();
  const app = createApp({
    bus: createEventBus(),
    readEventsSince: () => [],
    tailBus,
    readTailEventsSince: () => [],
    prepareTailSnapshot: async () => {
      const revision = tailBus.revision();
      queueMicrotask(() => tailBus.publish({ kind: "tail.pane.delta", runId: "r1", speaker: "baby", style: "text", text: "after-snapshot" }));
      return { snapshot: tailSnapshot("r1"), revision };
    },
  }, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/tail/r1/events", { signal: controller.signal });
  const reader = res.body!.getReader();
  const body = await readUntilText(reader, "after-snapshot");
  clearTimeout(timer);
  await reader.cancel();
  ok(body.includes("after-snapshot"));
});

test("Tail SSE: identical unsequenced live deltas are both delivered", async () => {
  const tailBus = createTailEventBus();
  const app = createApp({
    bus: createEventBus(),
    readEventsSince: () => [],
    tailBus,
    readTailEventsSince: () => [],
  }, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/tail/r1/events", { signal: controller.signal });
  const reader = res.body!.getReader();
  await reader.read();
  const repeated: TailEvent = { kind: "tail.pane.delta", runId: "r1", speaker: "baby", style: "text", text: "same" };
  tailBus.publish(repeated);
  tailBus.publish(repeated);
  tailBus.publish({ kind: "tail.journal", runId: "r1", seq: 10, at: "2026-01-01T00:00:10Z", line: "sentinel", event: "run_started", driver: true });
  const body = await readUntilId(reader, "10");
  clearTimeout(timer);
  await reader.cancel();
  equal(body.split('"text":"same"').length - 1, 2);
});

test("Tail SSE: active bootstrap uses the authoritative prepared target", async () => {
  const prepared: Array<string | null> = [];
  const tailBus = createTailEventBus();
  const app = createApp({
    bus: createEventBus(),
    readEventsSince: () => [],
    tailBus,
    readTailEventsSince: () => [],
    prepareTailSnapshot: async (runId) => {
      prepared.push(runId);
      return { snapshot: tailSnapshot("child"), revision: tailBus.revision() };
    },
    resolveActiveTailRunId: () => "child",
  }, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/tail/active/events", { signal: controller.signal });
  const reader = res.body!.getReader();
  const chunk = await reader.read();
  clearTimeout(timer);
  const body = chunk.value ? new TextDecoder().decode(chunk.value) : "";
  deepStrictEqual(prepared, [null]);
  ok(body.includes('"runId":"child"'));
  await reader.cancel();
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

test("Tail SSE: first frame is an authoritative run snapshot", async () => {
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
  const chunk = await reader.read();
  clearTimeout(timer);
  await reader.cancel();
  const body = chunk.value ? new TextDecoder().decode(chunk.value) : "";
  ok(body.includes("event: tail.run.changed"), "writes the authoritative bootstrap frame first");
  ok(body.includes('"runId":"r1"'), "identifies the explicitly selected run");
});

test("Tail SSE: active stream sends an authoritative null snapshot", async () => {
  const tailBus = createTailEventBus();
  const app = createApp({
    bus: createEventBus(),
    readEventsSince: () => [],
    tailBus,
    readTailEventsSince: () => [],
  }, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/tail/active/events", { signal: controller.signal });
  const reader = res.body!.getReader();
  const chunk = await reader.read();
  clearTimeout(timer);
  const body = chunk.value ? new TextDecoder().decode(chunk.value) : "";
  ok(body.includes("event: tail.run.changed"));
  ok(body.includes('"snapshot":null'));
  await reader.cancel();
});

test("Tail SSE: active stream transitions to null without another run event", async () => {
  const tailBus = createTailEventBus();
  let activeRunId: string | null = "r1";
  const app = createApp({
    bus: createEventBus(),
    readEventsSince: () => [],
    tailBus,
    readTailEventsSince: () => [],
    resolveActiveTailRunId: () => activeRunId,
    prepareTailSnapshot: async () => ({
      snapshot: activeRunId ? tailSnapshot(activeRunId) : null,
      revision: tailBus.revision(),
    }),
  }, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  const res = await app.request("http://localhost/tail/active/events", { signal: controller.signal });
  const reader = res.body!.getReader();
  await reader.read();
  activeRunId = null;
  const body = await readUntilText(reader, '"runId":null');
  clearTimeout(timer);
  await reader.cancel();
  ok(body.includes('"snapshot":null'));
});

test("SSE: fresh connection with no Last-Event-ID starts live-only", async () => {
  const bus = createEventBus();
  let replayCalls = 0;

  const deps = {
    bus,
    readEventsSince: (_seq: number): { seq: number; event: LatheEvent }[] => {
      replayCalls++;
      return [];
    },
  };
  const app = createApp(deps, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/events", {
    signal: controller.signal,
  });
  equal(res.status, 200);

  const reader = res.body!.getReader();
  await reader.read();
  bus.publish(1, { kind: "log", runId: "r", line: "live", at: new Date().toISOString() });
  const body = await readUntilId(reader, "1");
  clearTimeout(timer);
  await reader.cancel();
  equal(replayCalls, 0, "fresh connections do not replay the historical journal");
  ok(body.includes("id: 1"), "fresh connections still receive live events");
});

test("SSE: Last-Event-ID is ignored for live-only status stream", async () => {
  const bus = createEventBus();
  let replayCalls = 0;

  const deps = {
    bus,
    readEventsSince: (_seq: number): { seq: number; event: LatheEvent }[] => {
      replayCalls++;
      return [];
    },
  };
  const app = createApp(deps, null as unknown as Supervisor, { logger: false });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  const res = await app.request("http://localhost/events", {
    headers: { "Last-Event-ID": "1" },
    signal: controller.signal,
  });
  equal(res.status, 200);

  const reader = res.body!.getReader();
  await reader.read();
  bus.publish(2, { kind: "log", runId: "r", line: "live", at: new Date().toISOString() });
  const body = await readUntilId(reader, "2");
  clearTimeout(timer);
  await reader.cancel();
  equal(replayCalls, 0, "status SSE never reads historical journal rows");
  ok(body.includes("id: 2"), "reconnected clients still receive live events");
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

async function readUntilText(reader: ReadableStreamDefaultReader<Uint8Array>, target: string): Promise<string> {
  let body = "";
  while (!body.includes(target)) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    body += new TextDecoder().decode(value);
  }
  return body;
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
baby_model: openai/gpt-5.6
---
Body text
`;
  const supervisor = makeFakeSupervisor({
    validatePacket: (): ValidatePacketResult => ({
      repoPath: "/tmp/test",
      baseInFm: "main",
      headBranch: "main",
      stamped: validContent,
      shape: { ok: true, packet: { runId: "", frontmatter: { repo: "/tmp/test", base: "main", compare_commit: "abc123", summary: "test packet", outcomes: [{ id: "test-outcome", description: "Test outcome" }], expected_surface: ["src/app.ts"], suspicious_surface: [], verification: [{ command: "echo test" }], constraints: [], autofix_commands: [], campaign_id: undefined, parent_run_id: undefined, pass: 1, regression_outcomes: [], promoted: false, baby_model: "openai/gpt-5.6" }, body: "Body text", raw: validContent } },
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
  strictEqual((body.frontmatter as any).baby_model, "openai/gpt-5.6");
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

test("POST /runs/content returns 500 when getRun misses after enqueue", async () => {
  const supervisor = makeFakeSupervisor({
    enqueueContent: (_c: string, _f: string) => "content-run",
    getRun: () => undefined,
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/runs/content", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: "some content", filename: "test-packet.md" }),
  });
  const res = await app.request(req);
  equal(res.status, 500);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "internal_error");
  equal(body.message, "enqueue succeeded but run not found");
});

// ---------------------------------------------------------------------------
// run-to-dto — status mapping
// ---------------------------------------------------------------------------

test("status mapping handles all domain values", async () => {
  const { mapStatus } = await import("../src/run-to-dto.js");

  strictEqual(mapStatus("queued"), "queued");
  strictEqual(mapStatus("running"), "running");
  strictEqual(mapStatus("ready_for_review"), "ready_for_review");
  strictEqual(mapStatus("blocked"), "blocked");
  strictEqual(mapStatus("failed"), "failed");
  strictEqual(mapStatus("accepted"), "accepted");
  strictEqual(mapStatus("stopped"), "stopped");
});

// ---------------------------------------------------------------------------
// Settings & restart sidecar routes
// ---------------------------------------------------------------------------

test("GET /settings redacts configured API keys", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/settings");
  equal(res.status, 200);
  const body = await res.json() as { settings: SettingsDto; restartRequired: boolean };
  ok(typeof body.settings.baby === "object");
  ok(typeof body.settings.daddy === "object");
  ok(typeof body.settings.superdaddy === "object");
  ok(typeof body.settings.thresholds === "object");
  equal(body.settings.baby.apiKey, "");
  equal(body.settings.superdaddy.apiKey, undefined);
  equal(body.restartRequired, false);
});

test("PUT /settings updates the subsequent GET snapshot", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const currentSettings = Config.parse(supervisor.settings);
  const body = { ...currentSettings, baby: { ...currentSettings.baby, modelId: "new-model" } };
  const res = await app.request("http://localhost/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  equal(res.status, 200);
  const parsed = await res.json() as { settings: SettingsDto; restartRequired: boolean };
  equal(parsed.settings.baby.modelId, "new-model");
  equal(parsed.restartRequired, true);

  const get = await app.request("http://localhost/settings");
  equal(get.status, 200);
  const current = await get.json() as { settings: SettingsDto; restartRequired: boolean };
  equal(current.settings.baby.modelId, "new-model");
  equal(current.settings.baby.apiKey, "");
  equal(current.restartRequired, true);
  equal(supervisor.config.baby.apiKey, "api-key");
});

test("PUT /settings accepts disabled timeout settings", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);
  const current = Config.parse(supervisor.settings);
  const res = await app.request("http://localhost/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...current,
      idleTimeoutMs: false,
      superdaddy: { ...current.superdaddy, headerTimeoutMs: false },
    }),
  });

  equal(res.status, 200);
  const parsed = await res.json() as { settings: SettingsDto };
  equal(parsed.settings.idleTimeoutMs, false);
  equal(parsed.settings.superdaddy.headerTimeoutMs, false);
});

test("PUT /settings deletes omitted named models and restores secrets only for retained models", async () => {
  const supervisor = makeFakeSupervisor({
    config: Config.parse({
      ...defaultConfig,
      baby: {
        ...defaultConfig.baby,
        models: {
          retained: { providerId: "omlx", modelId: "retained", baseUrl: "http://retained", contextWindow: 10_000, apiKey: "retained-secret" },
          deleted: { providerId: "omlx", modelId: "deleted", baseUrl: "http://deleted", contextWindow: 20_000, apiKey: "deleted-secret" },
        },
      },
    }),
  });
  const app = createApp(supervisor.appDeps, supervisor);
  const submitted = {
    ...supervisor.settings,
    baby: {
      ...supervisor.settings.baby,
      apiKey: "",
      models: {
        retained: { ...supervisor.settings.baby.models.retained!, apiKey: "" },
      },
    },
  };

  const res = await app.request("http://localhost/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(submitted),
  });

  equal(res.status, 200);
  deepStrictEqual(Object.keys(supervisor.settings.baby.models), ["retained"]);
  equal(supervisor.settings.baby.models.retained?.apiKey, "retained-secret");
});

test("PUT /settings returns 400 for invalid body", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baby: { modelId: 12345 } }),
  });
  equal(res.status, 400);
  const body = await res.json() as { code: string; message: string };
  ok(body.code.length > 0);
  ok(body.message.length > 0);
});

test("POST /restart calls onRestart and returns 200", async () => {
  let restartCalled = false;
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor, {
    onRestart: () => { restartCalled = true; },
  });

  const res = await app.request("http://localhost/restart", { method: "POST" });
  equal(res.status, 200);
  const body = await res.json() as { restarting: boolean };
  equal(body.restarting, true);
  ok(restartCalled, "onRestart callback was invoked");
});

test("POST /restart returns 400 when onRestart not configured", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/restart", { method: "POST" });
  equal(res.status, 400);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "restart_unavailable");
  equal(body.message, "restart not available");
});

// ---------------------------------------------------------------------------
// Run ledger sidecar routes
// ---------------------------------------------------------------------------

test("GET /runs/:runId/decisions returns decisions array for known run", async () => {
  const supervisor = makeFakeSupervisor();
  supervisor.enqueueRun("/tmp/test-run.md");
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/runs/test-run/decisions");
  equal(res.status, 200);
  const body = await res.json() as DecisionDto[];
  ok(Array.isArray(body));
});

test("GET /runs/:runId/decisions returns 404 for unknown run", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/runs/nonexistent/decisions");
  equal(res.status, 404);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "not_found");
  equal(body.message, "run nonexistent not found");
});

test("GET /runs/:runId/outcomes returns ledger for known run", async () => {
  const supervisor = makeFakeSupervisor();
  supervisor.enqueueRun("/tmp/test-run.md");
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/runs/test-run/outcomes");
  equal(res.status, 200);
  const body = await res.json() as OutcomeLedgerDto;
  ok(Array.isArray(body.outcomes));
});

test("GET /runs/:runId/outcomes returns 404 for unknown run", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/runs/nonexistent/outcomes");
  equal(res.status, 404);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "not_found");
  equal(body.message, "run nonexistent not found");
});

test("GET /runs/:runId/report returns report string for known run", async () => {
  const supervisor = makeFakeSupervisor();
  supervisor.enqueueRun("/tmp/test-run.md");
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/runs/test-run/report");
  equal(res.status, 200);
  const body = await res.json() as { report: string };
  ok(typeof body.report === "string");
});

test("GET /runs/:runId/report returns 404 for unknown run", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/runs/nonexistent/report");
  equal(res.status, 404);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "not_found");
  equal(body.message, "run nonexistent not found");
});

test("GET /runs/:runId/convergence returns convergence log for known run", async () => {
  const supervisor = makeFakeSupervisor();
  supervisor.enqueueRun("/tmp/test-run.md");
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/runs/test-run/convergence");
  equal(res.status, 200);
  const body = await res.json() as ConvergenceLogEntryDto[];
  ok(Array.isArray(body));
});

test("GET /runs/:runId/convergence returns 404 for unknown run", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const res = await app.request("http://localhost/runs/nonexistent/convergence");
  equal(res.status, 404);
  const body = await res.json() as { code: string; message: string };
  equal(body.code, "not_found");
  equal(body.message, "run nonexistent not found");
});
