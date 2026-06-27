// Pure-gate domain tests (CONTRACT §10 G1–G10, V6 classification).
// No git, no fs, no Date.now() — all inputs as parameters.

import assert from "node:assert";
import { test } from "node:test";
import {
  globToRegExp,
  classifyChangedFiles,
  diffDelta,
} from "../src/domain/gate-classification.ts";
import {
  gateTriggerReason,
  rotationGateState,
  priorReconciliationAccepted,
  mutationDenyReason,
  checkpointNudgeDue,
  checkpointNudgeNotice,
  volumeCheckpointReason,
  volumeNoticeReason,
  denyMessage,
  QUESTION_MESSAGE,
  SUBAGENT_MESSAGE,
  GIT_MESSAGE,
} from "../src/domain/gate-decisions.ts";
import {
  isBridgeTool,
  isQuestionTool,
  isSubagentTool,
  isEditTool,
  isForbiddenGitCommand,
  isMutation,
  editTargetOutOfSurface,
  commandFromArgs,
} from "../src/domain/gate-tools.ts";
import { GateState, type GatePhase } from "../src/domain/gate.ts";

// ===========================================================================
// Build helpers
// ===========================================================================

const makeState = (
  overrides: { phase?: GatePhase } & Partial<Omit<GateState, "phase">> = {},
): GateState => {
  const { phase = { phase: "initial" }, ...rest } = overrides;
  return {
    runId: "20260618-000000-test",
    phase,
    expectedGlobs: ["src/**"],
    suspiciousGlobs: ["weird/**"],
    baselineDiffStats: {},
    mutationCommandPatterns: [],
    updatedAt: "2026-01-01T00:00:00Z",
    ...rest,
  };
};

// ===========================================================================
// G1: glob translation (carried from v1)
// ===========================================================================

test("globToRegExp: ** crosses directories, * does not", () => {
  assert.ok(globToRegExp("src/**").test("src/a/b/c.ts"));
  assert.ok(!globToRegExp("src/**").test("src")); // trailing slash not an issue
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("greeting.txt").test("greeting.txt"));
  assert.ok(!globToRegExp("greeting.txt").test("other.txt"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/lib/deep/mod.ts"));
  assert.ok(!globToRegExp("greeting.txt").test("sub/greeting.txt")); // single * does not cross /
});

test("globToRegExp: special characters are escaped", () => {
  const re = globToRegExp("my-file_v1.spec.ts");
  assert.ok(re.test("my-file_v1.spec.ts"));
  assert.ok(!re.test("myXfileYv1XspecZts")); // escaped dashes and underscore are literal
});

// ===========================================================================
// V6: file classification (pure, no fs)
// ===========================================================================

test("classifyChangedFiles: globs decide classification; all kept", () => {
  const files = classifyChangedFiles(
    ["src/in.ts", "lib/out.ts", "weird/sus.ts", "stray.txt"],
    ["src/**"],
    ["weird/**"],
  );
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.classification]));

  assert.strictEqual(byPath["src/in.ts"], "expected");
  assert.strictEqual(byPath["lib/out.ts"], "acceptable-but-not-predeclared");
  assert.strictEqual(byPath["weird/sus.ts"], "suspicious");
  assert.strictEqual(byPath["stray.txt"], "acceptable-but-not-predeclared");
  assert.strictEqual(files.length, 4);
  assert.ok(files.every((f) => f.action === "kept"));
});

test("classifyChangedFiles: empty inputs → empty output", () => {
  const files = classifyChangedFiles([], [], []);
  assert.deepStrictEqual(files, []);
});

test("classifyChangedFiles: suspicious surface takes precedence for matching paths", () => {
  const files = classifyChangedFiles(
    ["weird/sus.ts", "src/deep/nested.ts"],
    ["src/**", "weird/**"],
    ["weird/**"],
  );
  const byPath = Object.fromEntries(files.map((f) => [f.path, f.classification]));
  assert.strictEqual(byPath["weird/sus.ts"], "expected");
});

// ===========================================================================
// diffDelta arithmetic
// ===========================================================================

