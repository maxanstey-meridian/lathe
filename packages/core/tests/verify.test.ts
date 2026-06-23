import { equal, ok } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Verify } from "../src/application/ports/verify.js";
import { createVerify } from "../src/infrastructure/verify.js";

// ---------------------------------------------------------------------------
// Helpers

const makeVerify = (): Verify => createVerify();

const tempWorktree = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "verify-test-"));
  return dir;
};

const cleanup = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — test already passed.
  }
};

// ---------------------------------------------------------------------------
// (a) no-op when commands empty

test("runAutoFix: no-op when commands empty", async () => {
  const wt = tempWorktree();
  try {
    let threw = false;
    try {
      await makeVerify().runAutoFix([], ["src/index.ts"], wt, 60_000);
    } catch {
      threw = true;
    }
    equal(threw, false, "should not throw with empty commands");
  } finally {
    cleanup(wt);
  }
});

// ---------------------------------------------------------------------------
// (b) no-op when expectedSurface empty

test("runAutoFix: no-op when expectedSurface empty", async () => {
  const wt = tempWorktree();
  try {
    let threw = false;
    try {
      await makeVerify().runAutoFix([{ command: "echo hi" }], [], wt, 60_000);
    } catch {
      threw = true;
    }
    equal(threw, false, "should not throw with empty surface");
  } finally {
    cleanup(wt);
  }
});

// ---------------------------------------------------------------------------
// (c) real command executes against surface files (observable side-effect)

test("runAutoFix: executes command and touches surface files", async () => {
  const wt = tempWorktree();
  try {
    // Create a file inside the surface glob.
    const srcDir = join(wt, "src");
    mkdirSync(srcDir);
    const targetFile = join(srcDir, "hello.ts");
    writeFileSync(targetFile, "// old\n", "utf-8");

    // Run touch — creates a marker file inside src/ (matches "src/**" glob).
    await makeVerify().runAutoFix([{ command: "touch src/marker.txt" }], ["src/**"], wt, 60_000);

    ok(existsSync(join(srcDir, "marker.txt")), "marker.txt should exist after runAutoFix");
  } finally {
    cleanup(wt);
  }
});

// ---------------------------------------------------------------------------
// (d) failing command is swallowed (no throw escapes)

test("runAutoFix: failing command is swallowed", async () => {
  const wt = tempWorktree();
  try {
    let threw = false;
    try {
      await makeVerify().runAutoFix(
        [{ command: "cat /nonexistent/file/that/does/not/exist --fix" }],
        ["src/**/*.ts"],
        wt,
        60_000,
      );
    } catch {
      threw = true;
    }
    equal(threw, false, "runAutoFix should swallow command failures");
  } finally {
    cleanup(wt);
  }
});

// ---------------------------------------------------------------------------
// (e) single-quote in path is shell-escaped — surface arg reaches node correctly

test("runAutoFix: single-quote in path is shell-escaped", async () => {
  const wt = tempWorktree();
  try {
    // Create a directory with a single-quote in its name and a file inside.
    const quotedDir = join(wt, "it's");
    mkdirSync(quotedDir);
    const targetFile = join(quotedDir, "target.txt");
    writeFileSync(targetFile, "found\n", "utf-8");

    // The harness appends surface args to the end of the command string.
    // With proper escaping, the full shell string is:
    //   node -e "..." 'it'\''s/target.txt'
    // zsh parses the '\'' quoting and passes it as a single argument
    // to node: ["it's/target.txt"]
    // With broken escaping (e.g. literal 'it's/target.txt'), zsh sees
    // an unterminated quote and the command errors (swallowed).
    await makeVerify().runAutoFix(
      [
        {
          command: `node -e "const fs=require('fs');fs.writeFileSync('found.txt',fs.existsSync(process.argv[1])?'y':'n')"`,
        },
      ],
      ["it's/target.txt"],
      wt,
      60_000,
    );

    const resultFile = join(wt, "found.txt");
    ok(existsSync(resultFile), "node should receive escaped path as single argument");
    equal(readFileSync(resultFile, "utf-8"), "y", "file should exist at escaped path");
  } finally {
    cleanup(wt);
  }
});
