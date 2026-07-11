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
  Clock,
  Repo,
  Store,
  Paths,
  RunMeta,
  JournalEvent,
  RunAbort,
  RunLoopSeams,
  ValidatePacketResult,
  Plan,
} from "@lathe/core";
import {
  SqliteStoreAdapter,
  systemClock,
  buildRepo,
  runDriver,
  admitPacket,
  validatePacket as validatePacketUc,
  acceptRun as acceptRunUc,
  answerRun as answerRunUc,
  promoteStaged,
  parseStaged,
  isLatched,
  gateReason,
  renderJournalEvent,
  isDriverEvent,
  createEvents,
  createContextTokenReader,
  createMessageHistoryReader,
  RunTransitionConflictError,
  parsePacketShape,
  Config,
  createConfigSource,
  type ConfigSource,
  type DriverOutput,
  type VerificationProcessEvent,
  type VerificationPhase,
} from "@lathe/core";
import type { OpencodeEvent, OpencodeMessage } from "@lathe/core";

import type { EventBus, AppDeps, TailEventBus } from "./server-host.js";
import type { Reviewer, ReviewDto, StatusDto, TailEvent, TailSnapshotDto, TailSpeaker } from "@lathe/contract";
import type { LatheEvent } from "@lathe/contract";
import { createEventBus, createTailEventBus } from "./server-host.js";
import { createTailProjectionRetention } from "./tail-projection-retention.js";
import { projectJournalEvent } from "./event-projection.js";
import type { ProjectionContext } from "./event-projection.js";
import { createTailPaneProjection, type TailPaneProjection } from "./tail-pane-projection.js";

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

export class PlanNotFoundError extends Error {
  constructor(planId: string) {
    super(`plan not found: ${planId}`);
    this.name = "PlanNotFoundError";
  }
}

const extractTitle = (raw: string, fallback: string): string => {
  const shape = parsePacketShape(raw);
  if (shape.ok && shape.packet.frontmatter.summary) {
    return shape.packet.frontmatter.summary;
  }
  const headingMatch = raw.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1]!.trim();
  }
  return fallback;
};

const toDto = (plan: Plan): { planId: string; title: string; tags: string[]; queuedRunId: string | null; createdAt: string; updatedAt: string } => ({
  planId: plan.planId,
  title: plan.title,
  tags: plan.tags,
  queuedRunId: plan.queuedRunId ?? null,
  createdAt: plan.createdAt,
  updatedAt: plan.updatedAt,
});

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

export class RunNotAnswerableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunNotAnswerableError";
  }
}

export class RunCancellationConflictError extends Error {
  constructor(runId: string) {
    super(`run ${runId} is running without an active cancellation owner`);
    this.name = "RunCancellationConflictError";
  }
}

export class RunLifecycleConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLifecycleConflictError";
  }
}

// ---------------------------------------------------------------------------
// Supervisor options
// ---------------------------------------------------------------------------

export type SupervisorOptions = {
  /** Journal tail poll cadence in ms. Default: 1000. */
  pollIntervalMs?: number;
  /** Unit tests can exercise supervisor methods without starting the driver. */
  startDriver?: boolean;
  /** Test seam for observing background driver failure handling. */
  runDriver?: typeof runDriver;
};

// ---------------------------------------------------------------------------
// Supervisor interface
// ---------------------------------------------------------------------------

export type Supervisor = {
  /** Graceful shutdown: signal runDriver, abort in-flight runs, await exit. */
  stop(): Promise<void>;
  /** Explicit daemon health; false after an unexpected background driver failure. */
  health?(): { healthy: boolean; detail?: string };
  /** Dependencies for createApp (bus + readEventsSince). */
  appDeps: AppDeps;
  /** Read-only config snapshot (for GetConfig handler and contextWindow). */
  config: Config;
  // -- Lifecycle methods (P03 handlers call these) --
  /** Admit a packet file into the queue; returns the derived runId. */
  enqueueRun(packetPath: string): string;
  /** Admit raw packet content into the queue; returns the derived runId. */
  enqueueContent(content: string, filename: string): string;
  /** Validate raw packet content without writing; returns validation result. */
  validatePacket(content: string, filename?: string): ValidatePacketResult;
  /** Stage a chain directory (promotes heads straight away). */
  enqueueChain(chainDir: string): void;
  /** List all known runs (domain RunMeta). */
  listRuns(): RunMeta[];
  /** Read a single run's metadata. */
  getRun(runId: string): RunMeta | undefined;
  /** Stop a queued (archiveQueue) or running (fire per-run abort) run. */
  stopRun(runId: string): "stopped" | "cancellation_requested";
  /** Answer a parked blocked run and requeue it. */
  answerRun(runId: string, answer: string): void;
  /** Accept a ready_for_review run (chain-tip guarded). */
  acceptRun(runId: string): number;
  /** Reject a run — archive if queued, mark blocked if running. */
  rejectRun(runId: string, reason: string): void;
  /** Requeue a stopped run — flip status to queued, resume from sandbox. */
  requeueRun(runId: string): RunMeta;
  /** Whether runId is the chain tip (no staged child references it as parent). */
  isChainTip(runId: string): boolean;
  /** Latest reviewer verdict summary for a run (from store.readDecisions). */
  lastVerdict(runId: string): string | null;
  /** Staged entries for chain-walking in error messages. */
  listStaged(): Array<{ runId: string; parentRunId: string | undefined }>;
  /** Full snapshot for `lathe status`. */
  getStatus(): StatusDto;
  /** Morning triage snapshot for `lathe review`. */
  getReview(): ReviewDto;
  /** Hydrated daemon-owned snapshot for tail presentation. */
  prepareTailSnapshot(runId: string): Promise<TailSnapshotDto | undefined>;
  /** Hydrated active run/convergence snapshot, or null when nothing is active. */
  prepareActiveTailSnapshot(): Promise<TailSnapshotDto | null>;
  /** Canonical active tail target without hydration. */
  resolveActiveTailRunId(): string | null;
  /** Outcome roll-up for run detail DTOs. */
  outcomes(runId: string): string;
  /** Packet/journal-backed fields for run DTOs. */
  runReadModel(runId: string): RunReadModel;
  /** Validate and write a new config to disk. Returns parsed config. Throws on validation failure. */
  writeConfig(raw: unknown): Config;
  /** Latest validated settings persisted for the next daemon start. */
  readonly settings: Config;
  /** Whether persisted settings differ from the active startup snapshot. */
  readonly restartRequired: boolean;
  /** Full planner Q&A decision history for a run. */
  getDecisions(runId: string): ReturnType<Store["readDecisions"]>;
  /** Full outcome ledger for a run. */
  getLedger(runId: string): ReturnType<Store["readLedger"]>;
  /** Baby's completion report for a run. */
  getReport(runId: string): string;
  /** Convergence log for a run. */
  getConvergence(runId: string): ReturnType<Store["readConvergence"]>;
  // -- Plans shelf --
  listPlans(): ReturnType<Store["listPlans"]>;
  getPlan(planId: string): ReturnType<Store["readPlan"]>;
  createPlan(content: string, filename: string, tags?: string[]): { planId: string; title: string; tags: string[]; queuedRunId: string | null; createdAt: string; updatedAt: string };
  updatePlan(planId: string, content?: string, tags?: string[]): { planId: string; title: string; tags: string[]; queuedRunId: string | null; createdAt: string; updatedAt: string };
  deletePlan(planId: string): void;
  queuePlan(planId: string): string;
};

