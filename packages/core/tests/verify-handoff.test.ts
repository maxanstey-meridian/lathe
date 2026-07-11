// Tests for the verify-handoff protocol — write_handoff, verify_handoff,
// handoff inject, verification gate, and daddy-verify integration.
// Mocks executor at the boundary; no live opencode session.

import { strictEqual, equal, ok, deepStrictEqual, match } from "node:assert";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Executor } from "../src/application/ports/executor.js";
import type { Repo } from "../src/application/ports/repo.js";
import { buildHandoffInject } from "../src/application/use-cases/run-runtime.js";
import { makePaths } from "../src/config/paths.js";
import { HandoffArtifact as HandoffArtifactSchema } from "../src/domain/handoff.js";
import type { Packet } from "../src/domain/packet.js";
import type { RunRef } from "../src/infrastructure/bridge.js";
import {
  handleWriteHandoff,
  handleVerifyHandoff,
} from "../src/infrastructure/opencode/baby-tools.js";
import { runVerify, buildVerifyPrompt } from "../src/infrastructure/opencode/daddy-verify.js";
import { SqliteStoreAdapter } from "../src/infrastructure/sqlite-store.js";

// ===========================================================================
// Test helpers
// ===========================================================================

const TEST_RUN_ID = "test-run";

const TS_COUNTER = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS_COUNTER.n++).padStart(2, "0")}.000Z`,
});

const fakeRepo = (): Repo => ({
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
  reconciliationGitState: () => ({
    head: "abc",
    status: [] as string[],
    diffHash: "",
    untracked: [],
    changedFiles: [],
  }),
  fetchBranchFromClone: () => {
    throw new Error("unimplemented");
  },
  removeSandbox: () => {
    throw new Error("unimplemented");
  },
  headBranch: () => "main",
  branchExists: () => true,
  repoValid: () => true,
  deleteBranch: () => {
    throw new Error("unimplemented");
  },
});

const makeTestPacket = (overrides?: Record<string, unknown>): Packet => {
  const raw = `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: test packet
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
  const fm = {
    repo: "/tmp/test-repo",
    base: "main",
    compare_commit: "main",
    summary: "test packet",
    outcomes: [{ id: "test-outcome", description: "A test outcome" }],
    expected_surface: ["src/index.ts"],
    suspicious_surface: [],
    verification: [{ command: "echo ok" }],
    constraints: [],
    pass: 1,
    promoted: false,
    autofix_commands: [],
    regression_outcomes: [],
    ...overrides,
  };
  return { runId: "20260101-000000-test", frontmatter: fm as any, body: "body\n", raw };
};

const cleanTemp = async (dir: string) => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

