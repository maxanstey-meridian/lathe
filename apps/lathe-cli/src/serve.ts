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
import {
  createApp,
  createSupervisor,
  acquireSingleInstanceLock,
  type AppDeps,
  type CreateAppOptions,
  type Supervisor,
} from "@lathe/server";
import { getRequestListener } from "@hono/node-server";
import type { Server } from "node:http";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

type SignalName = "SIGINT" | "SIGTERM";
type LockHandle = { server: Server; release: () => void };
type DaemonApp = { fetch: (req: Request) => Response | Promise<Response> };

const closeServer = (server: Server): Promise<void> =>
  new Promise<void>((resolve) => server.close(() => resolve()));

export type DaemonDeps = {
  loadConfig: () => { config: Config; paths: Paths };
  acquireSingleInstanceLock: (lockPath: string, port: number, host?: string) => Promise<LockHandle>;
  createSupervisor: (config: Config, paths: Paths) => Supervisor;
  createApp: (appDeps: AppDeps, supervisor: Supervisor, options?: CreateAppOptions) => DaemonApp;
  closeServer: (server: Server) => Promise<void>;
  onSignal: (signal: SignalName, handler: () => Promise<void>) => void;
  exit: (code: number) => never;
};

export const startDaemon = async (deps?: DaemonDeps, userPort?: number): Promise<void> => {
  const cfg = deps?.loadConfig() ?? loadConfig();
  const config = cfg.config;
  const paths = cfg.paths;
  const port = userPort ?? config.daemon.port;
  const host = config.daemon.host;

  // 0. Ensure state root exists (fresh install — lock + SQLite both need it).
  mkdirSync(paths.root, { recursive: true });

  // 1. Acquire the held socket lock.
  const lockPath = join(paths.root, "lathe.lock");
  const lock = deps?.acquireSingleInstanceLock ?? acquireSingleInstanceLock;
  const { server, release: releaseLock } = await lock(lockPath, port, host);

  // 2. Create supervisor (owns runDriver, journal tail, lifecycle methods).
  const supervisor = deps?.createSupervisor ?? createSupervisor;
  const sup = supervisor(config, paths);

  // 3. Build the Hono app: use supervisor's own bus (journal tail publishes here) + readEventsSince.
  const appFactory = deps?.createApp ?? createApp;
  const app = appFactory(sup.appDeps, sup, { logger: true, cors: true });

  // 4. Attach the request listener to the already-bound held server.
  server.on("request", getRequestListener(app.fetch, { hostname: host }));

  console.log(`lathe daemon listening on http://${host}:${port}`);

  // 5. Graceful shutdown.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      (deps?.exit ?? process.exit)(1);
    }
    shuttingDown = true;

    console.log("shutting down…");
    await (deps?.closeServer ?? closeServer)(server);
    try {
      await sup.stop();
    } catch {
      /* supervisor stop timeout — proceed anyway */
    }
    releaseLock();
    (deps?.exit ?? process.exit)(0);
  };

  const onSignal = deps?.onSignal ?? ((signal, handler) => process.on(signal, handler));
  onSignal("SIGINT", shutdown);
  onSignal("SIGTERM", shutdown);
};
