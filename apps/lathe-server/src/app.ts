/**
 * The daemon's HTTP surface. Two transports on one Hono app:
 *   1. The rivet-ts contract → registerRivetHonoRoutes (request/response).
 *   2. A sidecar GET /events → streamSSE (the live push spine).
 *
 * Handlers delegate to the injected Supervisor — no business logic in handlers.
 * Error→status mapping uses rivetHttpError (404/409/400); unhandled errors fall
 * through to app.onError 500 envelope.
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { registerRivetHonoRoutes, rivetHttpError } from "rivet-ts/hono";
import type { AnswerRunRequest, EnqueueContentRequest, LatheContract, LatheEvent, RejectRunRequest, RunSummaryDto, TailEvent, TailSnapshotDto, ValidatePacketResponse, ErrorResponse, DecisionDto, OutcomeLedgerDto, ReportDto, RestartResponseDto, ConvergenceLogEntryDto, SettingsDto } from "@lathe/contract";
import type { ValidatePacketResult } from "@lathe/core";
export type { LatheEvent, TailEvent };
import contract from "@lathe/contract/generated/api.contract.json" with { type: "json" };

import type { RunMeta } from "@lathe/core";
import type { RunDtoCtx } from "./run-to-dto.js";
import { RunNotAnswerableError, RunNotFoundError, NonChainTipError, TerminalRunError, PlanNotFoundError } from "./supervisor.js";
import type { Supervisor } from "./supervisor.js";
import { configToDto } from "./config-to-dto.js";
import { runToSummary, runToDetail } from "./run-to-dto.js";

/**
 * In-process fan-out for live events. The supervisor calls publish() with the
 * projected wire event; every open /events stream gets it. Trivial pub/sub —
 * the durability/replay story is SQLite (readJournalSince), not this buffer.
 */
export interface EventBus {
  publish(seq: number, event: LatheEvent): void;
  subscribe(onEvent: (seq: number, event: LatheEvent) => void): () => void;
}

export interface TailEventBus {
  publish(event: TailEvent): void;
  subscribe(onEvent: (event: TailEvent) => void): () => void;
}

export const createEventBus = (): EventBus => {
  const subs = new Set<(seq: number, event: LatheEvent) => void>();
  return {
    publish: (seq, event) => { for (const s of subs) s(seq, event); },
    subscribe: (onEvent) => { subs.add(onEvent); return () => subs.delete(onEvent); },
  };
};

export const createTailEventBus = (): TailEventBus => {
  const subs = new Set<(event: TailEvent) => void>();
  return {
    publish: (event) => { for (const s of subs) s(event); },
    subscribe: (onEvent) => { subs.add(onEvent); return () => subs.delete(onEvent); },
  };
};

export interface AppDeps {
  bus: EventBus;
  /** Resumable replay on reconnect — SQLite events table (P01's readJournalSince). */
  readEventsSince: (seq: number) => { seq: number; event: LatheEvent }[];
  tailBus?: TailEventBus;
  readTailEventsSince?: (seq: number, runId: string) => TailEvent[];
}

export interface CreateAppOptions {
  readonly logger?: boolean;
  readonly cors?: boolean;
  readonly onRestart?: () => void;
}

