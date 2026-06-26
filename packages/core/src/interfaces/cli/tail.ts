// `meridian tail` on a TTY: the Ink split-pane UI (CONTRACT X3). Read-only —
// constructs a Store + the SSE Events subscription and hands them to the
// renderer, which polls the run's files and the live feed. Subscribing to the
// serve instance's SSE is best-effort: if no driver is up, the connection errors
// silently and the UI degrades to journal-only polling. Returns -1 (Ink owns the
// terminal until 'q').
//
// Extracted from composition.ts to keep it free of .tsx transitive dependencies.

import { babyContextBudget } from "../../config/config.js";
import type { Paths } from "../../config/paths.js";
import type { Config } from "../../config/schemas.js";
import { systemClock } from "../../infrastructure/clock.js";
import { createEvents } from "../../infrastructure/opencode/events.js";
import { StoreAdapter } from "../../infrastructure/store.js";
import { runTailUi } from "../tui/tail-ui.js";
import { buildRepo } from "./composition.js";

export const openTail = (
  config: Config,
  paths: Paths,
  runId: string,
  autoAdvance: boolean,
): number => {
  const clock = systemClock;
  const repo = buildRepo();
  const store = StoreAdapter.create(paths, repo, clock);
  const events = createEvents(config);
  runTailUi({
    store,
    budget: babyContextBudget(config),
    subscribe: events.subscribe,
    runId,
    daddyDirectory: paths.root,
    autoAdvance,
  });
  return -1;
};
