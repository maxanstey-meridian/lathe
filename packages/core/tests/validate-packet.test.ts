import assert from "node:assert";
import { test } from "node:test";

import { validatePacket } from "../src/application/use-cases/validate-packet.ts";

const makeRepo = (opts: { repoValid?: boolean; branchExists?: boolean; headBranch?: string } = {}) => ({
  createSandbox: () => {
    throw new Error("unused");
  },
  wipCommit: () => undefined,
  amendCommit: () => "",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => ({}),
  reviewableDiff: () => "",
  reviewableDiffAgainst: () => "",
  reconciliationGitState: () => ({ head: "main", status: [], diffHash: "", untracked: [], changedFiles: [] }),
  fetchBranchFromClone: () => {
    throw new Error("unused");
  },
  removeSandbox: () => {
    throw new Error("unused");
  },
  headBranch: () => opts.headBranch ?? "main",
  branchExists: () => opts.branchExists ?? true,
  mergeAccept: () => {
    throw new Error("unused");
  },
  repoValid: () => opts.repoValid ?? true,
});

const validPacket = `---
repo: /tmp/repo
base: main
compare_commit: abc123
summary: validate packet
outcomes:
  - id: outcome-1
    description: Outcome 1
expected_surface:
  - src/app.ts
verification:
  - command: echo test
---
Body text
`;

test("validatePacket returns repo and base state for a valid packet", () => {
  const result = validatePacket(validPacket, makeRepo({ repoValid: false, branchExists: false }));

  assert.strictEqual(result.shape.ok, true);
  assert.strictEqual(result.repoPath, "/tmp/repo");
  assert.strictEqual(result.baseInFm, "main");
  assert.strictEqual(result.base, "main");
  assert.strictEqual(result.repoValid, false);
  assert.strictEqual(result.baseExists, false);
});

test("validatePacket checks branch existence when the repo is valid", () => {
  const result = validatePacket(validPacket, makeRepo({ repoValid: true, branchExists: false }));

  assert.strictEqual(result.shape.ok, true);
  assert.strictEqual(result.repoValid, true);
  assert.strictEqual(result.baseExists, false);
  assert.strictEqual(result.base, "main");
});
