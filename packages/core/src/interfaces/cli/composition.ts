// ---------------------------------------------------------------------------
// Composition root (ARCHITECTURE §1, §3.4)
//
// The ONE place adapters are constructed and injected into the use cases. Every
// other module depends on ports; this file knows the concretes. It owns the
// driver lifecycle (`runDriver`), which brings the opencode serve substrate up
// behind the single-driver lock and tears it down on exit.
// ---------------------------------------------------------------------------

import { type ChildProcess } from "node:child_process";
import type { Server } from "node:http";
import type { BridgePort } from "../../application/ports/bridge.js";
import type { ModelConfig } from "../../application/ports/executor.js";
import type { Repo } from "../../application/ports/repo.js";
import type { Store } from "../../application/ports/store.js";
import { convergeRun } from "../../application/use-cases/converge-run.js";
import { makeExecuteRun, type BridgeBinding } from "../../application/use-cases/execute-run.js";
import {
  runLoop,
  type WaitForWorkCallback,
  type RunLoopSeams,
} from "../../application/use-cases/run-loop.js";
import type { RunPorts } from "../../application/use-cases/run-runtime.js";
import type { Paths } from "../../config/paths.js";
import type { Config } from "../../config/schemas.js";
import {
  startBridgeServer,
  listenBridge,
  type RunRef,
  type ActiveRunRef,
} from "../../infrastructure/bridge.js";
import { createCaffeinate } from "../../infrastructure/caffeinate.js";
import { systemClock } from "../../infrastructure/clock.js";
import {
  createSandbox,
  wipCommit,
  amendCommit,
  worktreeIsDirty,
  diffStat,
  readDiffStats,
  reviewableDiff,
  reviewableDiffAgainst,
  reconciliationGitState,
  fetchBranchFromClone,
  removeSandbox,
  headBranch,
  branchExists,
  mergeAccept,
  repoValid,
} from "../../infrastructure/git.js";
import {
  writeOpencodeConfig,
  spawnOpencodeServer,
  warnOnVersionDrift,
  waitForServer,
  pluginPath,
} from "../../infrastructure/opencode/config.js";
import { createOpencodeClient } from "../../infrastructure/opencode/executor.js";
import { createPlanner } from "../../infrastructure/opencode/planner.js";
import { createReviewer } from "../../infrastructure/opencode/reviewer.js";
import { createVerify } from "../../infrastructure/verify.js";

// ---------------------------------------------------------------------------
// Adapter assembly

// git.ts exports free functions; the Repo port is assembled from them here (the
// names map 1:1, no behaviour added — the composition root simply binds them).
export const buildRepo = (): Repo => ({
  createSandbox,
  wipCommit,
  amendCommit,
  worktreeIsDirty,
  diffStat,
  readDiffStats,
  reviewableDiff,
  reviewableDiffAgainst,
  reconciliationGitState,
  fetchBranchFromClone,
  removeSandbox,
  headBranch,
  branchExists,
  mergeAccept,
  repoValid,
});

const modelOf = (m: { providerId: string; modelId: string; agent: string }): ModelConfig => ({
  providerId: m.providerId,
  modelId: m.modelId,
  agent: m.agent,
});

// ---------------------------------------------------------------------------
// Serve substrate: the single-driver lock + the opencode server, brought up and
// torn down together. listenBridge IS the lock (binds :bridgePort, throws
// EADDRINUSE if another driver is live) — R1 demands it resolve before any state
// mutation, so the opencode spawn lives behind it.

type Serve = { httpServer: Server; opencode: ChildProcess };

const startServe = async (config: Config, paths: Paths, ref: RunRef): Promise<Serve> => {
  const httpServer = startBridgeServer(config, ref);
  await listenBridge(httpServer, config); // the lock — throws if a driver holds the port
  try {
    writeOpencodeConfig(config, paths, pluginPath());
    warnOnVersionDrift(config);
    const opencode = spawnOpencodeServer(config, paths);
    await waitForServer(config);
    return { httpServer, opencode };
  } catch (err) {
    httpServer.close();
    throw err;
  }
};

