import { equal, ok, deepEqual } from "node:assert";
import { mkdtemp as mkdtempP, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Executor } from "../src/application/ports/executor.js";
import type { Planner } from "../src/application/ports/planner.js";
import type { Repo } from "../src/application/ports/repo.js";
import type { Store } from "../src/application/ports/store.js";
import type { RunPorts, RunChannel } from "../src/application/use-cases/run-runtime.js";
import {
  turnLoop,
  babyModelConfig,
  promotedModelConfig,
} from "../src/application/use-cases/turn-loop.js";
import { makePaths } from "../src/config/paths.js";
import { Config } from "../src/config/schemas.js";
import type { MessagePart } from "../src/domain/agent-response.js";
import { initialGateState } from "../src/domain/gate.js";
import { parsePacketShape, type Packet } from "../src/domain/packet.js";
import { SubmitReport } from "../src/domain/report.js";
import type { AskPlannerInput, PlannerResponse, FinalReview } from "../src/domain/review.js";
import type { BridgeIntent } from "../src/domain/turn.js";
import { StoreAdapter } from "../src/infrastructure/store.js";

// ---------------------------------------------------------------------------
// Fixtures

const RUN_ID = "20260101-000000-turnloop";

const PACKET_RAW = `---
repo: /tmp/test-repo
base: main
summary: turn loop fixture
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

const parseFixture = (): Packet => {
  const shape = parsePacketShape(PACKET_RAW, RUN_ID);
  if (!shape.ok) {
    throw new Error(`fixture packet invalid: ${shape.problems.join("; ")}`);
  }
  return shape.packet;
};

const TS = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1_700_000_000_000 + TS.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS.n++ % 60).padStart(2, "0")}.000Z`,
});

const fakeRepo = (diffStats: Record<string, { added: number; removed: number }> = {}): Repo => ({
  createSandbox: () => {},
  wipCommit: () => "sha000",
  amendCommit: () => "sha000",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => diffStats,
  reviewableDiff: () => "diff",
  reviewableDiffAgainst: () => "diff",
  fetchBranchFromClone: () => {},
  removeSandbox: () => {},
  headBranch: () => "main",
  branchExists: () => true,
  repoValid: () => true,
  mergeAccept: () => {},
});

const PROCEED: PlannerResponse = {
  status: "proceed",
  answer: "go ahead",
  constraints: ["keep the seam narrow"],
  evidence_used: [],
  safe_next_action: "implement the slice",
  human_decision_needed: null,
};

const ACCEPT_REVIEW: FinalReview = {
  verdict: "accept",
  findings: [],
  notes: "looks good",
  human_decision_needed: null,
};

const fakePlanner = (over: Partial<Pick<Planner, "consult" | "finalReview">> = {}): Planner => ({
  handshake: async () => "daddy-session",
  resumeSession: async (sid: string) => sid,
  consult: over.consult ?? (async () => PROCEED),
  finalReview: over.finalReview ?? (async () => ACCEPT_REVIEW),
});

// A turn script step: what the bridge would record into the channel during the
// send, plus the response parts the executor returns.
type ScriptStep = {
  intents?: BridgeIntent[];
  pendingConsult?: AskPlannerInput;
  pendingFinalReview?: SubmitReport;
  bumpRejection?: number;
  toolParts?: MessagePart[];
};

const toolPart = (tool: string): MessagePart => ({
  type: "tool",
  tool,
  callID: "c1",
  state: {
    status: "completed",
    input: { filePath: "src/index.ts" },
    output: "ok",
    metadata: { exit: 0 },
  },
});

const scriptedExecutor = (
  channel: RunChannel,
  steps: ScriptStep[],
  newSessionIds: string[] = [],
): Executor => {
  let i = 0;
  let s = 0;
  return {
    createSession: async () => newSessionIds[s++] ?? `baby-r${s}`,
    sendMessage: async () => {
      const step = steps[i++] ?? {};
      if (step.intents) {
        channel.intents.push(...step.intents);
      }
      if (step.pendingConsult !== undefined) {
        channel.pendingConsult = step.pendingConsult;
      }
      if (step.pendingFinalReview !== undefined) {
        channel.pendingFinalReview = step.pendingFinalReview;
      }
      if (step.bumpRejection) {
        channel.reportRejectionCount += step.bumpRejection;
      }
      return { info: { id: `m${i}`, sessionID: "s", tokens: {} }, parts: step.toolParts ?? [] };
    },
    listMessages: async () => [],
    deleteSession: async () => {},
  };
};

