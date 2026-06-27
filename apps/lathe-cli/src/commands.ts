// ---------------------------------------------------------------------------
// @lathe/cli commands — the testable core behind the `lathe` bin.
//
// P05 cutover: mutating commands (enqueue, chain add, abort, accept, reject,
// and the queue add/drop aliases) go through the daemon — the single owner of
// run state — over the generated openapi-fetch client. Read commands (status,
// review, queue list, get, tail) stay local over the WAL Store for consistent
// snapshot reads.
//
// Everything here is parameterised over a CliEnv (daemon client + reachability
// probe + output sinks) so the commands can be driven in tests against a stub
// or an in-process app, with no process.exit and no network. index.ts is the
// thin entry that builds the real env and dispatches argv.
// ---------------------------------------------------------------------------

import type { paths } from "@lathe/contract";
import {
  loadConfig,
  buildRepo,
  systemClock,
  StoreAdapter,
  renderStatus,
  renderReview,
  renderQueue,
  renderJournalReplay,
  renderJournalEvent,
  fmtOutcomes,
} from "@lathe/core";
import { existsSync, statSync, watchFile, unwatchFile } from "node:fs";
import { resolve } from "node:path";
import { createDaemonClient, type DaemonClient } from "./client.js";

// ---------------------------------------------------------------------------
// CLI environment — the seams the commands need, injectable for tests.
// ---------------------------------------------------------------------------

export interface CliEnv {
  client: DaemonClient;
  isDaemonUp: () => Promise<boolean>;
  log: (line: string) => void;
  err: (line: string) => void;
}

// Probe daemon reachability over the generated client (GET /config) — no raw
// fetch. A refused connection rejects the promise; treat that as "down".
export const checkDaemon = async (client: DaemonClient): Promise<boolean> => {
  try {
    const { response } = await client.GET("/config");
    return response.ok;
  } catch {
    return false;
  }
};

// The real environment: client + reachability + console sinks.
export const makeEnv = (): CliEnv => {
  const { config } = loadConfig();
  const baseUrl = `http://${config.daemon.host}:${config.daemon.port}`;
  const client = createDaemonClient(baseUrl);
  return {
    client,
    isDaemonUp: () => checkDaemon(client),
    log: (line) => console.log(line),
    err: (line) => console.error(line),
  };
};

// ---------------------------------------------------------------------------
// Daemon call wrapper
// ---------------------------------------------------------------------------

// openapi-fetch returns { data, error, response }: on a 2xx `data` is the parsed
// success DTO; on a non-2xx `error` is the parsed error body and `response`
// carries the status. The contract declares only success responses, so `error`
// is typed `never` — we read it as unknown rather than casting the response.
const errorDetail = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object") {
    const e = error as { message?: unknown; error?: unknown };
    if (typeof e.message === "string") {
      return e.message;
    }
    if (typeof e.error === "string") {
      return e.error;
    }
  }
  return "";
};

// Run a mutating command against the daemon. fn issues the typed call; we map a
// 2xx to exit 0 (after onOk), and route failures through onErr for status-
// specific messages, falling back to a generic daemon-error line.
const runDaemon = async <T>(
  env: CliEnv,
  fn: (client: DaemonClient) => Promise<{ data?: T; error?: unknown; response: Response }>,
  onOk: (data: T) => void,
  onErr?: (status: number, detail: string) => boolean,
): Promise<number> => {
  if (!(await env.isDaemonUp())) {
    env.err("no daemon running — start `lathe serve` first");
    return 1;
  }

  const { data, error, response } = await fn(env.client);
  if (response.ok && data !== undefined) {
    onOk(data);
    return 0;
  }

  const detail = errorDetail(error);
  if (onErr?.(response.status, detail)) {
    return 1;
  }
  env.err(`daemon error (${response.status}): ${detail}`);
  return 1;
};

// ---------------------------------------------------------------------------
// Mutating commands — always go through the daemon
// ---------------------------------------------------------------------------

export const cmdEnqueue = (env: CliEnv, packetPath: string): Promise<number> => {
  if (!packetPath) {
    env.err("usage: lathe enqueue <packet.md>");
    return Promise.resolve(1);
  }
  const resolved = resolve(packetPath);
  if (!existsSync(resolved)) {
    env.err(`no such file: ${resolved}`);
    return Promise.resolve(1);
  }

  return runDaemon<paths["/runs"]["post"]["responses"]["202"]["content"]["application/json"]>(
    env,
    (client) => client.POST("/runs", { body: { packetPath: resolved } }),
    (data) => env.log(`enqueued: ${data.runId} (${data.status})`),
    (status) => {
      if (status === 400) {
        env.err("packet rejected — see rejected/");
        return true;
      }
      return false;
    },
  );
};

