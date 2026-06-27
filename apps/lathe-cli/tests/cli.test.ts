import { deepEqual, equal, ok } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  cmdEnqueue,
  cmdReject,
  runCommand,
  type CliEnv,
} from "../src/commands.js";

// ---------------------------------------------------------------------------
// Stub daemon — routes openapi-fetch calls to a canned responder, no network.
// ---------------------------------------------------------------------------

const stubClient = (responder: (req: Request) => Response) => {
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

const harness = (responder: (req: Request) => Response, up = true): Harness => {
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

test("runCommand: --help prints usage and exits 0", async () => {
  const h = harness(() => jsonResponse(200, { models: {}, thresholds: {} }));
  const code = await runCommand(h.env, "--help", []);
  equal(code, 0);
  ok(h.logs.some((line) => line.includes("lathe — sequential overnight executor")), h.logs.join("|"));
});

test("cmdTail: no-arg tail waits for the next active run", async () => {
  const home = mkdtempSync(join(tmpdir(), "lathe-home-"));
  const stateRoot = join(home, "state");
  const configDir = join(home, ".meridian", "v3");
  const configFile = join(configDir, "config.json");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateRoot, { recursive: true });
  writeFileSync(configFile, JSON.stringify({ stateRoot }));

  const originalHome = process.env.HOME;
  const originalExit = process.exit;
  const originalOn = process.on.bind(process);
  const originalSetInterval = globalThis.setInterval.bind(globalThis);
  const originalClearInterval = globalThis.clearInterval.bind(globalThis);
  const logs: string[] = [];
  let sigintHandler: (() => void | Promise<void>) | undefined;

  class TailExit extends Error {
    constructor(readonly code: number) {
      super(`exit(${code})`);
      this.name = "TailExit";
    }
  }

  try {
    process.env.HOME = home;
    process.exit = ((code = 0) => {
      throw new TailExit(code);
    }) as never;
    process.on = ((event: string, listener: never) => {
      if (event === "SIGINT") {
        sigintHandler = listener as () => void | Promise<void>;
        return process;
      }
      return originalOn(event as NodeJS.Signals, listener as never);
    }) as typeof process.on;
    globalThis.setInterval = ((handler: TimerHandler, _timeout?: number, ...args: never[]) =>
      originalSetInterval(handler, 10, ...args)) as typeof setInterval;
    globalThis.clearInterval = ((handle: number | NodeJS.Timeout | undefined) =>
      originalClearInterval(handle)) as typeof clearInterval;

    const { cmdTail } = await import("../src/commands.js");
    const { activeRunFile } = makePaths(stateRoot);

    cmdTail(
      {
        client: stubClient(() => jsonResponse(200, { models: {}, thresholds: {} })),
        isDaemonUp: () => Promise.resolve(true),
        log: (line) => logs.push(line),
        err: (line) => logs.push(`ERR:${line}`),
      },
      [],
    );

    ok(logs.some((line) => line.includes("waiting for one to start")), logs.join("|"));

    writeFileSync(
      activeRunFile,
      JSON.stringify({
        runId: "20260101-000000-waiting",
        runDir: join(stateRoot, "runs", "20260101-000000-waiting"),
        worktree: join(stateRoot, "worktree", "20260101-000000-waiting"),
        babySessionId: "baby-1",
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 40));

    ok(logs.some((line) => line.includes("became active — tailing")), logs.join("|"));
    ok(
      logs.some((line) => line.includes(`run 20260101-000000-waiting has not started — waiting for its journal`)),
      logs.join("|"),
    );

    try {
      await sigintHandler?.();
    } catch (err) {
      if (!(err instanceof TailExit)) throw err;
      equal(err.code, 0);
    }
  } finally {
    process.env.HOME = originalHome;
    process.exit = originalExit;
    process.on = originalOn;
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    rmSync(home, { recursive: true, force: true });
  }
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
  acceptRun: () => 0,
  rejectRun: () => {},
  isChainTip: () => true,
  lastVerdict: () => null,
  listStaged: () => [],
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
