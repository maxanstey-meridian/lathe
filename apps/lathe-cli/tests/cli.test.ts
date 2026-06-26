import { equal, ok } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:net";
import { acquireSingleInstanceLock, createSupervisor } from "@lathe/server";
import { Config as ConfigSchema } from "@lathe/core";
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
// Helper: find a random free port by binding and immediately closing.
// ---------------------------------------------------------------------------

const findFreePort = (host = "127.0.0.1"): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, host, () => {
      const { port } = s.address() as import("node:net").AddressInfo;
      s.close(() => resolve(port));
    });
  });

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

test("startDaemon: shutdown fires server.close → supervisor.stop → releaseLock → exit(0)", async () => {
  const port = await findFreePort();
  const dir = mkdtempSync(join(tmpdir(), "lathe-serve-"));
  const lockPath = join(dir, "lathe.lock");

  const order: string[] = [];
  const signalHandlers: Partial<Record<"SIGINT" | "SIGTERM", () => Promise<void> | void>> = {};
  let lockArgs: { lockPath: string; port: number; host?: string } | undefined;

  const originalOn = process.on.bind(process);
  const originalExit = process.exit.bind(process);
  let exited = false;
  process.on = ((event: string, cb: unknown): NodeJS.Process => {
    if (event === "SIGINT" || event === "SIGTERM") {
      signalHandlers[event] = cb as () => Promise<void> | void;
    }
    return process;
  }) as typeof process.on;
  process.exit = ((code?: number | string): never => {
    order.push(`exit(${code ?? 0})`);
    exited = true;
    throw new Error("__EXIT__");
  }) as never;

  try {
    const { startDaemon } = await import("../src/serve.js");
    await startDaemon({
      loadConfig: () => ({
        config: { ...ConfigSchema.parse({}), daemon: { port, host: "127.0.0.1" } },
        paths: { root: dir },
      }),
      acquireSingleInstanceLock: async (path, daemonPort, host) => {
        lockArgs = { lockPath: path, port: daemonPort, host };
        const acquired = await acquireSingleInstanceLock(path, daemonPort, host);
        const originalRelease = acquired.release;
        return {
          server: acquired.server,
          release: () => {
            order.push("releaseLock");
            originalRelease();
          },
        };
      },
      createSupervisor: (config, paths) => {
        const sup = createSupervisor(config, paths, { startDriver: false });
        const originalStop = sup.stop.bind(sup);
        sup.stop = async () => {
          order.push("supervisor.stop");
          await originalStop();
        };
        return sup;
      },
    });

    equal(lockArgs?.lockPath, lockPath);
    equal(lockArgs?.port, port);
    equal(lockArgs?.host, "127.0.0.1");

    const probeBefore = createServer();
    await new Promise<void>((resolve) => {
      probeBefore.once("error", () => resolve());
      probeBefore.listen(port, "127.0.0.1", () => {
        probeBefore.close(() => resolve());
        throw new Error("expected daemon port to be in use before shutdown");
      });
    });

    try {
      await Promise.resolve(signalHandlers.SIGINT?.());
    } catch (err) {
      if ((err as Error).message !== "__EXIT__") throw err;
    }
  } finally {
    process.on = originalOn;
    process.exit = originalExit;
    rmSync(dir, { recursive: true, force: true });
  }

  equal(order[0], "supervisor.stop", "1. supervisor.stop first observable effect");
  equal(order[1], "releaseLock", "2. releaseLock second");
  equal(order[2], "exit(0)", "3. process.exit(0) last");
  ok(exited, "process.exit was called");

  const probeAfter = createServer();
  await new Promise<void>((resolve, reject) => {
    probeAfter.once("error", reject);
    probeAfter.listen(port, "127.0.0.1", () => {
      probeAfter.close(() => resolve());
    });
  });
});

test("startDaemon: threads configured host into the held lock and shuts down on SIGTERM", async () => {
  const port = await findFreePort();
  const dir = mkdtempSync(join(tmpdir(), "lathe-serve-host-"));

  const order: string[] = [];
  const signalHandlers: Partial<Record<"SIGINT" | "SIGTERM", () => Promise<void> | void>> = {};
  let lockArgs: { lockPath: string; port: number; host?: string } | undefined;

  const originalOn = process.on.bind(process);
  const originalExit = process.exit.bind(process);
  let exited = false;
  process.on = ((event: string, cb: unknown): NodeJS.Process => {
    if (event === "SIGINT" || event === "SIGTERM") {
      signalHandlers[event] = cb as () => Promise<void> | void;
    }
    return process;
  }) as typeof process.on;
  process.exit = ((code?: number | string): never => {
    order.push(`exit(${code ?? 0})`);
    exited = true;
    throw new Error("__EXIT__");
  }) as never;

  try {
    const { startDaemon } = await import("../src/serve.js");
    await startDaemon({
      loadConfig: () => ({
        config: { ...ConfigSchema.parse({}), daemon: { port, host: "0.0.0.0" } },
        paths: { root: dir },
      }),
      acquireSingleInstanceLock: async (path, daemonPort, host) => {
        lockArgs = { lockPath: path, port: daemonPort, host };
        const acquired = await acquireSingleInstanceLock(path, daemonPort, host);
        const originalRelease = acquired.release;
        return {
          server: acquired.server,
          release: () => {
            order.push("releaseLock");
            originalRelease();
          },
        };
      },
      createSupervisor: (config, paths) => {
        const sup = createSupervisor(config, paths, { startDriver: false });
        const originalStop = sup.stop.bind(sup);
        sup.stop = async () => {
          order.push("supervisor.stop");
          await originalStop();
        };
        return sup;
      },
    });

    equal(lockArgs?.port, port);
    equal(lockArgs?.host, "0.0.0.0");

    const probeBefore = createServer();
    await new Promise<void>((resolve) => {
      probeBefore.once("error", () => resolve());
      probeBefore.listen(port, "127.0.0.1", () => {
        probeBefore.close(() => resolve());
        throw new Error("expected daemon port to be in use before shutdown");
      });
    });

    try {
      await Promise.resolve(signalHandlers.SIGTERM?.());
    } catch (err) {
      if ((err as Error).message !== "__EXIT__") throw err;
    }
  } finally {
    process.on = originalOn;
    process.exit = originalExit;
    rmSync(dir, { recursive: true, force: true });
  }

  equal(order[0], "supervisor.stop", "shutdown stops supervisor");
  equal(order[1], "releaseLock", "shutdown releases lock");
  equal(order[2], "exit(0)", "shutdown exits cleanly");
  ok(exited, "process.exit was called");

  const probeAfter = createServer();
  await new Promise<void>((resolve, reject) => {
    probeAfter.once("error", reject);
    probeAfter.listen(port, "127.0.0.1", () => {
      probeAfter.close(() => resolve());
    });
  });
});
