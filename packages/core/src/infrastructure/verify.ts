// Verify adapter: runs the packet's verification commands and reports real exit
// codes (CONTRACT §18 S6 — the driver's own run is ground truth, never the
// reviewer's word). Mirrors the bridge's runVerification (ported from
// reference/src/verification.ts) but speaks the Verify port: it takes the
// command list (not a packet) so the application stays decoupled from frontmatter.

import { execSync } from "node:child_process";
import { resolve } from "node:path";
import type { Verify, VerificationResult } from "../application/ports/verify.js";
import type { VerificationCommand } from "../domain/packet.js";

export const createVerify = (): Verify => ({
  run: async (
    commands: VerificationCommand[],
    worktree: string,
    timeoutMs: number,
  ): Promise<VerificationResult[]> => {
    const wt = resolve(worktree);
    return commands.map((v) => {
      try {
        const output = execSync(v.command, {
          cwd: wt,
          encoding: "utf-8",
          stdio: ["ignore" as const, "pipe" as const, "pipe" as const],
          timeout: timeoutMs,
          shell: "/bin/zsh",
        });
        return { command: v.command, exitCode: 0, outputTail: output.slice(-400) };
      } catch (err) {
        const e = err as {
          status?: number | null;
          stdout?: string;
          stderr?: string;
          message?: string;
        };
        return {
          command: v.command,
          exitCode: typeof e.status === "number" ? e.status : 1,
          outputTail: `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-400) || (e.message ?? "failed"),
        };
      }
    });
  },

  runAutoFix: async (
    commands: VerificationCommand[],
    expectedSurface: string[],
    worktree: string,
    timeoutMs: number,
  ): Promise<void> => {
    if (commands.length === 0 || expectedSurface.length === 0) {
      return;
    }
    const wt = resolve(worktree);
    // Shell-escape each surface entry for safe interpolation into /bin/zsh.
    const shellEscape = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`;
    const args = expectedSurface.map(shellEscape).join(" ");
    for (const cmd of commands) {
      try {
        execSync(`${cmd.command} ${args}`, {
          cwd: wt,
          encoding: "utf-8",
          stdio: ["ignore" as const, "pipe" as const, "pipe" as const],
          timeout: timeoutMs,
          shell: "/bin/zsh",
        });
      } catch {
        // Autofix is best-effort — swallow errors.
      }
    }
  },
});
