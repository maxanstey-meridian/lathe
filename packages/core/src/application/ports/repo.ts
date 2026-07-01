// Repo port: git operations the driver performs (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.

import type { DiffStats } from "../../domain/gate-classification.js";
import type { ReconciliationGitState } from "../../domain/reconciliation.js";

export type Repo = {
  createSandbox(repo: string, sandboxPath: string, branch: string, base: string): void;
  wipCommit(worktree: string, message: string): string | undefined;
  amendCommit(worktree: string, message: string): string;
  worktreeIsDirty(worktree: string): boolean;
  diffStat(worktree: string, base: string): string;
  readDiffStats(worktree: string, ref?: string): DiffStats;
  reviewableDiff(worktree: string, maxBytes: number): string;
  reviewableDiffAgainst(worktree: string, base: string, maxBytes: number): string;
  reconciliationGitState(worktree: string): ReconciliationGitState;
  fetchBranchFromClone(repo: string, clone: string, branch: string, force?: boolean): void;
  removeSandbox(sandboxPath: string, runsDir: string): void;
  headBranch(worktree: string): string;
  branchExists(worktree: string, branch: string): boolean;
  mergeAccept(repo: string, sourceBranch: string): void;
  repoValid(path: string): boolean;
};
