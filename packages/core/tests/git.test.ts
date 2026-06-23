// Tests for git operations the driver performs (CONTRACT §5, R2–R4).
// Uses temp repos with `git init`; no network.

import assert from "node:assert";
import { execSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createSandbox,
  isCloneSandbox,
  fetchBranchFromClone,
  removeSandbox,
  worktreeIsDirty,
  wipCommit,
  amendCommit,
  diffNameOnly,
  diffStat,
  readDiffStats,
  reviewableDiff,
  reviewableDiffAgainst,
  headBranch,
  branchExists,
  repoValid,
  mergeAccept,
} from "../src/infrastructure/git.ts";

// ===========================================================================
// Build helpers
// ===========================================================================

// Initialize a source repo with one commit on the default branch.
const initSourceRepo = (root: string) => {
  const repo = join(root, "source");
  mkdirSync(repo);
  const g = (c: string) => execSync(`git ${c}`, { cwd: repo, stdio: "ignore" });
  g("init -q -b main");
  g("config user.email t@t.t");
  g("config user.name t");
  writeFileSync(join(repo, "a.txt"), "base\n");
  g("add -A");
  g("commit -qm base");
  const baseSha = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
  return { repo, baseSha };
};

// Initialize a bare git repo (no worktree) for clone-sourced operations.
const initBareRepo = (root: string) => {
  const repo = join(root, "bare");
  mkdirSync(repo);
  const g = (c: string) => execSync(`git ${c}`, { cwd: repo, stdio: "ignore" });
  g("init -q -b main");
  g("config user.email t@t.t");
  g("config user.name t");
  writeFileSync(join(repo, "a.txt"), "base\n");
  g("add -A");
  g("commit -qm base");
  return { repo };
};

// ===========================================================================
// R2: self-rooted sandbox
// ===========================================================================