export const createApp = (
  deps: AppDeps,
  supervisor: Supervisor,
  options: CreateAppOptions = {},
): Hono => {
  const app = new Hono();

  if (options.logger) app.use(logger());
  if (options.cors) app.use(cors());

  // --- contract routes (real handlers — supervisor delegation) --------------
  registerRivetHonoRoutes<LatheContract>(app, contract, {
    group: "lathe",
    handlers: {
      enqueueRun: async ({ body }) => {
        let runId: string;
        try {
          runId = supervisor.enqueueRun(body.packetPath);
        } catch (err) {
          throw rivetHttpError(400, { code: "invalid_packet", message: err instanceof Error ? err.message : String(err) });
        }
        const meta = supervisor.getRun(runId);
        if (!meta) {
          throw rivetHttpError(500, { code: "internal_error", message: "enqueue succeeded but run not found" });
        }
        const ctx = buildDtoCtx(supervisor, meta);
        return runToSummary(meta, ctx);
      },

      enqueueContent: async ({ body }) => {
        let runId: string;
        try {
          runId = supervisor.enqueueContent(body.content, body.filename);
        } catch (err) {
          throw rivetHttpError(400, { code: "invalid_packet", message: err instanceof Error ? err.message : String(err) });
        }
        const meta = supervisor.getRun(runId);
        if (!meta) {
          throw rivetHttpError(500, { code: "internal_error", message: "enqueue succeeded but run not found" });
        }
        const ctx = buildDtoCtx(supervisor, meta);
        return runToSummary(meta, ctx);
      },

      validatePacket: async ({ body }) => {
        const result = supervisor.validatePacket(body.content, body.filename);

        // Fast path: all validation passes.
        if (result.shape.ok && result.repoValid && result.baseExists) {
          return {
            ok: true,
            frontmatter: {
              repo: result.shape.packet.frontmatter.repo,
              base: result.shape.packet.frontmatter.base,
              compare_commit: result.shape.packet.frontmatter.compare_commit,
              summary: result.shape.packet.frontmatter.summary,
              outcomes: result.shape.packet.frontmatter.outcomes,
              expected_surface: result.shape.packet.frontmatter.expected_surface,
              suspicious_surface: result.shape.packet.frontmatter.suspicious_surface,
              verification: result.shape.packet.frontmatter.verification,
              constraints: result.shape.packet.frontmatter.constraints,
              autofix_commands: result.shape.packet.frontmatter.autofix_commands,
              campaign_id: result.shape.packet.frontmatter.campaign_id,
              parent_run_id: result.shape.packet.frontmatter.parent_run_id,
              pass: result.shape.packet.frontmatter.pass,
              regression_outcomes: result.shape.packet.frontmatter.regression_outcomes,
              promoted: result.shape.packet.frontmatter.promoted,
            },
            body: result.shape.packet.body,
            problems: [],
          };
        }

        // Slow path: collect problems from shape, repo, or base failures.
        const problems: string[] = [];
        if (!result.shape.ok) {
          problems.push(...result.shape.problems);
        } else {
          if (!result.repoValid && result.repoPath) {
            problems.push(`repo "${result.repoPath}" is not a valid git repository`);
          }
          if (!result.baseExists && result.base) {
            problems.push(`base branch "${result.base}" does not exist in ${result.repoPath}`);
          }
        }

        return {
          ok: false,
          frontmatter: null,
          body: result.shape.ok ? result.shape.packet.body : "",
          problems,
        };
      },

      enqueueChain: async ({ body }) => {
        const before = new Set(supervisor.listRuns().map(r => r.runId));
        supervisor.enqueueChain(body.chainDir);
        const runs = supervisor.listRuns();
        const chainIds = runs.filter(r => !before.has(r.runId)).map(r => r.runId);
        const summaries = runs
          .filter(r => chainIds.includes(r.runId))
          .map((meta) => {
            const ctx = buildDtoCtx(supervisor, meta);
            return runToSummary(meta, ctx);
          });
        return summaries;
      },

      listRuns: async () => {
        const runs = supervisor.listRuns();
        const summaries = runs.map((meta) => {
          const ctx = buildDtoCtx(supervisor, meta);
          return runToSummary(meta, ctx);
        });
        return summaries;
      },

      getRun: async ({ params }) => {
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
        }
        const ctx = buildDtoCtx(supervisor, meta);
        return runToDetail(meta, ctx);
      },

      getStatus: async () => {
        return supervisor.getStatus();
      },

      getReview: async () => {
        return supervisor.getReview();
      },

      stopRun: async ({ params }) => {
        try {
          supervisor.stopRun(params.runId);
        } catch (err) {
          if (err instanceof RunNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
          }
          if (err instanceof TerminalRunError) {
            throw rivetHttpError(409, { code: "terminal", message: err.message });
          }
          throw err;
        }
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          return mutationSummary(params.runId, "stopped");
        }
        const ctx = buildDtoCtx(supervisor, meta);
        return runToSummary(meta, ctx);
      },

      answerRun: async ({ params, body }) => {
        const answer = body.answer;
        try {
          supervisor.answerRun(params.runId, answer);
        } catch (err) {
          if (err instanceof RunNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
          }
          if (err instanceof RunNotAnswerableError) {
            throw rivetHttpError(409, { code: "not_answerable", message: err.message });
          }
          throw err;
        }
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
        }
        const ctx = buildDtoCtx(supervisor, meta);
        return runToSummary(meta, ctx);
      },

      acceptRun: async ({ params }) => {
        let result: number;
        try {
          result = supervisor.acceptRun(params.runId);
        } catch (err) {
          if (err instanceof RunNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
          }
          if (err instanceof NonChainTipError) {
            throw rivetHttpError(409, {
              code: "chain_tip_required",
              message: `${params.runId} is not a chain tip — accept ${err.chainTip} first`,
            });
          }
          throw err;
        }
        if (result === 0) {
          const meta = supervisor.getRun(params.runId);
          if (!meta) {
            throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
          }
          const ctx = buildDtoCtx(supervisor, meta);
          return runToSummary(meta, ctx);
        }
        throw rivetHttpError(409, {
          code: "accept_refused",
          message: `accept ${params.runId} refused`,
        });
      },

      rejectRun: async ({ params, body }) => {
        const reason = body.reason ?? "rejected";
        try {
          supervisor.rejectRun(params.runId, reason);
        } catch (err) {
          if (err instanceof RunNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
          }
          if (err instanceof TerminalRunError) {
            throw rivetHttpError(409, { code: "terminal", message: err.message });
          }
          throw err;
        }
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          return mutationSummary(params.runId, "paused");
        }
        const ctx = buildDtoCtx(supervisor, meta);
        return runToSummary(meta, ctx);
      },

      requeueRun: async ({ params }) => {
        let meta: RunMeta;
        try {
          meta = supervisor.requeueRun(params.runId);
        } catch (err) {
          if (err instanceof RunNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
          }
          if (err instanceof TerminalRunError) {
            throw rivetHttpError(409, { code: "terminal", message: err.message });
          }
          throw err;
        }
        const ctx = buildDtoCtx(supervisor, meta);
        return runToSummary(meta, ctx);
      },

      getConfig: async () => {
        return configToDto(supervisor.config);
      },

      getTail: async ({ params }) => {
        const snapshot = supervisor.getTailSnapshot(params.runId);
        if (!snapshot) {
          throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
        }
        return snapshot;
      },

      getActiveTail: async () => {
        return supervisor.getActiveTailSnapshot();
      },

      getSettings: async () => {
        // rivet-ts reflector can't express `number | false` — the two fields
        // (idleTimeoutMs, superdaddy.headerTimeoutMs) are `number` in the contract
        // but `number | false` in the Zod Config. Narrowing cast is sound: `false`
        // is a diagnostic-only sentinel; all other fields are structurally identical.
        return supervisor.config as SettingsDto;
      },

      updateSettings: async ({ body }) => {
        try {
          const written = supervisor.writeConfig(body);
          return written as SettingsDto;
        } catch (err) {
          throw rivetHttpError(400, { code: "invalid_config", message: err instanceof Error ? err.message : String(err) });
        }
      },

      restart: async () => {
        if (!options.onRestart) {
          throw rivetHttpError(400, { code: "restart_unavailable", message: "restart not available" });
        }
        options.onRestart();
        return { restarting: true } satisfies RestartResponseDto;
      },

      getDecisions: async ({ params }) => {
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
        }
        return supervisor.getDecisions(params.runId) as DecisionDto[];
      },

      getOutcomes: async ({ params }) => {
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
        }
        return supervisor.getLedger(params.runId) as OutcomeLedgerDto;
      },

      getReport: async ({ params }) => {
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
        }
        return { report: supervisor.getReport(params.runId) } satisfies ReportDto;
      },

      getConvergence: async ({ params }) => {
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
        }
        return supervisor.getConvergence(params.runId) as ConvergenceLogEntryDto[];
      },

      // --- Plans shelf ---

      listPlans: async () => {
        return supervisor.listPlans().map((p) => ({
          planId: p.planId,
          title: p.title,
          tags: p.tags,
          queuedRunId: p.queuedRunId ?? null,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        }));
      },

      getPlan: async ({ params }) => {
        const plan = supervisor.getPlan(params.planId);
        if (!plan) {
          throw rivetHttpError(404, { code: "not_found", message: `plan ${params.planId} not found` });
        }
        return {
          planId: plan.planId,
          title: plan.title,
          raw: plan.raw,
          tags: plan.tags,
          queuedRunId: plan.queuedRunId ?? null,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
        };
      },

      createPlan: async ({ body }) => {
        return supervisor.createPlan(body.content, body.filename, body.tags);
      },

      updatePlan: async ({ params, body }) => {
        try {
          return supervisor.updatePlan(params.planId, body.content, body.tags);
        } catch (err) {
          if (err instanceof PlanNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: err.message });
          }
          throw err;
        }
      },

      deletePlan: async ({ params }) => {
        try {
          supervisor.deletePlan(params.planId);
          return { deleted: true };
        } catch (err) {
          if (err instanceof PlanNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: err.message });
          }
          throw err;
        }
      },

      queuePlan: async ({ params }) => {
        try {
          const runId = supervisor.queuePlan(params.planId);
          return { runId };
        } catch (err) {
          if (err instanceof PlanNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: err.message });
          }
          throw rivetHttpError(400, { code: "invalid_packet", message: err instanceof Error ? err.message : String(err) });
        }
      },
    },
  });

  // --- SSE sidecar -----------------------------------------------------------
  // Resumable: client sends Last-Event-ID; we replay the SQLite events table
  // from there (exclusive), THEN attach to the live bus. seq is the SSE event
  // id so a dropped connection resumes gap-free.
  //
  // NOTE: there is a bounded race window (≤ pollIntervalMs) between the
  // readJournalSince snapshot and the bus.subscribe() call — events written
  // to the journal in that window are not dropped (they arrive via the bus on
  // the next tail poll). A reconnect-mid-stream test verifies the handoff.
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const lastId = Number.parseInt(c.req.header("Last-Event-ID") ?? "0", 10);
      const since = Number.isInteger(lastId) ? lastId : -1;
      let lastSeq = since;

      for (const { seq, event } of deps.readEventsSince(since)) {
        lastSeq = seq;
        await stream.writeSSE({ id: String(seq), event: event.kind, data: JSON.stringify(event) });
      }

      const queue: { seq: number; event: LatheEvent }[] = [];
      let notify: (() => void) | null = null;
      stream.onAbort(() => notify?.());
      const unsub = deps.bus.subscribe((seq, event) => {
        if (seq <= lastSeq) {
          return;
        }
        queue.push({ seq, event });
        notify?.();
      });

      try {
        while (!stream.aborted) {
          if (queue.length === 0) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            await new Promise<void>((r) => { notify = r; timer = setTimeout(r, 15_000); });
            if (timer) clearTimeout(timer);
            notify = null;
            if (stream.aborted) break;
            if (queue.length === 0) { await stream.writeSSE({ event: "ping", data: "" }); continue; }
          }
          const { seq, event } = queue.shift()!;
          lastSeq = seq;
          await stream.writeSSE({ id: String(seq), event: event.kind, data: JSON.stringify(event) });
        }
      } finally {
        unsub();
      }
    }),
  );

  app.get("/tail/active/events", (c) =>
    streamTailSse(c, deps, () => supervisor.getActiveTailSnapshot(), null),
  );

  app.get("/tail/:runId/events", (c) =>
    streamTailSse(c, deps, () => supervisor.getTailSnapshot(c.req.param("runId")) ?? null, c.req.param("runId")),
  );

  // Unhandled handler errors become a structured 500 — same envelope rivetHttpError
  // produces, matching the scaffolder's app.onError (behavioral parity).
  app.onError((error, context) => {
    console.error(error);
    return context.json({ code: "internal_error", message: "Unexpected error." }, 500);
  });

  return app;
};