const emptyChannel = (): RunChannel => ({
  intents: [],
  pendingConsult: null,
  pendingFinalReview: null,
  reportRejectionCount: 0,
  checkpointBounceCount: 0,
  turnComplete: false,
  turn: 0,
});

const aSubmitReport = (): SubmitReport =>
  SubmitReport.parse({
    status: "ready_for_review",
    summary: "implemented the slice",
    outcomeClaims: [{ id: "test-outcome", status: "done" }],
  });

const seedRun = (
  store: Store,
  packet: Packet,
  gateDiff: Record<string, { added: number; removed: number }> = {},
): void => {
  store.writeMeta({
    runId: RUN_ID,
    status: "running",
    attempt: 1,
    repo: "/tmp/test-repo",
    base: "main",
    branch: `meridian/${RUN_ID}`,
    worktree: "/tmp/worktree",
    babySessionId: "baby-0",
    stallRetries: 0,
    reorientRetries: 0,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  store.writeLedger(store.initialLedger(packet));
  store.replaceObligations(RUN_ID, []);
  store.writeGateState(
    RUN_ID,
    initialGateState(
      RUN_ID,
      packet.frontmatter.expected_surface,
      packet.frontmatter.suspicious_surface,
      {
        checkpointNudgeMs: 1_200_000,
        checkpointToolCalls: 50,
        checkpointFiles: 6,
        checkpointLoc: 80,
        mutationCommandPatterns: [],
      },
      "2026-01-01T00:00:00.000Z",
    ),
  );
  void gateDiff;
};

const makePorts = (
  store: Store,
  repo: Repo,
  executor: Executor,
  planner: Planner,
  config = Config.parse({}),
): RunPorts => ({
  config,
  store,
  repo,
  executor,
  planner,
  clock: fixedClock(),
});

const cleanTemp = async (dir: string) => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

const FAR_FUTURE = 1_700_000_000_000 + 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// terminal accept (final review)

test("turnLoop: report → final review accept → ready_for_review with render payload", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-accept-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const report = aSubmitReport();
    const executor = scriptedExecutor(channel, [
      { intents: [{ kind: "final-review-requested" }], pendingFinalReview: report },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner());

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "ready_for_review");
    equal(result.finalReview?.verdict, "accept");
    ok(result.acceptedReport);
    // The final review verdict was persisted + journalled.
    const decisions = store.readDecisions(RUN_ID);
    ok(decisions.some((d) => d.questionType === "final_review" && d.status === "accept"));
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "report_accepted"));
    await cleanTemp(tmp);
  })();
});

test("turnLoop: final review request_changes → re-prompt Q7, then accept", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-rc-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const report = aSubmitReport();
    let calls = 0;
    const planner = fakePlanner({
      finalReview: async () => {
        calls += 1;
        return calls === 1
          ? {
              verdict: "request_changes",
              findings: ["tighten the test"],
              notes: "",
              human_decision_needed: null,
            }
          : ACCEPT_REVIEW;
      },
    });
    const executor = scriptedExecutor(channel, [
      { intents: [{ kind: "final-review-requested" }], pendingFinalReview: report },
      { intents: [{ kind: "final-review-requested" }], pendingFinalReview: report },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, planner);

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "ready_for_review");
    equal(calls, 2);
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "report_rejected"));
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// model promotion: 3 final-review rejections → swap to promoteTo model, rotate,
// re-seed, then succeed on the bigger model.

