// ---------------------------------------------------------------------------
// `lathe serve` — boot the daemon.
//
// Lifecycle:
//   1. loadConfig() → config + paths (state root, db file, etc.)
//   2. acquireSingleInstanceLock(lockPath, port, host) → { server, release }
//      (the held socket is the exclusivity primitive)
//   3. createSupervisor(config, paths) → Supervisor
//   4. createApp(AppDeps from supervisor) → Hono app
//   5. attach Hono request listener to the held server
//
// Shutdown (SIGINT/SIGTERM):
//   await server close → stop supervisor (→ abort runDriver, await exit) →
//   release lock → exit(0)
// ---------------------------------------------------------------------------

import { loadConfig, type Config, type Paths } from "@lathe/core";
import { createApp, createSupervisor, acquireSingleInstanceLock } from "@lathe/server";
import { getRequestListener } from "@hono/node-server";
import type { Server } from "node:http";
import { join } from "node:path";

export type DaemonDeps = {
  loadConfig: () => { config: Config; paths: Paths };
  acquireSingleInstanceLock: (lockPath: string, port: number, host?: string) => Promise<{ server: Server; release: () => void }>;
  createSupervisor: (config: Config, paths: Paths) => {
    appDeps: unknown;
    stop: () => Promise<void>;
  };
  createApp: (appDeps: unknown, supervisor: unknown, options?: { logger?: boolean }) => { fetch: (req: Request) => Promise<Response> };
};

export const startDaemon = async (deps?: DaemonDeps, userPort?: number): Promise<void> => {
  const cfg = deps?.loadConfig() ?? loadConfig();
  const config = cfg.config;
  const paths = cfg.paths;
  const port = userPort ?? config.daemon.port;
  const host = config.daemon.host;

  // 1. Acquire the held socket lock.
  const lockPath = join(paths.root, "lathe.lock");
  const lock = deps?.acquireSingleInstanceLock ?? acquireSingleInstanceLock;
  const { server, release: releaseLock } = await lock(lockPath, port, host);

  // 2. Create supervisor (owns runDriver, journal tail, lifecycle methods).
  const supervisor = deps?.createSupervisor ?? createSupervisor;
  const sup = supervisor(config, paths);

  // 3. Build the Hono app: use supervisor's own bus (journal tail publishes here) + readEventsSince.
  const app = deps?.createApp
    ? deps.createApp(sup.appDeps as unknown, sup as unknown, { logger: true })
    : createApp(sup.appDeps as any, sup as any, { logger: true });

  // 4. Attach the request listener to the already-bound held server.
  server.on("request", getRequestListener(app.fetch, { hostname: host }));

  console.log(`lathe daemon listening on http://${host}:${port}`);

  // 5. Graceful shutdown.
  const shutdown = async (): Promise<void> => {
    console.log("shutting down…");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await sup.stop();
    } catch {
      /* supervisor stop timeout — proceed anyway */
    }
    releaseLock();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};