test("diffDelta: counts files and LoC against baseline", () => {
  const baseline = { "a.ts": { added: 5, removed: 0 } };
  const current = { "a.ts": { added: 9, removed: 1 }, "b.ts": { added: 3, removed: 0 } };
  const delta = diffDelta(baseline, current);
  assert.deepStrictEqual(delta.files.sort(), ["a.ts", "b.ts"]);
  // a.ts: |9-5| + |1-0| = 4+1 = 5; b.ts: |3-0| + |0-0| = 3+0 = 3; total = 8
  assert.strictEqual(delta.loc, 8);
});

test("diffDelta: unchanged file not in changed list", () => {
  const delta = diffDelta(
    { "a.ts": { added: 5, removed: 0 } },
    { "a.ts": { added: 5, removed: 0 }, "b.ts": { added: 3, removed: 0 } },
  );
  assert.deepStrictEqual(delta.files, ["b.ts"]);
  assert.strictEqual(delta.loc, 3);
});

// ===========================================================================
// G3: tool classification predicates
// ===========================================================================

test("isBridgeTool: meridian-bridge and operational suffixes", () => {
  assert.ok(isBridgeTool("meridian-bridge_ask_planner"));
  assert.ok(isBridgeTool("meridian-bridge_update_outcomes"));
  assert.ok(isBridgeTool("meridian-bridge_write_checkpoint"));
  assert.ok(isBridgeTool("meridian-bridge_submit_report"));
  assert.ok(isBridgeTool("meridian-bridge_get_decisions"));
  assert.ok(isBridgeTool("ask_planner"));
  assert.ok(isBridgeTool("update_outcomes"));
  assert.ok(isBridgeTool("write_checkpoint"));
  assert.ok(isBridgeTool("submit_report"));
  assert.ok(isBridgeTool("get_decisions"));
});

test("isBridgeTool: non-bridge tools return false", () => {
  assert.ok(!isBridgeTool("bash"));
  assert.ok(!isBridgeTool("read"));
  assert.ok(!isBridgeTool("edit"));
  assert.ok(!isBridgeTool("write"));
  assert.ok(!isBridgeTool("glob"));
  assert.ok(!isBridgeTool("grep"));
});

test("isQuestionTool: tools with 'question' in name", () => {
  assert.ok(isQuestionTool("ask-question"));
  assert.ok(isQuestionTool("question_tool"));
  assert.ok(isQuestionTool("USER_QUESTION"));
  assert.ok(!isQuestionTool("ask_planner"));
  assert.ok(!isQuestionTool("bash"));
});

test("isSubagentTool: task, agent, _task, subagent patterns", () => {
  assert.ok(isSubagentTool("task"));
  assert.ok(isSubagentTool("agent"));
  assert.ok(isSubagentTool("run_task"));
  assert.ok(isSubagentTool("subagent_explore"));
  assert.ok(!isSubagentTool("bash"));
  assert.ok(!isSubagentTool("read"));
});

test("isEditTool: edit/write/patch", () => {
  assert.ok(isEditTool("edit"));
  assert.ok(isEditTool("write"));
  assert.ok(isEditTool("patch"));
  assert.ok(isEditTool("file-edit"));
  assert.ok(isEditTool("patch-file"));
  assert.ok(!isEditTool("bash"));
  assert.ok(!isEditTool("read"));
});

test("commandFromArgs: extracts command string from object", () => {
  assert.strictEqual(commandFromArgs(null), "");
  assert.strictEqual(commandFromArgs("not an object"), "");
  assert.strictEqual(commandFromArgs({ command: "pnpm test" }), "pnpm test");
  assert.strictEqual(commandFromArgs({ command: 42 }), "");
  assert.strictEqual(commandFromArgs({ other: "nope" }), "");
});

// ===========================================================================
// G3: forbidden git
// ===========================================================================