export const cmdChain = (env: CliEnv, dir: string): Promise<number> => {
  if (!dir) {
    env.err("usage: lathe chain add <dir>");
    return Promise.resolve(1);
  }
  const resolved = resolve(dir);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    env.err(`not a directory: ${resolved}`);
    return Promise.resolve(1);
  }

  return runDaemon<paths["/chains"]["post"]["responses"]["202"]["content"]["application/json"]>(
    env,
    (client) => client.POST("/chains", { body: { chainDir: resolved } }),
    (runs) => {
      for (const run of runs) {
        env.log(`enqueued: ${run.runId} (${run.status})`);
      }
    },
  );
};

export const cmdAbort = (env: CliEnv, runId: string): Promise<number> => {
  if (!runId) {
    env.err("usage: lathe abort <runId>");
    return Promise.resolve(1);
  }

  return runDaemon<
    paths["/runs/{runId}/abort"]["post"]["responses"]["201"]["content"]["application/json"]
  >(
    env,
    (client) => client.POST("/runs/{runId}/abort", { params: { path: { runId } } }),
    (data) => env.log(`aborted: ${data.runId} (${data.status})`),
    (status) => {
      if (status === 404) {
        env.err(`run ${runId} not found`);
        return true;
      }
      return false;
    },
  );
};

export const cmdAccept = (env: CliEnv, runId: string): Promise<number> => {
  if (!runId) {
    env.err("usage: lathe accept <runId>");
    return Promise.resolve(1);
  }

  return runDaemon<
    paths["/runs/{runId}/accept"]["post"]["responses"]["201"]["content"]["application/json"]
  >(
    env,
    (client) => client.POST("/runs/{runId}/accept", { params: { path: { runId } } }),
    (data) => env.log(`accepted: ${data.runId} (${data.status})`),
    (status, detail) => {
      if (status === 409) {
        // Daemon 409 body: "<runId> is not a chain tip — accept <tip> first".
        const match = detail.match(/accept (.+) first/);
        const chainTip = match ? match[1] : "a chain tip";
        env.err(`${runId} is not a chain tip — accept ${chainTip} first`);
        return true;
      }
      return false;
    },
  );
};

export const cmdReject = (env: CliEnv, runId: string, reason: string): Promise<number> => {
  if (!runId) {
    env.err("usage: lathe reject <runId> [reason]");
    return Promise.resolve(1);
  }

  return runDaemon<
    paths["/runs/{runId}/reject"]["post"]["responses"]["201"]["content"]["application/json"]
  >(
    env,
    (client) =>
      client.POST("/runs/{runId}/reject", {
        params: { path: { runId } },
        body: { reason: reason || "rejected" },
      }),
    (data) => env.log(`rejected: ${data.runId} (${data.status})`),
    (status) => {
      if (status === 404) {
        env.err(`run ${runId} not found`);
        return true;
      }
      return false;
    },
  );
};

// ---------------------------------------------------------------------------
// Read commands — stay local over the WAL Store
// ---------------------------------------------------------------------------

const openStore = () => {
  const { paths: configPaths } = loadConfig();
  const repo = buildRepo();
  const store = StoreAdapter.create(configPaths, repo, systemClock);
  return { configPaths, store };
};

export const cmdStatus = (env: CliEnv): number => {
  const { store } = openStore();
  env.log(renderStatus(store));
  return 0;
};

export const cmdReview = (env: CliEnv): number => {
  const { store } = openStore();
  env.log(renderReview(store));
  return 0;
};

// `queue` lists locally; `queue add`/`queue drop` are daemon aliases for
// enqueue/abort (abortRun archives a still-queued run), so they never mutate
// the Store behind the daemon's back.
export const cmdQueue = (env: CliEnv, args: string[]): Promise<number> => {
  const sub = args[0];
  if (sub === "add") {
    if (!args[1]) {
      env.err("usage: lathe queue add <packet.md>");
      return Promise.resolve(1);
    }
    return cmdEnqueue(env, args[1]);
  }
  if (sub === "drop") {
    if (!args[1]) {
      env.err("usage: lathe queue drop <runId>");
      return Promise.resolve(1);
    }
    return cmdAbort(env, args[1]);
  }
  const { store } = openStore();
  env.log(renderQueue(store));
  return Promise.resolve(0);
};