test("turnLoop: 3 final-review rejections → model_promoted → accept on promoted model", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-promo-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const report = aSubmitReport();
    let reviewCalls = 0;
    const modelsUsed: string[] = [];
    const planner = fakePlanner({
      finalReview: async () => {
        reviewCalls += 1;
        return reviewCalls <= 3
          ? {
              verdict: "request_changes",
              findings: ["add a test"],
              notes: "",
              human_decision_needed: null,
            }
          : ACCEPT_REVIEW;
      },
    });
    const executor: Executor = {
      createSession: async () => "baby-promoted",
      sendMessage: async (_sid, _text, model) => {
        modelsUsed.push(`${model.providerId}/${model.modelId}`);
        channel.pendingFinalReview = report;
        channel.intents.push({ kind: "final-review-requested" });
        return { info: { id: `m${modelsUsed.length}`, sessionID: _sid, tokens: {} }, parts: [] };
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    };
    const ports = makePorts(store, fakeRepo(), executor, planner);

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "ready_for_review");
    equal(reviewCalls, 4);
    // The promotion journal event was emitted.
    const journal = store.readJournal(RUN_ID);
    const promoEvent = journal.find((e) => e.event === "model_promoted");
    ok(promoEvent, "model_promoted journal event must be emitted");
    if (promoEvent?.event === "model_promoted") {
      equal(promoEvent.from, "omlx/Qwen3.6-35B-A3B-UD-MLX-4bit");
      equal(promoEvent.to, "zai-coding-plan/glm-5.1");
    }
    // The first 3 sends used baby's model; after promotion (rotation + reseed),
    // the 4th send used the promoted model.
    equal(modelsUsed[0], "omlx/Qwen3.6-35B-A3B-UD-MLX-4bit");
    equal(modelsUsed[modelsUsed.length - 1], "zai-coding-plan/glm-5.1");
    await cleanTemp(tmp);
  })();
});

test("turnLoop: promoted model also rejected → run fails (no double promotion)", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-promo-fail-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const report = aSubmitReport();
    const reject: FinalReview = {
      verdict: "request_changes",
      findings: ["still wrong"],
      notes: "",
      human_decision_needed: null,
    };
    const planner = fakePlanner({ finalReview: async () => reject });
    const executor: Executor = {
      createSession: async () => "baby-promoted",
      sendMessage: async () => {
        channel.pendingFinalReview = report;
        channel.intents.push({ kind: "final-review-requested" });
        return { info: { id: "m", sessionID: "s", tokens: {} }, parts: [] };
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    };
    const ports = makePorts(store, fakeRepo(), executor, planner);

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    // 3 rejections on baby model → promote → 3 more rejections on promoted model → fail.
    equal(result.outcome.status, "failed");
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "model_promoted"));
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// cooperative-stop: the bridge sets turnComplete=true after recording a submit
// intent; subsequent tool calls return errors; the executor turn resolves
// normally and the driver acts on the recorded intent this turn.

