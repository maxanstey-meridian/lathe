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
import type { AnswerRunRequest, EnqueueContentRequest, LatheContract, LatheEvent, RejectRunRequest, RunSummaryDto, SettingsDto, SettingsResponseDto, TailEvent, TailSnapshotDto, ValidatePacketResponse, ErrorResponse, DecisionDto, OutcomeLedgerDto, ReportDto, RestartResponseDto, ConvergenceLogEntryDto } from "@lathe/contract";
import type { Config, ValidatePacketResult } from "@lathe/core";
export type { LatheEvent, TailEvent };
import contract from "@lathe/contract/generated/api.contract.json" with { type: "json" };

import type { RunMeta } from "@lathe/core";
import type { RunDtoCtx } from "./run-to-dto.js";
import { RunCancellationConflictError, RunLifecycleConflictError, RunNotAnswerableError, RunNotFoundError, NonChainTipError, TerminalRunError, PlanNotFoundError } from "./supervisor.js";
import type { Supervisor } from "./supervisor.js";
import { configToDto } from "./config-to-dto.js";
import { runToSummary, runToDetail } from "./run-to-dto.js";
import type { AppDeps, PreparedTailSnapshot } from "./server-host.js";
/**
 * In-process fan-out for live events. The supervisor calls publish() with the
 * projected wire event; every open /events stream gets it. Trivial pub/sub —
 * the durability/replay story is SQLite (readJournalSince), not this buffer.
 */
export interface CreateAppOptions {
  readonly logger?: boolean;
  readonly cors?: boolean;
  readonly onRestart?: () => void;
}

const redactSettings = (config: Config): SettingsDto => ({
  ...config,
  baby: {
    ...config.baby,
    apiKey: "",
    models: Object.fromEntries(Object.entries(config.baby.models ?? {}).map(([name, model]) => [name, { ...model, apiKey: "" }])),
  },
  superdaddy: { ...config.superdaddy, apiKey: undefined },
});

const restoreSettingsSecrets = (settings: SettingsDto, current: Config): SettingsDto => {
  const input = settings as Partial<SettingsDto> & {
    baby?: Partial<SettingsDto["baby"]>;
    superdaddy?: Partial<SettingsDto["superdaddy"]>;
  };
  const models = input.baby?.models ?? current.baby.models;
  return ({
    ...current,
    ...input,
    baby: {
      ...current.baby,
      ...input.baby,
      apiKey: input.baby?.apiKey || current.baby.apiKey,
      models: Object.fromEntries(Object.entries(models).map(([name, model]) => [name, {
        ...model,
        apiKey: model.apiKey || current.baby.models[name]?.apiKey || "api-key",
      }])),
    },
    superdaddy: {
      ...current.superdaddy,
      ...input.superdaddy,
      ...(input.superdaddy?.apiKey ? { apiKey: input.superdaddy.apiKey } : current.superdaddy.apiKey ? { apiKey: current.superdaddy.apiKey } : {}),
    },
  }) as SettingsDto;
};

const isDriverMutation = (method: string, path: string): boolean => {
  if (method !== "POST") return false;
  return path === "/runs" ||
    path === "/runs/content" ||
    path === "/chains" ||
    /^\/runs\/[^/]+\/(stop|answer|accept|reject|requeue)$/.test(path) ||
    /^\/plans\/[^/]+\/queue$/.test(path);
};

const queuedStopRunId = (method: string, path: string, supervisor: Supervisor): string | null => {
  if (method !== "POST") return null;
  const match = path.match(/^\/runs\/([^/]+)\/stop$/);
  if (!match) return null;
  const runId = decodeURIComponent(match[1]!);
  return supervisor.getRun(runId)?.status === "queued" ? runId : null;
};

