import { execFile } from "node:child_process";
import { resolve } from "node:path";
import type { Verify, VerificationResult } from "../application/ports/verify.js";

const runOne = (command: string, cwd: string, timeoutMs: number): Promise<VerificationResult> =>
  new Promise((resolve) => {
    execFile(
      "/bin/zsh",
      ["-c", command],
      { cwd, encoding: "utf-8", timeout: timeoutMs / 1000 },
      (err, stdout, stderr) => {
        if (err) {
          const status = (err as unknown as { status?: number }).status;
          const timedOut = err.killed;
          resolve({
            command,
            exitCode: typeof status === "number" ? status : timedOut ? 124 : 1,
            outputTail:
              `${stdout ?? ""}${stderr ?? ""}`.slice(-400) ||
              (timedOut ? "timed out" : err.message),
          });
          return;
        }
        resolve({ command, exitCode: 0, outputTail: (stdout ?? "").slice(-400) });
      },
    );
  });

export const createVerify = (): Verify => ({
  run: async (commands, worktree, timeoutMs): Promise<VerificationResult[]> => {
    const wt = resolve(worktree);
    return Promise.all(commands.map((v) => runOne(v.command, wt, timeoutMs)));
  },

  runAutoFix: async (commands, expectedSurface, worktree, timeoutMs): Promise<void> => {
    if (commands.length === 0 || expectedSurface.length === 0) {
      return;
    }
    const wt = resolve(worktree);
    const shellEscape = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
    const args = expectedSurface.map(shellEscape).join(" ");
    for (const cmd of commands) {
      await runOne(`${cmd.command} ${args}`, wt, timeoutMs);
    }
  },
});