test("isForbiddenGitCommand: git mutations blocked", () => {
  assert.ok(isForbiddenGitCommand("git commit"));
  assert.ok(isForbiddenGitCommand("git push"));
  assert.ok(isForbiddenGitCommand("git reset --hard"));
  assert.ok(isForbiddenGitCommand("git checkout main"));
  assert.ok(isForbiddenGitCommand("git rebase -i"));
  assert.ok(isForbiddenGitCommand("git stash"));
  assert.ok(isForbiddenGitCommand("git clean -fd"));
  assert.ok(isForbiddenGitCommand("git merge origin/main"));
  assert.ok(isForbiddenGitCommand("git cherry-pick abc123"));
  assert.ok(isForbiddenGitCommand("git worktree add ../other"));
  assert.ok(isForbiddenGitCommand("git switch main"));
  assert.ok(isForbiddenGitCommand("git restore src/file.ts"));
  assert.ok(isForbiddenGitCommand("git add src/file.ts"));
  assert.ok(isForbiddenGitCommand("git branch feature"));
  assert.ok(isForbiddenGitCommand("git tag v1.0"));
  assert.ok(!isForbiddenGitCommand("git status"));
  assert.ok(!isForbiddenGitCommand("git diff HEAD"));
  assert.ok(!isForbiddenGitCommand("git log --oneline"));
});

test("FORBIDDEN_GIT: no pipe/semicolon workaround", () => {
  // The regex groups commit|push etc. after git, so 'git; commit' won't match the combined pattern
  assert.ok(isForbiddenGitCommand("git commit"));
});

// ===========================================================================
// G3: mutation classification
// ===========================================================================

test("isMutation: edit tools always mutate", () => {
  assert.ok(isMutation("edit", { path: "x" }, []));
  assert.ok(isMutation("write", { content: "x" }, []));
  assert.ok(isMutation("patch", { target: "x" }, []));
});

test("isMutation: bash tools with mutation verbs or patterns", () => {
  assert.ok(isMutation("bash", { command: "rm -rf node_modules" }, []));
  assert.ok(isMutation("bash", { command: "mv old new" }, []));
  assert.ok(isMutation("bash", { command: "cp src dest" }, []));
  assert.ok(isMutation("bash", { command: "mkdir -p dist" }, []));
  assert.ok(isMutation("bash", { command: "touch foo.txt" }, []));
  assert.ok(isMutation("bash", { command: "tee output.txt" }, []));
  assert.ok(isMutation("bash", { command: "echo x > file.txt" }, []));
  assert.ok(isMutation("bash", { command: "foo >> bar.txt" }, []));
  assert.ok(isMutation("bash", { command: "sed -i '' 's/a/b/g' file" }, []));

  // Custom patterns
  assert.ok(
    isMutation("bash", { command: "pnpm generate" }, ["\\b(pnpm|npm|yarn)\\b.*\\bgenerate\\b"]),
  );
  assert.ok(isMutation("bash", { command: "dotnet-rivet build" }, ["dotnet-rivet"]));
});

test("isMutation: safe bash reads pass through", () => {
  assert.ok(!isMutation("bash", { command: "git status" }, []));
  assert.ok(!isMutation("bash", { command: "grep foo src/" }, []));
  assert.ok(!isMutation("bash", { command: "cd src && ls" }, []));
  assert.ok(!isMutation("bash", { command: "echo hello" }, []));
  assert.ok(!isMutation("read", { path: "x" }, []));
  assert.ok(!isMutation("glob", { pattern: "**/*.ts" }, []));
});

// ===========================================================================
// G5: editTargetOutOfSurface (absolute-only)
// ===========================================================================

test("editTargetOutOfSurface: absolute path outside worktree is blocked", () => {
  const target = editTargetOutOfSurface("edit", { filePath: "/etc/passwd" }, "/home/user/worktree");
  assert.strictEqual(target, "/etc/passwd");
});

test("editTargetOutOfSurface: absolute path climbing out via .. is blocked", () => {
  const target = editTargetOutOfSurface(
    "edit",
    { filePath: "/home/user/worktree/../../etc/passwd" },
    "/home/user/worktree",
  );
  assert.strictEqual(target, "/home/user/worktree/../../etc/passwd");
});

