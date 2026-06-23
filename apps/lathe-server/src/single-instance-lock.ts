/**
 * STAGING REFERENCE — drop into apps/lathe-server/src in P00.
 *
 * One daemon per state root. A second `lathe serve` must fail loud, not race
 * the first over the same SQLite db + worktrees. Pidfile + liveness probe
 * (process.kill(pid, 0)): a stale pidfile from a crashed daemon is reclaimed,
 * a live one is refused.
 *
 * This is the cheap guard for P00's green baseline. P05 hardens it (the doc
 * mentions a socket bind as the stricter primitive — a bound port can't go
 * stale the way a pidfile can).
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

export class DaemonAlreadyRunningError extends Error {
  constructor(public readonly pid: number, public readonly lockPath: string) {
    super(`lathe daemon already running (pid ${pid}, lock ${lockPath})`);
    this.name = "DaemonAlreadyRunningError";
  }
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0); // signal 0 = liveness probe, no actual signal
    return true;
  } catch {
    return false; // ESRCH (gone) or EPERM-on-dead — treat as not ours/stale
  }
};

/**
 * Acquire the single-instance lock. Throws DaemonAlreadyRunningError if a live
 * daemon holds it. Returns a release fn; also self-releases on process exit.
 */
export const acquireSingleInstanceLock = (lockPath: string): (() => void) => {
  if (existsSync(lockPath)) {
    const existing = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    if (Number.isInteger(existing) && isAlive(existing)) {
      throw new DaemonAlreadyRunningError(existing, lockPath);
    }
    // Stale lock from a dead daemon — reclaim it.
    unlinkSync(lockPath);
  }

  writeFileSync(lockPath, String(process.pid), { flag: "wx" }); // wx: fail if it raced back

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    try {
      // Only remove if still ours.
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
        unlinkSync(lockPath);
      }
    } catch {
      /* best-effort */
    }
  };

  process.once("exit", release);
  process.once("SIGINT", () => { release(); process.exit(130); });
  process.once("SIGTERM", () => { release(); process.exit(143); });

  return release;
};