test("turnLoop: Baby submits mid-turn → bridge sets turnComplete, turn resolves normally, runs final review, terminal", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-submit-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const report = aSubmitReport();
    let sends = 0;
    // Mirrors the real handler: submit_report records the intent and sets
    // turnComplete=true; the executor turn completes normally (no abort).
    const submitExecutor: Executor = {
      createSession: async () => "baby-0",
      sendMessage: async () => {
        sends += 1;
        channel.pendingFinalReview = report;
        channel.intents.push({ kind: "final-review-requested" });
        channel.turnComplete = true;
        return { info: { id: `m${sends}`, sessionID: "s", tokens: {} }, parts: [] };
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    };
    const ports = makePorts(store, fakeRepo(), submitExecutor, fakePlanner());

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    // The turn resolved normally (not a send failure): the run reached the
    // terminal accept in a single send, driven by the recorded intent.
    equal(result.outcome.status, "ready_for_review");
    equal(result.finalReview?.verdict, "accept");
    equal(sends, 1);
    const journal = store.readJournal(RUN_ID);
    ok(
      !journal.some((e) => e.event === "driver_note" && e.note.includes("turn send failed")),
      "a submit turn must NOT be counted as a send failure",
    );
    ok(journal.some((e) => e.event === "report_accepted"));
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// consult round-trip

test("turnLoop: consult round-trip — accepted decision clears the gate", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-consult-"));
    const store = StoreAdapter.create(
      makePaths(tmp),
      fakeRepo({ "src/index.ts": { added: 3, removed: 0 } }),
      fixedClock(),
    );
    const packet = parseFixture();
    seedRun(store, packet);
    // Latch the gate (first edit pending) so the accepted consult must clear it.
    store.writeGateState(RUN_ID, {
      ...store.readGateState(RUN_ID),
      phase: {
        phase: "first-edit-latched",
        reason: "first edit of the run requires an accepted planner decision",
      },
    });

    const channel = emptyChannel();
    const submission: AskPlannerInput = {
      questionType: "architecture_discoverable",
      currentSlice: "the loop",
      question: "shape?",
      approach: "gather→evaluate→execute",
      evidence: ["src/index.ts"],
    };
    const executor = scriptedExecutor(channel, [
      { intents: [{ kind: "consult-requested" }], pendingConsult: submission },
      // After the proceed decision (Qp), Baby submits a blocked report → terminal.
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "stop_condition",
            blockedQuestion: "need Max",
            summary: "blocked",
          },
        ],
      },
    ]);
    const ports = makePorts(
      store,
      fakeRepo({ "src/index.ts": { added: 3, removed: 0 } }),
      executor,
      fakePlanner(),
    );

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "blocked");
    // Gate cleared by the accepted consult.
    const gate = store.readGateState(RUN_ID);
    equal(gate.phase.phase, "cleared");
    // The decision + the proceed obligation were persisted.
    const decisions = store.readDecisions(RUN_ID);
    ok(decisions.some((d) => d.status === "proceed"));
    deepEqual(store.readReviewState(RUN_ID).obligations, ["keep the seam narrow"]);
    await cleanTemp(tmp);
  })();
});

test("turnLoop: orphaned consult re-arms and runs on the next turn", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-rearm-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const submission: AskPlannerInput = {
      questionType: "diff_audit",
      currentSlice: "the slice",
      question: "why was my report rejected?",
      approach: "checking the gate latch",
      evidence: ["src/index.ts"],
    };
    let consultCalls = 0;
    const planner = fakePlanner({
      consult: async () => {
        consultCalls += 1;
        return PROCEED;
      },
    });

    // Turn 1: report rejected + consult submitted in the same turn.
    //   Branch 4 (report-rejected) shadows branch 5 (consult-requested).
    //   The consult is never sent; pendingConsult stays set on the bridge.
    // Turn 2: no new intents — re-arm sees pendingConsult still set,
    //   pushes consult-requested, branch 5 fires, consult runs, gate clears.
    // Turn 3: Baby submits blocked → terminal.
    const executor = scriptedExecutor(channel, [
      {
        intents: [
          { kind: "report-rejected", problems: ["gate latched"] },
          { kind: "consult-requested" },
        ],
        pendingConsult: submission,
        bumpRejection: 1,
      },
      {},
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "stop_condition",
            blockedQuestion: "done",
            summary: "work complete",
          },
        ],
      },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, planner);

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(consultCalls, 1, "consult must run on turn 2 after re-arm");
    const gate = store.readGateState(RUN_ID);
    equal(gate.phase.phase, "cleared", "gate cleared by the re-armed consult");
    const decisions = store.readDecisions(RUN_ID);
    ok(
      decisions.some((d) => d.status === "proceed"),
      "proceed decision persisted",
    );
    equal(result.outcome.status, "blocked");
    await cleanTemp(tmp);
  })();
});

test("turnLoop: consult stop verdict → parks blocked (stop_condition)", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-stop-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const submission: AskPlannerInput = {
      questionType: "stop_condition",
      currentSlice: "x",
      question: "should I?",
      approach: "a",
      evidence: ["e"],
    };
    const stop: PlannerResponse = {
      status: "stop",
      answer: "do not proceed",
      constraints: [],
      evidence_used: [],
      safe_next_action: "halt",
      human_decision_needed: "Max must decide",
    };
    const executor = scriptedExecutor(channel, [
      { intents: [{ kind: "consult-requested" }], pendingConsult: submission },
    ]);
    const ports = makePorts(
      store,
      fakeRepo(),
      executor,
      fakePlanner({ consult: async () => stop }),
    );

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "blocked");
    if (result.outcome.status === "blocked") {
      equal(result.outcome.reason, "stop_condition");
    }
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// no-progress rotate

