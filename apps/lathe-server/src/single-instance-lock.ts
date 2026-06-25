import { createServer, type Server } from "node:net";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

/**
 * Try to bind to a port to check if it is available. Binds, then immediately
 * unbinds — does not keep the port open. Returns `false` when the port is
 * already in use by another process.
 */
const tryBindPort = (port: number, host: string): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const server: Server = createServer();
    server.once("error", () => {
      server.close();
      resolve(false);
    });
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, host);
  });

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
 * daemon holds it. Returns a release fn.
 *
 * When `port` and `host` are provided, performs a socket bind check (stricter
 * than pidfile — a bound port cannot go stale). Falls back to pidfile +
 * liveness probe for stale-lock detection and reclamation.
 */
export const acquireSingleInstanceLock = async (
  lockPath: string,
  port?: number,
  host?: string,
): Promise<() => void> => {
  const bindHost = port !== undefined && !host ? "127.0.0.1" : host;

  // Socket bind gate (when port is provided). A bound port cannot go stale.
  if (port !== undefined && bindHost) {
    const available = await tryBindPort(port, bindHost);
    if (!available) {
      throw new DaemonAlreadyRunningError(-1, String(port));
    }
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
  };

  process.once("exit", release);

  return release;
};