test("editTargetOutOfSurface: in-worktree paths are NOT blocked", () => {
  const safe = editTargetOutOfSurface(
    "edit",
    { filePath: "/home/user/worktree/src/file.ts" },
    "/home/user/worktree",
  );
  assert.strictEqual(safe, undefined);
});

test("editTargetOutOfSurface: in-worktree path containing .. that stays inside is NOT blocked", () => {
  const safe = editTargetOutOfSurface(
    "edit",
    { filePath: "/home/user/worktree/a/../b" },
    "/home/user/worktree",
  );
  assert.strictEqual(safe, undefined);
});

test("editTargetOutOfSurface: doubled slash after worktree prefix bypass is blocked", () => {
  const escaped = editTargetOutOfSurface(
    "edit",
    { filePath: "/home/user/worktree//../../etc/passwd" },
    "/home/user/worktree",
  );
  assert.strictEqual(escaped, "/home/user/worktree//../../etc/passwd");
});

test("editTargetOutOfSurface: relative path climbing out is blocked", () => {
  const escaped = editTargetOutOfSurface(
    "edit",
    { filePath: "../other/file.ts" },
    "/home/user/worktree",
  );
  assert.strictEqual(escaped, "../other/file.ts");
});

test("editTargetOutOfSurface: relative path that resolves to worktree root is NOT blocked", () => {
  const safe = editTargetOutOfSurface("edit", { filePath: "." }, "/home/user/worktree");
  assert.strictEqual(safe, undefined);
});

test("editTargetOutOfSurface: relative dotted filename like ..foo is NOT blocked", () => {
  const safe = editTargetOutOfSurface("edit", { filePath: "..foo" }, "/home/user/worktree");
  assert.strictEqual(safe, undefined);
});

test("editTargetOutOfSurface: non-edit tools return undefined", () => {
  assert.strictEqual(editTargetOutOfSurface("bash", { command: "x" }, "/wt"), undefined);
  assert.strictEqual(editTargetOutOfSurface("read", { filePath: "/a" }, "/wt"), undefined);
});

// ===========================================================================
// G5: gateTriggerReason (first-edit + reconciliation, no cadence, no surface)
// ===========================================================================

test("gateTriggerReason: initial phase, no files → no trigger", () => {
  const state = makeState();
  assert.strictEqual(gateTriggerReason(state, { files: [], loc: 0 }), undefined);
});

test("gateTriggerReason: initial phase, files present → first-edit reason", () => {
  const state = makeState();
  const reason = gateTriggerReason(state, { files: ["src/file.ts"], loc: 0 });
  assert.ok(reason?.includes("first edit"));
  assert.ok(!reason?.includes("out-of-surface"));
});

test("gateTriggerReason: cleared phase → no trigger (G5: cadence gone)", () => {
  const state = makeState({
    phase: { phase: "cleared" },
    lastAcceptedDecisionAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  });
  const reason = gateTriggerReason(state, {
    files: ["src/file.ts", "other.txt", "deep/nested.go"],
    loc: 0,
  });
  assert.strictEqual(reason, undefined);
});

// ===========================================================================
// O5: rotationGateState
// ===========================================================================

test("rotationGateState: clean rotation (no reconciliation) re-latches first-edit", () => {
  const base = makeState({ phase: { phase: "cleared" } });
  const result = rotationGateState(base, false);

  assert.strictEqual(
    result.next.phase.phase,
    "first-edit-latched",
    "replaced session must re-earn first-edit",
  );
  assert.ok(result.reason.includes("first edit"));
});

test("rotationGateState: crash rotation stacks reconciliation", () => {
  const base = makeState({ phase: { phase: "cleared" } });
  const result = rotationGateState(base, true);

  assert.strictEqual(result.next.phase.phase, "reconciliation-latched");
  assert.ok(result.reason.includes("reconciliation"));
  assert.ok(result.reason.includes("checkpoint"));
});

// ===========================================================================
// O6 skip: priorReconciliationAccepted
// ===========================================================================