const tailEventRunId = (event: TailEvent): string | null =>
  "runId" in event ? event.runId : null;

const tailEventSeq = (event: TailEvent): number | null =>
  "seq" in event && typeof event.seq === "number" ? event.seq : null;

const streamTailSse = (
  c: Context,
  deps: AppDeps,
  resolveSnapshot: () => TailSnapshotDto | null,
  fallbackRunId: string | null,
) =>
  streamSSE(c, async (stream) => {
    const tailBus = deps.tailBus;
    const readTailEventsSince = deps.readTailEventsSince;
    if (!tailBus || !readTailEventsSince) {
      await stream.writeSSE({ event: "tail.ping", data: JSON.stringify({ kind: "tail.ping" } satisfies TailEvent) });
      return;
    }

    const lastId = Number.parseInt(c.req.header("Last-Event-ID") ?? "0", 10);
    const since = Number.isInteger(lastId) ? lastId : -1;
    const safeResolveSnapshot = (): TailSnapshotDto | null => {
      try {
        return resolveSnapshot();
      } catch {
        return null;
      }
    };
    let activeSnapshot = safeResolveSnapshot();
    let runId = activeSnapshot?.runId ?? fallbackRunId;
    let lastSeq = since;

    if (runId) {
      for (const event of readTailEventsSince(since, runId)) {
        const seq = tailEventSeq(event);
        if (seq !== null) {
          lastSeq = seq;
        }
        await stream.writeSSE({
          id: seq === null ? undefined : String(seq),
          event: event.kind,
          data: JSON.stringify(event),
        });
      }
    }

    const queue: TailEvent[] = [];
    let notify: (() => void) | null = null;
    stream.onAbort(() => notify?.());
    const unsub = tailBus.subscribe((event) => {
      const currentSnapshot = safeResolveSnapshot();
      const currentRunId = currentSnapshot?.runId ?? fallbackRunId;
      if (currentRunId !== runId) {
        activeSnapshot = currentSnapshot;
        runId = currentRunId;
        queue.push({ kind: "tail.run.changed", runId: currentRunId ?? "", snapshot: activeSnapshot });
        notify?.();
      }
      const eventRunId = tailEventRunId(event);
      if (currentRunId && eventRunId && eventRunId !== currentRunId) {
        return;
      }
      const seq = tailEventSeq(event);
      if (seq !== null && seq <= lastSeq) {
        return;
      }
      queue.push(event);
      notify?.();
    });

    try {
      while (!stream.aborted) {
        if (queue.length === 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await new Promise<void>((r) => { notify = r; timer = setTimeout(r, 15_000); });
          if (timer) clearTimeout(timer);
          notify = null;
          if (stream.aborted) break;
          if (queue.length === 0) {
            await stream.writeSSE({ event: "tail.ping", data: JSON.stringify({ kind: "tail.ping" } satisfies TailEvent) });
            continue;
          }
        }
        const event = queue.shift()!;
        const seq = tailEventSeq(event);
        if (seq !== null) {
          lastSeq = seq;
        }
        await stream.writeSSE({
          id: seq === null ? undefined : String(seq),
          event: event.kind,
          data: JSON.stringify(event),
        });
      }
    } finally {
      unsub();
    }
  });

// ---------------------------------------------------------------------------
// Handler helpers
// ---------------------------------------------------------------------------

const buildDtoCtx = (sup: Supervisor, meta: RunMeta): RunDtoCtx => ({
  ...sup.runReadModel(meta.runId),
  isChainTip: sup.isChainTip(meta.runId),
  contextWindow: sup.config.baby.contextWindow,
  lastVerdict: sup.lastVerdict(meta.runId),
  outcomes: sup.outcomes(meta.runId),
});

const mutationSummary = (runId: string, status: "stopped" | "paused"): RunSummaryDto => ({
  runId,
  campaignId: "",
  packet: runId,
  status,
  pass: 0,
  turn: 0,
  contextTokens: 0,
  contextWindow: 0,
  isChainTip: false,
  startedAt: "",
  updatedAt: new Date().toISOString(),
});
