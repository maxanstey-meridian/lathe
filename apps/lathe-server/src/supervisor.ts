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
  ValidatePacketResult,
} from "@lathe/core";
import {
  SqliteStoreAdapter,
  systemClock,
  buildRepo,
  runDriver,
  recoverOrphanedRuns,
  recoverStalledRunsAtStartup,
  admitPacket,
  validatePacket as validatePacketUc,
  acceptRun as acceptRunUc,
  answerRun as answerRunUc,
  promoteStaged,
  parseStaged,
  isLatched,
  gateReason,
  renderJournalEvent,
  createEvents,
  createContextTokenReader,
  parsePacketShape,
} from "@lathe/core";
import type { OpencodeEvent } from "@lathe/core";

import type { EventBus, AppDeps, LatheEvent, TailEventBus } from "./app.js";
import type { Reviewer, ReviewDto, StatusDto, TailEvent, TailSnapshotDto } from "@lathe/contract";
import { createEventBus, createTailEventBus } from "./app.js";
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

export class RunNotAnswerableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunNotAnswerableError";
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
  stopRun(runId: string): void;
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
  /** Full daemon-owned snapshot for tail presentation. */
  getTailSnapshot(runId: string): TailSnapshotDto | undefined;
  /** Active run/convergence tail snapshot, or null when nothing is active. */
  getActiveTailSnapshot(): TailSnapshotDto | null;
  /** Outcome roll-up for run detail DTOs. */
  outcomes(runId: string): string;
  /** Packet/journal-backed fields for run DTOs. */
  runReadModel(runId: string): RunReadModel;
};