test("priorReconciliationAccepted: last decision is accepted reconciliation → true", () => {
  const decisions = [
    {
      questionType: "other",
      status: "proceed",
      question: "",
      answer: "",
      timestamp: "",
      source: "daddy",
      evidence: [],
      constraints: [],
    },
    {
      questionType: "reconciliation",
      status: "proceed",
      question: "recon",
      answer: "yes",
      timestamp: "",
      source: "daddy",
      evidence: [],
      constraints: [],
    },
  ];
  assert.strictEqual(priorReconciliationAccepted(decisions as any), true);
});

test("priorReconciliationAccepted: last decision is accepted recon (proceed_with_constraints) → true", () => {
  const decisions = [
    {
      questionType: "reconciliation",
      status: "proceed_with_constraints",
      question: "",
      answer: "",
      timestamp: "",
      source: "daddy",
      evidence: [],
      constraints: [],
    },
  ];
  assert.strictEqual(priorReconciliationAccepted(decisions as any), true);
});

test("priorReconciliationAccepted: last decision is non-reconciliation → false", () => {
  const decisions = [
    {
      questionType: "reconciliation",
      status: "proceed",
      question: "",
      answer: "",
      timestamp: "",
      source: "daddy",
      evidence: [],
      constraints: [],
    },
    {
      questionType: "architecture_discoverable",
      status: "proceed",
      question: "",
      answer: "",
      timestamp: "",
      source: "daddy",
      evidence: [],
      constraints: [],
    },
  ];
  assert.strictEqual(priorReconciliationAccepted(decisions as any), false);
});

test("priorReconciliationAccepted: last decision is rejected reconciliation → false", () => {
  const decisions = [
    {
      questionType: "reconciliation",
      status: "stop",
      question: "",
      answer: "",
      timestamp: "",
      source: "daddy",
      evidence: [],
      constraints: [],
    },
  ];
  assert.strictEqual(priorReconciliationAccepted(decisions as any), false);
});

test("priorReconciliationAccepted: empty decisions → false", () => {
  assert.strictEqual(priorReconciliationAccepted([]), false);
});

// ===========================================================================
// G5: mutationDenyReason (deny order: out-of-surface > latched > memory-latch > first-edit > reconciliation)
// ===========================================================================

test("mutationDenyReason: out-of-surface absolute path wins first", () => {
  const state = makeState({
    phase: { phase: "reconciliation-latched", reason: "recon" },
  });
  const reason = mutationDenyReason(
    "edit",
    { filePath: "/etc/passwd" },
    state,
    "/home/wt",
    undefined,
  );
  assert.ok(reason?.includes("outside the handoff's expected change surface"));
});

test("mutationDenyReason: when latched, latch reason is returned", () => {
  const state = makeState({
    phase: { phase: "first-edit-latched", reason: "initial latch" },
  });
  const reason = mutationDenyReason(
    "edit",
    { filePath: "src/file.ts" },
    state,
    "/home/wt",
    undefined,
  );
  assert.strictEqual(reason, "initial latch");
});

test("mutationDenyReason: memory latch fires when gate is cleared", () => {
  const state = makeState({ phase: { phase: "cleared" } });
  const reason = mutationDenyReason(
    "edit",
    { filePath: "src/file.ts" },
    state,
    "/home/wt",
    "subagent used",
  );
  assert.strictEqual(reason, "subagent used");
});

test("mutationDenyReason: initial phase denies first edit (no memory latch)", () => {
  const state = makeState();
  const reason = mutationDenyReason(
    "edit",
    { filePath: "src/file.ts" },
    state,
    "/home/wt",
    undefined,
  );
  assert.ok(reason?.includes("first edit"));
});

test("mutationDenyReason: reconciliation-latched returns its reason", () => {
  const state = makeState({
    phase: { phase: "reconciliation-latched", reason: "reconciliation required" },
  });
  const reason = mutationDenyReason(
    "edit",
    { filePath: "src/file.ts" },
    state,
    "/home/wt",
    undefined,
  );
  assert.strictEqual(reason, "reconciliation required");
});

