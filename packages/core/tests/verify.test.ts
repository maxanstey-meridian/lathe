import { deepStrictEqual, equal, ok } from "node:assert";
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

test("runAutoFix: completion is reported outside the isolated presentation observer", async () => {
  const wt = tempWorktree();
  try {
    const results: Array<{ command: string; exitCode: number }> = [];
    await makeVerify().runAutoFix([{ command: "printf fixed" }], ["src/file.ts"], wt, 5_000, {
      onEvent: () => {
        throw new Error("presentation failed");
      },
      onResult: (result) => results.push(result),
    });
    deepStrictEqual(
      results.map(({ exitCode }) => exitCode),
      [0],
    );
  } finally {
    cleanup(wt);
  }
});

test("runAutoFix: cancellation prevents later commands from starting", async () => {
  const wt = tempWorktree();
  try {
    const controller = new AbortController();
    const running = makeVerify().runAutoFix(
      [{ command: "/bin/sh -c 'sleep 5'" }, { command: "touch must-not-exist" }],
      ["src/file.ts"],
      wt,
      5_000,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 30);
    await running;
    equal(existsSync(join(wt, "must-not-exist")), false);
  } finally {
    cleanup(wt);
  }
});

test("run: streams stdout before command completion", async () => {
  const wt = tempWorktree();
  try {
    let settled = false;
    let firstChunk: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => {
      firstChunk = resolve;
    });
    const running = makeVerify()
      .run([{ command: "printf first; sleep 0.2; printf second" }], wt, 5_000, {
        onEvent: (event) => {
          if (event.kind === "output") {
            firstChunk?.();
          }
        },
      })
      .finally(() => {
        settled = true;
      });

    await observed;
    equal(settled, false, "first chunk is observable while the process is still running");
    const [result] = await running;
    equal(result?.outputTail, "firstsecond");
  } finally {
    cleanup(wt);
  }
});

test("run: tags stdout and stderr and emits one terminal event", async () => {
  const wt = tempWorktree();
  try {
    const events: Array<{ kind: string; stream?: string; exitCode?: number }> = [];
    const [result] = await makeVerify().run(
      [{ command: "printf out; printf err >&2; exit 7" }],
      wt,
      5_000,
      { onEvent: (event) => events.push(event) },
    );

    equal(result?.exitCode, 7);
    deepStrictEqual(
      events
        .filter((event) => event.kind === "output")
        .map((event) => event.stream)
        .sort(),
      ["stderr", "stdout"],
    );
    deepStrictEqual(
      events.filter((event) => event.kind === "finished").map((event) => event.exitCode),
      [7],
    );
  } finally {
    cleanup(wt);
  }
});

test("run: timeout returns 124 and cancellation returns 130", async () => {
  const wt = tempWorktree();
  try {
    const timeoutEvents: Array<{ kind: string; timedOut?: boolean }> = [];
    const [timedOut] = await makeVerify().run([{ command: "sleep 5" }], wt, 30, {
      onEvent: (event) => timeoutEvents.push(event),
    });
    equal(timedOut?.exitCode, 124);
    equal(timeoutEvents.find((event) => event.kind === "finished")?.timedOut, true);

    const controller = new AbortController();
    const cancelled = makeVerify().run([{ command: "sleep 5" }], wt, 5_000, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 30);
    equal((await cancelled)[0]?.exitCode, 130);
  } finally {
    cleanup(wt);
  }
});

test("run: the first termination cause wins while process-group cleanup is pending", async () => {
  const wt = tempWorktree();
  try {
    const cancellation = new AbortController();
    const cancelled = makeVerify().run([{ command: "trap '' TERM; sleep 5" }], wt, 80, {
      signal: cancellation.signal,
    });
    setTimeout(() => cancellation.abort(), 20);
    equal((await cancelled)[0]?.exitCode, 130);

    const lateCancellation = new AbortController();
    const timedOut = makeVerify().run([{ command: "trap '' TERM; sleep 5" }], wt, 20, {
      signal: lateCancellation.signal,
    });
    setTimeout(() => lateCancellation.abort(), 80);
    equal((await timedOut)[0]?.exitCode, 124);
  } finally {
    cleanup(wt);
  }
});

test("run: cancellation escalates to kill a SIGTERM-resistant descendant", async () => {
  const wt = tempWorktree();
  let descendantPid: number | undefined;
  try {
    const controller = new AbortController();
    const running = makeVerify().run(
      [
        {
          command:
            "(trap '' TERM; while true; do sleep 1; done) </dev/null >/dev/null 2>&1 & echo $! > descendant.pid; wait",
        },
      ],
      wt,
      5_000,
      { signal: controller.signal },
    );
    const pidPath = join(wt, "descendant.pid");
    for (let attempt = 0; attempt < 100 && !existsSync(pidPath); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    ok(existsSync(pidPath), "descendant pid should be recorded before cancellation");
    descendantPid = Number.parseInt(readFileSync(pidPath, "utf8"), 10);
    controller.abort();
    equal((await running)[0]?.exitCode, 130);
    await new Promise((resolve) => setTimeout(resolve, 700));
    let alive = true;
    try {
      process.kill(descendantPid, 0);
    } catch {
      alive = false;
    }
    equal(alive, false, "SIGKILL escalation removes the descendant process group");
  } finally {
    if (descendantPid) {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // Already terminated as expected.
      }
    }
    cleanup(wt);
  }
});

test("run: a command that exits before the deadline is not misclassified while descendants hold pipes", async () => {
  const wt = tempWorktree();
  try {
    const [result] = await makeVerify().run([{ command: "sleep 1 & disown; exit 0" }], wt, 50);
    equal(result?.exitCode, 0);
  } finally {
    cleanup(wt);
  }
});

test("run: abort after process exit does not reclassify success as cancellation", async () => {
  const wt = tempWorktree();
  try {
    const controller = new AbortController();
    const running = makeVerify().run([{ command: "sleep 1 & disown; exit 0" }], wt, 5_000, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 150);
    equal((await running)[0]?.exitCode, 0);
  } finally {
    cleanup(wt);
  }
});

test("run: repeated commands get distinct IDs, preserve input order, and ignore observer failures", async () => {
  const wt = tempWorktree();
  try {
    const ids: string[] = [];
    const results = await makeVerify().run(
      [{ command: "sleep 0.05; printf one" }, { command: "printf two" }],
      wt,
      5_000,
      {
        onEvent: (event) => {
          if (event.kind === "started") {
            ids.push(event.commandId);
          }
          if (event.kind === "output") {
            throw new Error("presentation failed");
          }
        },
      },
    );

    equal(new Set(ids).size, 2);
    deepStrictEqual(
      results.map((result) => result.command),
      ["sleep 0.05; printf one", "printf two"],
    );
    deepStrictEqual(
      results.map((result) => result.exitCode),
      [0, 0],
    );
  } finally {
    cleanup(wt);
  }
});
