#!/usr/bin/env node
// ---------------------------------------------------------------------------
// @lathe/cli entry — the `lathe` bin (was the stale `meridian` bin at root).
//
// P00: only `lathe serve` is wired here. The run-driving commands (queue, run,
// status, accept, …) still live in @lathe/core's CLI and are reached via the
// ~/.meridian/bin/lathe wrapper until P05 cuts them over to the daemon client.
// ---------------------------------------------------------------------------

import { startDaemon } from "./serve.js";

const [command] = process.argv.slice(2);

if (command === "serve") {
  startDaemon();
} else {
  console.error(
    "lathe-cli (P00 skeleton): only `serve` is wired here. " +
      "Run-driving commands go through the @lathe/core CLI until the P05 cutover.",
  );
  process.exit(1);
}