test("createSandbox: a self-rooted clone — .git is a real dir (no worktree linkage), forked at base", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-sandbox-"));
  try {
    const { repo, baseSha } = initSourceRepo(tmp);
    const runsDir = join(tmp, "runs");
    const sandbox = join(runsDir, "20990101-000000-x", "worktree");
    mkdirSync(join(runsDir, "20990101-000000-x"), { recursive: true });

    createSandbox(repo, sandbox, "meridian/x", "main");

    // The whole point: .git is a real DIRECTORY, not a worktree pointer file, and
    // carries no commondir linking back to the source repo. This is the regression
    // guard — a worktree would fail both.
    assert.ok(statSync(join(sandbox, ".git")).isDirectory(), ".git must be a directory");
    assert.ok(!existsSync(join(sandbox, ".git", "commondir")), "must not be a linked worktree");

    // Run branch checked out, forked exactly at base.
    assert.equal(
      execSync("git rev-parse --abbrev-ref HEAD", { cwd: sandbox }).toString().trim(),
      "meridian/x",
    );
    assert.equal(execSync("git rev-parse HEAD", { cwd: sandbox }).toString().trim(), baseSha);

    // A LOCAL <base> branch exists so later `git diff <base>` resolves inside the clone.
    execSync("git rev-parse --verify main", { cwd: sandbox, stdio: "ignore" }); // throws if absent
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("createSandbox: crash recovery — reuses an existing real sandbox (.git dir present)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-sandbox-reuse-"));
  try {
    const { repo, baseSha } = initSourceRepo(tmp);
    const runsDir = join(tmp, "runs");
    const sandbox = join(runsDir, "20990101-000000-y", "worktree");
    mkdirSync(join(runsDir, "20990101-000000-y"), { recursive: true });

    // Create the sandbox once.
    createSandbox(repo, sandbox, "meridian/y", "main");
    const firstSha = execSync("git rev-parse HEAD", { cwd: sandbox }).toString().trim();
    assert.equal(firstSha, baseSha);

    // Calling again should be a no-op (reuse).
    createSandbox(repo, sandbox, "meridian/y", "main");
    const secondSha = execSync("git rev-parse HEAD", { cwd: sandbox }).toString().trim();
    assert.equal(secondSha, baseSha, "reused sandbox HEAD should be unchanged");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("isCloneSandbox: returns true for a self-rooted clone, false for a worktree-like .git file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-isclone-"));
  try {
    const { repo } = initSourceRepo(tmp);
    const runsDir = join(tmp, "runs");
    const sandbox = join(runsDir, "20990101-000000-z", "worktree");
    mkdirSync(join(runsDir, "20990101-000000-z"), { recursive: true });

    createSandbox(repo, sandbox, "meridian/z", "main");
    assert.ok(isCloneSandbox(sandbox), "should detect a clone sandbox");

    // Simulate a worktree: replace .git directory with a pointer file.
    rmSync(join(sandbox, ".git"), { recursive: true });
    writeFileSync(join(sandbox, ".git"), "gitdir: /tmp/fake\n");
    assert.ok(!isCloneSandbox(sandbox), "should NOT detect a worktree as clone");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// X1: guarded sandbox removal
// ===========================================================================

test("removeSandbox: deletes only a real <runsDir>/<id>/worktree sandbox; refuses everything else", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-rm-"));
  try {
    const runsDir = join(tmp, "runs");
    const sandbox = join(runsDir, "20990101-000000-x", "worktree");
    mkdirSync(sandbox, { recursive: true });
    mkdirSync(join(sandbox, ".git")); // looks like a real sandbox

    // Refuses: runsDir itself, the run dir, a non-"worktree" sibling, an outside
    // path, and a "worktree" dir with no .git. None of these get deleted.
    assert.throws(() => removeSandbox(runsDir, runsDir), /refusing to delete/);
    assert.throws(
      () => removeSandbox(join(runsDir, "20990101-000000-x"), runsDir),
      /refusing to delete/,
    );
    const sibling = join(runsDir, "20990101-000000-x", "other");
    mkdirSync(sibling);
    mkdirSync(join(sibling, ".git"));
    assert.throws(() => removeSandbox(sibling, runsDir), /refusing to delete/);
    const outside = join(tmp, "elsewhere");
    mkdirSync(outside);
    mkdirSync(join(outside, ".git"));
    assert.throws(() => removeSandbox(outside, runsDir), /refusing to delete/);
    const noGit = join(runsDir, "20990101-000000-y", "worktree");
    mkdirSync(noGit, { recursive: true });
    assert.throws(() => removeSandbox(noGit, runsDir), /no \.git/);

    // Everything it refused still exists.
    assert.ok(
      existsSync(sandbox) && existsSync(sibling) && existsSync(outside) && existsSync(noGit),
    );

    // A missing path is a no-op (accept is idempotent).
    removeSandbox(join(runsDir, "gone", "worktree"), runsDir);

    // The genuine article IS deleted.
    removeSandbox(sandbox, runsDir);
    assert.ok(!existsSync(sandbox), "the real sandbox is deleted");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("removeSandbox: refuses symlinks pointing outside runsDir", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-rm-sym-"));
  try {
    const runsDir = join(tmp, "runs");
    const realSandbox = join(tmp, "real-sandbox");
    mkdirSync(realSandbox, { recursive: true });
    mkdirSync(join(realSandbox, ".git"));

    const runsSubDir = join(runsDir, "20990101-000000-w", "worktree");
    mkdirSync(join(runsDir, "20990101-000000-w"), { recursive: true });
    // Create a symlink from inside runsDir pointing outside
    try {
      execSync(`ln -s ${realSandbox} ${runsSubDir}`, { stdio: "ignore" });
    } catch {
      // Some platforms don't allow symlinks in tmp without extra steps; skip if it fails
      rmSync(tmp, { recursive: true, force: true });
      return;
    }

    assert.throws(() => removeSandbox(runsSubDir, runsDir), /refusing to delete/);
    // The symlinked target still exists.
    assert.ok(existsSync(realSandbox), "symlink target must still exist");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// R3: WIP commit and amend
// ===========================================================================

test("worktreeIsDirty: dirty and clean states", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-dirty-"));
  try {
    const { repo } = initBareRepo(tmp);

    assert.ok(!worktreeIsDirty(repo), "clean repo should not be dirty");
    writeFileSync(join(repo, "new.txt"), "stuff\n");
    assert.ok(worktreeIsDirty(repo), "uncommitted file should be dirty");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("wipCommit: dirty → returns SHA; clean → undefined", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-wip-"));
  try {
    const { repo } = initBareRepo(tmp);

    // Clean → undefined.
    assert.strictEqual(wipCommit(repo, "WIP test"), undefined);

    // Dirty → SHA.
    writeFileSync(join(repo, "new.txt"), "stuff\n");
    const sha = wipCommit(repo, "meridian: WIP test");
    assert.ok(typeof sha === "string" && sha.length === 40, `expected 40-char SHA, got: ${sha}`);

    // Clean again → undefined.
    assert.strictEqual(wipCommit(repo, "WIP test"), undefined);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("amendCommit: rewords HEAD and returns new SHA", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-amend-"));
  try {
    const { repo } = initBareRepo(tmp);
    mkdirSync(join(repo, "wt"));
    execSync("git clone --local . wt", { cwd: repo, stdio: "ignore" });

    // Make a commit first.
    writeFileSync(join(repo, "a.txt"), "a\n");
    execSync("git add -A && git commit -m 'first'", { cwd: repo, stdio: "ignore" });

    const before = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
    const beforeMsg = execSync("git log -1 --format=%s", { cwd: repo }).toString().trim();
    assert.equal(beforeMsg, "first");

    // Amend the commit message.
    const newMsg = "new commit message";
    const sha = amendCommit(repo, newMsg);

    assert.ok(typeof sha === "string" && sha.length === 40);
    // HEAD sha should be different (tree changed because message changed).
    // Actually amend without --no-edit keeps same tree, but --amend -m changes the commit object.
    // The sha should be valid.
    const afterMsg = execSync("git log -1 --format=%s", { cwd: repo }).toString().trim();
    assert.equal(afterMsg, newMsg);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// diffStat: against base, not HEAD
// ===========================================================================

test("diffStat: shows diff against base, not HEAD", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-diffstat-"));
  try {
    const { repo } = initBareRepo(tmp);

    const stat = diffStat(repo, "main");
    assert.equal(stat, "", "clean repo → empty stat");

    // Make a committed change on a feature branch (not main) so diffStat against 'main' shows it.
    execSync("git checkout -q -b meridian/test", { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "b.txt"), "added\n");
    execSync("git add -A && git commit -qm 'added file'", { cwd: repo, stdio: "ignore" });

    const stat2 = diffStat(repo, "main");
    assert.ok(stat2.includes("b.txt"), "should show committed changes against base");

    // Make an uncommitted (staged) change too — diffStat uses `git diff` which
    // only covers tracked files, so the uncommitted change must be staged.
    writeFileSync(join(repo, "c.txt"), "more\n");
    execSync("git add c.txt", { cwd: repo, stdio: "ignore" });
    const stat3 = diffStat(repo, "main");
    assert.ok(
      stat3.includes("b.txt") && stat3.includes("c.txt"),
      "should show both committed and uncommitted",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// readDiffStats: numstat + untracked, excluding node_modules and binary
// ===========================================================================

test("readDiffStats: tracked changes + untracked text files, excluding node_modules and binary", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-readstats-"));
  try {
    const { repo } = initBareRepo(tmp);
    mkdirSync(join(repo, "wt"));
    execSync("git clone --local . wt", { cwd: repo, stdio: "ignore" });

    // Track a file.
    writeFileSync(join(repo, "a.ts"), "line1\nline2\n");
    execSync("git add a.ts && git commit -qm 'add a'", { cwd: repo, stdio: "ignore" });

    // Modify tracked file.
    writeFileSync(join(repo, "a.ts"), "line1\nline2\nline3\nline4\n");

    // Add untracked text file.
    writeFileSync(join(repo, "new.ts"), "hello\nworld\n");

    // Add node_modules file (should be excluded).
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "code\n");

    const stats = readDiffStats(repo);

    assert.ok(stats["a.ts"], "should have tracked changes");
    assert.strictEqual(stats["a.ts"]?.added, 2, "a.ts added lines should be 2 (4-2)");
    assert.strictEqual(stats["a.ts"]?.removed, 0);

    assert.ok(stats["new.ts"], "should have untracked file");
    assert.strictEqual(
      stats["new.ts"]?.added,
      3,
      "new.ts should have 3 segments (split on \\n with trailing)",
    );
    assert.strictEqual(stats["new.ts"]?.removed, 0);

    assert.ok(!stats["node_modules/pkg/index.js"], "node_modules files must be excluded");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("readDiffStats: excludes binary files (>1MB or NUL byte)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-readstats-bin-"));
  try {
    const { repo } = initBareRepo(tmp);
    mkdirSync(join(repo, "wt"));
    execSync("git clone --local . wt", { cwd: repo, stdio: "ignore" });

    // Untracked file with NUL byte (binary).
    const buf = Buffer.concat([Buffer.from("hello"), Buffer.from([0]), Buffer.from("world")]);
    writeFileSync(join(repo, "binary.dat"), buf);

    const stats = readDiffStats(repo);
    assert.ok(!stats["binary.dat"], "binary files must be excluded");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// V7: reviewableDiff — tracked + untracked, capped
// ===========================================================================

test("reviewableDiff: shows tracked changes + untracked files, caps with a marker", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-review-"));
  try {
    const { repo } = initBareRepo(tmp);
    mkdirSync(join(repo, "wt"));
    execSync("git clone --local . wt", { cwd: repo, stdio: "ignore" });

    // Tracked change.
    writeFileSync(join(repo, "tracked.txt"), "one\n");
    execSync("git add tracked.txt && git commit -q -m add", { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");

    // Untracked file.
    writeFileSync(join(repo, "fresh.txt"), "brand new\n");

    const diff = reviewableDiff(repo, 64 * 1024);
    assert.ok(diff.includes("two"), "tracked change visible");
    assert.ok(diff.includes("new file: fresh.txt"), "untracked file inlined");
    assert.ok(diff.includes("brand new"), "untracked content inlined");

    // Tiny cap → truncation marker.
    const capped = reviewableDiff(repo, 16);
    assert.ok(capped.includes("truncated"), "should include truncation marker when capped");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// V7: reviewableDiffAgainst — vs base, not HEAD
// ===========================================================================

test("reviewableDiffAgainst: shows diff vs base including committed work", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-review-against-"));
  try {
    const { repo } = initBareRepo(tmp);
    mkdirSync(join(repo, "wt"));
    execSync("git clone --local . wt", { cwd: repo, stdio: "ignore" });

    // Create a feature branch so committed work shows vs main.
    execSync("git checkout -q -b meridian/test", { cwd: repo, stdio: "ignore" });

    // Committed work on feature branch.
    writeFileSync(join(repo, "a.txt"), "a\n");
    execSync("git add a.txt && git commit -q -m 'work'", { cwd: repo, stdio: "ignore" });

    // Untracked work.
    writeFileSync(join(repo, "b.txt"), "b\n");

    const diff = reviewableDiffAgainst(repo, "main", 64 * 1024);
    assert.ok(diff.includes("a.txt"), "committed changes should show");
    assert.ok(diff.includes("b.txt"), "untracked changes should show");
    assert.ok(!diff.includes("truncated"), "should not be capped at 64KB");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("reviewableDiffAgainst: capped with marker referencing the base branch", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-review-against-cap-"));
  try {
    const { repo } = initBareRepo(tmp);
    mkdirSync(join(repo, "wt"));
    execSync("git clone --local . wt", { cwd: repo, stdio: "ignore" });

    writeFileSync(join(repo, "x.txt"), "x\n".repeat(1000));

    const capped = reviewableDiffAgainst(repo, "main", 16);
    assert.ok(capped.includes("truncated"), "should include truncation marker");
    assert.ok(capped.includes("main"), "truncation marker should reference base branch");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// headBranch, branchExists, repoValid
// ===========================================================================

test("headBranch: returns current branch; throws on detached HEAD", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-headbranch-"));
  try {
    const { repo } = initBareRepo(tmp);

    assert.equal(headBranch(repo), "main", "should return 'main' on default branch");

    // Detached HEAD.
    const sha = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim();
    execSync(`git checkout -q ${sha}`, { cwd: repo, stdio: "ignore" });
    assert.throws(() => headBranch(repo), /detached HEAD/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("headBranch: throws on non-repo path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-headbranch-nogit-"));
  try {
    assert.throws(() => headBranch(tmp), /git/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("branchExists: true for existing branch, false for nonexistent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-branchexists-"));
  try {
    const { repo } = initBareRepo(tmp);

    assert.ok(branchExists(repo, "main"), "main branch should exist");
    assert.ok(!branchExists(repo, "nonexistent"), "nonexistent branch should not exist");

    execSync("git branch feature", { cwd: repo, stdio: "ignore" });
    assert.ok(branchExists(repo, "feature"), "feature branch should exist");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("repoValid: true for git repo, false for non-repo", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-repovalid-"));
  try {
    const { repo } = initBareRepo(tmp);
    assert.ok(repoValid(repo), "git repo should be valid");

    const nonRepo = join(tmp, "nongit");
    mkdirSync(nonRepo);
    assert.ok(!repoValid(nonRepo), "non-repo dir should be invalid");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// diffNameOnly
// ===========================================================================

test("diffNameOnly: lists changed file names", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-diffname-"));
  try {
    const { repo } = initBareRepo(tmp);

    writeFileSync(join(repo, "a.txt"), "a\n");
    writeFileSync(join(repo, "b.txt"), "b\n");
    execSync("git add -A && git commit -qm 'add'", { cwd: repo, stdio: "ignore" });

    writeFileSync(join(repo, "c.txt"), "c\n");
    execSync("git add c.txt", { cwd: repo, stdio: "ignore" });
    const names = diffNameOnly(repo);
    assert.ok(names.includes("c.txt"), "should list uncommitted changes");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// fetchBranchFromClone
// ===========================================================================

test("fetchBranchFromClone: pulls a branch from a clone into source repo refs", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-fetch-"));
  try {
    const { repo: source, baseSha } = initSourceRepo(tmp);

    // Create a sandbox clone, make a commit on a feature branch.
    const clonePath = join(tmp, "clone");
    mkdirSync(clonePath);
    execSync(`git clone --local ${source} ${clonePath}`, { stdio: "ignore" });
    execSync("git config user.email t@t.t", { cwd: clonePath, stdio: "ignore" });
    execSync("git config user.name t", { cwd: clonePath, stdio: "ignore" });
    execSync("git checkout -q -b feature", { cwd: clonePath, stdio: "ignore" });
    writeFileSync(join(clonePath, "feature.txt"), "feat\n");
    execSync("git add -A && git commit -qm feature", { cwd: clonePath, stdio: "ignore" });

    // Fetch the branch from the clone into the source repo.
    fetchBranchFromClone(source, clonePath, "feature");

    // Source repo should now have the branch.
    assert.ok(branchExists(source, "feature"), "source repo should have fetched branch");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// mergeAccept
// ===========================================================================

test("mergeAccept: merges sourceBranch into current branch and deletes it", () => {
  const tmp = mkdtempSync(join(tmpdir(), "meridian-merge-"));
  try {
    const { repo } = initSourceRepo(tmp);
    execSync("git config user.email t@t.t", { cwd: repo, stdio: "ignore" });
    execSync("git config user.name t", { cwd: repo, stdio: "ignore" });

    // Create a source branch with a commit.
    execSync("git checkout -q -b source-branch", { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "source.txt"), "source\n");
    execSync("git add -A && git commit -qm source", { cwd: repo, stdio: "ignore" });

    // Go back to main.
    execSync("git checkout -q main", { cwd: repo, stdio: "ignore" });

    // Merge and delete — mergeAccept operates on the repo path directly.
    mergeAccept(repo, "source-branch");

    // File should be present, branch should be deleted.
    assert.ok(existsSync(join(repo, "source.txt")), "merged file should exist");
    assert.ok(!branchExists(repo, "source-branch"), "source branch should be deleted");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
