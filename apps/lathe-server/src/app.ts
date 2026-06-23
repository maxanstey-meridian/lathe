/**
 * STAGING REFERENCE — drop into apps/lathe-server/src/app.ts in P00.
 *
 * The daemon's HTTP surface. Two transports on one Hono app:
 *   1. The rivet-ts contract → registerRivetHonoRoutes (request/response).
 *   2. A sidecar GET /events → streamSSE (the live push spine).
 *
 * Wiring mirrors the current rivet-ts scaffolder (createApp factory + `with`
 * JSON import + rivetHttpError + app.onError envelope + hono/logger). P00 lands
 * this with EVERY contract handler stubbed (rivetHttpError 501) so the baseline
 * is green; bodies land in P03, the supervisor that fills `bus` in P02.
 */
import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { registerRivetHonoRoutes, rivetHttpError } from "rivet-ts/hono";
import type { LatheContract, LatheEvent } from "@lathe/contract";
import contract from "@lathe/contract/generated/api.contract.json" with { type: "json" };

/**
 * In-process fan-out for live events. P02's supervisor calls publish() with the
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
  // supervisor: Supervisor — injected in P02; handlers call it in P03.
}

export interface CreateAppOptions {
  // Server-entry concerns (the scaffolder's CreateAppOptions shape).
  readonly logger?: boolean;
  readonly cors?: boolean;
}

export const createApp = (deps: AppDeps, options: CreateAppOptions = {}): Hono => {
  const app = new Hono();

  if (options.logger) app.use(logger());
  if (options.cors) app.use(cors());

  // --- contract routes (stubbed in P00, bodies in P03) ---------------------
  registerRivetHonoRoutes<LatheContract>(app, contract, {
    group: "lathe",
    handlers: {
      EnqueueRun: () => { throw rivetHttpError(501, { code: "not_implemented", message: "EnqueueRun" }); },
      EnqueueChain: () => { throw rivetHttpError(501, { code: "not_implemented", message: "EnqueueChain" }); },
      ListRuns: () => { throw rivetHttpError(501, { code: "not_implemented", message: "ListRuns" }); },
      GetRun: () => { throw rivetHttpError(501, { code: "not_implemented", message: "GetRun" }); },
      AbortRun: () => { throw rivetHttpError(501, { code: "not_implemented", message: "AbortRun" }); },
      AcceptRun: () => { throw rivetHttpError(501, { code: "not_implemented", message: "AcceptRun" }); },
      RejectRun: () => { throw rivetHttpError(501, { code: "not_implemented", message: "RejectRun" }); },
      GetConfig: () => { throw rivetHttpError(501, { code: "not_implemented", message: "GetConfig" }); },
    },
  });

  // --- SSE sidecar (skeleton in P00, full feed in P04) ---------------------
  // Resumable: client sends Last-Event-ID; we replay the SQLite events table
  // from there, THEN attach to the live bus. seq is the SSE event id, so a
  // dropped connection resumes gap-free.
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      const lastId = Number.parseInt(c.req.header("Last-Event-ID") ?? "0", 10);
      const since = Number.isInteger(lastId) ? lastId : 0;

      for (const { seq, event } of deps.readEventsSince(since)) {
        await stream.writeSSE({ id: String(seq), event: event.kind, data: JSON.stringify(event) });
      }

      const queue: { seq: number; event: LatheEvent }[] = [];
      let notify: (() => void) | null = null;
      const unsub = deps.bus.subscribe((seq, event) => {
        queue.push({ seq, event });
        notify?.();
      });

      try {
        // heartbeat-able loop; replace with abort-aware wait in P04
        while (!stream.aborted) {
          if (queue.length === 0) {
            await new Promise<void>((r) => { notify = r; setTimeout(r, 15_000); });
            notify = null;
            if (queue.length === 0) { await stream.writeSSE({ event: "ping", data: "" }); continue; }
          }
          const { seq, event } = queue.shift()!;
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
