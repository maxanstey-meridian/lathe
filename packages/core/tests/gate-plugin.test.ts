// Gate plugin coverage: active-run.json array selection by sessionID and
// per-session latch isolation. Because gate-core.ts computes STATE_ROOT from
// homedir() at module load, these tests use dynamic import after setting HOME.

import { equal, strictEqual, ok } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// Helpers

// ---------------------------------------------------------------------------
// editTargetOutOfSurface — live plugin copy regression tests
// These exercise gate-core.ts directly (not the shared helper in gate-tools.ts)
// to catch future drift between the two copies.

test("gate-core: editTargetOutOfSurface blocks relative path climbing out", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gate-core-edit-"));
  const homeBack = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const { editTargetOutOfSurface } = await import("../plugin/gate-core.ts");

    const worktree = join(tmp, "worktree");

    // Relative climb via ".." — blocked
    strictEqual(editTargetOutOfSurface("edit", { filePath: ".." }, worktree), "..");

    // Relative climb via "../" — blocked
    strictEqual(
      editTargetOutOfSurface("edit", { filePath: "../other/file.ts" }, worktree),
      "../other/file.ts",
    );

    // Relative path that stays inside (bare ".") — allowed
    strictEqual(editTargetOutOfSurface("edit", { filePath: "." }, worktree), undefined);

    // Dotted filename like "..foo" — allowed (not a climb)
    strictEqual(editTargetOutOfSurface("edit", { filePath: "..foo" }, worktree), undefined);
  } finally {
    process.env.HOME = homeBack;
  }
});

// ---------------------------------------------------------------------------
// activeRun — array selection by sessionID

test("gate-plugin: activeRun selects matching babySessionId from array", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gate-active-"));
  const homeBack = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const runDir = join(tmp, "runs", "20260101-000000-a");
    const worktree = join(tmp, "worktree");
    const runs = [
      {
        runId: "20260101-000000-a",
        runDir,
        worktree,
        babySessionId: "sess-alpha",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        runId: "20260101-000000-b",
        runDir: join(tmp, "runs", "20260101-000000-b"),
        worktree,
        babySessionId: "sess-beta",
        startedAt: "2026-01-01T00:00:01.000Z",
      },
    ];
    const meridianDir = join(tmp, ".meridian", "v3");
    mkdirSync(meridianDir, { recursive: true });
    writeFileSync(join(meridianDir, "active-run.json"), JSON.stringify(runs));

    const { activeRun } = await import("../plugin/gate-core.ts");
    const alpha = activeRun("sess-alpha");
    ok(alpha);
    equal(alpha.babySessionId, "sess-alpha");
    equal(alpha.runId, "20260101-000000-a");
    const beta = activeRun("sess-beta");
    ok(beta);
    equal(beta.babySessionId, "sess-beta");
    equal(beta.runId, "20260101-000000-b");
    const unknown = activeRun("sess-gamma");
    strictEqual(unknown, undefined);
  } finally {
    process.env.HOME = homeBack;
  }
});

test("gate-plugin: activeRun returns empty array content as undefined", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gate-empty-"));
  const homeBack = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const meridianDir = join(tmp, ".meridian", "v3");
    mkdirSync(meridianDir, { recursive: true });
    writeFileSync(join(meridianDir, "active-run.json"), "[]");
    const { activeRun } = await import("../plugin/gate-core.ts");
    strictEqual(activeRun("any-session"), undefined);
  } finally {
    process.env.HOME = homeBack;
  }
});

// ---------------------------------------------------------------------------
// guard — per-session latch isolation (observable via hook behavior)