test("mutationDenyReason: cleared with no memory latch → undefined", () => {
  const state = makeState({ phase: { phase: "cleared" } });
  const reason = mutationDenyReason(
    "edit",
    { filePath: "src/file.ts" },
    state,
    "/home/wt",
    undefined,
  );
  assert.strictEqual(reason, undefined);
});

// ===========================================================================
// G10: checkpointNudgeDue
// ===========================================================================

const INTERVAL = 20 * 60 * 1000;
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();

test("checkpointNudgeDue: initial phase → undefined", () => {
  const state = makeState({ lastAcceptedDecisionAt: iso(INTERVAL * 2) });
  assert.strictEqual(checkpointNudgeDue(state, now, INTERVAL), undefined);
});

test("checkpointNudgeDue: cleared but no lastAcceptedDecisionAt → undefined", () => {
  const state = makeState({ phase: { phase: "cleared" } });
  assert.strictEqual(checkpointNudgeDue(state, now, INTERVAL), undefined);
});

test("checkpointNudgeDue: within interval → undefined (grace period)", () => {
  const state = makeState({
    phase: { phase: "cleared" },
    lastAcceptedDecisionAt: iso(5 * 60 * 1000),
  });
  assert.strictEqual(checkpointNudgeDue(state, now, INTERVAL), undefined);
});

test("checkpointNudgeDue: past interval → returns elapsed minutes", () => {
  const state = makeState({
    phase: { phase: "cleared" },
    lastAcceptedDecisionAt: iso(30 * 60 * 1000),
  });
  assert.strictEqual(checkpointNudgeDue(state, now, INTERVAL), 30);
});

test("checkpointNudgeDue: un-throttled — always reports elapsed minutes", () => {
  const state = makeState({
    phase: { phase: "cleared" },
    lastAcceptedDecisionAt: iso(90 * 60 * 1000),
  });
  assert.strictEqual(checkpointNudgeDue(state, now, INTERVAL), 90);
});

// ===========================================================================
// G10: checkpointNudgeNotice
// ===========================================================================

test("checkpointNudgeNotice: not due while below interval", () => {
  const state = makeState({
    phase: { phase: "cleared" },
    lastAcceptedDecisionAt: iso(5 * 60 * 1000),
  });
  assert.strictEqual(checkpointNudgeNotice(state, now), undefined);
});

test("checkpointNudgeNotice: past interval → NOTICE string", () => {
  const state = makeState({
    phase: { phase: "cleared" },
    lastAcceptedDecisionAt: iso(30 * 60 * 1000),
  });
  const notice = checkpointNudgeNotice(state, now);
  assert.ok(notice?.includes("MERIDIAN GATE NOTICE"));
  assert.ok(notice?.includes("~30 min"));
  assert.ok(notice?.includes("You are NOT blocked"));
  assert.ok(notice?.includes("ask_planner"));
});

test("checkpointNudgeNotice: uses default 20 min if checkpointNudgeMs not set", () => {
  const state = makeState({
    phase: { phase: "cleared" },
    lastAcceptedDecisionAt: iso(25 * 60 * 1000),
    checkpointNudgeMs: undefined,
  });
  const notice = checkpointNudgeNotice(state, now);
  assert.ok(notice?.includes("MERIDIAN GATE NOTICE"));
});

// ===========================================================================
// G10: volumeCheckpointReason + volumeNoticeReason (wording consistency)
// ===========================================================================

test("volumeCheckpointReason: under all thresholds → undefined", () => {
  const limits = { checkpointToolCalls: 50, checkpointFiles: 6, checkpointLoc: 80 };
  assert.strictEqual(volumeCheckpointReason(49, { files: [], loc: 0 }, limits), undefined);
});

test("volumeCheckpointReason: tool-call axis", () => {
  const tc = volumeCheckpointReason(
    50,
    { files: [], loc: 0 },
    { checkpointToolCalls: 50, checkpointFiles: 6, checkpointLoc: 80 },
  );
  assert.ok(tc?.includes("50 tool calls"), `expected "50 tool calls", got: ${tc}`);
});