export type RunReadModel = {
  campaignId: string;
  parentRunId: string | null;
  expectedSurface: string[];
  pass: number;
  turn: number;
  contextTokens: number;
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

type TailOpenCodeHandle = {
  stop(): void;
};

const startJournalTail = (
  store: Store,
  bus: EventBus,
  tailBus: TailEventBus,
  config: Config,
  pollIntervalMs: number,
  projectTailEvents: (seq: number, runId: string, event: JournalEvent) => TailEvent[],
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

const isTailDriverEvent = (event: JournalEvent): boolean =>
  event.event !== "tool_call" && event.event !== "turn_ended" && event.event !== "prompt_sent";

const tailToolDetail = (state: Record<string, unknown>): string => {
  const inputObj = (state.input ?? {}) as Record<string, unknown>;
  if (typeof inputObj.command === "string") {
    return inputObj.command.slice(0, 90);
  }
  if (typeof inputObj.filePath === "string") {
    return inputObj.filePath.split("/worktree/").pop() ?? inputObj.filePath;
  }
  if (typeof inputObj.question === "string") {
    return `"${inputObj.question.slice(0, 80)}…"`;
  }
  return typeof inputObj.status === "string" ? inputObj.status : "";
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

const startTailOpenCode = (
  config: Config,
  paths: Paths,
  store: Store,
  tailBus: TailEventBus,
  pollIntervalMs: number,
): TailOpenCodeHandle => {
  const events = createEvents(config);
  const readContextTokens = createContextTokenReader(config);
  const subscriptions = new Map<string, { close: () => void }[]>();
  const partTypes = new Map<string, string>();
  const toolSeen = new Set<string>();
  let running = true;

  const speakerFor = (runId: string, sessionId: string): "baby" | "daddy" | "super" | undefined =>
    resolveSpeaker(store, runId, sessionId);

  const onOpenCodeEvent = (runId: string, event: OpencodeEvent): void => {
    const props = event.properties;
    if (!props) {
      return;
    }
    if (event.type === "message.part.updated") {
      const part = (props.part ?? {}) as Record<string, unknown>;
      const partId = typeof part.id === "string" ? part.id : undefined;
      const type = typeof part.type === "string" ? part.type : "";
      const sessionId = typeof part.sessionID === "string" ? part.sessionID : undefined;
      if (partId) {
        partTypes.set(`${runId}:${partId}`, type);
      }
      if (type !== "tool" || !partId || !sessionId) {
        return;
      }
      const state = (part.state ?? {}) as Record<string, unknown>;
      const status = typeof state.status === "string" ? state.status : "";
      const seenKey = `${runId}:${partId}`;
      if ((status !== "completed" && status !== "error") || toolSeen.has(seenKey)) {
        return;
      }
      const speaker = speakerFor(runId, sessionId);
      if (!speaker) {
        return;
      }
      toolSeen.add(seenKey);
      const inputObj = (state.input ?? {}) as Record<string, unknown>;
      const hasStructuredInput = Object.keys(inputObj).length > 0;
      tailBus.publish({
        kind: "tail.pane.tool",
        runId,
        speaker,
        status,
        tool: typeof part.tool === "string" ? part.tool : "tool",
        detail: tailToolDetail(state),
        ...(hasStructuredInput ? { input: JSON.stringify(inputObj, null, 2) } : {}),
      });
      return;
    }
    if (event.type === "message.part.delta") {
      if (props.field !== "text") {
        return;
      }
      const sessionId = typeof props.sessionID === "string" ? props.sessionID : undefined;
      const partId = typeof props.partID === "string" ? props.partID : undefined;
      const text = typeof props.delta === "string" ? props.delta : "";
      if (!sessionId || !partId || !text) {
        return;
      }
      const speaker = speakerFor(runId, sessionId);
      if (!speaker) {
        return;
      }
      tailBus.publish({
        kind: "tail.pane.delta",
        runId,
        speaker,
        style: partTypes.get(`${runId}:${partId}`) === "reasoning" ? "think" : "text",
        text,
      });
    }
  };

  const ensureRun = (meta: RunMeta): void => {
    if (subscriptions.has(meta.runId)) {
      return;
    }
    subscriptions.set(meta.runId, [
      events.subscribe(meta.worktree, (event) => onOpenCodeEvent(meta.runId, event)),
      events.subscribe(paths.root, (event) => onOpenCodeEvent(meta.runId, event)),
    ]);
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
  };

  const syncSubscriptions = (): void => {
    _testSyncSubscriptions(store, subscriptions, ensureRun, closeRun);
  };

  const pollTokens = async (): Promise<void> => {
    for (const runId of subscriptions.keys()) {
      const meta = store.readMetaIfExists(runId);
      if (!meta?.babySessionId) {
        continue;
      }
      const tokens = await readContextTokens(meta.babySessionId).catch(() => undefined);
      if (typeof tokens !== "number") {
        continue;
      }
      const counts = (() => {
        try {
          const ledger = store.readLedger(runId);
          return { done: ledger.outcomes.filter((outcome) => outcome.status === "done").length, total: ledger.outcomes.length };
        } catch {
          return { done: 0, total: 0 };
        }
      })();
      tailBus.publish({
        kind: "tail.stats",
        runId,
        at: new Date().toISOString(),
        contextTokens: tokens,
        turn: 0,
        rotations: 0,
        outcomesDone: counts.done,
        outcomesTotal: counts.total,
        gateReason: null,
        status: meta.status,
        promoted: meta.promoted,
      });
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

  // Derive a single "compatibility" active run from multi-row state:
  // newest startedAt descending, or undefined if no active runs.
  const firstActiveRun = () => {
    const runs = store.listActiveRuns().sort((a, b) => (b.startedAt > a.startedAt ? 1 : -1));
    return runs[0];
  };

  // --- Lifecycle seams ---

  // Graceful shutdown: supervisor creates its own AbortController.
  const stopController = new AbortController();

  // Per-run AbortController map keyed by runId. runLoop creates and populates
  // it; supervisor reads and fires it for the stopRun path.
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

  // --- Event buses ---

  const bus = createEventBus();
  const tailBus = createTailEventBus();

  // --- Start runDriver ---

  // runDriver is a background promise; the supervisor holds its handle.
  const driverPromise = options.startDriver === false ? Promise.resolve() : runDriver(config, paths, store, seams);

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
      const counts = { done: 0, in_progress: 0, not_started: 0, blocked: 0 };
      for (const outcome of ledger.outcomes) {
        counts[outcome.status] += 1;
      }
      const extra = `${counts.in_progress ? `, ${counts.in_progress} in progress` : ""}${counts.blocked ? `, ${counts.blocked} blocked` : ""}`;
      return `${counts.done}/${ledger.outcomes.length} done${extra}`;
    } catch {
      return "";
    }
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

  const getTailSnapshot = (runId: string): TailSnapshotDto | undefined => {
    const meta = store.readMetaIfExists(runId);
    if (!meta) {
      return undefined;
    }

    const journalRows = store.readJournalSince(0).filter((row) => row.runId === runId);
    const counts = outcomeCounts(runId);
    let contextTokens = 0;
    let turn = 0;
    let rotations = 0;

    for (const { event } of journalRows) {
      if (typeof event.turn === "number") {
        turn = event.turn;
      }
      if (event.event === "turn_ended") {
        contextTokens = event.contextTokens;
      }
      if (event.event === "rotation" && event.phase === "session_replaced") {
        rotations += 1;
        contextTokens = event.contextTokens ?? 0;
      }
    }

    return {
      runId,
      summary: meta.summary ?? null,
      status: meta.status,
      startedAt: meta.startedAt ?? null,
      models: {
        baby: config.baby.modelId,
        promoted: config.baby.promoteTo?.modelId ?? config.daddy.modelId,
        daddy: config.daddy.modelId,
        super: config.superdaddy.modelId,
      },
      promoted: meta.promoted,
      budget: Math.floor(config.baby.contextWindow * config.thresholds.rotationFraction),
      worktree: meta.worktree,
      outcomesDone: counts.done,
      outcomesTotal: counts.total,
      gateReason: gateLatchReason(runId),
      contextTokens,
      turn,
      rotations,
      journal: journalRows.map(({ seq, event }) => ({
        seq,
        at: event.at,
        line: renderJournalEvent(event),
        event: event.event,
        driver: isTailDriverEvent(event),
      })),
      lastSeq: journalRows.at(-1)?.seq ?? 0,
    };
  };

  const runReadModel = (runId: string): RunReadModel => {
    const raw = store.readQueuePacket(runId);
    const parsed = raw ? parsePacketShape(raw, runId) : undefined;
    const frontmatter = parsed?.ok ? parsed.packet.frontmatter : undefined;

    let turn = 0;
    let contextTokens = 0;
    for (const event of store.readJournal(runId)) {
      if (typeof event.turn === "number") {
        turn = event.turn;
      }
      if (event.event === "turn_ended") {
        contextTokens = event.contextTokens;
      }
      if (event.event === "rotation" && typeof event.contextTokens === "number") {
        contextTokens = event.contextTokens;
      }
    }

    return {
      campaignId: frontmatter?.campaign_id ?? runId,
      parentRunId: frontmatter?.parent_run_id ?? null,
      expectedSurface: frontmatter?.expected_surface ?? [],
      pass: frontmatter?.pass ?? store.readMetaIfExists(runId)?.attempt ?? 0,
      turn,
      contextTokens,
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
    const snapshot = getTailSnapshot(runId);
    if (!snapshot) {
      return [];
    }
    const journalEvent: TailEvent = {
      kind: "tail.journal",
      runId,
      seq,
      at: event.at,
      line: renderJournalEvent(event),
      event: event.event,
      driver: isTailDriverEvent(event),
    };
    const statsEvent: TailEvent = {
      kind: "tail.stats",
      runId,
      seq,
      at: event.at,
      contextTokens: snapshot.contextTokens,
      turn: snapshot.turn,
      rotations: snapshot.rotations,
      outcomesDone: snapshot.outcomesDone,
      outcomesTotal: snapshot.outcomesTotal,
      gateReason: snapshot.gateReason,
      status: snapshot.status,
      promoted: snapshot.promoted,
    };
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
        lines: [`verdict: ${event.verdict} (pass ${event.pass})`, ...event.findings.map((finding) => `  ${finding}`)],
      },
    ];
  };

  // --- Journal tail ---

  const journalTail = startJournalTail(store, bus, tailBus, config, pollIntervalMs, projectTailEvents);
  const tailOpenCode = startTailOpenCode(config, paths, store, tailBus, pollIntervalMs);

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
        recentEvents: store.readJournal(run.runId).slice(-5).map((event) => ({
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
      const runs = store
        .listMeta()
        .filter((meta) => meta.status !== "running" && meta.status !== "queued")
        .map((meta) => ({
          runId: meta.runId,
          status: meta.status,
          outcomes: outcomes(meta.runId),
          branch: meta.branch,
          repo: meta.repo,
          base: meta.base,
          blockedQuestion: meta.blockedQuestion ?? null,
        }));
      return { runs };
    },

    getTailSnapshot(runId: string): TailSnapshotDto | undefined {
      return getTailSnapshot(runId);
    },

    getActiveTailSnapshot(): TailSnapshotDto | null {
      const runId = firstActiveRun()?.runId ?? store.listActiveConvergences()[0]?.runId;
      if (!runId) {
        return null;
      }
      return getTailSnapshot(runId) ?? null;
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
              const ctx = buildProjectionContext(runId, meta, config);
              const wire = projectJournalEvent(event, ctx);
              return wire ? { seq, event: wire } : null;
            })
            .filter((e): e is { seq: number; event: LatheEvent } => e !== null);
        },
        readTailEventsSince: (seq: number, runId: string): TailEvent[] =>
          store
            .readJournalSince(seq)
            .filter((row) => row.runId === runId)
            .flatMap((row) => projectTailEvents(row.seq, row.runId, row.event)),
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

    stopRun(runId: string): void {
      // Queued runs are represented by run meta with status = "queued".
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

    answerRun(runId: string, answer: string): void {
      const meta = store.readMetaIfExists(runId);
      const result = answerRunUc(store, repo, runId, answer, meta?.worktree ?? "", clock);
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
      // Queued runs are represented by run meta with status = "queued".
      if (store.listQueue().some((q) => q.runId === runId)) {
        store.archiveQueue(runId);
        return;
      }

      const meta = store.readMetaIfExists(runId);
      if (!meta) {
        throw new RunNotFoundError(runId);
      }

      if (meta.status === "queued") {
        // Queued runs: archive the queue entry.
        store.archiveQueue(runId);
        return;
      }

      // Irreversible terminal states: accepted/stopped/failed cannot be
      // rewritten to blocked — the work is merged/gone or already failed.
      if (meta.status === "accepted" || meta.status === "stopped" || meta.status === "failed") {
        throw new TerminalRunError(runId, meta.status);
      }

      // Running/ready_for_review/blocked runs: mark as blocked with reason.
      store.writeMeta({
        ...meta,
        status: "blocked" as const,
        blockedReason: "human_decision" as const,
        blockedQuestion: reason,
        updatedAt: clock.nowIso(),
      });
    },

    requeueRun(runId: string): RunMeta {
      const meta = store.readMetaIfExists(runId);
      if (!meta) {
        throw new RunNotFoundError(runId);
      }
      if (meta.status !== "stopped") {
        throw new TerminalRunError(runId, meta.status);
      }
      const updated: RunMeta = { ...meta, status: "queued" as const, updatedAt: clock.nowIso() };
      store.writeMeta(updated);
      return updated;
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
