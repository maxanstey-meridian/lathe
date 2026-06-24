// ---------------------------------------------------------------------------
// Composition root (ARCHITECTURE §1, §3.4)
//
// The ONE place adapters are constructed and injected into the use cases. Every
// other module depends on ports; this file knows the concretes. It owns the
// driver lifecycle (`meridian run`) and the two manual reviewer commands
// (converge / super-review), both of which bring the opencode serve substrate up
// behind the single-driver lock and tear it down on exit.
// ---------------------------------------------------------------------------

import { spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import type { Server } from "node:http";
import type { BridgePort } from "../../application/ports/bridge.js";
import type { ModelConfig } from "../../application/ports/executor.js";
import type { Repo } from "../../application/ports/repo.js";
import { convergeRun } from "../../application/use-cases/converge-run.js";
import { makeExecuteRun, type BridgeBinding } from "../../application/use-cases/execute-run.js";
import { runLoop, type WaitForWorkCallback } from "../../application/use-cases/run-loop.js";
import type { RunPorts } from "../../application/use-cases/run-runtime.js";
import { babyContextBudget } from "../../config/config.js";
import { expandHome, type Paths } from "../../config/paths.js";
import type { Config } from "../../config/schemas.js";
import { campaignIdForRun } from "../../domain/campaign.js";
import { parsePacketShape } from "../../domain/packet.js";
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
  fetchBranchFromClone,
  removeSandbox,
  headBranch,
  branchExists,
  isCloneSandbox,
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
import { createEvents } from "../../infrastructure/opencode/events.js";
import { createOpencodeClient } from "../../infrastructure/opencode/executor.js";
import { createPlanner } from "../../infrastructure/opencode/planner.js";
import { createReviewer } from "../../infrastructure/opencode/reviewer.js";
import { StoreAdapter } from "../../infrastructure/store.js";
import { createVerify } from "../../infrastructure/verify.js";
import { runTailUi } from "../tui/tail-ui.js";

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
  fetchBranchFromClone,
  removeSandbox,
  headBranch,
  branchExists,
  isCloneSandbox,
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
// mutation, so the opencode spawn lives behind it, exactly as the reference
// ordered the lifecycle.

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
// `meridian run`: the always-on driver. Constructs every adapter, wires the run
// loop, and hands it the bridge lock (which doubles as the serve-substrate
// lifecycle) plus the executeRun / convergeStep / waitForWork callbacks.

export const runDriver = async (config: Config, paths: Paths): Promise<void> => {
  mkdirSync(paths.queueDir, { recursive: true });
  mkdirSync(paths.runsDir, { recursive: true });

  const clock = systemClock;
  const repo = buildRepo();
  const store = StoreAdapter.create(paths, repo, clock);
  const executor = createOpencodeClient(config);
  // Daddy roots in a fixed directory (paths.root): he consults on intent — approach
  // and evidence arrive inline, no worktree access needed. Super-daddy is different:
  // it MUST execute verification and inspect the tree (renderSuperReview promises
  // "your cwd is the run's worktree"), so its session is scoped per-call to the run's
  // worktree — passed via SuperReviewInput, NOT fixed here.
  const planner = createPlanner(
    executor,
    modelOf(config.daddy),
    config.daddy.timeoutMs,
    paths.root,
  );
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
  const ref: RunRef = { current: undefined };
  let serve: Serve | undefined;
  const bridge: BridgePort<RunRef> = {
    bind: async () => {
      serve = await startServe(config, paths, ref);
      return ref;
    },
    clearActive: (r) => {
      r.current = undefined;
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
      r.current = channel;
      return channel;
    },
    endRun: (r) => {
      r.current = undefined;
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
  );
};

// Block until the queue might have work or the loop is stopping. fs.watch on the
// queue and runs dirs wakes us promptly; the interval is the robust fallback
// (watch can miss events and a requeue is a nested meta.json write a
// non-recursive dir watch won't see). The driver re-lists the queue on return.
const waitForWork =
  (paths: Paths): WaitForWorkCallback =>
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
        queueWatcher.close();
        runsWatcher?.close();
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => finish();
      const poll = setInterval(finish, 1500);
      const queueWatcher = watch(paths.queueDir, finish);
      const runsWatcher = existsSync(paths.runsDir) ? watch(paths.runsDir, finish) : undefined;
      signal.addEventListener("abort", onAbort, { once: true });
    });

// ---------------------------------------------------------------------------
// Manual reviewer commands. Both refuse to run while a `meridian run` driver
// holds the lock (converge mutates run state; super-review would share the live
// server), then bring up their own serve substrate for the one call.

