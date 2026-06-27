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
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { registerRivetHonoRoutes, rivetHttpError } from "rivet-ts/hono";
import type { LatheContract, LatheEvent, RejectRunRequest, RunSummaryDto } from "@lathe/contract";
export type { LatheEvent };
import contract from "@lathe/contract/generated/api.contract.json" with { type: "json" };

import type { RunMeta } from "@lathe/core";
import type { RunDtoCtx } from "./run-to-dto.js";
import { RunNotFoundError, NonChainTipError } from "./supervisor.js";
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

export const createEventBus = (): EventBus => {
  const subs = new Set<(seq: number, event: LatheEvent) => void>();
  return {
    publish: (seq, event) => { for (const s of subs) s(seq, event); },
    subscribe: (onEvent) => { subs.add(onEvent); return () => subs.delete(onEvent); },
  };
};

export interface AppDeps {
  bus: EventBus;
  /** Resumable replay on reconnect — SQLite events table (P01's readJournalSince). */
  readEventsSince: (seq: number) => { seq: number; event: LatheEvent }[];
}

export interface CreateAppOptions {
  readonly logger?: boolean;
  readonly cors?: boolean;
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
      EnqueueRun: async ({ body }) => {
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

      EnqueueChain: async ({ body }) => {
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

      ListRuns: async () => {
        const runs = supervisor.listRuns();
        const summaries = runs.map((meta) => {
          const ctx = buildDtoCtx(supervisor, meta);
          return runToSummary(meta, ctx);
        });
        return summaries;
      },

      GetRun: async ({ params }) => {
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
        }
        const ctx = buildDtoCtx(supervisor, meta);
        return runToDetail(meta, ctx);
      },

      AbortRun: async ({ params }) => {
        try {
          supervisor.abortRun(params.runId);
        } catch (err) {
          if (err instanceof RunNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
          }
          throw err;
        }
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          return mutationSummary(params.runId, "aborted");
        }
        const ctx = buildDtoCtx(supervisor, meta);
        return runToSummary(meta, ctx);
      },

      AcceptRun: async ({ params }) => {
        let result: number;
        try {
          result = supervisor.acceptRun(params.runId);
        } catch (err) {
          if (err instanceof NonChainTipError) {
            throw rivetHttpError(409, {
              code: "chain_tip_required",
              message: `${params.runId} is not a chain tip — accept ${err.chainTip} first`,
            });
          }
          throw err;
        }
        if (result === 0) {
          throw rivetHttpError(409, {
            code: "accept_refused",
            message: `accept ${params.runId} refused`,
          });
        }
        const meta = supervisor.getRun(params.runId);
        if (!meta) {
          throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
        }
        const ctx = buildDtoCtx(supervisor, meta);
        return runToSummary(meta, ctx);
      },

      RejectRun: async ({ params, body }) => {
        const reason = (body as RejectRunRequest).reason ?? "rejected";
        try {
          supervisor.rejectRun(params.runId, reason);
        } catch (err) {
          if (err instanceof RunNotFoundError) {
            throw rivetHttpError(404, { code: "not_found", message: `run ${params.runId} not found` });
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

      GetConfig: async () => {
        return configToDto(supervisor.config);
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

  // Unhandled handler errors become a structured 500 — same envelope rivetHttpError
  // produces, matching the scaffolder's app.onError (behavioral parity).
  app.onError((error, context) => {
    console.error(error);
    return context.json({ code: "internal_error", message: "Unexpected error." }, 500);
  });

  return app;
};

// ---------------------------------------------------------------------------
// Handler helpers
// ---------------------------------------------------------------------------

const buildDtoCtx = (sup: Supervisor, meta: RunMeta): RunDtoCtx => ({
  isChainTip: sup.isChainTip(meta.runId),
  contextWindow: sup.config.baby.contextWindow,
  lastVerdict: sup.lastVerdict(meta.runId),
});

const mutationSummary = (runId: string, status: "aborted" | "paused"): RunSummaryDto => ({
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