export const cmdGet = (env: CliEnv, runId: string): number => {
  if (!runId) {
    env.err("usage: lathe get <runId>");
    return 1;
  }
  const { store } = openStore();

  const meta = store.readMetaIfExists(runId);
  if (!meta) {
    env.err(`run ${runId} not found`);
    return 1;
  }

  env.log(`run: ${meta.runId}`);
  env.log(`  status:    ${meta.status}`);
  env.log(`  base:      ${meta.base}`);
  env.log(`  branch:    ${meta.branch}`);
  env.log(`  pass:      ${meta.attempt}`);
  env.log(`  worktree:  ${meta.worktree}`);
  if (meta.summary) {
    env.log(`  summary:   ${meta.summary}`);
  }

  const outcomes = fmtOutcomes(store, runId);
  if (outcomes) {
    env.log(`  outcomes: ${outcomes}`);
  }

  return 0;
};

export const cmdTail = (env: CliEnv, args: string[]): void => {
  const { configPaths, store } = openStore();

  const follow = !args.includes("--no-follow");
  const plain = args.includes("--plain");
  const explicit = args.find((a) => !a.startsWith("--"));
  const tailRunId = (target: string): void => {
    const replay = (): void => {
      if (existsSync(configPaths.journalFile(target))) {
        env.log(renderJournalReplay(store, target));
      }
    };

    if (!follow || plain || !process.stdout.isTTY) {
      if (!existsSync(configPaths.journalFile(target))) {
        if (!follow) {
          env.err(`no journal for ${target}`);
          return;
        }
        env.log(`run ${target} has not started — waiting for its journal…`);
      } else {
        env.log(renderJournalReplay(store, target));
      }
      if (!follow) {
        return;
      }
    } else {
      replay();
    }

    let printed = existsSync(configPaths.journalFile(target)) ? store.readJournal(target).length : 0;
    const flush = (): void => {
      if (!existsSync(configPaths.journalFile(target))) {
        return;
      }
      const events = store.readJournal(target);
      for (const e of events.slice(printed)) {
        env.log(renderJournalEvent(e));
      }
      printed = events.length;
    };
    watchFile(configPaths.journalFile(target), { interval: 1000 }, flush);
    process.on("SIGINT", () => {
      unwatchFile(configPaths.journalFile(target));
      process.exit(0);
    });
  };

  const target = explicit ?? store.readActiveRun()?.runId;
  if (!target) {
    if (!follow) {
      env.log("no active run");
      return;
    }

    env.log("no active run — waiting for one to start…");
    const poll = setInterval(() => {
      const next = store.readActiveRun()?.runId;
      if (!next) {
        return;
      }
      clearInterval(poll);
      env.log(`run ${next} became active — tailing…`);
      tailRunId(next);
    }, 1000);
    process.on("SIGINT", () => {
      clearInterval(poll);
      process.exit(0);
    });
    return;
  }

  tailRunId(target);
};

// ---------------------------------------------------------------------------
// Dispatch — returns an exit code; never calls process.exit (testable).
// `serve` and `tail` are handled by index.ts (they don't return an exit code).
// ---------------------------------------------------------------------------

export const usage = `lathe — sequential overnight executor of human-written specs

  lathe serve                  boot the daemon (always-on run engine + HTTP API)
  lathe enqueue <packet.md>    add a packet to the queue (via daemon)
  lathe chain add <dir>        stage a chain of packets (via daemon)
  lathe abort <runId>          abort a run (via daemon)
  lathe accept <runId>         accept a ready_for_review run (via daemon, chain-tip guarded)
  lathe reject <runId> [reason]  reject a run (via daemon)
  lathe status                 what is running / queued / parked + campaign convergence
  lathe review                 morning triage: terminal statuses, outcomes, questions
  lathe queue [add|drop]       list the queue (local) / add or drop a packet (via daemon)
  lathe get <runId>            show run details (local)
  lathe tail [runId]           live journal stream for a run (local)
`;

export const runCommand = async (env: CliEnv, command: string, args: string[]): Promise<number> => {
  switch (command) {
    case "--help":
    case "-h":
      env.log(usage);
      return 0;
    case "enqueue":
      return cmdEnqueue(env, args[0] ?? "");
    case "chain":
      if (args[0] !== "add") {
        env.err("usage: lathe chain add <dir>");
        return 1;
      }
      return cmdChain(env, args[1] ?? "");
    case "abort":
      return cmdAbort(env, args[0] ?? "");
    case "accept":
      return cmdAccept(env, args[0] ?? "");
    case "reject":
      return cmdReject(env, args[0] ?? "", args[1] ?? "");
    case "status":
      return cmdStatus(env);
    case "review":
      return cmdReview(env);
    case "queue":
      return cmdQueue(env, args);
    case "get":
      return cmdGet(env, args[0] ?? "");
    default:
      env.log(usage);
      return command ? 1 : 0;
  }
};
