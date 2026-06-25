/**
 * Supervisor — in-process host for the run engine, journal tail, and lifecycle
 * methods that the HTTP surface (P03) calls.
 *
 * The supervisor OWNS the runDriver lifecycle: it starts runDriver with
 * abort/stop seams, holds its handle, and tears it down cleanly on stop().
 * It also runs boot recovery, tails the global journal, and exposes thin
 * delegations to existing use-cases for the daemon's HTTP handlers.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import type {
  Config,
  Clock,
  Repo,
  Store,
  Paths,
  RunMeta,
  JournalEvent,
  RunLoopSeams,
} from "@lathe/core";
import {
  StoreAdapter,
  systemClock,
  buildRepo,
  runDriver,
  recoverOrphanedRuns,
  recoverStalledRunsAtStartup,
  admitPacket,
  acceptRun as acceptRunUc,
  promoteStaged,
  parseStaged,
} from "@lathe/core";

import type { EventBus, AppDeps, LatheEvent } from "./app.js";
import type { Reviewer } from "@lathe/contract";
import { createEventBus } from "./app.js";
import { projectJournalEvent } from "./event-projection.js";
import type { ProjectionContext } from "./event-projection.js";

// ---------------------------------------------------------------------------
// Domain errors — P03 handlers map these to typed HTTP responses
// ---------------------------------------------------------------------------

export class NonChainTipError extends Error {
  readonly chainTip: string;
  constructor(runId: string, chainTip: string) {
    super(`run ${runId} is not a chain tip — it has staged children`);
    this.name = "NonChainTipError";
    this.chainTip = chainTip;
  }
}

export class TerminalRunError extends Error {
  constructor(runId: string, status: string) {
    super(`run ${runId} is already terminal (${status})`);
    this.name = "TerminalRunError";
  }
}

export class RunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run ${runId} not found`);
    this.name = "RunNotFoundError";
  }
}

// ---------------------------------------------------------------------------
// Supervisor options
// ---------------------------------------------------------------------------

export type SupervisorOptions = {
  /** Journal tail poll cadence in ms. Default: 1000. */
  pollIntervalMs?: number;
};

// ---------------------------------------------------------------------------
// Supervisor interface
// ---------------------------------------------------------------------------

export type Supervisor = {
  /** Graceful shutdown: signal runDriver, abort in-flight runs, await exit. */
  stop(): Promise<void>;
  /** Dependencies for createApp (bus + readEventsSince). */
  appDeps: AppDeps;
  /** Read-only config — used by GetConfig handler and run-to-dto contextWindow. */
  config: Config;
  // -- Lifecycle methods (P03 handlers call these) --
  /** Admit a packet file into the queue; returns the derived runId. */
   enqueueRun(packetPath: string): string;
  /** Stage a chain directory (promotes heads straight away). */
  enqueueChain(chainDir: string): void;
  /** List all known runs (domain RunMeta). */
  listRuns(): RunMeta[];
  /** Read a single run's metadata. */
  getRun(runId: string): RunMeta | undefined;
  /** Abort a queued (archiveQueue) or running (fire per-run abort) run. */
  abortRun(runId: string): void;
  /** Accept a ready_for_review run (chain-tip guarded). */
  acceptRun(runId: string): number;
  /** Reject a run — archive if queued, mark blocked if running. */
  rejectRun(runId: string, reason: string): void;
  /** Whether runId is the chain tip (no staged child references it as parent). */
  isChainTip(runId: string): boolean;
  /** Latest reviewer verdict summary for a run (from store.readDecisions). */
  lastVerdict(runId: string): string | null;
  /** Staged entries for chain-walking in error messages. */
  listStaged(): Array<{ runId: string; parentRunId: string | undefined }>;
};

// ---------------------------------------------------------------------------
// Projection context builder — derives from supervisor-held state
// ---------------------------------------------------------------------------

const buildProjectionContext = (
  runId: string,
  meta: RunMeta | undefined,
  config: Config,
): ProjectionContext => {
  // Pass = attempt count; contextWindow from config; reviewer defaults to
  // "daddy" when no converged pass is available.
  const reviewer: Reviewer =
    meta?.status === "accepted" ? "superdaddy" : "daddy";
  return {
    runId,
    pass: meta?.attempt ?? 1,
    contextWindow: config.baby.contextWindow,
    reviewer,
  };
};

// ---------------------------------------------------------------------------
// Journal tail — polls readJournalSince, projects, publishes to bus
// ---------------------------------------------------------------------------

type JournalTailHandle = {
  /** Stop the polling loop. */
  stop(): void;
};

