// Verify port: run packet verification commands with real exit codes (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.
//
// classifyFiles is NOT here — it is the domain pure function
// (src/domain/gate-classification.ts:33) taking diffPaths: string[], NOT DiffStats.
// The adapter extracts paths via Object.keys(readDiffStats(...)) and calls domain.

import type { VerificationCommand } from "../../domain/packet.js";
import type { VerificationProcessEvent } from "./driver-output.js";

// VerificationResult — inline; no domain function consumes it.
export type VerificationResult = { command: string; exitCode: number; outputTail: string };
export type VerificationRunOptions = {
  signal?: AbortSignal;
  onEvent?: (event: VerificationProcessEvent) => void;
  onResult?: (result: VerificationResult) => void;
};

export type Verify = {
  run(
    commands: VerificationCommand[],
    worktree: string,
    timeoutMs: number,
    options?: VerificationRunOptions,
  ): Promise<VerificationResult[]>;
  runAutoFix(
    commands: VerificationCommand[],
    expectedSurface: string[],
    worktree: string,
    timeoutMs: number,
    options?: VerificationRunOptions,
  ): Promise<void>;
};
