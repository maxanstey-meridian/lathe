// ---------------------------------------------------------------------------
// `lathe serve` — boot the daemon.
//
// Lifecycle:
//   1. loadConfig() → config + paths (state root, db file, etc.)
//   2. acquireSingleInstanceLock(paths.stateRoot/lock) → release fn
//   3. createSupervisor(config, paths) → Supervisor (owns runDriver, journal tail)
//   4. createApp(AppDeps from supervisor, supervisor, { logger }) → Hono app
//   5. @hono/node-server serve on configured port (default 4198)
//
// Shutdown (SIGINT/SIGTERM):
//   stop supervisor (→ abort runDriver, await exit) → release lock → exit(0)
// ---------------------------------------------------------------------------

import { serve } from "@hono/node-server";
import { loadConfig } from "@lathe/core";
import {
  createApp,
  createEventBus,
  createSupervisor,
  acquireSingleInstanceLock,
} from "@lathe/server";
import { join } from "node:path";

const DEFAULT_DAEMON_PORT = 4198;
const LOCK_FILE = "lathe.lock";

export const startDaemon = (port = DEFAULT_DAEMON_PORT): void => {
  const { config, paths } = loadConfig();

  // 1. Acquire single-instance lock. Throws DaemonAlreadyRunningError if live.
  const lockPath = join(paths.root, LOCK_FILE);
  const releaseLock = acquireSingleInstanceLock(lockPath);

  // 2. Create supervisor (owns runDriver, journal tail, lifecycle methods).
  const supervisor = createSupervisor(config, paths);

  // 3. Build the Hono app: bus + readEventsSince from supervisor, supervisor as handler target.
  const bus = createEventBus();
  const app = createApp(
    { bus, readEventsSince: supervisor.appDeps.readEventsSince },
    supervisor,
    { logger: true },
  );

  // 4. Start HTTP server.
  const server = serve({ fetch: app.fetch, port });

  console.log(`lathe daemon listening on http://127.0.0.1:${port}`);

  // 5. Graceful shutdown.
  const shutdown = (): void => {
    console.log("shutting down…");
    server.close();
    supervisor.stop().catch(() => {});
    releaseLock();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};