test("turnLoop: no-progress rotate — session replaced, gate re-latched, then terminal", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-rotate-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const executor = scriptedExecutor(
      channel,
      [
        {}, // no intents, no tool calls, no diff → no progress → rotate (rotateAt=1)
        { intents: [{ kind: "report-accepted", status: "failed", summary: "gave up" }] },
      ],
      ["baby-rotated"],
    );
    const config = Config.parse({ thresholds: { ladderRotateAt: 1, ladderParkAt: 10 } });
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner(), config);

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "failed");
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "rotation" && e.phase === "no_progress"));
    ok(journal.some((e) => e.event === "rotation" && e.phase === "session_replaced"));
    // No checkpoint existed → the rotated gate stacks reconciliation (O6).
    const gate = store.readGateState(RUN_ID);
    equal(gate.phase.phase, "reconciliation-latched");
    equal(store.readMeta(RUN_ID).babySessionId, "baby-rotated");
    await cleanTemp(tmp);
  })();
});

test("turnLoop: provider context overflow rotates instead of parking as dead session", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-overflow-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    let turnCount = 0;
    const executor: Executor = {
      createSession: async () => "baby-overflow-rotated",
      sendMessage: async (sessionID) => {
        turnCount += 1;
        if (turnCount === 1) {
          return {
            info: {
              id: "m1",
              sessionID,
              tokens: {},
              error: {
                name: "ContextOverflowError",
                data: { message: "request (106197 tokens) exceeds the available context size" },
              },
            },
            parts: [],
          };
        }

        channel.intents.push({
          kind: "report-accepted",
          status: "failed",
          summary: "after overflow rotation",
        });
        return { info: { id: "m2", sessionID, tokens: {} }, parts: [] };
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    };
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner());

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "failed");
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "rotation" && e.phase === "context_overflow"));
    ok(journal.some((e) => e.event === "rotation" && e.phase === "session_replaced"));
    ok(!journal.some((e) => e.event === "parked" && e.reason === "wedged"));
    equal(store.readMeta(RUN_ID).babySessionId, "baby-overflow-rotated");
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// gate demands a checkpoint

test("turnLoop: gate trigger at turn end → latch + demand checkpoint (Q4)", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-gate-"));
    // A diff present + initial phase → the first-edit trigger fires.
    const repo = fakeRepo({ "src/index.ts": { added: 5, removed: 1 } });
    const store = StoreAdapter.create(makePaths(tmp), repo, fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const executor = scriptedExecutor(channel, [
      { toolParts: [toolPart("edit")] }, // an edit, gate unapproved → demand checkpoint
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "human_decision",
            blockedQuestion: "?",
            summary: "blocked",
          },
        ],
      },
    ]);
    const ports = makePorts(store, repo, executor, fakePlanner());

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "blocked");
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "gate_latched"));
    // The gate latched on the first turn.
    const latchTurn = journal.find((e) => e.event === "gate_latched");
    ok(latchTurn);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// report rejection cap → failed

test("turnLoop: report rejected at the cap → terminal failed", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-reject-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    // The bridge already counted reportRejectionCount up to the cap (3) and
    // pushed a report-rejected intent → evaluateTurn returns terminal failed.
    const executor = scriptedExecutor(channel, [
      { intents: [{ kind: "report-rejected", problems: ["outcome not done"] }], bumpRejection: 3 },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner());

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "failed");
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// watchdog

test("turnLoop: past the deadline → parks wedged (watchdog)", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-watchdog-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const executor = scriptedExecutor(channel, [{ toolParts: [toolPart("read")] }]);
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner());

    // Deadline already in the past → the first gather trips the watchdog.
    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      0,
    );

    equal(result.outcome.status, "blocked");
    if (result.outcome.status === "blocked") {
      equal(result.outcome.reason, "wedged");
    }
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// neutral continue

