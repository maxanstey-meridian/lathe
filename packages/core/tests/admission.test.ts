import { equal, strictEqual, ok, match } from "node:assert";
import { execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp as mkdtempP, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import { admitPacket } from "../src/application/use-cases/admit-packet.js";
import { makePaths } from "../src/config/paths.js";
import { repoValid, branchExists, headBranch } from "../src/infrastructure/git.js";
import { SqliteStoreAdapter } from "../src/infrastructure/sqlite-store.js";

// ---------------------------------------------------------------------------
// Test helpers

const TS_COUNTER = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS_COUNTER.n++).padStart(2, "0")}.000Z`,
});

const fakeRepo = (_opts?: {
  headBranch?: string;
  branchExists?: boolean;
  headBranchThrows?: boolean;
  repoValid?: boolean;
}): Repo => ({
  createSandbox: () => {
    throw new Error("unimplemented");
  },
  wipCommit: () => undefined,
  amendCommit: () => "",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => ({}),
  reviewableDiff: () => "",
  reviewableDiffAgainst: () => "",
  fetchBranchFromClone: () => {
    throw new Error("unimplemented");
  },
  removeSandbox: () => {
    throw new Error("unimplemented");
  },
  headBranch: () => "main",
  branchExists: () => true,
  repoValid: () => true,
  reconciliationGitState: () => ({
    head: "abc",
    status: [] as string[],
    diffHash: "",
    untracked: [],
    changedFiles: [],
  }),
  deleteBranch: () => {
    throw new Error("unimplemented");
  },
});

const gitRepo = (): Repo => ({
  createSandbox: () => {
    throw new Error("unimplemented");
  },
  wipCommit: () => undefined,
  amendCommit: () => "",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => ({}),
  reviewableDiff: () => "",
  reviewableDiffAgainst: () => "",
  fetchBranchFromClone: () => {
    throw new Error("unimplemented");
  },
  removeSandbox: () => {
    throw new Error("unimplemented");
  },
  headBranch,
  branchExists,
  repoValid,
  reconciliationGitState: () => ({
    head: "abc",
    status: [] as string[],
    diffHash: "",
    untracked: [],
    changedFiles: [],
  }),
  deleteBranch: () => {
    throw new Error("unimplemented");
  },
});

const initGitRepo = (path: string): void => {
  mkdirSync(path, { recursive: true });
  execSync("git init -q -b main", {
    cwd: path,
    encoding: "utf-8",
    stdio: "pipe",
    shell: "/bin/zsh",
  });
  execSync("git config user.email test@test.com", {
    cwd: path,
    encoding: "utf-8",
    stdio: "pipe",
    shell: "/bin/zsh",
  });
  execSync("git config user.name Test", {
    cwd: path,
    encoding: "utf-8",
    stdio: "pipe",
    shell: "/bin/zsh",
  });
  writeFileSync(join(path, "README.md"), "# test\n");
  execSync("git add -A", { cwd: path, encoding: "utf-8", stdio: "pipe", shell: "/bin/zsh" });
  execSync("git commit -m initial", {
    cwd: path,
    encoding: "utf-8",
    stdio: "pipe",
    shell: "/bin/zsh",
  });
};

// ---------------------------------------------------------------------------
// Test data

const validPacket = `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: valid packet
outcomes:
  - id: test-outcome
    description: A test outcome
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;

const invalidNoRepoPacket = `---
base: main
compare_commit: main
summary: no repo
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;

const invalidNoOutcomesPacket = `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: no outcomes
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;

const invalidYamlPacket = "---\nnot: valid: yaml: ::: \n---\n\nbody\n";

const cleanTemp = async (dir: string) => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

// ---------------------------------------------------------------------------
// admitPacket — valid packet

test("admitPacket: valid packet → admitted to queue, not archived", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "admit-valid-"));
    const clock = fixedClock();
    const repoPath = join(tmp, "repo");
    const repo = gitRepo();
    initGitRepo(repoPath);
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
    const packet = validPacket.replace("/tmp/test-repo", repoPath);
    admitPacket(store, "20260101-000000-valid", packet);
    // Should be in queue
    const queue = store.listQueue();
    strictEqual(queue.length, 1);
    equal(queue[0]!.runId, "20260101-000000-valid");
    // Should NOT be archived
    strictEqual(store.readRejected("20260101-000000-valid"), undefined);
    await cleanTemp(tmp);
  })();
});