const stopServe = (serve: Serve): void => {
  serve.httpServer.close();
  serve.opencode.kill();
};

// ---------------------------------------------------------------------------
// `lathe serve`: the always-on driver. Constructs every adapter, wires the run
// loop, and hands it the bridge lock (which doubles as the serve-substrate
// lifecycle) plus the executeRun / convergeStep / waitForWork callbacks.
// ---------------------------------------------------------------------------

export const runDriver = async (
  config: Config,
  paths: Paths,
  store: Store,
  seams?: RunLoopSeams,
): Promise<void> => {
  const clock = systemClock;
  const repo = buildRepo();
  const executor = createOpencodeClient(config);
  // Daddy's session roots in the run's worktree (passed to handshake per-run, not
  // fixed here) so the planner can read the actual code when a question can't be
  // answered from inline evidence. It's read-only by agent config (no
  // write/edit/patch/bash). Super-daddy is likewise scoped to the worktree per-call
  // via SuperReviewInput.
  const planner = createPlanner(executor, modelOf(config.daddy), config.daddy.timeoutMs);
  const reviewer = createReviewer(
    executor,
    modelOf(config.superdaddy),
    config.superdaddy.timeoutMs,
    config.superdaddy.transportRetries,
  );
  const verify = createVerify();
  const caffeinate = createCaffeinate();

  const ports: RunPorts = { config, store, repo, executor, planner, clock };

  // The bridge port (the lock) holds the serve substrate. bind() acquires the
  // lock and brings opencode up; close() tears both down. The driver loop calls
  // bind() first (R1) and close() in its finally.
  const ref: RunRef = { byRunId: new Map() };
  let serve: Serve | undefined;
  const bridge: BridgePort<RunRef> = {
    bind: async () => {
      serve = await startServe(config, paths, ref);
      return ref;
    },
    clearActive: (r, runId) => {
      r.byRunId.delete(runId);
    },
    close: () => {
      if (serve) {
        stopServe(serve);
      }
    },
  };

  // beginRun fills the bound ref with the per-run intent channel; the concrete
  // ActiveRunRef is a structural superset of the application's RunChannel, passed
  // in with no cast (the seam that keeps application off the infrastructure type).
  const binding: BridgeBinding<RunRef> = {
    beginRun: (r, packet, worktree) => {
      const channel: ActiveRunRef = {
        intents: [],
        pendingConsult: null,
        pendingFinalReview: null,
        reportRejectionCount: 0,
        checkpointBounceCount: 0,
        turnComplete: false,
        awaitingVerification: false,
        config,
        paths,
        worktree,
        packet,
        store,
        turn: 0,
        executor,
        verifyModel: modelOf(config.daddy),
      };
      r.byRunId.set(packet.runId, channel);
      return channel;
    },
    endRun: (r, runId) => {
      r.byRunId.delete(runId);
    },
  };

  const executeRun = makeExecuteRun(ports, binding);
  const convergeStep = convergeRun({ store, repo, reviewer, verify, clock, config, paths });

  await runLoop(
    config,
    store,
    repo,
    caffeinate,
    clock,
    bridge,
    executeRun,
    convergeStep,
    waitForWork(paths),
    seams,
  );
};

// Block until the queue might have work or the loop is stopping. The queue is
// now SQLite-backed, so fs.watch can't detect new admissions. Poll on an
// interval — the driver re-lists the queue on return.
const waitForWork =
  (_paths: Paths): WaitForWorkCallback =>
  (signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) {
        return resolve();
      }
      let done = false;
      const finish = (): void => {
        if (done) {
          return;
        }
        done = true;
        clearInterval(poll);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => finish();
      const poll = setInterval(finish, 1500);
      signal.addEventListener("abort", onAbort, { once: true });
    });