const withServe = async <T>(
  config: Config,
  paths: Paths,
  fn: (store: StoreReturn) => Promise<T>,
): Promise<T | 1> => {
  const ref: RunRef = { current: undefined };
  let serve: Serve;
  try {
    serve = await startServe(config, paths, ref);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      message.includes("in use") ? "a `meridian run` driver is live — stop it first" : message,
    );
    return 1;
  }
  try {
    const clock = systemClock;
    const repo = buildRepo();
    const store = StoreAdapter.create(paths, repo, clock);
    return await fn({ store, repo, clock });
  } finally {
    stopServe(serve);
  }
};

type StoreReturn = {
  store: ReturnType<typeof StoreAdapter.create>;
  repo: Repo;
  clock: typeof systemClock;
};

// `meridian converge <runId>`: review a finished run and ACT (converge / author
// a follow-up / escalate) — the same use case the always-on driver runs.
export const convergeOnce = async (config: Config, paths: Paths, runId: string): Promise<number> =>
  withServe(config, paths, async ({ store, repo, clock }) => {
    const executor = createOpencodeClient(config);
    const reviewer = createReviewer(
      executor,
      modelOf(config.superdaddy),
      config.superdaddy.timeoutMs,
      config.superdaddy.transportRetries,
    );
    const verify = createVerify();
    await convergeRun({ store, repo, reviewer, verify, clock, config, paths })(runId);
    console.log(
      `converged pass run for ${runId} — see 'meridian status' / 'meridian tail ${runId}'`,
    );
    return 0;
  });

// `meridian super-review <runId>`: dry-run the convergence reviewer and print the
// verdict. No packet authored, no state changed (D4-adjacent: read-only).
export const superReviewOnce = async (
  config: Config,
  paths: Paths,
  runId: string,
): Promise<number> =>
  withServe(config, paths, async ({ store, repo }) => {
    const meta = store.readMetaIfExists(runId);
    if (!meta) {
      console.error(`run ${runId} not found`);
      return 1;
    }
    let raw: string;
    try {
      raw = store.readFrozenPacket(runId);
    } catch {
      console.error(`run ${runId} has no frozen packet to review`);
      return 1;
    }
    const shape = parsePacketShape(raw, runId);
    if (!shape.ok) {
      console.error(`cannot parse packet: ${shape.problems.join("; ")}`);
      return 1;
    }
    const executor = createOpencodeClient(config);
    const reviewer = createReviewer(
      executor,
      modelOf(config.superdaddy),
      config.superdaddy.timeoutMs,
      config.superdaddy.transportRetries,
    );
    const diff = repo.reviewableDiffAgainst(
      meta.worktree,
      meta.base,
      config.superdaddy.diffCapBytes,
    );
    const reportText = existsSync(paths.reportFile(runId))
      ? readFileSync(paths.reportFile(runId), "utf-8")
      : "";
    const skillText = readFileSync(expandHome(config.superdaddy.skillPath), "utf-8");

    const campaignId = campaignIdForRun(shape.packet, runId);
    const outcome = await reviewer.superReview({
      packet: shape.packet,
      worktree: meta.worktree,
      diff,
      reportText,
      skillText,
      pass: shape.packet.frontmatter.pass,
      maxPasses: config.thresholds.maxPasses,
      campaignId,
    });

    if (outcome.kind === "unreachable") {
      console.error(`super-daddy unreachable: ${outcome.detail}`);
      console.error("(transport drop, not a verdict — retry when the connection is back)");
      return 1;
    }

    console.log(`super-daddy verdict: ${outcome.review.verdict}`);
    for (const f of outcome.review.findings) {
      console.log(`  - [${f.severity}] ${f.title}`);
    }
    if (outcome.review.notes) {
      console.log(`notes: ${outcome.review.notes}`);
    }
    return 0;
  });

// `meridian tail` on a TTY: the Ink split-pane UI (CONTRACT X3). Read-only —
// constructs a Store + the SSE Events subscription and hands them to the
// renderer, which polls the run's files and the live feed. Subscribing to the
// serve instance's SSE is best-effort: if no driver is up, the connection errors
// silently and the UI degrades to journal-only polling. Returns -1 (Ink owns the
// terminal until 'q').
export const openTail = (config: Config, paths: Paths, runId: string): number => {
  const clock = systemClock;
  const repo = buildRepo();
  const store = StoreAdapter.create(paths, repo, clock);
  const events = createEvents(config);
  runTailUi({
    store,
    budget: babyContextBudget(config),
    subscribe: events.subscribe,
    runId,
    daddyDirectory: paths.root,
  });
  return -1;
};

// `meridian plan`: open an interactive opencode session; the global /packet skill
// authors the handoff into the queue dir (K4 — no hand-rolled chat).
export const openPlanner = (paths: Paths): number => {
  console.log(
    "Opening OpenCode. Plan with your model of choice, then invoke /packet to author the handoff into:",
  );
  console.log(`  ${paths.queueDir}/YYYYMMDD-HHMMSS-<slug>.md`);
  console.log("Then admit it with: meridian queue add <that file>\n");
  const result = spawnSync("opencode", [], { stdio: "inherit", cwd: process.cwd() });
  return result.status ?? 0;
};