const makeRef = (overrides?: {
  packet?: Packet;
  turnComplete?: boolean;
  awaitingVerification?: boolean;
}) => {
  const tmp = join(tmpdir(), `handoff-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  const clock = fixedClock();
  const packet = overrides?.packet ?? makeTestPacket();
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), clock);
  const ctx = {
    intents: [] as any[],
    pendingConsult: null,
    pendingFinalReview: null,
    reportRejectionCount: 0,
    checkpointBounceCount: 0,
    turnComplete: overrides?.turnComplete ?? false,
    awaitingVerification: overrides?.awaitingVerification ?? false,
    config: {
      thresholds: {
        checkpointToolCalls: 50,
        checkpointFiles: 6,
        checkpointLoc: 80,
        reportRejectionParkAt: 3,
        checkpointBounceLimit: 1,
        verificationTimeoutMs: 600000,
        maxPasses: 3,
        maxReorientRetries: 2,
        maxRunMs: 6 * 60 * 60 * 1000,
      },
      opencode: { bridgePort: 0 },
      mutationCommandPatterns: [
        "\\b(pnpm|npm|yarn)\\b.*\\bgenerate\\b",
        "task contracts",
        "dotnet-rivet",
      ],
      daddy: {
        providerId: "test",
        modelId: "test",
        agent: "test",
        timeoutMs: 300000,
      },
    },
    paths,
    worktree: tmp,
    packet,
    store,
    turn: 1,
    executor: {
      createSession: async () => "session",
      sendMessage: async () => ({
        info: { id: "m", sessionID: "s", tokens: {} },
        parts: [{ type: "text", text: "ok" }],
      }),
      listMessages: async () => [],
      deleteSession: async () => {},
      abortSession: async () => {},
    } as unknown as Executor,
    verifyModel: { providerId: "test", modelId: "test", agent: "test" },
  };
  const ref = {
    byRunId: new Map([[TEST_RUN_ID, ctx]]),
  } as unknown as RunRef;
  store.writeMeta({
    runId: packet.runId,
    status: "running",
    attempt: 1,
    repo: "/tmp/test-repo",
    base: "main",
    branch: `meridian/${packet.runId}`,
    worktree: tmp,
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  store.writeLedger(store.initialLedger(packet));
  store.writeGateState(packet.runId, {
    runId: packet.runId,
    phase: { phase: "initial" },
    expectedGlobs: ["src/**"],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  });
  return { ref, tmp, clock };
};

const submitWriteHandoff = (
  ref: ReturnType<typeof makeRef>["ref"],
  input: Omit<Parameters<typeof handleWriteHandoff>[1], "runId">,
) => handleWriteHandoff(ref, { runId: TEST_RUN_ID, ...input });

const submitVerifyHandoff = (
  ref: ReturnType<typeof makeRef>["ref"],
  input: Omit<Parameters<typeof handleVerifyHandoff>[1], "runId">,
) => handleVerifyHandoff(ref, { runId: TEST_RUN_ID, ...input });

const makeHandoffArtifact = (
  overrides?: Partial<{
    runId: string;
    completedSteps: { description: string; files: string[] }[];
    remainingWork: string[];
    decisionsMade: string[];
    resumeFrom: string;
  }>,
) => ({
  runId: overrides?.runId ?? "20260101-000000-test",
  timestamp: "2026-01-01T00:00:00.000Z",
  completedSteps: overrides?.completedSteps ?? [{ description: "step 1", files: ["src/index.ts"] }],
  remainingWork: overrides?.remainingWork ?? ["step 2"],
  decisionsMade: overrides?.decisionsMade ?? [],
  resumeFrom: overrides?.resumeFrom ?? "",
});

// ===========================================================================
// (a) write_handoff — persists HandoffArtifact to the expected path
//     and overwrites on repeat calls
// ===========================================================================

test("write_handoff: persists HandoffArtifact to run state dir", async () => {
  const { ref, tmp } = makeRef();
  const result = await submitWriteHandoff(ref, {
    completedSteps: [{ description: "added foo", files: ["src/foo.ts"] }],
    remainingWork: ["fix bar"],
    decisionsMade: ["use const"],
    resumeFrom: "src/bar.ts:42",
  });
  equal(result.isError, false);
  const body = JSON.parse(result.content[0]!.text);
  equal(body.written, true);

  // Check the file exists and contains valid HandoffArtifact.
  const runId = ref.byRunId.get(TEST_RUN_ID)!.packet.runId;
  const paths = makePaths(tmp);
  const handoffPath = join(paths.runDir(runId), "handoff.json");
  ok(existsSync(handoffPath), "handoff.json should exist at run state path");

  const raw = await readFile(handoffPath, "utf-8");
  const parsed = HandoffArtifactSchema.safeParse(JSON.parse(raw));
  ok(parsed.success, "handoff.json should validate against HandoffArtifact schema");
  strictEqual(parsed.data.completedSteps.length, 1);
  strictEqual(parsed.data.completedSteps[0]!.description, "added foo");
  strictEqual(parsed.data.completedSteps[0]!.files[0], "src/foo.ts");
  strictEqual(parsed.data.remainingWork[0], "fix bar");
  strictEqual(parsed.data.decisionsMade[0], "use const");
  strictEqual(parsed.data.resumeFrom, "src/bar.ts:42");
  strictEqual(parsed.data.runId, "20260101-000000-test");

  await cleanTemp(tmp);
});

test("write_handoff: overwrites on repeat calls", async () => {
  const { ref, tmp } = makeRef();
  const runId = ref.byRunId.get(TEST_RUN_ID)!.packet.runId;
  const paths = makePaths(tmp);

  // First write.
  await submitWriteHandoff(ref, {
    completedSteps: [{ description: "first batch" }],
    remainingWork: ["a", "b"],
    decisionsMade: [],
    resumeFrom: "step 2",
  });

  let handoffPath = join(paths.runDir(runId), "handoff.json");
  let raw = await readFile(handoffPath, "utf-8");
  let parsed = HandoffArtifactSchema.safeParse(JSON.parse(raw));
  ok(parsed.success);
  strictEqual(parsed.data.completedSteps[0]!.description, "first batch");
  deepStrictEqual(parsed.data.remainingWork, ["a", "b"]);

  // Second write — should overwrite.
  await submitWriteHandoff(ref, {
    completedSteps: [{ description: "second batch", files: ["src/bar.ts"] }],
    remainingWork: ["c"],
    decisionsMade: ["decided x"],
    resumeFrom: "step 3",
  });

  raw = await readFile(handoffPath, "utf-8");
  parsed = HandoffArtifactSchema.safeParse(JSON.parse(raw));
  ok(parsed.success);
  strictEqual(parsed.data.completedSteps[0]!.description, "second batch");
  strictEqual(parsed.data.completedSteps[0]!.files[0], "src/bar.ts");
  deepStrictEqual(parsed.data.remainingWork, ["c"]);
  strictEqual(parsed.data.decisionsMade[0], "decided x");
  strictEqual(parsed.data.resumeFrom, "step 3");

  await cleanTemp(tmp);
});

// ===========================================================================
// (b) handoff inject — reads handoff.json and prepends system message
//     (tested via the inject logic in execute-run.ts / turn-loop.ts)
//     We test the inject logic directly here.
// ===========================================================================

test("handoff inject: prepends system message when handoff.json exists", async () => {
  const { ref, tmp } = makeRef();
  const runId = ref.byRunId.get(TEST_RUN_ID)!.packet.runId;
  const paths = makePaths(tmp);
  const runDir = paths.runDir(runId);
  const handoffPath = join(runDir, "handoff.json");

  // Write a handoff artifact.
  const artifact = makeHandoffArtifact({
    completedSteps: [{ description: "added handoff.ts", files: ["src/domain/handoff.ts"] }],
    remainingWork: ["add tests"],
    resumeFrom: "verify-handoff tests",
  });
  await writeFile(handoffPath, JSON.stringify(artifact, null, 2));

  // Read it back the way execute-run.ts / turn-loop.ts do, then pass through the production formatter.
  const raw = readFileSync(handoffPath, "utf-8");
  const injectText = buildHandoffInject(raw);

  ok(injectText.startsWith("Predecessor handoff available:"));
  ok(injectText.includes("Call verify_handoff"));
  ok(injectText.length <= 2100); // inject + packet prefix should be capped

  await cleanTemp(tmp);
});

test("handoff inject: skips inject when handoff.json absent", async () => {
  // Pass undefined to buildHandoffInject — the production formatter returns "".
  strictEqual(buildHandoffInject(undefined), "");
});

// ===========================================================================
// (c) verification gate — blocks non-verify_handoff tools when handoff injected
//     (tested by setting awaitingVerification on the context)
// ===========================================================================

test("verification gate: write_handoff blocked when awaitingVerification is true", async () => {
  const { ref } = makeRef({ awaitingVerification: true });
  const result = await submitWriteHandoff(ref, {
    completedSteps: [{ description: "blocked step" }],
    remainingWork: [],
    decisionsMade: [],
    resumeFrom: "now",
  });
  equal(result.isError, true);
  const body = JSON.parse(result.content[0]!.text);
  match(body.error, /Handoff verification required/);
});

// ===========================================================================
// (d) gate clears after verify_handoff resolves
//     (tested by verifying the handler sets awaitingVerification = false)
//     We test the clear behavior by verifying the code path directly:
//     the handleVerifyHandoff handler sets ctx.awaitingVerification = false
//     after the verdict resolves. Since we can't easily mock the full flow,
//     we verify the handler reads the handoff and the verdict is returned.
//     The awaitingVerification clear is a simple field assignment on ctx.
// ===========================================================================

test("verify_handoff: returns verdict and clears awaitingVerification", async () => {
  const { ref, tmp } = makeRef();
  const runId = ref.byRunId.get(TEST_RUN_ID)!.packet.runId;
  const paths = makePaths(tmp);
  const runDir = paths.runDir(runId);
  const handoffPath = join(runDir, "handoff.json");

  // Create a handoff artifact and a real file on disk for the handoff.
  const handoff = makeHandoffArtifact({
    completedSteps: [{ description: "added handoff.ts", files: ["src/domain/handoff.ts"] }],
    remainingWork: ["add tests"],
  });
  await writeFile(handoffPath, JSON.stringify(handoff, null, 2));

  // Create the handoff.ts file so file read doesn't fail.
  const handoffDir = join(tmp, "src", "domain");
  await (async () => {
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(handoffDir, { recursive: true });
    await wf(
      join(handoffDir, "handoff.ts"),
      "import { z } from 'zod';\nexport const Foo = z.string();",
      "utf-8",
    );
  })();

  // Set awaitingVerification to true.
  ref.byRunId.get(TEST_RUN_ID)!.awaitingVerification = true;

  // Mock executor that returns a valid verdict.
  const verdictJson = JSON.stringify({
    ok: true,
    trusted: [{ description: "added handoff.ts", files: ["src/domain/handoff.ts"] }],
    issues: [],
    resumeHint: "add tests",
  });
  let capturedPrompt = "";
  const mockExecutor: Executor = {
    createSession: async () => "verify-session",
    sendMessage: async (_sessionId: string, text: string) => {
      capturedPrompt = text;
      return {
        info: { id: "m", sessionID: "s", tokens: {} },
        parts: [{ type: "text" as const, text: verdictJson }],
      };
    },
    listMessages: async () => [],
    deleteSession: async () => {},
    abortSession: async () => {},
  } as unknown as Executor;
  ref.byRunId.get(TEST_RUN_ID)!.executor = mockExecutor;

  const result = await submitVerifyHandoff(ref, { claimedCompletions: ["added handoff.ts"] });
  equal(result.isError, false);
  const body = JSON.parse(result.content[0]!.text);
  equal(body.ok, true);
  strictEqual(body.trusted.length, 1);
  strictEqual(body.trusted[0]!.description, "added handoff.ts");

  // Gate should be cleared.
  strictEqual(ref.byRunId.get(TEST_RUN_ID)!.awaitingVerification, false);

  // Verify the prompt was built correctly.
  ok(capturedPrompt.includes("## Claimed completions"));
  ok(capturedPrompt.includes("added handoff.ts"));
  ok(capturedPrompt.includes("## Your task"));
  ok(capturedPrompt.includes("VerifyVerdict"));

  await cleanTemp(tmp);
});

// ===========================================================================
// (e) no handoff injected → no gate, tool calls proceed immediately
// ===========================================================================

test("write_handoff: proceeds normally when awaitingVerification is false", async () => {
  const { ref } = makeRef({ awaitingVerification: false });
  const result = await submitWriteHandoff(ref, {
    completedSteps: [{ description: "ok step" }],
    remainingWork: [],
    decisionsMade: [],
    resumeFrom: "now",
  });
  equal(result.isError, false);
  const body = JSON.parse(result.content[0]!.text);
  equal(body.written, true);
});

// ===========================================================================
// (f) verify_handoff triggers daddy-verify with correct inputs
//     (mock executor, assert prompt content)
//     Covered in the verify_handoff test above (capturedPrompt check).
//     Also test here with multiple steps and questions.
// ===========================================================================

test("verify_handoff: prompt includes all claimed steps, file samples, and questions", async () => {
  const { ref, tmp } = makeRef();
  const runId = ref.byRunId.get(TEST_RUN_ID)!.packet.runId;
  const paths = makePaths(tmp);
  const runDir = paths.runDir(runId);
  const handoffPath = join(runDir, "handoff.json");

  const handoff = makeHandoffArtifact({
    completedSteps: [
      { description: "added handoff.ts", files: ["src/domain/handoff.ts"] },
      { description: "added baby-tools.ts", files: ["src/infrastructure/opencode/baby-tools.ts"] },
    ],
    remainingWork: ["add tests"],
  });
  await writeFile(handoffPath, JSON.stringify(handoff, null, 2));

  // Create the handoff.ts file.
  const handoffDir = join(tmp, "src", "domain");
  await (async () => {
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(handoffDir, { recursive: true });
    await wf(
      join(handoffDir, "handoff.ts"),
      "import { z } from 'zod';\nexport const Foo = z.string();\nexport const Bar = z.number();",
      "utf-8",
    );
  })();

  const verdictJson = JSON.stringify({ ok: true, trusted: [], issues: [], resumeHint: "done" });
  let capturedPrompt = "";
  ref.byRunId.get(TEST_RUN_ID)!.executor = {
    createSession: async () => "s",
    sendMessage: async (_s: string, text: string) => {
      capturedPrompt = text;
      return { info: { tokens: {} }, parts: [{ type: "text", text: verdictJson }] };
    },
    listMessages: async () => [],
    deleteSession: async () => {},
  } as any;

  await submitVerifyHandoff(ref, {
    claimedCompletions: ["added handoff.ts", "added baby-tools.ts"],
    questionsForDaddy: ["is the Zod schema correct?"],
  });

  ok(
    capturedPrompt.includes("## Claimed completions"),
    "prompt should include claimed completions section",
  );
  ok(capturedPrompt.includes("added handoff.ts"), "prompt should include first step");
  ok(capturedPrompt.includes("added baby-tools.ts"), "prompt should include second step");
  ok(capturedPrompt.includes("## Baby's questions"), "prompt should include questions section");
  ok(
    capturedPrompt.includes("is the Zod schema correct?"),
    "prompt should include baby's question",
  );
  ok(capturedPrompt.includes("src/domain/handoff.ts"), "prompt should include file sample");
});

// Regression: verify_handoff file samples are NOT truncated at 4000 chars.
// Before the fix, content.slice(0, 4000) hid the tail of large files from
// daddy-verify. After the fix, the full file content is included.
test("verify_handoff: file samples include full content (no 4000-char cap)", async () => {
  const { ref, tmp } = makeRef();
  const runId = ref.byRunId.get(TEST_RUN_ID)!.packet.runId;
  const paths = makePaths(tmp);
  const runDir = paths.runDir(runId);
  const handoffPath = join(runDir, "handoff.json");

  // Create a file > 4000 chars.
  const testFile = join(tmp, "src", "large.ts");
  await (async () => {
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    await mkdir(join(tmp, "src"), { recursive: true });
    // 5000 'A' chars + newline = 5001 chars, well above the old 4000 cap.
    await wf(testFile, "A".repeat(5000) + "\n", "utf-8");
  })();

  const handoff = makeHandoffArtifact({
    completedSteps: [{ description: "added large.ts", files: ["src/large.ts"] }],
    remainingWork: [],
  });
  await writeFile(handoffPath, JSON.stringify(handoff, null, 2));

  const verdictJson = JSON.stringify({ ok: true, trusted: [], issues: [], resumeHint: "done" });
  let capturedPrompt = "";
  ref.byRunId.get(TEST_RUN_ID)!.executor = {
    createSession: async () => "s",
    sendMessage: async (_s: string, text: string) => {
      capturedPrompt = text;
      return { info: { tokens: {} }, parts: [{ type: "text", text: verdictJson }] };
    },
    listMessages: async () => [],
    deleteSession: async () => {},
  } as any;

  await submitVerifyHandoff(ref, {
    claimedCompletions: ["added large.ts"],
    questionsForDaddy: [],
  });

  // Before the fix, the prompt would contain only 4000 'A's (truncated).
  // After the fix, it contains all 5000.
  ok(
    capturedPrompt.includes("A".repeat(4000)),
    "prompt should contain content at position 4000 (old cap boundary)",
  );
  ok(
    capturedPrompt.includes("A".repeat(4999)),
    "prompt should contain content at position 4999 (beyond old 4000 cap)",
  );
});

// ===========================================================================
// (g) daddy returns valid VerifyVerdict JSON → tool result matches
// ===========================================================================

test("verify_handoff: valid verdict JSON passed through correctly", async () => {
  const { ref, tmp } = makeRef();
  const runId = ref.byRunId.get(TEST_RUN_ID)!.packet.runId;
  const paths = makePaths(tmp);
  const handoffPath = join(paths.runDir(runId), "handoff.json");

  await writeFile(handoffPath, JSON.stringify(makeHandoffArtifact(), null, 2));

  const verdictJson = JSON.stringify({
    ok: false,
    trusted: [{ description: "partial step", files: ["src/foo.ts"] }],
    issues: [
      { file: "src/bar.ts", problem: "missing export" },
      { file: "src/baz.ts", problem: "type error" },
    ],
    resumeHint: "fix the type error in baz before continuing",
  });

  ref.byRunId.get(TEST_RUN_ID)!.executor = {
    createSession: async () => "s",
    sendMessage: async () => ({
      info: { tokens: {} },
      parts: [{ type: "text", text: verdictJson }],
    }),
    listMessages: async () => [],
    deleteSession: async () => {},
  } as any;

  const result = await submitVerifyHandoff(ref, { claimedCompletions: ["step 1"] });
  equal(result.isError, false);
  const body = JSON.parse(result.content[0]!.text);

  equal(body.ok, false);
  strictEqual(body.trusted.length, 1);
  strictEqual(body.trusted[0]!.description, "partial step");
  strictEqual(body.issues.length, 2);
  strictEqual(body.issues[0]!.file, "src/bar.ts");
  strictEqual(body.issues[0]!.problem, "missing export");
  strictEqual(body.resumeHint, "fix the type error in baz before continuing");
});

// ===========================================================================
// (h) daddy returns unparseable response → parse-error fallback
// ===========================================================================

test("verify_handoff: unparseable daddy response returns fallback verdict", async () => {
  const { ref, tmp } = makeRef();
  const runId = ref.byRunId.get(TEST_RUN_ID)!.packet.runId;
  const paths = makePaths(tmp);
  const handoffPath = join(paths.runDir(runId), "handoff.json");

  await writeFile(handoffPath, JSON.stringify(makeHandoffArtifact(), null, 2));

  // Daddy returns garbage — no JSON at all.
  ref.byRunId.get(TEST_RUN_ID)!.executor = {
    createSession: async () => "s",
    sendMessage: async () => ({
      info: { tokens: {} },
      parts: [
        { type: "text", text: "I'm not sure, let me think about this... maybe { ok: true }" },
      ],
    }),
    listMessages: async () => [],
    deleteSession: async () => {},
  } as any;

  const result = await submitVerifyHandoff(ref, { claimedCompletions: ["step 1"] });
  equal(result.isError, false);
  const body = JSON.parse(result.content[0]!.text);

  equal(body.ok, false);
  strictEqual(body.trusted.length, 0);
  strictEqual(body.issues.length, 1);
  strictEqual(body.issues[0]!.file, "daddy-response");
  strictEqual(body.issues[0]!.problem, "could not parse verdict JSON");
  strictEqual(body.resumeHint, "ask_planner to investigate");
});

test("verify_handoff: executor exception returns error verdict", async () => {
  const { ref, tmp } = makeRef();
  const runId = ref.byRunId.get(TEST_RUN_ID)!.packet.runId;
  const paths = makePaths(tmp);
  const handoffPath = join(paths.runDir(runId), "handoff.json");

  await writeFile(handoffPath, JSON.stringify(makeHandoffArtifact(), null, 2));

  ref.byRunId.get(TEST_RUN_ID)!.executor = {
    createSession: async () => "s",
    sendMessage: async () => {
      throw new Error("provider timeout");
    },
    listMessages: async () => [],
    deleteSession: async () => {},
  } as any;

  const result = await submitVerifyHandoff(ref, { claimedCompletions: ["step 1"] });
  equal(result.isError, false);
  const body = JSON.parse(result.content[0]!.text);

  equal(body.ok, false);
  strictEqual(body.issues.length, 1);
  strictEqual(body.issues[0]!.file, "daddy-verify");
  ok(body.issues[0]!.problem.includes("verify call failed"));
});

// ===========================================================================
// buildVerifyPrompt — pure function tests
// ===========================================================================

test("buildVerifyPrompt: includes all sections when provided", () => {
  const handoff = makeHandoffArtifact({
    completedSteps: [{ description: "step 1", files: ["a.ts", "b.ts"] }],
    remainingWork: ["step 2"],
  });
  const fileSamples = { "a.ts": "export const x = 1;", "b.ts": "export const y = 2;" };
  const questions = ["is x correct?"];

  const prompt = buildVerifyPrompt(handoff, fileSamples, questions);

  ok(prompt.includes("## Claimed completions"));
  ok(prompt.includes("step 1"));
  ok(prompt.includes("a.ts"));
  // No git diff stat — daddy verifies against the file samples / the worktree.
  ok(!prompt.includes("## Git diff stat"));
  ok(prompt.includes("## File samples"));
  ok(prompt.includes("export const x = 1;"));
  ok(prompt.includes("## Baby's questions"));
  ok(prompt.includes("is x correct?"));
  ok(prompt.includes("## Your task"));
});

test("buildVerifyPrompt: omits empty sections", () => {
  const handoff = makeHandoffArtifact({ completedSteps: [] });
  const prompt = buildVerifyPrompt(handoff, {}, []);

  ok(!prompt.includes("## Claimed completions"));
  ok(!prompt.includes("## Git diff stat"));
  ok(!prompt.includes("## File samples"));
  ok(!prompt.includes("## Baby's questions"));
  ok(prompt.includes("## Your task"));
});

// ===========================================================================
// runVerify — orchestrator tests (mock executor)
// ===========================================================================

test("runVerify: creates session, sends prompt, returns parsed verdict", async () => {
  const executor: Executor = {
    createSession: async (title: string) => {
      strictEqual(title, "lathe-verify");
      return "session-123";
    },
    sendMessage: async (
      sessionId: string,
      _text: string,
      model: { providerId: string },
      timeout: number,
    ) => {
      strictEqual(sessionId, "session-123");
      strictEqual(model.providerId, "test");
      strictEqual(timeout, 300000);
      return {
        info: { id: "m", sessionID: "session-123", tokens: {} },
        parts: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, trusted: [], issues: [], resumeHint: "go" }),
          },
        ],
      };
    },
    listMessages: async () => [],
    deleteSession: async (sessionId: string) => {
      strictEqual(sessionId, "session-123");
    },
    abortSession: async () => {},
  } as unknown as Executor;

  const verdict = await runVerify(
    executor,
    { providerId: "test", modelId: "test", agent: "test" },
    300000,
    "/tmp/test",
    makeHandoffArtifact(),
    {},
    [],
  );

  equal(verdict.ok, true);
  strictEqual(verdict.resumeHint, "go");
});

test("runVerify: executor failure returns error verdict", async () => {
  const executor: Executor = {
    createSession: async () => {
      throw new Error("network");
    },
    sendMessage: async () => ({ info: { id: "m", sessionID: "s", tokens: {} }, parts: [] }),
    listMessages: async () => [],
    deleteSession: async () => {},
    abortSession: async () => {},
  } as unknown as Executor;

  const verdict = await runVerify(
    executor,
    { providerId: "test", modelId: "test", agent: "test" },
    300000,
    "/tmp/test",
    makeHandoffArtifact(),
    {},
    [],
  );

  equal(verdict.ok, false);
  strictEqual(verdict.issues[0]!.file, "daddy-verify");
  ok(verdict.issues[0]!.problem.includes("verify call failed"));
});

// ===========================================================================
// turnComplete gate on verify_handoff
// ===========================================================================

test("verify_handoff: returns turnCompleteError when turnComplete is true", async () => {
  const { ref } = makeRef({ turnComplete: true });
  const result = await submitVerifyHandoff(ref, { claimedCompletions: ["step 1"] });
  equal(result.isError, true);
  const body = JSON.parse(result.content[0]!.text);
  match(body.error, /End your turn now/);
});

test("write_handoff: returns turnCompleteError when turnComplete is true", async () => {
  const { ref } = makeRef({ turnComplete: true });
  const result = await submitWriteHandoff(ref, {
    completedSteps: [{ description: "step" }],
    remainingWork: [],
    decisionsMade: [],
    resumeFrom: "now",
  });
  equal(result.isError, true);
  const body = JSON.parse(result.content[0]!.text);
  match(body.error, /End your turn now/);
});

// ===========================================================================
// verify_handoff: no handoff on disk — error
// ===========================================================================

test("verify_handoff: returns error when handoff.json does not exist", async () => {
  const { ref } = makeRef();
  // Don't write handoff.json — leave it absent.
  const result = await submitVerifyHandoff(ref, { claimedCompletions: ["step 1"] });
  equal(result.isError, true);
  const body = JSON.parse(result.content[0]!.text);
  match(body.error, /no handoff.json found/);
});

// ===========================================================================
// write_handoff: no active run — error
// ===========================================================================

test("write_handoff: returns error when no active run", async () => {
  const result = await submitWriteHandoff(
    { byRunId: new Map() },
    {
      completedSteps: [{ description: "step" }],
      remainingWork: [],
      decisionsMade: [],
      resumeFrom: "now",
    },
  );
  equal(result.isError, true);
  const body = JSON.parse(result.content[0]!.text);
  strictEqual(body.error, `no active run for runId: ${TEST_RUN_ID}`);
});

test("verify_handoff: returns error when no active run", async () => {
  const result = await submitVerifyHandoff(
    { byRunId: new Map() },
    { claimedCompletions: ["step 1"] },
  );
  equal(result.isError, true);
  const body = JSON.parse(result.content[0]!.text);
  strictEqual(body.error, `no active run for runId: ${TEST_RUN_ID}`);
});
