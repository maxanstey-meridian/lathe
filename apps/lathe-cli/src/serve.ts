// ---------------------------------------------------------------------------
// `lathe serve` — boot the daemon.
//
// P00 skeleton: real wiring (single-instance lock, the SQLite-backed
// readEventsSince from P01, the supervisor from P02) lands incrementally. For
// now it stands up the Hono app with stubbed handlers so the surface is live.
// ---------------------------------------------------------------------------

import { serve } from "@hono/node-server";
import { loadConfig } from "@lathe/core";
import { createApp, createSupervisor } from "@lathe/server";

export const startDaemon = (port = 4198): void => {
  const { config, paths } = loadConfig();
  const supervisor = createSupervisor(config, paths);
  const app = createApp(supervisor.appDeps, supervisor, { logger: true });
  serve({ fetch: app.fetch, port });
  console.log(`lathe daemon listening on http://127.0.0.1:${port}`);
};
