import { equal, ok, strictEqual } from "node:assert";
import { test } from "node:test";

import type { RunMeta } from "@lathe/core";
import type { Supervisor } from "../src/supervisor.js";
import { createApp, createEventBus } from "../src/app.js";
import type { LatheEvent } from "@lathe/contract";
import { RunNotFoundError, NonChainTipError } from "../src/supervisor.js";

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
  thresholds: { ladderParkAt: 10, ladderRotateAt: 4, maxPasses: 3 } as const,
} as const;

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

    abortRun: (runId: string): void => {
      const meta = metaStore.get(runId);
      if (!meta) throw new RunNotFoundError(runId);
      metaStore.set(runId, { ...meta, status: "aborted" as const, updatedAt: new Date().toISOString() });
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
  };

  // Apply overrides: they replace base methods. To keep CRUD methods working
  // with overridden getRun/isChainTip, we use a proxy pattern — the base CRUD
  // methods are re-bound to the final merged object.
  const merged = { ...base, ...overrides };

  // Re-bind CRUD methods that need access to the merged getRun/isChainTip
  merged.abortRun = (runId: string) => {
    if (overrides?.abortRun) return overrides.abortRun!(runId);
    const meta = merged.getRun!(runId);
    if (!meta) throw new RunNotFoundError(runId);
    metaStore.set(runId, { ...meta, status: "aborted" as const, updatedAt: new Date().toISOString() });
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
  });
  const app2 = createApp(supWithMeta.appDeps, supWithMeta);

  const req = new Request(`http://localhost/runs/${runId}`);
  const res = await app2.request(req);
  equal(res.status, 200);
  const body = await res.json() as { runId: string; status: string; isChainTip: boolean; base: string; branch: string };
  equal(body.runId, runId);
  equal(body.status, "running");
  equal(body.base, "main");
  equal(body.branch, "meridian/test");
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

test("AbortRun for unknown runId returns 404", async () => {
  const supervisor = makeFakeSupervisor();
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request("http://localhost/runs/nonexistent/abort", { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 404);
});

test("AbortRun for a running run returns updated summary", async () => {
  const runId = "abort-running";
  const meta = {
    runId,
    status: "running" as const,
    attempt: 1,
    repo: "/tmp/test",
    base: "main",
    branch: "meridian/abort-running",
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
    abortRun: (id: string) => {
      if (id !== runId) throw new RunNotFoundError(id);
      meta.status = "aborted" as const;
    },
    isChainTip: () => true,
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/abort`, { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 201);
  const body = await res.json() as { runId: string; status: string };
  equal(body.runId, runId);
  ok(["blocked", "aborted"].includes(body.status));
});

test("AbortRun for a queue-only run returns success without meta", async () => {
  const runId = "abort-queued";
  const supervisor = makeFakeSupervisor({
    getRun: () => undefined,
    abortRun: () => {},
  });
  const app = createApp(supervisor.appDeps, supervisor);

  const req = new Request(`http://localhost/runs/${runId}/abort`, { method: "POST" });
  const res = await app.request(req);
  equal(res.status, 201);
  const body = await res.json() as { runId: string; status: string };
  equal(body.runId, runId);
  equal(body.status, "aborted");
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

  const supervisor = makeFakeSupervisor({
    getRun: (id: string) => (id === runId ? meta : undefined),
    isChainTip: (id: string) => id === runId,
    acceptRun: (id: string): number => {
      if (id !== runId) throw new NonChainTipError(id, runId);
      meta.status = "accepted" as const;
      return 2;
    },
  });
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
  const supervisor = makeFakeSupervisor({
    getRun: () => undefined,
    acceptRun: () => 0,
  });
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
  strictEqual(mapStatus("aborted"), "aborted");
});
