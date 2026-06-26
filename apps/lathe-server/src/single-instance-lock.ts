import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createServer, type Server } from "node:http";

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
 * daemon holds it. Returns { server, release } — the bound server is the live
 * exclusivity primitive; release() cleans up the supplementary pidfile and
 * closes the held socket when needed.
 *
 * Port exclusivity is provided by the bound server returned here. This module
 * handles stale-crash recovery via pidfile gate, then binds the live socket.
 */
export const acquireSingleInstanceLock = async (
  lockPath: string,
  port: number,
  host = "127.0.0.1",
): Promise<{ server: Server; release: () => void }> => {
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

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => {
      server.close();
      reject(new DaemonAlreadyRunningError(-1, `${host}:${port}`));
    });
    server.listen(port, host, resolve);
  });

  writeFileSync(lockPath, String(process.pid));

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    process.off("exit", release);
    try {
      if (server.listening) {
        server.close();
      }
    } catch {
      /* best-effort */
    }
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

  return { server, release };
};