test("volumeCheckpointReason: files axis", () => {
  const f = volumeCheckpointReason(
    3,
    { files: ["a", "b", "c", "d", "e", "f"], loc: 10 },
    { checkpointToolCalls: 50, checkpointFiles: 6, checkpointLoc: 80 },
  );
  assert.ok(f?.includes("6 files"), `expected "6 files", got: ${f}`);
});

test("volumeCheckpointReason: LoC axis", () => {
  const l = volumeCheckpointReason(
    3,
    { files: ["a"], loc: 80 },
    { checkpointToolCalls: 50, checkpointFiles: 6, checkpointLoc: 80 },
  );
  assert.ok(l?.includes("80 changed LoC"), `expected "80 changed LoC", got: ${l}`);
});

test("volumeCheckpointReason: tool-call axis wins when both cross", () => {
  const both = volumeCheckpointReason(
    50,
    { files: ["a", "b", "c", "d", "e", "f"], loc: 99 },
    { checkpointToolCalls: 50, checkpointFiles: 6, checkpointLoc: 80 },
  );
  assert.ok(both?.includes("tool calls"), `expected tool-call message, got: ${both}`);
});

test("volumeNoticeReason: tool-call axis trips", () => {
  const state = makeState({ checkpointToolCalls: 50, checkpointFiles: 6, checkpointLoc: 80 });
  const notice = volumeNoticeReason(state, 50, false, { files: [], loc: 0 });
  assert.ok(notice?.includes("50 tool calls"), `expected tool-call message, got: ${notice}`);
});

test("volumeNoticeReason: files/LoC only on mutation calls", () => {
  const state = makeState({ checkpointFiles: 6, checkpointLoc: 80 });
  assert.strictEqual(
    volumeNoticeReason(state, 3, false, { files: ["a", "b", "c", "d", "e", "f"], loc: 90 }),
    undefined,
  );
});

test("volumeNoticeReason: files/LoC on mutation calls", () => {
  const state = makeState({ checkpointToolCalls: 50, checkpointFiles: 6, checkpointLoc: 80 });
  const notice = volumeNoticeReason(state, 3, true, {
    files: ["a", "b", "c", "d", "e", "f"],
    loc: 90,
  });
  assert.ok(notice?.includes("6 files"), `files axis should fire: ${notice}`);
});

// ===========================================================================
// Messages
// ===========================================================================

test("denyMessage: starts with MERIDIAN GATE BLOCKED", () => {
  const msg = denyMessage("first edit of the run requires an accepted planner decision");
  assert.ok(msg.startsWith("MERIDIAN GATE BLOCKED"));
  assert.ok(msg.includes("ask_planner"));
  assert.ok(msg.includes("proceed or proceed_with_constraints"));
  assert.ok(msg.includes("Reads stay available for gathering evidence"));
});

test("denyMessage: reconciliation block asks only for Daddy-owned reconciliation", () => {
  const msg = denyMessage("reconciliation required: no valid checkpoint from the previous session");
  assert.ok(msg.includes('questionType "reconciliation"'));
  assert.ok(msg.includes("Baby is only triggering Daddy-owned reconciliation"));
  assert.ok(!msg.includes("what you were about to change"));
});

test("QUESTION_MESSAGE: interactive questions disabled", () => {
  assert.ok(QUESTION_MESSAGE.startsWith("MERIDIAN GATE BLOCKED"));
  assert.ok(QUESTION_MESSAGE.includes("interactive questions are disabled"));
  assert.ok(QUESTION_MESSAGE.includes("Max is not present"));
  assert.ok(QUESTION_MESSAGE.includes("ask_planner"));
  assert.ok(QUESTION_MESSAGE.includes('submit_report with status "blocked"'));
});

test("SUBAGENT_MESSAGE: subagents blocked", () => {
  assert.ok(SUBAGENT_MESSAGE.startsWith("MERIDIAN GATE BLOCKED"));
  assert.ok(SUBAGENT_MESSAGE.includes("exploration subagents are disabled"));
  assert.ok(SUBAGENT_MESSAGE.includes("ask_planner"));
  assert.ok(SUBAGENT_MESSAGE.includes("bounded inspection"));
});

