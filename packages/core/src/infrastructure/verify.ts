import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { VerificationProcessEvent } from "../application/ports/driver-output.js";
import type { Verify, VerificationResult, VerificationRunOptions } from "../application/ports/verify.js";

const OUTPUT_TAIL_LENGTH = 400;
const KILL_GRACE_MS = 500;

const observe = (options: VerificationRunOptions | undefined, event: VerificationProcessEvent): void => {
  try {
    options?.onEvent?.(event);
  } catch {
    // Presentation failures cannot alter verification behavior.
  }
};

const runOne = (
  command: string,
  commandId: string,
  cwd: string,
  timeoutMs: number,
  options?: VerificationRunOptions,
): Promise<VerificationResult> =>
  new Promise((complete, fail) => {
    const child = spawn("/bin/zsh", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let outputTail = "";
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let exited = false;
    let terminationStarted = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let termination: Promise<void> | undefined;

    const completeResult = (result: VerificationResult): void => {
      try {
        options?.onResult?.(result);
        complete(result);
      } catch (error) {
        fail(error);
      }
    };

    const append = (stream: "stdout" | "stderr", chunk: string): void => {
      outputTail = `${outputTail}${chunk}`.slice(-OUTPUT_TAIL_LENGTH);
      observe(options, { kind: "output", commandId, command, stream, chunk });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => append("stdout", chunk));
    child.stderr.on("data", (chunk: string) => append("stderr", chunk));

    const killGroup = (): void => {
      if (!child.pid || terminationStarted) {
        return;
      }
      terminationStarted = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        return;
      }
      termination = new Promise((resolveTermination) => {
        killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            // The process group already exited.
          } finally {
            resolveTermination();
          }
        }, KILL_GRACE_MS);
      });
    };

    const onAbort = (): void => {
      cancelled ||= !exited;
      killGroup();
    };
    if (options?.signal?.aborted) {
      onAbort();
    } else {
      options?.signal?.addEventListener("abort", onAbort, { once: true });
    }

    const timeout = setTimeout(() => {
      timedOut = !exited;
      killGroup();
    }, timeoutMs);
    timeout.unref();

    child.once("exit", () => {
      exited = true;
    });

    child.once("spawn", () => {
      observe(options, { kind: "started", commandId, command });
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer && !terminationStarted) {
        clearTimeout(killTimer);
      }
      options?.signal?.removeEventListener("abort", onAbort);
      const exitCode = timedOut ? 124 : cancelled ? 130 : 1;
      if (!outputTail) {
        outputTail = error.message.slice(-OUTPUT_TAIL_LENGTH);
      }
      observe(options, { kind: "finished", commandId, command, exitCode, timedOut });
      completeResult({ command, exitCode, outputTail });
    });
    child.once("close", async (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killTimer && !terminationStarted) {
        clearTimeout(killTimer);
      }
      options?.signal?.removeEventListener("abort", onAbort);
      await termination;
      const exitCode = timedOut ? 124 : cancelled ? 130 : typeof code === "number" ? code : signal ? 1 : 0;
      if (!outputTail && timedOut) {
        outputTail = "timed out";
      }
      observe(options, { kind: "finished", commandId, command, exitCode, timedOut });
      completeResult({ command, exitCode, outputTail });
    });
  });

export const createVerify = (): Verify => ({
  run: async (commands, worktree, timeoutMs, options): Promise<VerificationResult[]> => {
    const cwd = resolve(worktree);
    return Promise.all(commands.map((item, index) =>
      runOne(item.command, `${index + 1}-${randomUUID()}`, cwd, timeoutMs, options),
    ));
  },

  runAutoFix: async (commands, expectedSurface, worktree, timeoutMs, options): Promise<void> => {
    if (commands.length === 0 || expectedSurface.length === 0) {
      return;
    }
    const cwd = resolve(worktree);
    const shellEscape = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;
    const args = expectedSurface.map(shellEscape).join(" ");
    for (const [index, item] of commands.entries()) {
      if (options?.signal?.aborted) {
        break;
      }
      await runOne(`${item.command} ${args}`, `${index + 1}-${randomUUID()}`, cwd, timeoutMs, options);
    }
  },
});