test("admitPacket: valid packet without base → stamped from HEAD", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "admit-stamp-"));
    const clock = fixedClock();
    const repoPath = join(tmp, "repo");
    const repo = gitRepo();
    initGitRepo(repoPath);
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
    const packet = `---
repo: ${repoPath}
compare_commit: main
summary: no base
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;
    admitPacket(store, "20260101-000000-nobase", packet);
    const queue = store.listQueue();
    strictEqual(queue.length, 1);
    // Base should be stamped from HEAD (main)
    const queueContent = store.readQueuePacket("20260101-000000-nobase");
    ok(queueContent);
    match(queueContent, /base: main/);
    await cleanTemp(tmp);
  })();
});

test("admitPacket: valid packet with explicit base → base preserved", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "admit-explicit-"));
    const clock = fixedClock();
    const repoPath = join(tmp, "repo");
    const repo = gitRepo();
    initGitRepo(repoPath);
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
    const packet = validPacket.replace("/tmp/test-repo", repoPath);
    admitPacket(store, "20260101-000000-explicit", packet);
    const queue = store.listQueue();
    strictEqual(queue.length, 1);
    const queueContent = store.readQueuePacket("20260101-000000-explicit");
    ok(queueContent);
    match(queueContent, /base: main/);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// admitPacket — invalid packets

test("admitPacket: invalid packet (no repo) → archived, not in queue", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "admit-norepo-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
    admitPacket(store, "20260101-000000-norepo", invalidNoRepoPacket);
    strictEqual(store.listQueue().length, 0);
    const rejected = store.readRejected("20260101-000000-norepo");
    ok(rejected, "should be archived");
    match(rejected!.problems ?? "", /no repo/);
    await cleanTemp(tmp);
  })();
});

test("admitPacket: invalid packet (no outcomes) → archived with schema error", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "admit-nooutcomes-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
    admitPacket(store, "20260101-000000-nooutcomes", invalidNoOutcomesPacket);
    strictEqual(store.listQueue().length, 0);
    const rejected = store.readRejected("20260101-000000-nooutcomes");
    ok(rejected, "should be archived");
    match(rejected!.problems ?? "", /outcomes/);
    await cleanTemp(tmp);
  })();
});

test("admitPacket: invalid YAML frontmatter → archived", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "admit-badyaml-"));
    const clock = fixedClock();
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
    admitPacket(store, "20260101-000000-badyaml", invalidYamlPacket);
    strictEqual(store.listQueue().length, 0);
    const rejected = store.readRejected("20260101-000000-badyaml");
    ok(rejected, "should be archived");
    match(rejected!.problems ?? "", /no repo/);
    await cleanTemp(tmp);
  })();
});

test("admitPacket: invalid packet when repoValid fails → archived with repo error", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "admit-repoval-"));
    const clock = fixedClock();
    // Plain directory — no .git, repoValid returns false
    const repoPath = join(tmp, "not-a-repo");
    mkdirSync(repoPath);
    const repo = gitRepo();
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
    const packet = validPacket.replace("/tmp/test-repo", repoPath);
    admitPacket(store, "20260101-000000-badrepo", packet);
    strictEqual(store.listQueue().length, 0);
    const rejected = store.readRejected("20260101-000000-badrepo");
    ok(rejected, "should be archived");
    match(rejected!.problems ?? "", /not a valid git repository/);
    await cleanTemp(tmp);
  })();
});

test("admitPacket: invalid packet when branchExists fails → archived", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "admit-noexist-"));
    const clock = fixedClock();
    const repoPath = join(tmp, "repo");
    const repo = gitRepo();
    initGitRepo(repoPath);
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
    // Use a base branch that does not exist in the repo
    const packet = validPacket
      .replace("/tmp/test-repo", repoPath)
      .replace("base: main", "base: nonexistent");
    admitPacket(store, "20260101-000000-noexist", packet);
    strictEqual(store.listQueue().length, 0);
    const rejected = store.readRejected("20260101-000000-noexist");
    ok(rejected, "should be archived");
    match(rejected!.problems ?? "", /does not exist/);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// admitPacket — never-delete guarantee (F3)

test("admitPacket: both valid and invalid packets are never deleted", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "admit-neverdel-"));
    const clock = fixedClock();
    const repoPath = join(tmp, "repo");
    const repo = gitRepo();
    initGitRepo(repoPath);
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

    const validP = validPacket.replace("/tmp/test-repo", repoPath);
    admitPacket(store, "20260101-000000-valid", validP);
    admitPacket(store, "20260101-000000-invalid", invalidNoRepoPacket);

    // Valid should be in queue
    const queue = store.listQueue();
    strictEqual(queue.length, 1);
    equal(queue[0]!.runId, "20260101-000000-valid");

    // Invalid should be in rejected
    ok(store.readRejected("20260101-000000-invalid"));

    await cleanTemp(tmp);
  })();
});
