#!/usr/bin/env node
// ---------------------------------------------------------------------------
// @lathe/cli entry — the `lathe` bin.
//
// P05 cutover: mutating commands go through the daemon (single owner of run
// state). Read commands stay local over the WAL Store.
//
// Mutating commands (enqueue, chain add, abort, accept, reject):
//   → POST to the daemon via openapi-fetch client.
//   → If no daemon running: fail loud with "start `lathe serve` first", exit 1.
//   → 409 on accept prints the chain tip and exits non-zero.
//
// Read commands (status, list, get, tail, review, queue):
//   → local over the WAL Store (consistent snapshot reads).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, statSync, watchFile, unwatchFile } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  loadConfig,
  buildRepo,
  systemClock,
  StoreAdapter,
  admitPacket,
  renderJournalEvent,
} from "@lathe/core";
import {
  renderStatus,
  renderReview,
  renderQueue,
  renderJournalReplay,
  fmtOutcomes,
} from "@lathe/core";
import { createDaemonClient } from "./client.js";
import type { paths } from "@lathe/contract";

// ---------------------------------------------------------------------------
// Daemon reachability check
// ---------------------------------------------------------------------------

const checkDaemon = async (): Promise<boolean> => {
  try {
    const { config } = loadConfig();
    const url = `http://${config.daemon.host}:${config.daemon.port}/config`;
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------------
// OpenAPI response — the contract spec only defines success responses,
// so openapi-fetch infers `error: never`. At runtime the response object
// has { data, error } where one is set. We assert the shape here.
// ---------------------------------------------------------------------------

type ApiResult<T> = { data: T | undefined; error: Response | undefined };

const asResult = <T>(res: { data?: T; error?: Response }): ApiResult<T> =>
  res as ApiResult<T>;

// ---------------------------------------------------------------------------
// Daemon client helpers
// ---------------------------------------------------------------------------

const withDaemon = async <T>(
  label: string,
  fn: (client: ReturnType<typeof createDaemonClient>) => Promise<ApiResult<T>>,
): Promise<number> => {
  if (!await checkDaemon()) {
    console.error("no daemon running — start `lathe serve` first");
    return 1;
  }

  const { config } = loadConfig();
  const baseUrl = `http://${config.daemon.host}:${config.daemon.port}`;
  const client = createDaemonClient(baseUrl);
  const result = await fn(client);

  if (result.data !== undefined) {
    return 0;
  }

  if (result.error) {
    const status = result.error.status;
    // Try to read error body for a human message.
    let detail = "";
    try {
      const body = await result.error.text();
      if (body) {
        try {
          const parsed = JSON.parse(body);
          detail = parsed.message ?? parsed.error ?? body;
        } catch {
          detail = body;
        }
      }
    } catch {
      /* ignore */
    }
    console.error(`daemon error (${status}): ${detail}`);
    return 1;
  }

  console.error(`unexpected ${label} response`);
  return 1;
};

// ---------------------------------------------------------------------------
// Mutating commands — always go through the daemon
// ---------------------------------------------------------------------------

const cmdEnqueue = async (packetPath: string): Promise<number> => {
  if (!packetPath) {
    console.error("usage: lathe enqueue <packet.md>");
    return 1;
  }

  const resolved = resolve(packetPath);
  if (!existsSync(resolved)) {
    console.error(`no such file: ${resolved}`);
    return 1;
  }

  return withDaemon<paths["/runs"]["post"]["responses"]["202"]["content"]["application/json"]>(
    "enqueue",
    async (client) => {
      const res = await client.POST("/runs", { body: { packetPath: resolved } });
      const r = asResult(res);
      if (r.error) {
        // 400 = packet rejected (handled by daemon handler)
        if (r.error.status === 400) {
          console.error("packet rejected — see rejected/");
          return { data: undefined, error: r.error };
        }
        return { data: undefined, error: r.error };
      }
      if (r.data) {
        console.log(`enqueued: ${r.data.runId} (${r.data.status})`);
      }
      return { data: r.data, error: undefined };
    },
  );
};

const cmdChain = async (dir: string): Promise<number> => {
  if (!dir) {
    console.error("usage: lathe chain add <dir>");
    return 1;
  }

  const resolved = resolve(dir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    console.error(`not a directory: ${resolved}`);
    return 1;
  }

  return withDaemon<paths["/chains"]["post"]["responses"]["202"]["content"]["application/json"]>(
    "chain",
    async (client) => {
      const res = await client.POST("/chains", { body: { chainDir: resolved } });
      const r = asResult(res);
      if (r.error) {
        return { data: undefined, error: r.error };
      }
      if (r.data) {
        for (const run of r.data) {
          console.log(`enqueued: ${run.runId} (${run.status})`);
        }
      }
      return { data: r.data, error: undefined };
    },
  );
};

const cmdAbort = async (runId: string): Promise<number> => {
  if (!runId) {
    console.error("usage: lathe abort <runId>");
    return 1;
  }

  return withDaemon<paths["/runs/{runId}/abort"]["post"]["responses"]["201"]["content"]["application/json"]>(
    "abort",
    async (client) => {
      const res = await client.POST("/runs/{runId}/abort", { params: { path: { runId } } });
      const r = asResult(res);
      if (r.error) {
        if (r.error.status === 404) {
          console.error(`run ${runId} not found`);
        }
        return { data: undefined, error: r.error };
      }
      if (r.data) {
        console.log(`aborted: ${r.data.runId} (${r.data.status})`);
      }
      return { data: r.data, error: undefined };
    },
  );
};

const cmdAccept = async (runId: string): Promise<number> => {
  if (!runId) {
    console.error("usage: lathe accept <runId>");
    return 1;
  }

  return withDaemon<paths["/runs/{runId}/accept"]["post"]["responses"]["201"]["content"]["application/json"]>(
    "accept",
    async (client) => {
      const res = await client.POST("/runs/{runId}/accept", { params: { path: { runId } } });
      const r = asResult(res);
      if (r.error) {
        if (r.error.status === 409) {
          // Parse chain tip from error body.
          let bodyText = "";
          try {
            bodyText = await r.error.text();
          } catch {
            /* ignore */
          }
          let msg = `${runId} is not a chain tip`;
          try {
            const parsed = JSON.parse(bodyText);
            msg = parsed.message ?? msg;
          } catch {
            msg = bodyText || msg;
          }
          const match = msg.match(/accept (.+) first/);
          const chainTip = match ? match[1] : "a chain tip";
          console.error(`${runId} is not a chain tip — accept ${chainTip} first`);
        }
        return { data: undefined, error: r.error };
      }
      if (r.data) {
        console.log(`accepted: ${r.data.runId} (${r.data.status})`);
      }
      return { data: r.data, error: undefined };
    },
  );
};

const cmdReject = async (runId: string, reason: string): Promise<number> => {
  if (!runId) {
    console.error("usage: lathe reject <runId> [reason]");
    return 1;
  }

  return withDaemon<paths["/runs/{runId}/reject"]["post"]["responses"]["201"]["content"]["application/json"]>(
    "reject",
    async (client) => {
      const res = await client.POST("/runs/{runId}/reject", {
        params: { path: { runId } },
        body: { reason: reason || "rejected" },
      });
      const r = asResult(res);
      if (r.error) {
        if (r.error.status === 404) {
          console.error(`run ${runId} not found`);
        }
        return { data: undefined, error: r.error };
      }
      if (r.data) {
        console.log(`rejected: ${r.data.runId} (${r.data.status})`);
      }
      return { data: r.data, error: undefined };
    },
  );
};

// ---------------------------------------------------------------------------
// Read commands — stay local over the WAL Store
// ---------------------------------------------------------------------------

const cmdStatus = (): number => {
  const { paths: configPaths } = loadConfig();
  const repo = buildRepo();
  const clock = systemClock;
  const store = StoreAdapter.create(configPaths, repo, clock);
  console.log(renderStatus(store));
  return 0;
};

const cmdReview = (): number => {
  const { paths: configPaths } = loadConfig();
  const repo = buildRepo();
  const clock = systemClock;
  const store = StoreAdapter.create(configPaths, repo, clock);
  console.log(renderReview(store));
  return 0;
};

const cmdQueue = (args: string[]): number => {
  const { paths: configPaths } = loadConfig();
  const repo = buildRepo();
  const clock = systemClock;
  const store = StoreAdapter.create(configPaths, repo, clock);

  const sub = args[0];
  if (sub === "add") {
    const file = args[1];
    if (!file) {
      console.error("usage: lathe queue add <packet.md>");
      return 1;
    }
    const resolved = resolve(file);
    if (!existsSync(resolved)) {
      console.error(`no such file: ${resolved}`);
      return 1;
    }
    const runId = basename(resolved).replace(/\.md$/, "");
    admitPacket(store, runId, readFileSync(resolved, "utf-8"));

    if (existsSync(join(configPaths.queueDir, `${runId}.md`))) {
      console.log(`admitted: ${runId}`);
      return 0;
    }
    console.error(`packet REJECTED — see ${configPaths.rejectedDir}`);
    return 1;
  }

  if (sub === "drop") {
    const runId = args[1];
    if (!runId) {
      console.error("usage: lathe queue drop <runId>");
      return 1;
    }
    const present = existsSync(join(configPaths.queueDir, `${runId}.md`));
    store.archiveQueue(runId);
    console.log(present ? `dropped: ${runId}` : `not in queue: ${runId}`);
    return 0;
  }

  console.log(renderQueue(store));
  return 0;
};

const cmdGet = (runId: string): number => {
  if (!runId) {
    console.error("usage: lathe get <runId>");
    return 1;
  }

  const { paths: configPaths } = loadConfig();
  const repo = buildRepo();
  const clock = systemClock;
  const store = StoreAdapter.create(configPaths, repo, clock);

  const meta = store.readMetaIfExists(runId);
  if (!meta) {
    console.error(`run ${runId} not found`);
    return 1;
  }

  console.log(`run: ${meta.runId}`);
  console.log(`  status:    ${meta.status}`);
  console.log(`  base:      ${meta.base}`);
  console.log(`  branch:    ${meta.branch}`);
  console.log(`  pass:      ${meta.attempt}`);
  console.log(`  worktree:  ${meta.worktree}`);
  if (meta.summary) {
    console.log(`  summary:   ${meta.summary}`);
  }

  const outcomes = fmtOutcomes(store, runId);
  if (outcomes) {
    console.log(`  outcomes: ${outcomes}`);
  }

  return 0;
};

const cmdTail = (args: string[]): number => {
  const { paths: configPaths } = loadConfig();
  const repo = buildRepo();
  const clock = systemClock;
  const store = StoreAdapter.create(configPaths, repo, clock);

  const follow = !args.includes("--no-follow");
  const plain = args.includes("--plain");
  const explicit = args.find((a) => !a.startsWith("--"));

  let runId = explicit;
  if (!runId) {
    const active = store.readActiveRun();
    runId = active?.runId;
  }

  if (!runId) {
    console.log("no active run");
    return 1;
  }

  if (!follow || plain || !process.stdout.isTTY) {
    if (!existsSync(configPaths.journalFile(runId))) {
      if (!follow) {
        console.error(`no journal for ${runId}`);
        return 1;
      }
      console.log(`run ${runId} has not started — waiting for its journal…`);
    } else {
      console.log(renderJournalReplay(store, runId));
    }
    if (!follow) return 0;

    let printed = existsSync(configPaths.journalFile(runId)) ? store.readJournal(runId).length : 0;
    const flush = () => {
      if (!existsSync(configPaths.journalFile(runId))) return;
      const events = store.readJournal(runId);
      for (const e of events.slice(printed)) {
        console.log(renderJournalEvent(e));
      }
      printed = events.length;
    };
    watchFile(configPaths.journalFile(runId), { interval: 1000 }, flush);
    process.on("SIGINT", () => {
      unwatchFile(configPaths.journalFile(runId));
      process.exit(0);
    });
    return -1;
  }

  if (existsSync(configPaths.journalFile(runId))) {
    console.log(renderJournalReplay(store, runId));
  }

  let printed = existsSync(configPaths.journalFile(runId)) ? store.readJournal(runId).length : 0;
  const flush = () => {
    if (!existsSync(configPaths.journalFile(runId))) return;
    const events = store.readJournal(runId);
    for (const e of events.slice(printed)) {
      console.log(renderJournalEvent(e));
    }
    printed = events.length;
  };
  watchFile(configPaths.journalFile(runId), { interval: 1000 }, flush);
  process.on("SIGINT", () => {
    unwatchFile(configPaths.journalFile(runId));
    process.exit(0);
  });
  return -1;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const usage = `lathe — sequential overnight executor of human-written specs

  lathe serve                  boot the daemon (always-on run engine + HTTP API)
  lathe enqueue <packet.md>    add a packet to the queue (via daemon)
  lathe chain add <dir>        stage a chain of packets (via daemon)
  lathe abort <runId>          abort a run (via daemon)
  lathe accept <runId>         accept a ready_for_review run (via daemon, chain-tip guarded)
  lathe reject <runId> [reason]  reject a run (via daemon)
  lathe status                 what is running / queued / parked + campaign convergence
  lathe review                 morning triage: terminal statuses, outcomes, questions
  lathe queue [add|drop]       list the queue / add or drop a packet (local)
  lathe get <runId>            show run details (local)
  lathe tail [runId]           live journal stream for a run (local)
`;

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "serve": {
      const { startDaemon } = await import("./serve.js");
      startDaemon();
      return;
    }
    case "enqueue":
      process.exit(await cmdEnqueue(args[0] ?? ""));
      break;
    case "chain":
      process.exit(await cmdChain(args[0] ?? ""));
      break;
    case "abort":
      process.exit(await cmdAbort(args[0] ?? ""));
      break;
    case "accept":
      process.exit(await cmdAccept(args[0] ?? ""));
      break;
    case "reject":
      process.exit(await cmdReject(args[0] ?? "", args[1] ?? ""));
      break;
    case "status":
      process.exit(cmdStatus());
      break;
    case "review":
      process.exit(cmdReview());
      break;
    case "queue":
      process.exit(cmdQueue(args));
      break;
    case "get":
      process.exit(cmdGet(args[0] ?? ""));
      break;
    case "tail":
      cmdTail(args);
      return;
    default:
      console.log(usage);
      process.exit(command ? 1 : 0);
  }
};

main();