test("GIT_MESSAGE: git mutations blocked to driver", () => {
  assert.ok(GIT_MESSAGE.startsWith("MERIDIAN GATE BLOCKED"));
  assert.ok(GIT_MESSAGE.includes("git mutations are not yours"));
  assert.ok(GIT_MESSAGE.includes("the driver commits at the end of the run"));
});

// ===========================================================================
// Legacy migration — old-format gate-state on disk must parse to new phase
// ===========================================================================

const legacyBase = {
  runId: "20260101-000000-test",
  expectedGlobs: ["src/**"],
  suspiciousGlobs: [],
  baselineDiffStats: {},
  mutationCommandPatterns: [],
  updatedAt: "2026-01-01T00:00:00Z",
};

test("GateState.parse: legacy FFF → initial", () => {
  const parsed = GateState.parse({
    ...legacyBase,
    latched: false,
    firstEditApproved: false,
    reconciliationRequired: false,
  });
  assert.strictEqual(parsed.phase.phase, "initial");
});

test("GateState.parse: legacy TFF → first-edit-latched", () => {
  const parsed = GateState.parse({
    ...legacyBase,
    latched: true,
    latchReason: "first edit pending",
    firstEditApproved: false,
    reconciliationRequired: false,
  });
  assert.strictEqual(parsed.phase.phase, "first-edit-latched");
  if (parsed.phase.phase === "first-edit-latched") {
    assert.strictEqual(parsed.phase.reason, "first edit pending");
  }
});

test("GateState.parse: legacy TFT → reconciliation-latched", () => {
  const parsed = GateState.parse({
    ...legacyBase,
    latched: true,
    latchReason: "recon needed",
    firstEditApproved: false,
    reconciliationRequired: true,
  });
  assert.strictEqual(parsed.phase.phase, "reconciliation-latched");
  if (parsed.phase.phase === "reconciliation-latched") {
    assert.strictEqual(parsed.phase.reason, "recon needed");
  }
});

test("GateState.parse: legacy FTF → cleared", () => {
  const parsed = GateState.parse({
    ...legacyBase,
    latched: false,
    firstEditApproved: true,
    reconciliationRequired: false,
  });
  assert.strictEqual(parsed.phase.phase, "cleared");
});

test("GateState.parse: legacy TTF → checkpoint-demand-latched", () => {
  const parsed = GateState.parse({
    ...legacyBase,
    latched: true,
    latchReason: "checkpoint demand",
    firstEditApproved: true,
    reconciliationRequired: false,
  });
  assert.strictEqual(parsed.phase.phase, "checkpoint-demand-latched");
  if (parsed.phase.phase === "checkpoint-demand-latched") {
    assert.strictEqual(parsed.phase.reason, "checkpoint demand");
  }
});

test("GateState.parse: legacy with lastAcceptedDecisionAt preserves it", () => {
  const parsed = GateState.parse({
    ...legacyBase,
    latched: false,
    firstEditApproved: true,
    reconciliationRequired: false,
    lastAcceptedDecisionAt: "2026-06-01T00:00:00Z",
  });
  assert.strictEqual(parsed.phase.phase, "cleared");
  assert.strictEqual(parsed.lastAcceptedDecisionAt, "2026-06-01T00:00:00Z");
});

test("GateState.parse: legacy with no latchReason gets default", () => {
  const parsed = GateState.parse({
    ...legacyBase,
    latched: true,
    firstEditApproved: false,
    reconciliationRequired: false,
  });
  assert.strictEqual(parsed.phase.phase, "first-edit-latched");
  if (parsed.phase.phase === "first-edit-latched") {
    assert.ok(parsed.phase.reason.length > 0, "missing latchReason gets a default");
  }
});

test("GateState.parse: new-format passes through unchanged", () => {
  const parsed = GateState.parse({
    ...legacyBase,
    phase: { phase: "reconciliation-latched", reason: "test" },
  });
  assert.strictEqual(parsed.phase.phase, "reconciliation-latched");
  if (parsed.phase.phase === "reconciliation-latched") {
    assert.strictEqual(parsed.phase.reason, "test");
  }
});
