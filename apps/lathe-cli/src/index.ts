#!/usr/bin/env node
// ---------------------------------------------------------------------------
// @lathe/cli entry — the `lathe` bin.
//
// Thin dispatcher: `serve` boots the daemon, `tail` opens a live journal stream
// (neither returns an exit code), everything else routes through runCommand,
// which returns an exit code. All command behaviour lives in commands.ts so it
// is testable without process.exit or a real daemon.
// ---------------------------------------------------------------------------

import { cmdTail, makeEnv, runCommand } from "./commands.js";

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);

  if (command === "serve") {
    const { startDaemon } = await import("./serve.js");
    await startDaemon();
    return;
  }

  if (command === "tail") {
    cmdTail(makeEnv(), args);
    return;
  }

  process.exit(await runCommand(makeEnv(), command ?? "", args));
};

main();
