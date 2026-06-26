import { equal, ok } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "node:net";

import { acquireSingleInstanceLock, DaemonAlreadyRunningError } from "../src/single-instance-lock.js";

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
// Lock release — pidfile cleanup
// ---------------------------------------------------------------------------

test("acquireSingleInstanceLock: release removes the pidfile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-lock-release-"));
  const lockPath = join(dir, "test.lock");
  const port = await findFreePort();

  equal(existsSync(lockPath), false);

  const { server, release } = await acquireSingleInstanceLock(lockPath, port, "127.0.0.1");

  ok(existsSync(lockPath), "pidfile created on acquire");
  equal(Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10), process.pid);
  ok(server.listening, "held server is listening");
  const address = server.address() as import("node:net").AddressInfo;
  equal(address.port, port);
  equal(address.address, "127.0.0.1");

  await new Promise<void>((resolve) => server.close(() => resolve()));
  release();

  equal(existsSync(lockPath), false, "pidfile removed after release");
  rmSync(dir, { recursive: true, force: true });
});

test("acquireSingleInstanceLock: release is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-lock-idem-"));
  const lockPath = join(dir, "test.lock");
  const port = await findFreePort();

  const { server, release } = await acquireSingleInstanceLock(lockPath, port, "127.0.0.1");

  await new Promise<void>((resolve) => server.close(() => resolve()));
  release();
  equal(existsSync(lockPath), false);

  // Second call should not throw or re-create the pidfile.
  release();
  equal(existsSync(lockPath), false, "double release does not re-create pidfile");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Lock refusal — live pidfile (daemon already running)
// ---------------------------------------------------------------------------

test("acquireSingleInstanceLock: throws when live daemon holds the pidfile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-lock-live-"));
  const lockPath = join(dir, "test.lock");
  const port = await findFreePort();

  // Write the current PID to simulate a live daemon.
  writeFileSync(lockPath, String(process.pid));

  try {
    await acquireSingleInstanceLock(lockPath, port, "127.0.0.1");
    throw new Error("expected DaemonAlreadyRunningError");
  } catch (err) {
    ok(err instanceof DaemonAlreadyRunningError, "throws DaemonAlreadyRunningError");
    equal(err.pid, process.pid, "pid matches the live daemon");
  } finally {
    unlinkSync(lockPath);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireSingleInstanceLock: throws when the port is already bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-lock-used-"));
  const lockPath = join(dir, "test.lock");

  const blocker = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => {
      const { port } = blocker.address() as import("node:net").AddressInfo;
      resolve(port);
    });
  });

  try {
    await acquireSingleInstanceLock(lockPath, port, "127.0.0.1");
    throw new Error("expected DaemonAlreadyRunningError");
  } catch (err) {
    ok(err instanceof DaemonAlreadyRunningError, "throws DaemonAlreadyRunningError");
    equal(err.pid, -1, "pid is -1 for port-in-use refusal");
  } finally {
    blocker.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireSingleInstanceLock: stale pidfile is reclaimed and the server binds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-lock-stale-"));
  const lockPath = join(dir, "test.lock");
  const port = await findFreePort();

  const fakePid = 99999; // unlikely to be alive
  writeFileSync(lockPath, String(fakePid));

  const { server, release } = await acquireSingleInstanceLock(lockPath, port, "127.0.0.1");
  ok(existsSync(lockPath), "pidfile re-created after reclaiming stale lock");
  equal(Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10), process.pid);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  release();
  rmSync(dir, { recursive: true, force: true });
});
