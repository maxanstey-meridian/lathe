// ---------------------------------------------------------------------------
// `lathe serve` — boot the daemon.
//
// Lifecycle:
//   1. loadConfig() → config + paths (state root, db file, etc.)
//   2. acquireSingleInstanceLock(lockPath, port, host) → release fn
//   3. createSupervisor(config, paths) → Supervisor (owns runDriver, journal tail)
//   4. createApp(AppDeps from supervisor, supervisor, { logger }) → Hono app
//   5. @hono/node-server serve on config.daemon.port
//
// Shutdown (SIGINT/SIGTERM):
//   await server close → stop supervisor (→ abort runDriver, await exit) →
//   release lock → exit(0)
// ---------------------------------------------------------------------------

import { loadConfig } from "@lathe/core";
import { createApp, createSupervisor, acquireSingleInstanceLock } from "@lathe/server";
import { join } from "node:path";

export const startDaemon = async (userPort?: number): Promise<void> => {
  const { config, paths } = loadConfig();
  const port = userPort ?? config.daemon.port;
  const host = config.daemon.host;

  // 1. Acquire single-instance lock (socket bind + pidfile).
  const lockPath = join(paths.root, "lathe.lock");
  const releaseLock = await acquireSingleInstanceLock(lockPath, port, host);

  // 2. Create supervisor (owns runDriver, journal tail, lifecycle methods).
  const supervisor = createSupervisor(config, paths);

  // 3. Build the Hono app: use supervisor's own bus (journal tail publishes here) + readEventsSince.
  const app = createApp(supervisor.appDeps, supervisor, { logger: true });

  // 4. Start HTTP server.
  const { serve } = await import("@hono/node-server");
  const server = serve({ fetch: app.fetch, port, hostname: host });

  console.log(`lathe daemon listening on http://${host}:${port}`);

  // 5. Graceful shutdown.
  const shutdown = async (): Promise<void> => {
    console.log("shutting down…");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      await supervisor.stop();
    } catch {
      /* supervisor stop timeout — proceed anyway */
    }
    releaseLock();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};
