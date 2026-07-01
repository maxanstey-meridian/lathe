import { deepEqual, equal, ok } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createEventBus, type Supervisor } from "@lathe/server";
import { Config as ConfigSchema, makePaths } from "@lathe/core";
import { createDaemonClient } from "../src/client.js";
import {
  checkDaemon,
  cmdAbort,
  cmdAccept,
  cmdAnswer,
  cmdEnqueue,
  cmdReject,
  cmdGet,
  cmdQueue,
  cmdReview,
  cmdStatus,
  cmdTail,
  runCommand,
  type CliEnv,
  type TailDeps,
} from "../src/commands.js";

// ---------------------------------------------------------------------------
// Stub daemon — routes openapi-fetch calls to a canned responder, no network.
// ---------------------------------------------------------------------------

const stubClient = (responder: (req: Request) => Response | Promise<Response>) => {
  const fetchImpl: typeof fetch = (input, init) => {
    const req = input instanceof Request ? input : new Request(input as URL | string, init);
    return Promise.resolve(responder(req));
  };
  return createDaemonClient("http://daemon", fetchImpl);
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

interface Harness {
  env: CliEnv;
  logs: string[];
  errs: string[];
  paths: string[];
}

const harness = (responder: (req: Request) => Response | Promise<Response>, up = true): Harness => {
  const logs: string[] = [];
  const errs: string[] = [];
  const paths: string[] = [];
  const env: CliEnv = {
    client: stubClient((req) => {
      paths.push(new URL(req.url).pathname);
      return responder(req);
    }),
    isDaemonUp: () => Promise.resolve(up),
    log: (line) => logs.push(line),
    err: (line) => errs.push(line),
  };
  return { env, logs, errs, paths };
};

const summary = (runId: string, status: string) => ({
  runId,
  campaignId: runId,
  packet: runId,
  status,
  pass: 1,
  turn: 0,
  contextTokens: 0,
  contextWindow: 0,
  isChainTip: true,
  startedAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

const statusSnapshot = () => ({
  activeRun: {
    runId: "active-run",
    outcomes: "1/2 done, 1 in progress",
    gateLatched: null,
    recentEvents: [{ at: "2026-01-01T12:34:56Z", event: "thinking" }],
  },
  queued: [{ runId: "queued-run" }],
  parked: [],
  campaigns: [],
  staged: [],
});

const detail = (runId: string) => ({
  ...summary(runId, "paused"),
  base: "main",
  branch: `meridian/${runId}`,
  worktreePath: `/tmp/${runId}`,
  parentRunId: null,
  expectedSurface: [],
  lastVerdict: null,
  outcomes: "0/1 done, 1 blocked",
  blockedReason: "human_decision",
  blockedQuestion: "Which target branch?",
});

const withTempFile = (fn: (path: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-cli-"));
  const file = join(dir, "20260101-000000-x.md");
  writeFileSync(file, "---\n---\n");
  return fn(file).finally(() => rmSync(dir, { recursive: true, force: true }));
};

const withTempDir = (fn: (path: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-chain-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
};

const tailDeps = (overrides: Partial<TailDeps> = {}): TailDeps => ({
  paths: { journalFile: (runId) => join(tmpdir(), `missing-${runId}.jsonl`) },
  store: {
    readActiveRun: () => undefined,
    readActiveConvergence: () => undefined,
    readJournal: () => [],
  },
  openTail: () => 0,
  stdoutIsTTY: () => false,
  watchJournal: () => () => {},
  startPolling: () => () => {},
  onSigint: () => {},
  exit: (code) => {
    throw new Error(`exit(${code})`);
  },
  ...overrides,
});

// ---------------------------------------------------------------------------
// Daemon routing + response handling
// ---------------------------------------------------------------------------

test("cmdEnqueue: posts to the daemon and reports the enqueued run", async () => {
  await withTempFile(async (file) => {
    const h = harness(() => jsonResponse(202, summary("20260101-000000-x", "queued")));
    const code = await cmdEnqueue(h.env, file);
    equal(code, 0);
    ok(h.paths.includes("/runs"), "hit POST /runs");
    ok(
      h.logs.some((l) => l.includes("enqueued: 20260101-000000-x")),
      h.logs.join("|"),
    );
  });
});

test("cmdEnqueue: a missing file fails locally without contacting the daemon", async () => {
  const h = harness(() => jsonResponse(202, summary("x", "queued")));
  const code = await cmdEnqueue(h.env, "/no/such/packet.md");
  equal(code, 1);
  equal(h.paths.length, 0, "daemon not contacted");
  ok(h.errs.some((e) => e.includes("no such file")));
});

test("cmdEnqueue: a 400 surfaces a 'packet rejected' message", async () => {
  await withTempFile(async (file) => {
    const h = harness(() => jsonResponse(400, { code: "invalid_packet", message: "bad packet" }));
    const code = await cmdEnqueue(h.env, file);
    equal(code, 1);
    ok(
      h.errs.some((e) => e.includes("packet rejected")),
      h.errs.join("|"),
    );
  });
});

test("cmdAbort: a 404 reports the run as not found", async () => {
  const h = harness(() => jsonResponse(404, { code: "not_found", message: "nope" }));
  const code = await cmdAbort(h.env, "missing-run");
  equal(code, 1);
  ok(
    h.errs.some((e) => e.includes("run missing-run not found")),
    h.errs.join("|"),
  );
});

test("cmdAnswer: success posts the answer and reports the requeued run", async () => {
  let body: { answer?: string } | undefined;
  const h = harness(async (req) => {
    body = await req.json() as { answer?: string };
    return jsonResponse(201, summary("blocked-run", "queued"));
  });
  const code = await cmdAnswer(h.env, "blocked-run", "go ahead");
  equal(code, 0);
  ok(h.paths.includes("/runs/blocked-run/answer"), "hit POST /runs/{runId}/answer");
  equal(body?.answer, "go ahead");
  ok(
    h.logs.some((l) => l.includes("answered: blocked-run (queued)")),
    h.logs.join("|"),
  );
});

test("cmdAnswer: a 409 surfaces the not-answerable reason", async () => {
  const h = harness(() =>
    jsonResponse(409, {
      code: "not_answerable",
      message: "run r is not parked (status: running)",
    }),
  );
  const code = await cmdAnswer(h.env, "r", "go ahead");
  equal(code, 1);
  ok(
    h.errs.some((e) => e.includes("not parked")),
    h.errs.join("|"),
  );
});

test("cmdAccept: a 409 names the chain tip to accept first", async () => {
  const h = harness(() =>
    jsonResponse(409, {
      code: "chain_tip_required",
      message: "parent is not a chain tip — accept the-tip first",
    }),
  );
  const code = await cmdAccept(h.env, "parent");
  equal(code, 1);
  ok(
    h.errs.some((e) => e.includes("accept the-tip first")),
    h.errs.join("|"),
  );
});

test("cmdAccept: a 409 with code accept_refused reports refusal", async () => {
  const h = harness(() =>
    jsonResponse(409, {
      code: "accept_refused",
      message: "accept parent refused",
    }),
  );
  const code = await cmdAccept(h.env, "parent");
  equal(code, 1);
  ok(
    h.errs.some((e) => e.includes("refused — do not accept")),
    h.errs.join("|"),
  );
});

test("cmdAccept: success reports the accepted run", async () => {
  const h = harness(() => jsonResponse(201, summary("tip", "accepted")));
  const code = await cmdAccept(h.env, "tip");
  equal(code, 0);
  ok(
    h.logs.some((l) => l.includes("accepted: tip")),
    h.logs.join("|"),
  );
});

test("cmdReject: success reports the rejected run", async () => {
  const h = harness(() => jsonResponse(201, summary("r", "paused")));
  const code = await cmdReject(h.env, "r", "wrong scope");
  equal(code, 0);
  ok(
    h.logs.some((l) => l.includes("rejected: r")),
    h.logs.join("|"),
  );
});

test("mutating commands fail loud when the daemon is down", async () => {
  const h = harness(() => jsonResponse(201, summary("x", "aborted")), false);
  const code = await cmdAbort(h.env, "x");
  equal(code, 1);
  equal(h.paths.length, 0, "daemon not contacted when down");
  ok(
    h.errs.some((e) => e.includes("no daemon running")),
    h.errs.join("|"),
  );
});

test("checkDaemon: true on 200, false on a non-2xx, false when fetch rejects", async () => {
  equal(
    await checkDaemon(stubClient(() => jsonResponse(200, { models: {}, thresholds: {} }))),
    true,
  );
  equal(await checkDaemon(stubClient(() => jsonResponse(503, {}))), false);
  const refused = createDaemonClient("http://daemon", () =>
    Promise.reject(new Error("ECONNREFUSED")),
  );
  equal(await checkDaemon(refused), false);
});

test("cmdStatus: reads status through the daemon", async () => {
  const h = harness((req) => {
    if (new URL(req.url).pathname === "/status") {
      return jsonResponse(200, statusSnapshot());
    }
    return jsonResponse(200, { models: {}, thresholds: {} });
  });
  const code = await cmdStatus(h.env);
  equal(code, 0);
  ok(h.paths.includes("/status"), "hit GET /status");
  ok(h.logs.some((line) => line.includes("ACTIVE: active-run")), h.logs.join("|"));
  ok(h.logs.some((line) => line.includes("queued: queued-run")), h.logs.join("|"));
});

test("cmdReview: reads review through the daemon", async () => {
  const h = harness((req) => {
    if (new URL(req.url).pathname === "/review") {
      return jsonResponse(200, {
        runs: [{
          runId: "ready-run",
          status: "ready_for_review",
          outcomes: "2/2 done",
          branch: "meridian/ready-run",
          repo: "/repo",
          base: "main",
          blockedQuestion: null,
        }],
      });
    }
    return jsonResponse(200, { models: {}, thresholds: {} });
  });
  const code = await cmdReview(h.env);
  equal(code, 0);
  ok(h.paths.includes("/review"), "hit GET /review");
  ok(h.logs.some((line) => line.includes("ready-run")), h.logs.join("|"));
});

test("cmdQueue: lists queue through the daemon", async () => {
  const h = harness((req) => {
    if (new URL(req.url).pathname === "/status") {
      return jsonResponse(200, statusSnapshot());
    }
    return jsonResponse(200, { models: {}, thresholds: {} });
  });
  const code = await cmdQueue(h.env, []);
  equal(code, 0);
  ok(h.paths.includes("/status"), "queue list hit GET /status");
  ok(h.logs.some((line) => line.includes("1. queued-run")), h.logs.join("|"));
});

test("cmdGet: reads run details through the daemon", async () => {
  const h = harness((req) => {
    if (new URL(req.url).pathname === "/runs/run-detail") {
      return jsonResponse(200, detail("run-detail"));
    }
    return jsonResponse(200, { models: {}, thresholds: {} });
  });
  const code = await cmdGet(h.env, "run-detail");
  equal(code, 0);
  ok(h.paths.includes("/runs/run-detail"), "hit GET /runs/{runId}");
  ok(h.logs.some((line) => line.includes("run: run-detail")), h.logs.join("|"));
  ok(h.logs.some((line) => line.includes("outcomes: 0/1 done")), h.logs.join("|"));
  ok(h.logs.some((line) => line.includes("question: Which target branch?")), h.logs.join("|"));
});

test("cmdGet: a 404 reports the run as not found", async () => {
  const h = harness((req) => {
    if (new URL(req.url).pathname === "/runs/missing") {
      return jsonResponse(404, { code: "not_found", message: "missing" });
    }
    return jsonResponse(200, { models: {}, thresholds: {} });
  });
  const code = await cmdGet(h.env, "missing");
  equal(code, 1);
  ok(h.errs.some((line) => line.includes("run missing not found")), h.errs.join("|"));
});

test("runCommand: --help prints usage and exits 0", async () => {
  const h = harness(() => jsonResponse(200, { models: {}, thresholds: {} }));
  const code = await runCommand(h.env, "--help", []);
  equal(code, 0);
  ok(h.logs.some((line) => line.includes("lathe — sequential overnight executor")), h.logs.join("|"));
});

// ---------------------------------------------------------------------------
// Dispatch — chain subcommand + queue aliases route through the daemon
// ---------------------------------------------------------------------------

test("chain: 'chain add <dir>' routes the directory (not 'add') to the daemon", async () => {
  await withTempDir(async (dir) => {
    const h = harness(() => jsonResponse(202, [summary("c1", "queued")]));
    const code = await runCommand(h.env, "chain", ["add", dir]);
    equal(code, 0);
    ok(h.paths.includes("/chains"), "hit POST /chains");
    ok(
      h.logs.some((l) => l.includes("enqueued: c1")),
      h.logs.join("|"),
    );
  });
});

test("chain: legacy 'chain <dir>' (no 'add' subcommand) is rejected with usage", async () => {
  await withTempDir(async (dir) => {
    const h = harness(() => jsonResponse(202, []));
    const code = await runCommand(h.env, "chain", [dir]);
    equal(code, 1);
    equal(h.paths.length, 0, "daemon not contacted for a malformed chain command");
    ok(
      h.errs.some((e) => e.includes("usage: lathe chain add <dir>")),
      h.errs.join("|"),
    );
  });
});

test("queue add: routes through the daemon (POST /runs), not the local Store", async () => {
  await withTempFile(async (file) => {
    const h = harness(() => jsonResponse(202, summary("q", "queued")));
    const code = await runCommand(h.env, "queue", ["add", file]);
    equal(code, 0);
    ok(h.paths.includes("/runs"), "queue add hit POST /runs");
    ok(
      h.logs.some((l) => l.includes("enqueued")),
      h.logs.join("|"),
    );
  });
});

test("queue drop: routes through the daemon abort endpoint", async () => {
  const h = harness(() => jsonResponse(201, summary("d", "aborted")));
  const code = await runCommand(h.env, "queue", ["drop", "d"]);
  equal(code, 0);
  ok(
    h.paths.some((p) => p.endsWith("/abort")),
    `queue drop hit abort: ${h.paths.join(",")}`,
  );
});

test("queue drop: missing runId is rejected with usage, no daemon call", async () => {
  const h = harness(() => jsonResponse(201, summary("d", "aborted")));
  const code = await runCommand(h.env, "queue", ["drop"]);
  equal(code, 1);
  equal(h.paths.length, 0);
  ok(
    h.errs.some((e) => e.includes("usage: lathe queue drop <runId>")),
    h.errs.join("|"),
  );
});

test("answer: dispatch joins the decision words and routes through the daemon", async () => {
  let body: { answer?: string } | undefined;
  const h = harness(async (req) => {
    body = await req.json() as { answer?: string };
    return jsonResponse(201, summary("r", "queued"));
  });
  const code = await runCommand(h.env, "answer", ["r", "go", "ahead"]);
  equal(code, 0);
  ok(h.paths.includes("/runs/r/answer"), "answer hit POST /runs/{runId}/answer");
  equal(body?.answer, "go ahead");
});

test("tail: TTY follow opens the Ink tail UI for an explicit run", () => {
  const h = harness(() => jsonResponse(200, {}));
  const opened: Array<{ runId: string; autoAdvance: boolean }> = [];

  cmdTail(
    h.env,
    ["run-1"],
    tailDeps({
      stdoutIsTTY: () => true,
      openTail: (runId, autoAdvance) => {
        opened.push({ runId, autoAdvance });
        return -1;
      },
    }),
  );

  deepEqual(opened, [{ runId: "run-1", autoAdvance: false }]);
});

test("tail: --plain keeps the plain journal stream instead of opening Ink", () => {
  const h = harness(() => jsonResponse(200, {}));
  let opened = false;
  let watched = false;

  cmdTail(
    h.env,
    ["--plain", "run-1"],
    tailDeps({
      stdoutIsTTY: () => true,
      openTail: () => {
        opened = true;
        return -1;
      },
      watchJournal: () => {
        watched = true;
        return () => {};
      },
    }),
  );

  equal(opened, false);
  equal(watched, true);
  ok(h.logs.some((l) => l.includes("waiting for its journal")), h.logs.join("|"));
});

test("tail: no active run waits and then opens TTY tail with auto-advance", () => {
  const h = harness(() => jsonResponse(200, {}));
  const opened: Array<{ runId: string; autoAdvance: boolean }> = [];
  let active = false;

  cmdTail(
    h.env,
    [],
    tailDeps({
      store: {
        readActiveRun: () =>
          active
            ? {
                runId: "run-2",
                runDir: "/runs/run-2",
                worktree: "/worktrees/run-2",
                babySessionId: "baby",
                startedAt: "2026-01-01T00:00:00Z",
              }
            : undefined,
        readActiveConvergence: () => undefined,
        readJournal: () => [],
      },
      stdoutIsTTY: () => true,
      startPolling: (poll) => {
        active = true;
        poll();
        return () => {};
      },
      openTail: (runId, autoAdvance) => {
        opened.push({ runId, autoAdvance });
        return -1;
      },
    }),
  );

  ok(h.logs.some((l) => l.includes("waiting for one to start")), h.logs.join("|"));
  ok(h.logs.some((l) => l.includes("run run-2 became active")), h.logs.join("|"));
  deepEqual(opened, [{ runId: "run-2", autoAdvance: true }]);
});

// ---------------------------------------------------------------------------
// startDaemon — runtime shutdown lifecycle
// ---------------------------------------------------------------------------

type SignalName = "SIGINT" | "SIGTERM";

class ExitCalled extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
    this.name = "ExitCalled";
  }
}

const fakeSupervisor = (order: string[], config = ConfigSchema.parse({})): Supervisor => ({
  appDeps: {
    bus: createEventBus(),
    readEventsSince: () => [],
  },
  config,
  stop: async () => {
    order.push("supervisor.stop");
  },
  enqueueRun: () => "run",
  enqueueChain: () => {},
  listRuns: () => [],
  getRun: () => undefined,
  abortRun: () => {},
  answerRun: () => {},
  acceptRun: () => 0,
  rejectRun: () => {},
  isChainTip: () => true,
  lastVerdict: () => null,
  listStaged: () => [],
  outcomes: () => "",
  getStatus: () => ({ activeRun: null, queued: [], parked: [], campaigns: [], staged: [] }),
  getReview: () => ({ runs: [] }),
});

test("startDaemon: shutdown fires server.close → supervisor.stop → releaseLock → exit(0)", async () => {
  const port = 43123;
  const dir = mkdtempSync(join(tmpdir(), "lathe-serve-"));
  const lockPath = join(dir, "lathe.lock");
  const server = createServer();

  const order: string[] = [];
  const signalHandlers: Partial<Record<SignalName, () => Promise<void>>> = {};
  let lockArgs: { lockPath: string; port: number; host?: string } | undefined;
  let supervisor: Supervisor | undefined;
  let released = false;
  let exited = false;

  try {
    const { startDaemon } = await import("../src/serve.js");
    await startDaemon({
      loadConfig: () => ({
        config: { ...ConfigSchema.parse({}), daemon: { port, host: "127.0.0.1" } },
        paths: makePaths(dir),
      }),
      acquireSingleInstanceLock: async (path, daemonPort, host) => {
        lockArgs = { lockPath: path, port: daemonPort, host };
        return {
          server,
          release: () => {
            order.push("releaseLock");
            released = true;
          },
        };
      },
      createSupervisor: (config, paths) => {
        equal(paths.root, dir);
        const sup = fakeSupervisor(order, config);
        supervisor = sup;
        return sup;
      },
      closeServer: async (heldServer) => {
        equal(heldServer, server);
        order.push("server.close");
      },
      onSignal: (signal, handler) => {
        signalHandlers[signal] = handler;
      },
      exit: (code) => {
        order.push(`exit(${code})`);
        exited = true;
        throw new ExitCalled(code);
      },
    });

    equal(lockArgs?.lockPath, lockPath);
    equal(lockArgs?.port, port);
    equal(lockArgs?.host, "127.0.0.1");
    equal(server.listenerCount("request"), 1, "Hono request listener is attached to the held server");
    ok(signalHandlers.SIGINT, "SIGINT handler registered");
    ok(signalHandlers.SIGTERM, "SIGTERM handler registered");

    try {
      await signalHandlers.SIGINT?.();
    } catch (err) {
      if (!(err instanceof ExitCalled)) throw err;
      equal(err.code, 0);
    }
  } finally {
    if (!exited && supervisor) await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }

  deepEqual(order, ["server.close", "supervisor.stop", "releaseLock", "exit(0)"]);
  ok(released, "lock was released");
  ok(exited, "process.exit was called");
});

test("startDaemon: threads configured host into the held lock and shuts down on SIGTERM", async () => {
  const port = 43124;
  const dir = mkdtempSync(join(tmpdir(), "lathe-serve-host-"));
  const server = createServer();

  const order: string[] = [];
  const signalHandlers: Partial<Record<SignalName, () => Promise<void>>> = {};
  let lockArgs: { lockPath: string; port: number; host?: string } | undefined;
  let supervisor: Supervisor | undefined;
  let exited = false;

  try {
    const { startDaemon } = await import("../src/serve.js");
    await startDaemon({
      loadConfig: () => ({
        config: { ...ConfigSchema.parse({}), daemon: { port, host: "0.0.0.0" } },
        paths: makePaths(dir),
      }),
      acquireSingleInstanceLock: async (path, daemonPort, host) => {
        lockArgs = { lockPath: path, port: daemonPort, host };
        return {
          server,
          release: () => {
            order.push("releaseLock");
          },
        };
      },
      createSupervisor: (config, paths) => {
        equal(paths.root, dir);
        const sup = fakeSupervisor(order, config);
        supervisor = sup;
        return sup;
      },
      closeServer: async (heldServer) => {
        equal(heldServer, server);
        order.push("server.close");
      },
      onSignal: (signal, handler) => {
        signalHandlers[signal] = handler;
      },
      exit: (code) => {
        order.push(`exit(${code})`);
        exited = true;
        throw new ExitCalled(code);
      },
    });

    equal(lockArgs?.port, port);
    equal(lockArgs?.host, "0.0.0.0");
    equal(server.listenerCount("request"), 1, "Hono request listener is attached to the held server");
    ok(signalHandlers.SIGTERM, "SIGTERM handler registered");

    try {
      await signalHandlers.SIGTERM?.();
    } catch (err) {
      if (!(err instanceof ExitCalled)) throw err;
      equal(err.code, 0);
    }
  } finally {
    if (!exited && supervisor) await supervisor.stop();
    rmSync(dir, { recursive: true, force: true });
  }

  deepEqual(order, ["server.close", "supervisor.stop", "releaseLock", "exit(0)"]);
  ok(exited, "process.exit was called");
});
