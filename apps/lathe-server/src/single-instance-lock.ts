import { createServer, type Server } from "node:net";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

export class DaemonAlreadyRunningError extends Error {
  constructor(
    public readonly pid: number,
    public readonly lockPath: string,
  ) {
    super(
      pid === -1
        ? `port ${lockPath} is already in use — another daemon may be running`
        : `lathe daemon already running (pid ${pid}, lock ${lockPath})`,
    );
    this.name = "DaemonAlreadyRunningError";
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Acquire the single-instance lock. Throws DaemonAlreadyRunningError if a live
 * daemon holds it. Returns { server, release } — the server is the bound socket
 * that is held for the daemon lifetime (the stricter exclusivity primitive);
 * release cleans it up (and the supplementary pidfile).
 *
 * When `port` and `host` are provided, creates and binds a server on that
 * port/host as the live lock. No probe — just bind or fail (EADDRINUSE).
 * Falls back to pidfile-only for non-daemon use.
 */
export const acquireSingleInstanceLock = async (
  lockPath: string,
  port?: number,
  host?: string,
): Promise<{ server: Server; release: () => void }> => {
  const bindHost = port !== undefined && !host ? "127.0.0.1" : host;

  let server: Server;
  let heldPort = false;

  // Create and bind the held server (port cannot go stale).
  if (port !== undefined && bindHost) {
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", (err) => {
        server.close();
        reject(new DaemonAlreadyRunningError(-1, String(port)));
      });
      server.listen(port, bindHost, () => resolve());
    });
    heldPort = true;
  } else {
    // No port — create a no-op server for callers that expect one.
    server = createServer();
  }

  // Pidfile gate — reclaim stale locks from crashed daemons.
  if (existsSync(lockPath)) {
    const existing = Number.parseInt(
      readFileSync(lockPath, "utf8").trim(),
      10,
    );
    if (Number.isInteger(existing) && isAlive(existing)) {
      throw new DaemonAlreadyRunningError(existing, lockPath);
    }
    unlinkSync(lockPath);
  }

  writeFileSync(lockPath, String(process.pid), { flag: "wx" });

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      if (
        existsSync(lockPath) &&
        readFileSync(lockPath, "utf8").trim() === String(process.pid)
      ) {
        unlinkSync(lockPath);
      }
    } catch {
      /* best-effort */
    }
    // Close the held socket if it's still listening.
    if (heldPort) {
      server.close();
    }
  };

  process.once("exit", release);

  return { server, release };
};