test("turnLoop: progress with nothing pending → neutral continue (Q3), then terminal", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-continue-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const executor = scriptedExecutor(channel, [
      { toolParts: [toolPart("read")] }, // progress, nothing pending → continue
      { intents: [{ kind: "report-accepted", status: "failed", summary: "done-ish" }] },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner());

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "failed");
    // Two turns ran (the continue + the terminal).
    const journal = store.readJournal(RUN_ID);
    equal(journal.filter((e) => e.event === "prompt_sent").length, 2);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// send-failure crash path (two consecutive failures → wedged)

test("turnLoop: two consecutive sendMessage failures → parks wedged", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-sndfail-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    let sendCount = 0;
    const throwingExecutor = {
      createSession: async () => "baby-0",
      sendMessage: async () => {
        sendCount += 1;
        if (sendCount <= 2) {
          throw new Error("turn timeout");
        }
        return { info: { id: `m${sendCount}`, sessionID: "s", tokens: {} }, parts: [] };
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    };
    const ports = makePorts(store, fakeRepo(), throwingExecutor, fakePlanner());

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "blocked");
    equal(result.outcome.reason, "wedged");
    // First failure → rotate (turn 1→2). Second failure on rotated session → wedged (turn 2).
    const journal = store.readJournal(RUN_ID);
    equal(journal.filter((e) => e.event === "prompt_sent").length, 2);
    ok(journal.some((e) => e.event === "driver_note" && e.note.includes("turn send failed (1)")));
    ok(journal.some((e) => e.event === "driver_note" && e.note.includes("turn send failed (2)")));
    // One rotation happened (first failure triggers rotateSession).
    ok(journal.some((e) => e.event === "rotation"));
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// planner reorient → rotate + Q9

test("turnLoop: consult reorient → session replaced, Q9 reseed, then terminal", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-reorient-"));
    const store = StoreAdapter.create(
      makePaths(tmp),
      fakeRepo({ "src/index.ts": { added: 3, removed: 0 } }),
      fixedClock(),
    );
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    const submission: AskPlannerInput = {
      questionType: "other",
      currentSlice: "reorient test",
      question: "should I?",
      approach: "a",
      evidence: ["e"],
    };
    const reorient: PlannerResponse = {
      status: "reorient",
      answer: "you're drifting",
      constraints: ["stick to the slice"],
      evidence_used: [],
      safe_next_action: "implement the slice",
      human_decision_needed: null,
    };
    const planner = fakePlanner({ consult: async () => reorient });
    const executor = scriptedExecutor(channel, [
      { intents: [{ kind: "consult-requested" }], pendingConsult: submission },
      { intents: [{ kind: "report-accepted", status: "failed", summary: "after reorient" }] },
    ]);
    const ports = makePorts(
      store,
      fakeRepo({ "src/index.ts": { added: 3, removed: 0 } }),
      executor,
      planner,
    );

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "failed");
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "reorient"));
    const decisions = store.readDecisions(RUN_ID);
    ok(decisions.some((d) => d.status === "reorient"));
    equal(store.readMeta(RUN_ID).reorientRetries, 1);
    equal(store.readGateState(RUN_ID).phase.phase, "first-edit-latched");
    // The second prompt sent should be Q9 (reorient seed).
    const prompts = journal.filter((e) => e.event === "prompt_sent");
    equal(prompts.length, 2);
    equal(prompts[1].promptName, "Q9");
    equal(store.readMeta(RUN_ID).babySessionId, "baby-r1");
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// demand_teardown (context budget exhaustion → Q5)