const startJournalTail = (
  store: Store,
  bus: EventBus,
  config: Config,
  pollIntervalMs: number,
): JournalTailHandle => {
  let running = true;
  let lastSeq = 0;

  // Seed lastSeq to current max seq so we only tail live events.
  const initialEvents = store.readJournalSince(0);
  if (initialEvents.length > 0) {
    lastSeq = initialEvents.at(-1)!.seq;
  }

  const poll = setInterval(() => {
    if (!running) return;

    const events = store.readJournalSince(lastSeq);
    for (const { seq, runId, event } of events) {
      lastSeq = seq;

      // Derive projection context from run state. For events without a run
      // (seq-based global tail), the store always returns runId, so we can
      // look up the meta.
      const meta = store.readMetaIfExists(runId);
      const ctx = buildProjectionContext(runId, meta, config);
      const wire = projectJournalEvent(event, ctx);
      if (wire) {
        bus.publish(seq, wire);
      }
    }
  }, pollIntervalMs);

  return {
    stop: () => {
      running = false;
      clearInterval(poll);
    },
  };
};

// ---------------------------------------------------------------------------
// Supervisor build
// ---------------------------------------------------------------------------

export const createSupervisor = (
  config: Config,
  paths: Paths,
  options: SupervisorOptions = {},
): Supervisor => {
  const pollIntervalMs = options.pollIntervalMs ?? 1000;

  // Supervisor-owned Store/Repo/Clock (same pattern as convergeOnce/withServe).
  const clock: Clock = systemClock;
  const repo: Repo = buildRepo();
  const store: Store = StoreAdapter.create(paths, repo, clock);

  // --- Lifecycle seams ---

  // Graceful shutdown: supervisor creates its own AbortController.
  const stopController = new AbortController();

  // Per-run AbortController map keyed by runId. runLoop creates and populates
  // it; supervisor reads and fires it for the abortRun path.
  const abortMap = new Map<string, AbortController>();

  // Seams wired to runDriver.
  const seams: RunLoopSeams = {
    stopSignal: stopController.signal,
    abortMap,
  };

  // --- Boot recovery ---

  // Run existing recovery use-cases before the loop accepts new work.
  recoverOrphanedRuns(store, repo, clock);
  recoverStalledRunsAtStartup(store, config.thresholds.maxStallRetries, clock);

  // --- EventBus + journal tail ---

  const bus = createEventBus();
  const journalTail = startJournalTail(store, bus, config, pollIntervalMs);

  // --- Start runDriver ---

  // runDriver is a background promise; the supervisor holds its handle.
  const driverPromise = runDriver(config, paths, seams);

  // --- Lifecycle method implementations ---

  const isTerminalStatus = (status: RunMeta["status"]): boolean =>
    status === "ready_for_review" ||
    status === "accepted" ||
    status === "blocked" ||
    status === "failed" ||
    status === "aborted";

  const isChainTip = (runId: string): boolean => {
    // A run is a chain tip if no staged entry references it as a parent.
    const staged = store.listStaged();
    return !staged.some((s) => s.parentRunId === runId);
  };

  // Private helper: find the tip of the chain containing runId.
  // Walks every chain tip and traces its ancestry to see if it contains runId.
  const findChainTip = (runId: string): string => {
    const staged = store.listStaged();
    const runs = store.listRunIds().map((id) => store.readMeta(id));
    const tips = runs.filter(r => isChainTip(r.runId));

    for (const tip of tips) {
      let current: string | undefined = tip.runId;
      while (current) {
        if (current === runId) return tip.runId;
        const entry = staged.find(s => s.runId === current);
        current = entry?.parentRunId;
      }
    }

    return tips.at(0)?.runId ?? runs.at(-1)?.runId ?? "unknown";
  };

  return {
    get config(): Config {
      return config;
    },

    isChainTip(runId: string): boolean {
      return isChainTip(runId);
    },

    lastVerdict(runId: string): string | null {
      const decisions = store.readDecisions(runId);
      const verdict = decisions
        .slice()
        .reverse()
        .find(
          (d) =>
            d.status === "accepted" ||
            d.status === "blocked" ||
            d.status === "stop",
        );
      if (!verdict) return null;
      return verdict.answer ?? null;
    },

    listStaged(): Array<{ runId: string; parentRunId: string | undefined }> {
      return store.listStaged().map(s => ({ runId: s.runId, parentRunId: s.parentRunId }));
    },

    async stop(): Promise<void> {
      // Signal graceful shutdown.
      stopController.abort();

      // Abort any in-flight per-run controllers (a run still executing when
      // stopSignal fires).
      for (const [, ac] of abortMap) {
        ac.abort();
      }
      abortMap.clear();

      // Stop the journal tail.
      journalTail.stop();

      // Await the driver to exit (with a timeout to avoid hanging forever).
      await Promise.race([
        driverPromise,
        new Promise<void>((_, reject) => {
          setTimeout(
            () => reject(new Error("runDriver shutdown timeout")),
            10_000,
          );
        }),
      ]);
    },

    get appDeps(): AppDeps {
      return {
        bus,
        readEventsSince: (seq: number): { seq: number; event: LatheEvent }[] => {
          const events = store.readJournalSince(seq);
          return events
            .flatMap(({ seq, runId, event }) => {
              const meta = store.readMetaIfExists(runId);
              const ctx = buildProjectionContext(runId, meta, config);
              const wire = projectJournalEvent(event, ctx);
              return wire ? { seq, event: wire } : null;
            })
            .filter((e): e is { seq: number; event: LatheEvent } => e !== null);
        },
      };
    },

    enqueueRun(packetPath: string): string {
      const resolved = resolve(packetPath);
      if (!existsSync(resolved)) {
        throw new Error(`no such file: ${resolved}`);
      }
      const raw = readFileSync(resolved, "utf-8");
      const runId = basename(resolved).replace(/\.md$/, "");
      admitPacket(store, runId, raw);

      // Check if admission succeeded (packet landed in queue dir).
      if (!existsSync(join(paths.queueDir, `${runId}.md`))) {
        throw new Error(`packet rejected — see ${paths.rejectedDir}`);
      }
      return runId;
    },

    enqueueChain(chainDir: string): void {
      const dir = resolve(chainDir);
      if (!existsSync(dir) || !readdirSync(dir).length) {
        throw new Error(`not a directory: ${dir}`);
      }

      for (const file of readdirSync(dir).sort()) {
        if (!file.endsWith(".md")) continue;
        const raw = readFileSync(join(dir, file), "utf-8");
        const parsed = parseStaged(raw, file);
        if (!parsed.ok) {
          throw new Error(
            `rejected ${file}: ${parsed.problems.join("; ")}`,
          );
        }
        store.writeStaged(parsed.info.runId, raw);
      }

      // Heads with no parent (and children whose parent already converged)
      // promote straight away.
      promoteStaged(store, repo);
    },

    listRuns(): RunMeta[] {
      return store.listRunIds().map((id) => store.readMeta(id));
    },

    getRun(runId: string): RunMeta | undefined {
      return store.readMetaIfExists(runId);
    },

    abortRun(runId: string): void {
      // Fresh queued runs have no meta.json yet — check the queue first.
      if (store.listQueue().some((q) => q.runId === runId)) {
        store.archiveQueue(runId);
        return;
      }

      const meta = store.readMetaIfExists(runId);
      if (!meta) {
        throw new RunNotFoundError(runId);
      }

      // An already-terminal run -> throw (P03 maps to 404/409).
      if (isTerminalStatus(meta.status)) {
        throw new TerminalRunError(runId, meta.status);
      }

      // The active running run -> fire the per-run abort seam.
      if (meta.status === "running") {
        const ac = abortMap.get(runId);
        if (ac) {
          ac.abort();
        }
        return;
      }

      // Unexpected state.
      throw new Error(
        `run ${runId} is in state "${meta.status}" — cannot abort`,
      );
    },

    acceptRun(runId: string): number {
      // Chain-tip guard: refuse a non-chain-tip run (mid-chain accept deletes
      // the branch the next link forks off).
      if (!isChainTip(runId)) {
        throw new NonChainTipError(runId, findChainTip(runId));
      }
      return acceptRunUc(runId, undefined, {
        store,
        repo,
        clock,
        runsDir: paths.runsDir,
      });
    },

    rejectRun(runId: string, reason: string): void {
      // Fresh queued runs have no meta — check the queue first (same pattern
      // as abortRun; a purely-queued run has no meta.json yet to flip).
      if (store.listQueue().some((q) => q.runId === runId)) {
        store.archiveQueue(runId);
        return;
      }

      const meta = store.readMetaIfExists(runId);
      if (!meta) {
        throw new RunNotFoundError(runId);
      }

      if (meta.status === "queued") {
        // Queued runs: archive the queue entry (no meta.json yet to flip).
        store.archiveQueue(runId);
        return;
      }

      // Running/terminal runs: mark as blocked with reason.
      store.writeMeta({
        ...meta,
        status: "blocked" as const,
        blockedReason: "human_decision" as const,
        blockedQuestion: reason,
        updatedAt: clock.nowIso(),
      });
    },
  };
};
