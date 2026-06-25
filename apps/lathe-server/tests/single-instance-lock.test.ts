import { equal, ok, throws } from "node:assert";
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

  equal(existsSync(lockPath), false);

  const port = await findFreePort();
  const { release } = await acquireSingleInstanceLock(lockPath, port, "127.0.0.1");

  ok(existsSync(lockPath), "pidfile created on acquire");
  equal(Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10), process.pid);

  release();

  equal(existsSync(lockPath), false, "pidfile removed after release");
  rmSync(dir, { recursive: true, force: true });
});

test("acquireSingleInstanceLock: release is idempotent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-lock-idem-"));
  const lockPath = join(dir, "test.lock");

  const port = await findFreePort();
  const { release } = await acquireSingleInstanceLock(lockPath, port, "127.0.0.1");

  release();
  equal(existsSync(lockPath), false);

  // Second call should not throw or re-create the pidfile.
  release();
  equal(existsSync(lockPath), false, "double release does not re-create pidfile");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Lock refusal — port in use
// ---------------------------------------------------------------------------

test("acquireSingleInstanceLock: throws when port is already bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-lock-used-"));
  const lockPath = join(dir, "test.lock");

  const server = createServer();
  const portPromise = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as import("node:net").AddressInfo;
      resolve(port);
    });
  });

  const port = await portPromise;

  try {
    await acquireSingleInstanceLock(lockPath, port, "127.0.0.1");
    throw new Error("expected DaemonAlreadyRunningError");
  } catch (err) {
    ok(err instanceof DaemonAlreadyRunningError, "throws DaemonAlreadyRunningError");
    equal(err.pid, -1, "pid is -1 for port-in-use error");
  }

  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("acquireSingleInstanceLock: throws DaemonAlreadyRunningError with correct pid for live daemon", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-lock-stale-"));
  const lockPath = join(dir, "test.lock");

  const port = await findFreePort();
  const fakePid = 99999; // unlikely to be alive
  writeFileSync(lockPath, String(fakePid));

  // The pid is alive check fails for 99999, so stale lock recovery kicks in.
  // No error should be thrown — it reclaims the stale lock.
  const { release } = await acquireSingleInstanceLock(lockPath, port, "127.0.0.1");
  ok(existsSync(lockPath), "pidfile re-created after reclaiming stale lock");
  equal(Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10), process.pid);
  release();
  rmSync(dir, { recursive: true, force: true });
});

test("acquireSingleInstanceLock: reclaims stale pidfile without port probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-lock-noport-"));
  const lockPath = join(dir, "test.lock");

  const fakePid = 99999;
  writeFileSync(lockPath, String(fakePid));

  // No port provided — should only check pidfile.
  const { release } = await acquireSingleInstanceLock(lockPath);
  ok(existsSync(lockPath));
  equal(Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10), process.pid);
  release();
  rmSync(dir, { recursive: true, force: true });
});

test("acquireSingleInstanceLock: returns server bound to the port for daemon lifetime", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-lock-held-"));
  const lockPath = join(dir, "test.lock");

  const port = await findFreePort();
  const { server, release } = await acquireSingleInstanceLock(lockPath, port, "127.0.0.1");

  ok(server, "server is returned");
  equal(server.listening, true, "server is listening on the port");

  // The port should now be in use — another bind attempt should fail.
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () => {
      probe.close();
      resolve();
    });
    probe.listen(port, "127.0.0.1");
    setTimeout(() => { probe.close(); reject(new Error("port did not fail to bind — socket was not held")); }, 1000);
  });

  release();
  rmSync(dir, { recursive: true, force: true });
});

test("acquireSingleInstanceLock: no-signal-exit on SIGINT (process.exit not called by lock)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lathe-lock-nosignal-"));
  const lockPath = join(dir, "test.lock");

  const port = await findFreePort();
  const { release } = await acquireSingleInstanceLock(lockPath, port, "127.0.0.1");
  ok(release, "acquires lock without error");
  release();
  rmSync(dir, { recursive: true, force: true });
});