export const createApp = (
  deps: AppDeps,
  supervisor: Supervisor,
  options: CreateAppOptions = {},
): Hono => {
  const app = new Hono();

  if (options.logger) app.use(logger());
  if (options.cors) app.use(cors());
  app.use(async (context, next) => {
    const health = supervisor?.health?.() ?? { healthy: true };
    if (
      !health.healthy &&
      isDriverMutation(context.req.method, context.req.path) &&
      queuedStopRunId(context.req.method, context.req.path, supervisor) === null
    ) {
      return context.json({
        code: "supervisor_unhealthy",
        message: `run driver unavailable${health.detail ? `: ${health.detail}` : ""}`,
      }, 503);
    }
    await next();
  });

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
              baby_model: result.shape.packet.frontmatter.baby_model,
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
        let status: "stopped" | "cancellation_requested";
        try {
          status = supervisor.stopRun(params.runId);
        } catch (err) {
          if (err instanceof RunNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
          }
          if (err instanceof TerminalRunError) {
            throw rivetHttpError(409, { code: "terminal", message: err.message });
          }
          if (err instanceof RunCancellationConflictError) {
            throw rivetHttpError(409, { code: "cancellation_conflict", message: err.message });
          }
          throw err;
        }
        return { runId: params.runId, status, cancellationRequested: status === "cancellation_requested" };
      },

      answerRun: async ({ params, body }) => {
        const answer = body.answer.trim();
        if (!answer) {
          throw rivetHttpError(400, { code: "invalid_answer", message: "decision must not be empty" });
        }
        try {
          supervisor.answerRun(params.runId, answer);
        } catch (err) {
          if (err instanceof RunNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
          }
          if (err instanceof RunNotAnswerableError) {
            throw rivetHttpError(409, { code: "not_answerable", message: err.message });
          }
          if (err instanceof RunLifecycleConflictError) {
            throw rivetHttpError(409, { code: "lifecycle_conflict", message: err.message });
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
              message: `${params.runId} is not a chain tip — prepare ${err.chainTip} first`,
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
          message: `cannot prepare ${params.runId} for merge: acceptance review has not passed or the campaign is not ready`,
        });
      },

      rejectRun: async ({ params, body }) => {
        const reason = body.reason ?? "Changes requested";
        try {
          supervisor.rejectRun(params.runId, reason);
        } catch (err) {
          if (err instanceof RunNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
          }
          if (err instanceof TerminalRunError) {
            throw rivetHttpError(409, { code: "not_reviewable", message: err.message });
          }
          if (err instanceof RunLifecycleConflictError) {
            throw rivetHttpError(409, { code: "lifecycle_conflict", message: err.message });
          }
          throw err;
        }
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          return mutationSummary(params.runId, "blocked");
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
          if (err instanceof RunNotAnswerableError) {
            throw rivetHttpError(409, { code: "not_answerable", message: err.message });
          }
          if (err instanceof RunLifecycleConflictError) {
            throw rivetHttpError(409, { code: "lifecycle_conflict", message: err.message });
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
        const snapshot = await supervisor.prepareTailSnapshot(params.runId);
        if (!snapshot) {
          throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
        }
        return snapshot;
      },

      getActiveTail: async () => {
        return supervisor.prepareActiveTailSnapshot();
      },

      getSettings: async () => {
        return {
          settings: redactSettings(supervisor.settings),
          restartRequired: supervisor.restartRequired,
        } satisfies SettingsResponseDto;
      },

      updateSettings: async ({ body }) => {
        try {
          const written = supervisor.writeConfig(restoreSettingsSecrets(body, supervisor.settings));
          return {
            settings: redactSettings(written),
            restartRequired: supervisor.restartRequired,
          } satisfies SettingsResponseDto;
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
  // Live-only status SSE. The dashboard uses this only as an invalidation signal
  // before refetching /status, so historical journal replay is wasted work and
  // can soft-lock startup on large event tables.
  //
  // NOTE: there is a bounded race window (≤ pollIntervalMs) between the
  // readJournalSince snapshot and the bus.subscribe() call — events written
  // to the journal in that window are not dropped (they arrive via the bus on
  // the next tail poll). A reconnect-mid-stream test verifies the handoff.
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let lastSeq = 0;

      const queue: Array<{ seq: number; event: LatheEvent } | { ping: true }> = [{ ping: true }];
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
          const next = queue.shift()!;
          if ("ping" in next) {
            await stream.writeSSE({ event: "ping", data: "" });
            continue;
          }
          const { seq, event } = next;
          lastSeq = seq;
          await stream.writeSSE({ id: String(seq), event: event.kind, data: JSON.stringify(event) });
        }
      } finally {
        unsub();
      }
    }),
  );

  app.get("/tail/active/events", (c) =>
    streamTailSse(c, deps, null),
  );

  app.get("/tail/:runId/events", (c) =>
    streamTailSse(c, deps, c.req.param("runId")),
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
    const queue: Array<{ revision: number; event: TailEvent }> = [];
    const emittedDurable = new Set<string>();
    let notify: (() => void) | null = null;
    let activeSnapshot: TailSnapshotDto | null = null;
    let runId = fallbackRunId;
    let lastSeq = since;
    let representedThroughRevision = 0;
    let lastPingAt = Date.now();
    const prepare = async (target: string | null): Promise<PreparedTailSnapshot> =>
      deps.prepareTailSnapshot
        ? deps.prepareTailSnapshot(target)
        : { snapshot: null, revision: tailBus.revision() };
    stream.onAbort(() => notify?.());
    const unsub = tailBus.subscribe((revision, event) => {
      queue.push({ revision, event });
      notify?.();
    });

    try {
      const prepared = await prepare(fallbackRunId);
      activeSnapshot = prepared.snapshot;
      representedThroughRevision = prepared.revision;
      runId = activeSnapshot?.runId ?? fallbackRunId;
      if (activeSnapshot) {
        lastSeq = Math.max(lastSeq, activeSnapshot.lastSeq);
      }
      await stream.writeSSE({
        event: "tail.run.changed",
        data: JSON.stringify({ kind: "tail.run.changed", runId, snapshot: activeSnapshot } satisfies TailEvent),
      });

      if (runId) {
        for (const event of readTailEventsSince(lastSeq, runId)) {
          const seq = tailEventSeq(event);
          const fingerprint = JSON.stringify(event);
          if ((seq !== null && seq < lastSeq) || (seq !== null && emittedDurable.has(fingerprint))) {
            continue;
          }
          if (seq !== null) {
            lastSeq = Math.max(lastSeq, seq);
          }
          if (seq !== null) emittedDurable.add(fingerprint);
          await stream.writeSSE({
            id: seq === null ? undefined : String(seq),
            event: event.kind,
            data: JSON.stringify(event),
          });
        }
      }

      while (!stream.aborted) {
        if (fallbackRunId === null) {
          const selectedRunId = deps.resolveActiveTailRunId
            ? deps.resolveActiveTailRunId()
            : activeSnapshot?.runId ?? null;
          if (selectedRunId !== runId) {
            const transition = await prepare(null);
            if (stream.aborted) break;
            activeSnapshot = transition.snapshot;
            representedThroughRevision = transition.revision;
            runId = activeSnapshot?.runId ?? null;
            if (activeSnapshot) lastSeq = Math.max(lastSeq, activeSnapshot.lastSeq);
            await stream.writeSSE({
              event: "tail.run.changed",
              data: JSON.stringify({ kind: "tail.run.changed", runId, snapshot: activeSnapshot } satisfies TailEvent),
            });
            continue;
          }
        }
        if (queue.length === 0) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const waitMs = fallbackRunId === null ? 1_000 : 15_000;
          await new Promise<void>((r) => { notify = r; timer = setTimeout(r, waitMs); });
          if (timer) clearTimeout(timer);
          notify = null;
          if (stream.aborted) break;
          if (queue.length === 0) {
            if (Date.now() - lastPingAt >= 15_000) {
              await stream.writeSSE({ event: "tail.ping", data: JSON.stringify({ kind: "tail.ping" } satisfies TailEvent) });
              lastPingAt = Date.now();
            }
            continue;
          }
        }
        const queued = queue.shift()!;
        if (queued.revision <= representedThroughRevision) {
          continue;
        }
        const event = queued.event;
        const eventRunId = tailEventRunId(event);
        if (eventRunId !== null && eventRunId !== runId) {
          continue;
        }
        const seq = tailEventSeq(event);
        const fingerprint = JSON.stringify(event);
        if ((seq !== null && seq < lastSeq) || (seq !== null && emittedDurable.has(fingerprint))) {
          continue;
        }
        if (seq !== null) {
          lastSeq = Math.max(lastSeq, seq);
        }
        if (seq !== null) {
          emittedDurable.add(fingerprint);
          if (emittedDurable.size > 1_000) {
            const oldest = [...emittedDurable].slice(0, emittedDurable.size - 1_000);
            for (const key of oldest) emittedDurable.delete(key);
          }
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

const mutationSummary = (runId: string, status: RunSummaryDto["status"]): RunSummaryDto => ({
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