test("turnLoop: context budget reached → demand_teardown Q5, then terminal", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-teardown-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    let turnCount = 0;
    const teardownExecutor = {
      createSession: async () => "baby-0",
      sendMessage: async () => {
        turnCount += 1;
        // Turn 1: high tokens → triggers demand_teardown → Q5. No intents this turn.
        // Turn 2: no high tokens, but report-accepted intent (pushed before evaluateTurn) → terminal (Branch 3)
        if (turnCount === 2) {
          channel.intents.push({
            kind: "report-accepted",
            status: "failed",
            summary: "after teardown",
          });
        }
        return {
          info: {
            id: `m${turnCount}`,
            sessionID: "s",
            tokens: turnCount === 1 ? { input: 1_400_000, output: 0 } : {},
          },
          parts: [],
        };
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    };
    const config = Config.parse({ thresholds: { rotationFraction: 0.01 } }); // Very low budget (~12000)
    const ports = makePorts(store, fakeRepo(), teardownExecutor, fakePlanner(), config);

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "failed");
    const journal = store.readJournal(RUN_ID);
    const hasTeardown = journal.filter(
      (e) => "phase" in e && e.phase === "teardown_demanded",
    ).length;
    ok(hasTeardown > 0, "should have teardown_demanded rotation phase");
    const prompts = journal.filter((e) => e.event === "prompt_sent");
    equal(prompts.length, 2);
    equal(prompts[1].promptName, "Q5");
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// re_demand_teardown (rotationPending + no checkpoint → Q5 again, ladder climbs)

test("turnLoop: rotationPending with no checkpoint → re_demand_teardown Q5, ladder climbs", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "tl-redemand-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    seedRun(store, packet);

    const channel = emptyChannel();
    let turnCount = 0;
    const redemandExecutor = {
      createSession: async () => "baby-0",
      sendMessage: async () => {
        turnCount += 1;
        // Turn 1: high tokens → demand_teardown → Q5, rotationPending=true
        // Turn 2: no intents, no checkpoint → re_demand_teardown → Q5 again, ladder climbs
        // Turn 3: report-accepted intent → terminal (Branch 3 beats Branch 7)
        if (turnCount === 1) {
          return { info: { id: "m1", sessionID: "s", tokens: { input: 1_400_000 } }, parts: [] };
        }
        if (turnCount === 2) {
          // No intents, no checkpoint — just progress → re_demand_teardown
          return { info: { id: "m2", sessionID: "s", tokens: {} }, parts: [] };
        }
        channel.intents.push({
          kind: "report-accepted",
          status: "failed",
          summary: "after re-demand",
        });
        return { info: { id: "m3", sessionID: "s", tokens: {} }, parts: [] };
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    };
    const config = Config.parse({
      thresholds: { rotationFraction: 0.01, ladderRotateAt: 3, ladderParkAt: 5 },
    });
    const ports = makePorts(store, fakeRepo(), redemandExecutor, fakePlanner(), config);

    const result = await turnLoop(
      ports,
      packet,
      "/tmp/worktree",
      "baby-0",
      channel,
      { name: "Q1", text: "go" },
      FAR_FUTURE,
    );

    equal(result.outcome.status, "failed");
    const journal = store.readJournal(RUN_ID);
    // First teardown demand + re-demand (ladder climbs twice: once for demand_teardown, once for re_demand_teardown)
    ok(
      journal.some((e) => "phase" in e && e.phase === "teardown_demanded"),
      "should have teardown_demanded rotation phase",
    );
    const ladderSteps = journal.filter((e) => e.event === "ladder_step");
    ok(ladderSteps.length >= 1, "ladder should have climbed at least 1 step (re_demand_teardown)");
    const prompts = journal.filter((e) => e.event === "prompt_sent");
    equal(prompts.length, 3);
    equal(prompts[0].promptName, "Q1");
    equal(prompts[1].promptName, "Q5");
    equal(prompts[2].promptName, "Q5");
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// model helpers — pure

test("babyModelConfig: returns baby provider/model/agent", () => {
  const config = Config.parse({});
  const model = babyModelConfig(config);
  equal(model.providerId, "omlx");
  equal(model.modelId, "Qwen3.6-35B-A3B-UD-MLX-4bit");
  equal(model.agent, "baby");
});

test("promotedModelConfig: returns promoteTo provider/model with baby agent", () => {
  const config = Config.parse({});
  const model = promotedModelConfig(config);
  equal(model.providerId, "zai-coding-plan");
  equal(model.modelId, "glm-5.1");
  equal(model.agent, "baby");
});
