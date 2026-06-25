// ---------------------------------------------------------------------------
// `lathe serve` — boot the daemon.
//
// Lifecycle:
//   1. loadConfig() → config + paths (state root, db file, etc.)
//   2. acquireSingleInstanceLock(lockPath, port, host) → { server, release }
//      (the server is a bound socket held for daemon lifetime)
//   3. createSupervisor(config, paths) → Supervisor (owns runDriver, journal tail)
//   4. createApp(AppDeps from supervisor, supervisor, { logger }) → Hono app
//   5. Attach Hono request adapter to the held socket (already listening).
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
  const { server: lockServer, release: releaseLock } = await acquireSingleInstanceLock(lockPath, port, host);

  // 2. Create supervisor (owns runDriver, journal tail, lifecycle methods).
  const supervisor = createSupervisor(config, paths);

  // 3. Build the Hono app: use supervisor's own bus (journal tail publishes here) + readEventsSince.
  const app = createApp(supervisor.appDeps, supervisor, { logger: true });

  // 4. Attach Hono request adapter to the already-bound lock server.
  //    The lock server owns the port (exclusivity primitive) — we reuse it
  //    for HTTP so the daemon binds exactly one socket.
  const { getRequestListener } = await import("@hono/node-server");
  const requestListener = getRequestListener(app.fetch, { hostname: host });
  lockServer.on("request", requestListener);

  console.log(`lathe daemon listening on http://${host}:${port}`);

  // 5. Graceful shutdown.
  const shutdown = async (): Promise<void> => {
    console.log("shutting down…");
    await new Promise<void>((resolve) => lockServer.close(() => resolve()));
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