test("gate-plugin: tool.execute.after volume reminder is keyed by sessionID", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gate-volume-"));
  const homeBack = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const meridianDir = join(tmp, ".meridian", "v3");
    mkdirSync(meridianDir, { recursive: true });

    const runA = {
      runId: "20260101-000000-a",
      runDir: join(tmp, "runs", "20260101-000000-a"),
      worktree: join(tmp, "worktree-a"),
      babySessionId: "sess-a",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const runB = {
      runId: "20260101-000000-b",
      runDir: join(tmp, "runs", "20260101-000000-b"),
      worktree: join(tmp, "worktree-b"),
      babySessionId: "sess-b",
      startedAt: "2026-01-01T00:00:01.000Z",
    };
    mkdirSync(runA.runDir, { recursive: true });
    mkdirSync(runB.runDir, { recursive: true });
    writeFileSync(join(meridianDir, "active-run.json"), JSON.stringify([runA, runB]));

    const gateState = {
      runId: runA.runId,
      phase: { phase: "cleared" },
      expectedGlobs: ["src/**"],
      baselineDiffStats: {},
      checkpointToolCalls: 2,
      mutationCommandPatterns: [],
      updatedAt: "2026-01-01T00:00:00Z",
    };
    writeFileSync(join(runA.runDir, "gate-state.json"), JSON.stringify(gateState));
    writeFileSync(join(runB.runDir, "gate-state.json"), JSON.stringify(gateState));

    const { default: GatePlugin } = await import("../plugin/gate-plugin.ts");
    const plugin = await GatePlugin(null);
    const afterHook = plugin["tool.execute.after"] as
      | ((input: unknown, output: unknown) => Promise<void>)
      | undefined;
    ok(afterHook, "after hook exists");

    const outputA1 = { output: "ok" };
    await afterHook!({ tool: "Read", sessionID: "sess-a", callID: "a-1", args: {} }, outputA1);
    strictEqual(outputA1.output, "ok");

    const outputB1 = { output: "ok" };
    await afterHook!({ tool: "Read", sessionID: "sess-b", callID: "b-1", args: {} }, outputB1);
    strictEqual(outputB1.output, "ok");

    const outputA2 = { output: "ok" };
    await afterHook!({ tool: "Read", sessionID: "sess-a", callID: "a-2", args: {} }, outputA2);
    ok(outputA2.output.includes("LATHE GATE BLOCKED"), outputA2.output);
    ok(outputA2.output.includes("2 tool calls"), outputA2.output);

    const outputB2 = { output: "ok" };
    await afterHook!({ tool: "Read", sessionID: "sess-b", callID: "b-2", args: {} }, outputB2);
    ok(outputB2.output.includes("LATHE GATE BLOCKED"), outputB2.output);
    ok(outputB2.output.includes("2 tool calls"), outputB2.output);
  } finally {
    process.env.HOME = homeBack;
  }
});

test("gate-plugin: memory latch does not leak across sessionID", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "gate-latch-"));
  const homeBack = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const runDirA = join(tmp, "runs", "20260101-000000-a");
    const worktree = join(tmp, "worktree");
    const runA = {
      runId: "20260101-000000-a",
      runDir: runDirA,
      worktree,
      babySessionId: "sess-a",
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    const meridianDir = join(tmp, ".meridian", "v3");
    mkdirSync(meridianDir, { recursive: true });
    mkdirSync(runDirA, { recursive: true });
    writeFileSync(join(meridianDir, "active-run.json"), JSON.stringify([runA]));
    writeFileSync(
      join(runDirA, "gate-state.json"),
      JSON.stringify({
        runId: runA.runId,
        phase: { phase: "cleared" },
        expectedGlobs: ["src/**"],
        baselineDiffStats: {},
        mutationCommandPatterns: [],
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );

    const { default: GatePlugin } = await import("../plugin/gate-plugin.ts");
    const plugin = await GatePlugin(null);
    const beforeHook = plugin["tool.execute.before"] as
      | ((input: unknown, output: unknown) => Promise<void>)
      | undefined;
    const afterHook = plugin["tool.execute.after"] as
      | ((input: unknown, output: unknown) => Promise<void>)
      | undefined;
    const permissionHook = plugin["permission.ask"] as
      | ((input: unknown, output: unknown) => Promise<void>)
      | undefined;
    ok(beforeHook, "before hook exists");
    ok(afterHook, "after hook exists");
    ok(permissionHook, "permission hook exists");

    // Call the before hook with sess-a asking a question — should throw
    const callID = "call-1";
    let threw = false;
    try {
      await beforeHook!({ tool: "AskQuestion", sessionID: "sess-a", callID }, { args: {} });
    } catch (e) {
      threw = true;
      strictEqual(
        (e as Error).message,
        'LATHE GATE BLOCKED: interactive questions are disabled. Route implementation, architecture, procedure, and scope questions to meridian-bridge_ask_planner. Route decisions owned by the Human Operator through meridian-bridge_submit_report with status "blocked" and the exact question.',
      );
    }
    ok(threw, "sess-a question should throw");

    // Call the before hook with sess-b asking a question — should NOT throw (no latch for sess-b)
    threw = false;
    try {
      await beforeHook!({ tool: "AskQuestion", sessionID: "sess-b", callID }, { args: {} });
    } catch {
      threw = true;
    }
    strictEqual(threw, false, "sess-b should not be affected by sess-a latch");
  } finally {
    process.env.HOME = homeBack;
  }
});