export type RunReadModel = {
  campaignId: string;
  parentRunId: string | null;
  expectedSurface: string[];
  pass: number;
  turn: number;
  contextTokens: number;
};

type TailStats = Pick<
  TailSnapshotDto,
  | "contextTokens"
  | "turn"
  | "rotations"
  | "outcomesDone"
  | "outcomesTotal"
  | "gateReason"
  | "status"
  | "promoted"
>;

export const _testMergePolledTailStats = (
  contextTokens: number,
  previous: TailStats | undefined,
  canonical: Omit<TailStats, "contextTokens">,
): TailStats => ({
  ...canonical,
  contextTokens,
  turn: previous?.turn ?? canonical.turn,
  rotations: previous?.rotations ?? canonical.rotations,
});

const TAIL_SNAPSHOT_JOURNAL_LIMIT = 500;

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

type TailOpenCodeHandle = {
  stop(): void;
};

const startJournalTail = (
  store: Store,
  bus: EventBus,
  tailBus: TailEventBus,
  getConfig: () => Config,
  pollIntervalMs: number,
  projectTailEvents: (seq: number, runId: string, event: JournalEvent) => TailEvent[],
): JournalTailHandle => {
  let running = true;
  let lastSeq = 0;

  // Seed to current max seq so startup never parses the historical journal.
  lastSeq = store.latestJournalSeq();

  const poll = setInterval(() => {
    if (!running) return;

    const events = store.readJournalSince(lastSeq);
    for (const { seq, runId, event } of events) {
      lastSeq = seq;

      // Derive projection context from run state. For events without a run
      // (seq-based global tail), the store always returns runId, so we can
      // look up the meta.
      const meta = store.readMetaIfExists(runId);
      const ctx = buildProjectionContext(runId, meta, getConfig());
      const wire = projectJournalEvent(event, ctx);
      if (wire) {
        bus.publish(seq, wire);
      }
      for (const tailEvent of projectTailEvents(seq, runId, event)) {
        tailBus.publish(tailEvent);
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

const superReviewLines = (event: JournalEvent): string[] | undefined => {
  if (event.event === "super_review") {
    return [
      `acceptance review: verdict ${event.verdict} (pass ${event.pass})`,
      ...event.findings.map((finding) => `  ${finding}`),
    ];
  }
  if (event.event !== "super_review_status") return undefined;
  if (event.status === "started") {
    return [`acceptance review: reviewing pass ${event.pass}`];
  }
  if (event.status === "cancelled") {
    return [`acceptance review: pass ${event.pass} cancelled`];
  }
  if (event.status === "failed") {
    return [`acceptance review: pass ${event.pass} failed${event.detail ? `: ${event.detail}` : ""}`];
  }
  return undefined;
};

export const resolveSpeaker = (store: Store, runId: string, sessionId: string): "baby" | "daddy" | "super" | undefined => {
  const activeRuns = store.listActiveRuns();
  if (activeRuns.some((r) => r.runId === runId && sessionId === r.babySessionId)) {
    return "baby";
  }
  const meta = store.readMetaIfExists(runId);
  if (meta?.daddySessionId === sessionId) {
    return "daddy";
  }
  if (meta?.reviewerSessionId === sessionId) {
    return "super";
  }
  if (meta?.babySessionId === sessionId) {
    return "baby";
  }
  return undefined;
};

export const _testSelectActiveTailRunId = (
  activeRuns: Array<{ runId: string; startedAt: string }>,
  activeConvergences: Array<{ runId: string; startedAt: string }>,
): string | null => {
  return [...activeRuns, ...activeConvergences]
    .toSorted((a, b) => b.startedAt.localeCompare(a.startedAt) || b.runId.localeCompare(a.runId))[0]?.runId ?? null;
};

export const createOpenCodeTailProjector = (
  speakerFor: (runId: string, sessionId: string) => "baby" | "daddy" | "super" | undefined,
  publish: (event: TailEvent) => void,
): TailPaneProjection => createTailPaneProjection(speakerFor, publish);

type TailHydrator = {
  hydrateRun(runId: string, force?: boolean): Promise<void>;
  clearRun(runId: string): void;
  isHydrating(runId: string): boolean;
};

const createTailHydrator = (
  config: Config,
  store: Store,
  projection: TailPaneProjection,
  publish: (event: TailEvent) => void,
  settled: () => void,
): TailHydrator => {
  const readHistory = createMessageHistoryReader(config);
  const hydrated = new Map<string, string>();
  const inFlight = new Map<string, { promise: Promise<void>; forceRequested: boolean }>();

  const bindingOf = (runId: string, speaker: TailSpeaker): string | undefined => {
    const meta = store.readMetaIfExists(runId);
    if (speaker === "baby") return meta?.babySessionId;
    if (speaker === "daddy") return meta?.daddySessionId;
    return meta?.reviewerSessionId;
  };

  const hydrateSpeaker = async (runId: string, speaker: TailSpeaker, force: boolean): Promise<void> => {
    let sessionId = bindingOf(runId, speaker);
    if (!sessionId || (!force && hydrated.get(`${runId}:${speaker}`) === sessionId)) return;
    for (let attempt = 0; attempt < 2 && sessionId; attempt += 1) {
      let messages: OpencodeMessage[];
      try {
        messages = await readHistory(sessionId, AbortSignal.timeout(10_000));
      } catch {
        const current = bindingOf(runId, speaker);
        if (current && current !== sessionId) {
          sessionId = current;
          continue;
        }
        return;
      }
      const current = bindingOf(runId, speaker);
      if (current !== sessionId) {
        sessionId = current;
        continue;
      }
      projection.mergeHistory(runId, speaker, sessionId, messages);
      hydrated.set(`${runId}:${speaker}`, sessionId);
      return;
    }
  };

  const hydrateRun = (runId: string, force = false): Promise<void> => {
    const existing = inFlight.get(runId);
    if (existing) {
      existing.forceRequested ||= force;
      return existing.promise;
    }
    const state = { promise: Promise.resolve(), forceRequested: force };
    state.promise = (async () => {
      do {
        const forceThisPass = state.forceRequested;
        state.forceRequested = false;
        await Promise.all(
          (["baby", "daddy", "super"] as const).map((speaker) => hydrateSpeaker(runId, speaker, forceThisPass)),
        );
        publish({
          kind: "tail.agent.panes.replaced",
          runId,
          panes: projection.panes(runId),
          acceptanceReviewLines: projection.acceptanceReviewLines(runId),
        });
      } while (state.forceRequested);
    })().finally(() => {
      inFlight.delete(runId);
      settled();
    });
    inFlight.set(runId, state);
    return state.promise;
  };

  const clearRun = (runId: string): void => {
    for (const key of hydrated.keys()) {
      if (key.startsWith(`${runId}:`)) hydrated.delete(key);
    }
  };

  return { hydrateRun, clearRun, isHydrating: (runId) => inFlight.has(runId) };
};

const startTailOpenCode = (
  config: Config,
  paths: Paths,
  store: Store,
  tailBus: TailEventBus,
  pollIntervalMs: number,
  tailProjector: TailPaneProjection,
  hydrator: TailHydrator,
  publishTokenStats: (runId: string, contextTokens: number) => void,
  onRunActive: (runId: string) => void,
  onRunInactive: (runId: string) => void,
): TailOpenCodeHandle => {
  const events = createEvents(config);
  const readContextTokens = createContextTokenReader(config);
  const subscriptions = new Map<string, { close: () => void }[]>();
  let running = true;

  const onOpenCodeEvent = tailProjector.project;

  const ensureRun = (meta: RunMeta): void => {
    onRunActive(meta.runId);
    if (subscriptions.has(meta.runId)) {
      void hydrator.hydrateRun(meta.runId);
      return;
    }
    subscriptions.set(meta.runId, [
      events.subscribe(meta.worktree, (event) => onOpenCodeEvent(meta.runId, event), () => void hydrator.hydrateRun(meta.runId, true)),
      events.subscribe(paths.root, (event) => onOpenCodeEvent(meta.runId, event), () => void hydrator.hydrateRun(meta.runId, true)),
    ]);
    void hydrator.hydrateRun(meta.runId);
  };

  const closeRun = (runId: string): void => {
    const existing = subscriptions.get(runId);
    if (!existing) {
      return;
    }
    for (const sub of existing) {
      sub.close();
    }
    subscriptions.delete(runId);
    onRunInactive(runId);
  };

  const syncSubscriptions = (): void => {
    _testSyncSubscriptions(store, subscriptions, ensureRun, closeRun);
  };

  let tokenPollInFlight = false;

  const pollTokens = async (): Promise<void> => {
    if (tokenPollInFlight) {
      return;
    }
    tokenPollInFlight = true;
    try {
      for (const runId of subscriptions.keys()) {
        const meta = store.readMetaIfExists(runId);
        if (!meta?.babySessionId) {
          continue;
        }
        const tokens = await readContextTokens(meta.babySessionId, AbortSignal.timeout(5_000)).catch(() => undefined);
        if (typeof tokens !== "number") {
          continue;
        }
        publishTokenStats(runId, tokens);
      }
    } finally {
      tokenPollInFlight = false;
    }
  };

  const poll = setInterval(() => {
    if (!running) {
      return;
    }
    syncSubscriptions();
    void pollTokens();
  }, pollIntervalMs);
  syncSubscriptions();

  return {
    stop: () => {
      running = false;
      clearInterval(poll);
      for (const runId of [...subscriptions.keys()]) {
        closeRun(runId);
      }
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

  // Supervisor-owned Store/Repo/Clock.
  const clock: Clock = systemClock;
  const repo: Repo = buildRepo();
  const store: Store = SqliteStoreAdapter.create(paths, repo, clock);

  // Runtime configuration is a startup snapshot. Settings writes are persisted
  // separately because adapters and concurrency are composed once per daemon.
  const configSource: ConfigSource = createConfigSource(config);
  let persistedConfig = config;

  // Derive a single "compatibility" active run from multi-row state:
  // newest startedAt descending, or undefined if no active runs.
  const activeTailRunId = (): string | null =>
    _testSelectActiveTailRunId(store.listActiveRuns(), store.listActiveConvergences());

  // --- Lifecycle seams ---

  // Graceful shutdown: supervisor creates its own AbortController.
  const stopController = new AbortController();

  // Per-run AbortController map keyed by runId. runLoop creates and populates
  // it; supervisor reads and fires it for the stopRun path.
  const abortMap = new Map<string, RunAbort>();
  let driverReady = options.startDriver === false;

  // Seams wired to runDriver.
  const seams: RunLoopSeams = {
    stopSignal: stopController.signal,
    abortMap,
    onReady: () => {
      driverReady = true;
    },
  };

  // --- Event buses ---

  const bus = createEventBus();
  const tailBus = createTailEventBus();
  const tailProjection = createTailPaneProjection(
    (runId, sessionId) => resolveSpeaker(store, runId, sessionId),
    (event) => tailBus.publish(event),
  );
  let enforceTailRetention = (): void => {};
  let tailHydrator = createTailHydrator(config, store, tailProjection, (event) => tailBus.publish(event), () => enforceTailRetention());
  const driverOutput: DriverOutput = {
    verification: (
      runId: string,
      phase: VerificationPhase,
      event: VerificationProcessEvent,
    ): void => {
      const wire: Extract<TailEvent, { kind: "tail.driver.command" | "tail.driver.delta" }> = event.kind === "output"
        ? {
            kind: "tail.driver.delta",
            runId,
            phase,
            commandId: event.commandId,
            stream: event.stream,
            text: event.chunk,
            at: clock.nowIso(),
          }
        : event.kind === "started"
          ? {
              kind: "tail.driver.command",
              runId,
              phase,
              commandId: event.commandId,
              command: event.command,
              status: "running",
              at: clock.nowIso(),
            }
          : {
            kind: "tail.driver.command",
            runId,
            phase,
            commandId: event.commandId,
            command: event.command,
            status: event.exitCode === 0 ? "completed" : "error",
              exitCode: event.exitCode,
              timedOut: event.timedOut,
              at: clock.nowIso(),
          };
      tailProjection.projectDriver(wire);
    },
  };

  // --- Start runDriver ---

  // runDriver is a background promise; the supervisor holds its handle.
  let driverFailure: unknown;
  const activeDriver = options.runDriver ?? runDriver;
  const driverPromise = options.startDriver === false
    ? Promise.resolve()
    : activeDriver(configSource, paths, store, seams, driverOutput).then(
        () => {
          if (!stopController.signal.aborted) {
            driverFailure = new Error("run driver exited unexpectedly");
            console.error("lathe run driver stopped unexpectedly", driverFailure);
          }
        },
        (error: unknown) => {
          if (!stopController.signal.aborted) {
            driverFailure = error;
            console.error("lathe run driver stopped unexpectedly", error);
          }
        },
      );

  // --- Lifecycle method implementations ---

  const isTerminalStatus = (status: RunMeta["status"]): boolean =>
    status === "ready_for_review" ||
    status === "accepted" ||
    status === "blocked" ||
    status === "failed" ||
    status === "stopped";

  const isChainTip = (runId: string): boolean => {
    // A run is a chain tip if no staged entry references it as a parent.
    const staged = store.listStaged();
    return !staged.some((s) => s.parentRunId === runId);
  };

  const outcomes = (runId: string): string => {
    try {
      const ledger = store.readLedger(runId);
      return renderOutcomeSummary(ledger);
    } catch {
      return "";
    }
  };

  const renderOutcomeSummary = (ledger: ReturnType<Store["readLedger"]>): string => {
    const counts = { done: 0, in_progress: 0, not_started: 0, blocked: 0 };
    for (const outcome of ledger.outcomes) {
      counts[outcome.status] += 1;
    }
    const extra = `${counts.in_progress ? `, ${counts.in_progress} in progress` : ""}${counts.blocked ? `, ${counts.blocked} blocked` : ""}`;
    return `${counts.done}/${ledger.outcomes.length} done${extra}`;
  };

  const gateLatchReason = (runId: string): string | null => {
    try {
      const gate = store.readGateState(runId);
      return isLatched(gate) ? gateReason(gate) ?? "unknown" : null;
    } catch {
      return null;
    }
  };

  const outcomeCounts = (runId: string): { done: number; total: number } => {
    try {
      const ledger = store.readLedger(runId);
      return {
        done: ledger.outcomes.filter((outcome) => outcome.status === "done").length,
        total: ledger.outcomes.length,
      };
    } catch {
      return { done: 0, total: 0 };
    }
  };

  const tailStatsByRun = new Map<string, TailStats>();
  const tailRetention = createTailProjectionRetention(
    8,
    (runId) => tailHydrator.isHydrating(runId),
    (runId) => {
      tailProjection.clearRun(runId);
      tailHydrator.clearRun(runId);
      tailStatsByRun.delete(runId);
    },
  );
  enforceTailRetention = tailRetention.enforce;

  const cacheTailStats = (snapshot: TailSnapshotDto): TailStats => {
    const stats: TailStats = {
      contextTokens: snapshot.contextTokens,
      turn: snapshot.turn,
      rotations: snapshot.rotations,
      outcomesDone: snapshot.outcomesDone,
      outcomesTotal: snapshot.outcomesTotal,
      gateReason: snapshot.gateReason,
      status: snapshot.status,
      promoted: snapshot.promoted,
    };
    tailStatsByRun.set(snapshot.runId, stats);
    return stats;
  };

  const publishPolledTailStats = (runId: string, contextTokens: number): void => {
    const meta = store.readMetaIfExists(runId);
    if (!meta) return;
    const journalStats = store.readJournalStats(runId);
    const counts = outcomeCounts(runId);
    const previous = tailStatsByRun.get(runId);
    const stats = _testMergePolledTailStats(contextTokens, previous, {
      turn: journalStats.turn,
      rotations: journalStats.rotations,
      outcomesDone: counts.done,
      outcomesTotal: counts.total,
      gateReason: gateLatchReason(runId),
      status: meta.status,
      promoted: meta.promoted,
    });
    tailStatsByRun.set(runId, stats);
    tailBus.publish({ kind: "tail.stats", runId, at: clock.nowIso(), ...stats });
  };

  const updateTailStats = (runId: string, event: JournalEvent): TailStats | undefined => {
    const meta = store.readMetaIfExists(runId);
    if (!meta) {
      return undefined;
    }

    const previous = tailStatsByRun.get(runId);
    const counts = outcomeCounts(runId);
    const next: TailStats = {
      contextTokens: previous?.contextTokens ?? 0,
      turn: previous?.turn ?? 0,
      rotations: previous?.rotations ?? 0,
      outcomesDone: counts.done,
      outcomesTotal: counts.total,
      gateReason: gateLatchReason(runId),
      status: meta.status,
      promoted: meta.promoted,
    };

    if (typeof event.turn === "number") {
      next.turn = event.turn;
    }
    if (event.event === "turn_ended") {
      next.contextTokens = event.contextTokens;
    }
    if (event.event === "rotation" && event.phase === "session_replaced") {
      next.rotations += 1;
      next.contextTokens = event.contextTokens ?? 0;
    }

    tailStatsByRun.set(runId, next);
    return next;
  };

  const buildTailSnapshot = (runId: string): TailSnapshotDto | undefined => {
    const meta = store.readMetaIfExists(runId);
    if (!meta) {
      return undefined;
    }
    tailRetention.touch(runId);
    const journalRows = store.readRecentJournalWithSeq(runId, TAIL_SNAPSHOT_JOURNAL_LIMIT);
    const latestReview = store.readJournal(runId).findLast(
      (event) => event.event === "super_review_status" || event.event === "super_review",
    );
    const latestReviewLines = latestReview ? superReviewLines(latestReview) : undefined;
    if (latestReviewLines) {
      tailProjection.mergeVerdict(runId, latestReviewLines);
    }
    const journalStats = store.readJournalStats(runId);
    const counts = outcomeCounts(runId);

    const liveConfig = configSource.get();
    const snapshot: TailSnapshotDto = {
      runId,
      summary: meta.summary ?? null,
      status: meta.status,
      startedAt: meta.startedAt ?? null,
      models: {
        baby: liveConfig.baby.modelId,
        promoted: liveConfig.baby.promoteTo?.modelId ?? liveConfig.daddy.modelId,
        daddy: liveConfig.daddy.modelId,
        super: liveConfig.superdaddy.modelId,
      },
      promoted: meta.promoted,
      budget: Math.floor(liveConfig.baby.contextWindow * liveConfig.thresholds.rotationFraction),
      worktree: meta.worktree,
      outcomesDone: counts.done,
      outcomesTotal: counts.total,
      gateReason: gateLatchReason(runId),
      contextTokens: journalStats.contextTokens,
      turn: journalStats.turn,
      rotations: journalStats.rotations,
      panes: tailProjection.panes(runId),
      acceptanceReviewLines: tailProjection.acceptanceReviewLines(runId),
      driverCommands: tailProjection.driverCommands(runId),
      journal: journalRows.map(({ seq, event }) => ({
        seq,
        at: event.at,
        line: renderJournalEvent(event),
        event: event.event,
        driver: isDriverEvent(event),
      })),
      lastSeq: journalRows.at(-1)?.seq ?? 0,
    };
    cacheTailStats(snapshot);
    return snapshot;
  };

  const prepareRunTailSnapshot = async (runId: string) => {
    if (!store.readMetaIfExists(runId)) {
      return { snapshot: null, revision: tailBus.revision() };
    }
    await tailHydrator.hydrateRun(runId);
    const snapshot = buildTailSnapshot(runId) ?? null;
    return { snapshot, revision: tailBus.revision() };
  };

  const prepareActiveTailState = async () => {
    let runId = activeTailRunId();
    while (runId) {
      await tailHydrator.hydrateRun(runId);
      const current = activeTailRunId();
      if (current === runId) {
        const snapshot = buildTailSnapshot(runId) ?? null;
        return { snapshot, revision: tailBus.revision() };
      }
      runId = current;
    }
    return { snapshot: null, revision: tailBus.revision() };
  };

  const runReadModel = (runId: string): RunReadModel => {
    const raw = store.readQueuePacket(runId);
    const parsed = raw ? parsePacketShape(raw, runId) : undefined;
    const frontmatter = parsed?.ok ? parsed.packet.frontmatter : undefined;
    const journalStats = store.readJournalStats(runId);

    return {
      campaignId: frontmatter?.campaign_id ?? runId,
      parentRunId: frontmatter?.parent_run_id ?? null,
      expectedSurface: frontmatter?.expected_surface ?? [],
      pass: frontmatter?.pass ?? store.readMetaIfExists(runId)?.attempt ?? 0,
      turn: journalStats.turn,
      contextTokens: journalStats.contextTokens,
    };
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

  const projectTailEvents = (seq: number, runId: string, event: JournalEvent): TailEvent[] => {
    const stats = updateTailStats(runId, event);
    if (!stats) {
      return [];
    }
    const journalEvent: TailEvent = {
      kind: "tail.journal",
      runId,
      seq,
      at: event.at,
      line: renderJournalEvent(event),
      event: event.event,
      driver: isDriverEvent(event),
    };
    const statsEvent: TailEvent = {
      kind: "tail.stats",
      runId,
      seq,
      at: event.at,
      contextTokens: stats.contextTokens,
      turn: stats.turn,
      rotations: stats.rotations,
      outcomesDone: stats.outcomesDone,
      outcomesTotal: stats.outcomesTotal,
      gateReason: stats.gateReason,
      status: stats.status,
      promoted: stats.promoted,
    };
    const lines = superReviewLines(event);
    if (!lines) {
      return [journalEvent, statsEvent];
    }
    tailProjection.mergeVerdict(runId, lines);
    if (event.event === "super_review_status") {
      return [
        journalEvent,
        statsEvent,
        {
          kind: "tail.super.status",
          runId,
          seq,
          at: event.at,
          status: event.status,
          pass: event.pass,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          lines,
        },
      ];
    }
    if (event.event !== "super_review") {
      return [journalEvent, statsEvent];
    }
    return [
      journalEvent,
      statsEvent,
      {
        kind: "tail.super.verdict",
        runId,
        seq,
        at: event.at,
        verdict: event.verdict,
        pass: event.pass,
        findings: event.findings,
        lines,
      },
    ];
  };

  const replayTailEventsSince = (seq: number, runId: string): TailEvent[] => {
    const rows = store.readJournalSinceForRun(runId, seq);
    if (rows.length === 0) {
      return [];
    }

    const events = rows.flatMap(({ seq, event }): TailEvent[] => {
      const journalEvent: TailEvent = {
        kind: "tail.journal",
        runId,
        seq,
        at: event.at,
        line: renderJournalEvent(event),
        event: event.event,
        driver: isDriverEvent(event),
      };
      const lines = superReviewLines(event);
      if (!lines) {
        return [journalEvent];
      }
      if (event.event === "super_review_status") {
        return [
          journalEvent,
          {
            kind: "tail.super.status",
            runId,
            seq,
            at: event.at,
            status: event.status,
            pass: event.pass,
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
            lines,
          },
        ];
      }
      if (event.event !== "super_review") {
        return [journalEvent];
      }
      return [
        journalEvent,
        {
          kind: "tail.super.verdict",
          runId,
          seq,
          at: event.at,
          verdict: event.verdict,
          pass: event.pass,
          findings: event.findings,
          lines,
        } satisfies TailEvent,
      ];
    });

    const snapshot = buildTailSnapshot(runId);
    if (!snapshot) {
      return events;
    }

    return [
      ...events,
      {
        kind: "tail.stats",
        runId,
        seq: snapshot.lastSeq,
        at: rows.at(-1)!.event.at,
        contextTokens: snapshot.contextTokens,
        turn: snapshot.turn,
        rotations: snapshot.rotations,
        outcomesDone: snapshot.outcomesDone,
        outcomesTotal: snapshot.outcomesTotal,
        gateReason: snapshot.gateReason,
        status: snapshot.status,
        promoted: snapshot.promoted,
      },
    ];
  };

  // --- Journal tail ---

  const journalTail = startJournalTail(store, bus, tailBus, () => configSource.get(), pollIntervalMs, projectTailEvents);
  let tailOpenCode = startTailOpenCode(
    config,
    paths,
    store,
    tailBus,
    pollIntervalMs,
    tailProjection,
    tailHydrator,
    publishPolledTailStats,
    (runId) => tailRetention.pin(runId),
    (runId) => tailRetention.unpin(runId),
  );
  return {
    health(): { healthy: boolean; detail?: string } {
      if (stopController.signal.aborted && driverFailure === undefined) {
        return { healthy: true };
      }
      return driverFailure === undefined && driverReady
        ? { healthy: true }
        : {
            healthy: false,
            detail:
              driverFailure === undefined
                ? "run driver is starting"
                : driverFailure instanceof Error
                  ? driverFailure.message
                  : String(driverFailure),
          };
    },

    get config(): Config {
      return configSource.get();
    },

    get settings(): Config {
      return persistedConfig;
    },

    get restartRequired(): boolean {
      return JSON.stringify(persistedConfig) !== JSON.stringify(configSource.get());
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

    outcomes(runId: string): string {
      return outcomes(runId);
    },

    runReadModel(runId: string): RunReadModel {
      return runReadModel(runId);
    },

    getStatus(): StatusDto {
      const activeRuns = store.listActiveRuns().sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1)).map((run) => ({
        runId: run.runId,
        outcomes: outcomes(run.runId),
        gateLatched: gateLatchReason(run.runId),
        recentEvents: store.readRecentJournal(run.runId, 5).map((event) => ({
          at: event.at,
          event: event.event,
        })),
      }));

      const allMeta = store.listMeta();

      const parked = allMeta
        .filter((meta) => meta.status === "blocked")
        .map((meta) => ({
          runId: meta.runId,
          blockedReason: meta.blockedReason ?? null,
          blockedQuestion: meta.blockedQuestion ?? null,
          stallRetries: meta.stallRetries,
        }));

      const campaigns = store.listCampaigns().map((campaign) => {
        const last = campaign.passes[campaign.passes.length - 1];
        return {
          campaignId: campaign.campaignId,
          status: campaign.status,
          pass: last?.pass ?? 0,
          maxPasses: campaign.maxPasses,
          originalIntent: campaign.originalIntent,
        };
      });

      const review = allMeta.reduce(
        (summary, meta) => {
          if (meta.status === "ready_for_review") {
            summary.readyForReview += 1;
          }
          if (meta.status === "failed") {
            summary.failed += 1;
          }
          return summary;
        },
        { readyForReview: 0, failed: 0 },
      );

      return {
        activeRuns,
        queued: store.listQueue().map((entry) => ({ runId: entry.runId })),
        parked,
        campaigns,
        staged: store.listStaged().map((entry) => ({
          runId: entry.runId,
          parentRunId: entry.parentRunId ?? null,
        })),
        review,
        stopped: allMeta
          .filter((meta) => meta.status === "stopped")
          .map((meta) => ({ runId: meta.runId, status: meta.status })),
      };
    },

    getReview(): ReviewDto {
      const outcomesByRun = new Map(store.listLedgers().map((ledger) => [ledger.runId, renderOutcomeSummary(ledger)]));
      const runs = store
        .listMeta()
        .filter((meta) => meta.status !== "running" && meta.status !== "queued")
        .map((meta) => ({
          runId: meta.runId,
          status: meta.status,
          outcomes: outcomesByRun.get(meta.runId) ?? "",
          branch: meta.branch,
          repo: meta.repo,
          base: meta.base,
          blockedQuestion: meta.blockedQuestion ?? null,
        }));
      return { runs };
    },

    async prepareTailSnapshot(runId: string): Promise<TailSnapshotDto | undefined> {
      return (await prepareRunTailSnapshot(runId)).snapshot ?? undefined;
    },

    async prepareActiveTailSnapshot(): Promise<TailSnapshotDto | null> {
      return (await prepareActiveTailState()).snapshot;
    },

    resolveActiveTailRunId(): string | null {
      return activeTailRunId();
    },

    listStaged(): Array<{ runId: string; parentRunId: string | undefined }> {
      return store.listStaged().map(s => ({ runId: s.runId, parentRunId: s.parentRunId }));
    },

    async stop(): Promise<void> {
      // Signal graceful shutdown.
      stopController.abort();

      // Abort any in-flight per-run controllers (a run still executing when
      // stopSignal fires).
      for (const [, abort] of abortMap) {
        abort.cause = "daemon_shutdown";
        abort.controller.abort();
      }
      abortMap.clear();

      // Stop the journal tail.
      journalTail.stop();
      tailOpenCode.stop();

      // Await the driver to exit (with a timeout to avoid hanging forever).
      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          driverPromise,
          new Promise<void>((_, reject) => {
            shutdownTimer = setTimeout(
              () => reject(new Error("runDriver shutdown timeout")),
              10_000,
            );
          }),
        ]);
      } finally {
        if (shutdownTimer) clearTimeout(shutdownTimer);
      }
    },

    get appDeps(): AppDeps {
      return {
        bus,
        tailBus,
        readEventsSince: (seq: number): { seq: number; event: LatheEvent }[] => {
          const events = store.readJournalSince(seq);
          return events
            .flatMap(({ seq, runId, event }) => {
              const meta = store.readMetaIfExists(runId);
              const ctx = buildProjectionContext(runId, meta, configSource.get());
              const wire = projectJournalEvent(event, ctx);
              return wire ? { seq, event: wire } : null;
            })
            .filter((e): e is { seq: number; event: LatheEvent } => e !== null);
        },
        readTailEventsSince: (seq: number, runId: string): TailEvent[] =>
          replayTailEventsSince(seq, runId),
        prepareTailSnapshot: (runId: string | null) =>
          runId === null ? prepareActiveTailState() : prepareRunTailSnapshot(runId),
        resolveActiveTailRunId: () => activeTailRunId(),
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

      // Check if admission succeeded (meta written with status = 'queued').
      const meta = store.readMetaIfExists(runId);
      if (!meta || meta.status !== "queued") {
        throw new Error(`packet "${runId}" rejected during admission`);
      }
      return runId;
    },

    enqueueContent(content: string, filename: string): string {
      const runId = basename(filename).replace(/\.md$/, "");
      admitPacket(store, runId, content);

      // Check if admission succeeded (meta written with status = 'queued').
      const meta = store.readMetaIfExists(runId);
      if (!meta || meta.status !== "queued") {
        throw new Error(`packet "${runId}" rejected during admission`);
      }
      return runId;
    },

    validatePacket(content: string, filename?: string): ValidatePacketResult {
      return validatePacketUc(content, repo, filename);
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

    stopRun(runId: string): "stopped" | "cancellation_requested" {
      const meta = store.readMetaIfExists(runId);
      if (!meta) {
        throw new RunNotFoundError(runId);
      }
      if (meta.status === "queued") {
        store.archiveQueue(runId);
        return "stopped";
      }

      const activeAbort = abortMap.get(runId);
      if (activeAbort && meta.status === "ready_for_review") {
        activeAbort.cause = "operator_cancel";
        activeAbort.controller.abort();
        return "cancellation_requested";
      }

      if (isTerminalStatus(meta.status)) {
        throw new TerminalRunError(runId, meta.status);
      }

      if (activeAbort) {
        activeAbort.cause = "operator_cancel";
        activeAbort.controller.abort();
        return "cancellation_requested";
      }

      // A running row without an owner is inconsistent and cannot be cancelled safely.
      if (meta.status === "running") {
        throw new RunCancellationConflictError(runId);
      }

      // Unexpected state.
      throw new Error(
        `run ${runId} is in state "${meta.status}" — cannot abort`,
      );
    },

    answerRun(runId: string, answer: string): void {
      const meta = store.readMetaIfExists(runId);
      let result;
      try {
        result = answerRunUc(store, repo, runId, answer, meta?.worktree ?? "", clock);
      } catch (error) {
        if (error instanceof RunTransitionConflictError) {
          throw new RunLifecycleConflictError(error.message);
        }
        throw error;
      }
      if (result.ok) {
        return;
      }
      if (!meta) {
        throw new RunNotFoundError(runId);
      }
      throw new RunNotAnswerableError(result.reason);
    },

    acceptRun(runId: string): number {
      // Missing run → 404, not a generic accept refusal.
      if (!store.readMetaIfExists(runId)) {
        throw new RunNotFoundError(runId);
      }
      // Chain-tip guard: refuse a non-chain-tip run (mid-chain accept deletes
      // the branch the next link forks off).
      if (!isChainTip(runId)) {
        throw new NonChainTipError(runId, findChainTip(runId));
      }
      return acceptRunUc(runId, {
        store,
        repo,
        clock,
        runsDir: paths.runsDir,
      });
    },

    rejectRun(runId: string, reason: string): void {
      const meta = store.readMetaIfExists(runId);
      if (!meta) {
        throw new RunNotFoundError(runId);
      }

      if (meta.status !== "ready_for_review") {
        throw new TerminalRunError(runId, meta.status);
      }

      // Review rejection is a resumable request for changes, not cancellation
      // and not a fabricated Human Operator decision.
      try {
        store.transitionRun({
          runId,
          expectedRevision: meta.revision ?? 0,
          expectedStatuses: ["ready_for_review"],
          meta: {
            ...meta,
            status: "blocked",
            blockedReason: "stop_condition",
            blockedQuestion: reason,
            updatedAt: clock.nowIso(),
          },
        });
      } catch (error) {
        if (error instanceof RunTransitionConflictError) {
          throw new RunLifecycleConflictError(error.message);
        }
        throw error;
      }
    },

    requeueRun(runId: string): RunMeta {
      const meta = store.readMetaIfExists(runId);
      if (!meta) {
        throw new RunNotFoundError(runId);
      }
      const requeueable =
        meta.status === "stopped" ||
        (meta.status === "blocked" && meta.blockedReason === "crashed");
      if (!requeueable) {
        throw new RunNotAnswerableError(`run ${runId} cannot be retried from ${meta.status}`);
      }
      const { blockedReason: _reason, blockedQuestion: _question, ...rest } = meta;
      try {
        return store.transitionRun({
          runId,
          expectedRevision: meta.revision ?? 0,
          expectedStatuses: [meta.status],
          meta: { ...rest, status: "queued", updatedAt: clock.nowIso() },
        });
      } catch (error) {
        if (error instanceof RunTransitionConflictError) {
          throw new RunLifecycleConflictError(error.message);
        }
        throw error;
      }
    },

    writeConfig(raw: unknown): Config {
      const parsed = Config.parse(raw);
      writeFileSync(paths.configFile, JSON.stringify(parsed, null, 2) + "\n", "utf-8");
      persistedConfig = parsed;
      return parsed;
    },

    getDecisions(runId: string): ReturnType<Store["readDecisions"]> {
      return store.readDecisions(runId);
    },

    getLedger(runId: string): ReturnType<Store["readLedger"]> {
      return store.readLedger(runId);
    },

    getReport(runId: string): string {
      return store.readReport(runId);
    },

    getConvergence(runId: string): ReturnType<Store["readConvergence"]> {
      return store.readConvergence(runId);
    },

    // -- Plans shelf --

    listPlans(): Plan[] {
      return store.listPlans();
    },

    getPlan(planId: string): Plan | undefined {
      return store.readPlan(planId);
    },

    createPlan(content: string, filename: string, tags?: string[]) {
      const planId = basename(filename).replace(/\.md$/, "");
      const existing = store.readPlan(planId);
      const title = extractTitle(content, planId);
      const now = clock.nowIso();
      const plan: Plan = {
        planId,
        title,
        raw: content,
        tags: tags ?? [],
        ...(existing?.queuedRunId ? { queuedRunId: existing.queuedRunId } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      store.writePlan(plan);
      return toDto(plan);
    },

    updatePlan(planId: string, content?: string, tags?: string[]) {
      const existing = store.readPlan(planId);
      if (!existing) {
        throw new PlanNotFoundError(planId);
      }
      const updated: Plan = {
        ...existing,
        ...(content !== undefined ? { raw: content, title: extractTitle(content, planId) } : {}),
        ...(tags !== undefined ? { tags } : {}),
        updatedAt: clock.nowIso(),
      };
      store.writePlan(updated);
      return toDto(updated);
    },

    deletePlan(planId: string): void {
      const existing = store.readPlan(planId);
      if (!existing) {
        throw new PlanNotFoundError(planId);
      }
      store.deletePlan(planId);
    },

    queuePlan(planId: string): string {
      const plan = store.readPlan(planId);
      if (!plan) {
        throw new PlanNotFoundError(planId);
      }
      admitPacket(store, planId, plan.raw);
      const meta = store.readMetaIfExists(planId);
      if (!meta || meta.status !== "queued") {
        throw new Error(`plan "${planId}" rejected during admission`);
      }
      store.writePlan({ ...plan, queuedRunId: planId });
      return planId;
    },
  };
};

// ---------------------------------------------------------------------------
// Test-only exports — no production code should import these.
// ---------------------------------------------------------------------------

export const _testSyncSubscriptions = (
  store: Store,
  subscriptions: Map<string, { close: () => void }[]>,
  ensureRun: (meta: RunMeta) => void,
  closeRun: (runId: string) => void,
): void => {
  const activeIds = new Set<string>();
  for (const activeRun of store.listActiveRuns()) {
    const meta = store.readMetaIfExists(activeRun.runId);
    if (meta) {
      activeIds.add(activeRun.runId);
      ensureRun(meta);
    }
  }
  for (const ac of store.listActiveConvergences()) {
    const meta = store.readMetaIfExists(ac.runId);
    if (meta) {
      activeIds.add(ac.runId);
      ensureRun(meta);
    }
  }
  for (const runId of [...subscriptions.keys()]) {
    if (!activeIds.has(runId)) {
      closeRun(runId);
    }
  }
};
