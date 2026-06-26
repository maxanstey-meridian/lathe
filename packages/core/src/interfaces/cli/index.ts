#!/usr/bin/env node
// ---------------------------------------------------------------------------
// meridian CLI entry point (ARCHITECTURE §1, §3.4).
//
// The thin outer shell: load + validate config (the single env boundary, §14),
// construct the read-side adapters, bind the side-effectful commands to the
// composition root, dispatch, and exit. All wiring lives in composition.ts; all
// parsing lives in dispatch.ts.
// ---------------------------------------------------------------------------

import { loadConfig } from "../../config/config.js";
import { systemClock } from "../../infrastructure/clock.js";
import { StoreAdapter } from "../../infrastructure/store.js";
import { buildRepo, runDriver, convergeOnce, superReviewOnce, openPlanner } from "./composition.js";
import { dispatch, type CliDeps } from "./dispatch.js";
import { openTail } from "./tail.js";

const { config, paths } = loadConfig();
const clock = systemClock;
const repo = buildRepo();
const store = StoreAdapter.create(paths, repo, clock);

const deps: CliDeps = {
  config,
  paths,
  store,
  repo,
  clock,
  openPlanner: () => openPlanner(paths),
  runDriver: () => runDriver(config, paths),
  convergeOnce: (runId) => convergeOnce(config, paths, runId),
  superReviewOnce: (runId) => superReviewOnce(config, paths, runId),
  openTail: (runId, autoAdvance) => openTail(config, paths, runId, autoAdvance),
};

dispatch(process.argv.slice(2), deps)
  .then((code) => {
    if (code >= 0) {
      process.exit(code);
    }
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
