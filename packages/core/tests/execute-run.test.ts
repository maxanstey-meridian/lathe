import { equal, ok, deepEqual, strictEqual } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp as mkdtempP, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Executor } from "../src/application/ports/executor.js";
import type { Planner } from "../src/application/ports/planner.js";
import type { Repo } from "../src/application/ports/repo.js";
import type { Store } from "../src/application/ports/store.js";
import { makeExecuteRun, type BridgeBinding } from "../src/application/use-cases/execute-run.js";
import { rotateSession } from "../src/application/use-cases/rotation.js";
import type { RunPorts, RunChannel } from "../src/application/use-cases/run-runtime.js";
import { makePaths } from "../src/config/paths.js";
import { Config } from "../src/config/schemas.js";
import { initialGateState } from "../src/domain/gate.js";
import { parsePacketShape, type Packet } from "../src/domain/packet.js";
import { decideRunStart } from "../src/domain/run.js";
import type { BridgeIntent } from "../src/domain/turn.js";
import { StoreAdapter } from "../src/infrastructure/store.js";

const RUN_ID = "20260101-000000-execrun";

const PACKET_RAW = `---
repo: /tmp/test-repo
base: main
summary: execute-run fixture
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
    throw new Error(shape.problems.join("; "));
  }
  return shape.packet;
};

const TS = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1_700_000_000_000 + TS.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS.n++ % 60).padStart(2, "0")}.000Z`,
});

const fakeRepo = (): Repo => ({
  createSandbox: () => {},
  wipCommit: () => "sha000",
  amendCommit: () => "sha000",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => ({}),
  reviewableDiff: () => "diff",
  reviewableDiffAgainst: () => "diff",
  fetchBranchFromClone: () => {},
  removeSandbox: () => {},
  headBranch: () => "main",
  branchExists: () => true,
  repoValid: () => true,
  mergeAccept: () => {},
});

const fakePlanner = (): Planner => ({
  handshake: async () => "daddy-session",
  resumeSession: async (sid: string) => sid,
  consult: async () => ({
    status: "proceed",
    answer: "go",
    constraints: [],
    evidence_used: [],
    safe_next_action: "x",
    human_decision_needed: null,
  }),
  finalReview: async () => ({
    verdict: "accept",
    findings: [],
    notes: "ok",
    human_decision_needed: null,
  }),
});

const emptyChannel = (): RunChannel => ({
  intents: [],
  pendingConsult: null,
  pendingFinalReview: null,
  reportRejectionCount: 0,
  checkpointBounceCount: 0,
  turn: 0,
  awaitingVerification: false,
});

const scriptedExecutor = (
  channel: RunChannel,
  steps: Array<{ intents?: BridgeIntent[] }>,
  newSessionIds: string[] = [],
): Executor => {
  let i = 0;
  let s = 0;
  return {
    createSession: async () => newSessionIds[s++] ?? `baby-${s}`,
    sendMessage: async () => {
      const step = steps[i++] ?? {};
      if (step.intents) {
        channel.intents.push(...step.intents);
      }
      return { info: { id: `m${i}`, sessionID: "s", tokens: {} }, parts: [] };
    },
    listMessages: async () => [],
    abortSession: async () => {},
    deleteSession: async () => {},
  };
};

const makePorts = (store: Store, repo: Repo, executor: Executor, planner: Planner): RunPorts => ({
  config: Config.parse({}),
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

// ---------------------------------------------------------------------------
// decideRunStart (run lifecycle: fresh vs resume)
// ---------------------------------------------------------------------------

test("decideRunStart: no prior meta → fresh", () => {
  equal(decideRunStart(undefined, "", undefined).mode, "fresh");
  equal(decideRunStart(undefined, "packet", "queue").mode, "fresh");
});

test("decideRunStart: prior meta but no babySessionId → fresh", () => {
  const meta = { babySessionId: undefined, daddySessionId: "daddy-old", attempt: 1 };
  equal(decideRunStart(meta, "frozen", "queue").mode, "fresh");
});

test("decideRunStart: prior meta with babySessionId + no frozen + queue → fresh", () => {
  const meta = { babySessionId: "baby-old", daddySessionId: "daddy-old", attempt: 1 };
  const result = decideRunStart(meta, "", "queue");
  equal(result.mode, "fresh");
  equal(result.reason, "no frozen snapshot, using queue packet");
});

test("decideRunStart: prior meta with babySessionId + frozen + no queue → resume", () => {
  const meta = { babySessionId: "baby-old", daddySessionId: "daddy-old", attempt: 1 };
  const result = decideRunStart(meta, "frozen-content", undefined);
  equal(result.mode, "resume");
});

test("decideRunStart: prior meta with babySessionId + identical frozen and queue → resume", () => {
  const meta = { babySessionId: "baby-old", daddySessionId: "daddy-old", attempt: 1 };
  const content = "---\nrepo: x\nbase: main\n---\nbody";
  const result = decideRunStart(meta, content, content);
  equal(result.mode, "resume");
});

test("decideRunStart: prior meta with babySessionId + queue differs from frozen → fresh", () => {
  const meta = { babySessionId: "baby-old", daddySessionId: "daddy-old", attempt: 1 };
  const result = decideRunStart(meta, "frozen-old", "queue-new");
  equal(result.mode, "fresh");
  equal(result.reason, "queue packet differs from frozen snapshot");
});

test("decideRunStart: identical frozen and queue packets → resume", () => {
  const meta = { babySessionId: "baby-old", daddySessionId: "daddy-old", attempt: 1 };
  const same = "---\nrepo: x\nbase: main\n---\nbody";
  const result = decideRunStart(meta, same, same);
  equal(result.mode, "resume");
});

// ---------------------------------------------------------------------------
// rotation (O5/O6)

test("rotateSession: replaces the session, updates meta, latches first-edit (with checkpoint)", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "rot-cp-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    store.writeMeta({
      runId: RUN_ID,
      status: "running",
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: "/tmp/wt",
      babySessionId: "baby-0",
      stallRetries: 0,
      reorientRetries: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.writeGateState(
      RUN_ID,
      initialGateState(
        RUN_ID,
        ["src/index.ts"],
        [],
        {
          checkpointNudgeMs: 1,
          checkpointToolCalls: 1,
          checkpointFiles: 1,
          checkpointLoc: 1,
          mutationCommandPatterns: [],
        },
        "2026-01-01T00:00:00.000Z",
      ),
    );

    const executor = scriptedExecutor(emptyChannel(), [], ["baby-1"]);
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner());

    const newId = await rotateSession(ports, packet, "/tmp/wt", "baby-0", 4, false);

    equal(newId, "baby-1");
    equal(store.readMeta(RUN_ID).babySessionId, "baby-1");
    const gate = store.readGateState(RUN_ID);
    equal(gate.phase.phase, "first-edit-latched");
    await cleanTemp(tmp);
  })();
});

test("rotateSession: no checkpoint stacks reconciliation (O6)", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "rot-nocp-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const packet = parseFixture();
    store.writeMeta({
      runId: RUN_ID,
      status: "running",
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: "/tmp/wt",
      babySessionId: "baby-0",
      stallRetries: 0,
      reorientRetries: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.writeGateState(
      RUN_ID,
      initialGateState(
        RUN_ID,
        ["src/index.ts"],
        [],
        {
          checkpointNudgeMs: 1,
          checkpointToolCalls: 1,
          checkpointFiles: 1,
          checkpointLoc: 1,
          mutationCommandPatterns: [],
        },
        "2026-01-01T00:00:00.000Z",
      ),
    );

    const ports = makePorts(
      store,
      fakeRepo(),
      scriptedExecutor(emptyChannel(), [], ["baby-1"]),
      fakePlanner(),
    );
    await rotateSession(ports, packet, "/tmp/wt", "baby-0", 2, true);

    const gate = store.readGateState(RUN_ID);
    equal(gate.phase.phase, "reconciliation-latched");
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// execute-run (R2)

test("makeExecuteRun: fresh run → freeze + init state → terminal status in meta", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-fresh-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    // The packet is frozen by admission before execute-run reads it.
    store.freezePacket(RUN_ID, PACKET_RAW);

    const channel = emptyChannel();
    const executor = scriptedExecutor(channel, [
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "human_decision",
            blockedQuestion: "decide",
            summary: "blocked out",
          },
        ],
      },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner());
    const bridge: BridgeBinding<unknown> = { beginRun: () => channel, endRun: () => {} };

    const executeRun = makeExecuteRun(ports, bridge);
    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "wt"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );

    const meta = store.readMeta(RUN_ID);
    equal(meta.status, "blocked");
    equal(meta.blockedReason, "human_decision");
    equal(meta.babySessionId, "baby-1");
    equal(meta.daddySessionId, "daddy-session");
    // The ledger + gate were initialised on the fresh attempt.
    equal(store.readLedger(RUN_ID).outcomes.length, 1);
    ok(store.readGateState(RUN_ID));
    // The first seed was Q1 and the active run was cleared at finalize.
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "prompt_sent" && e.promptName === "Q1"));
    ok(journal.some((e) => e.event === "run_started"));
    equal(store.readActiveRun(), undefined);
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: real fresh queue path — reads from queue dir, not pre-frozen", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-fresh-queue-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());

    // Do NOT freeze the packet — instead write it directly to the queue dir.
    mkdirSync(join(tmp, "queue"), { recursive: true });
    writeFileSync(join(tmp, "queue", `${RUN_ID}.md`), PACKET_RAW);

    // Simulate what run-loop does: initMetaFromQueue → writeMeta as running.
    const meta = store.initMetaFromQueue(RUN_ID);
    ok(meta, "initMetaFromQueue produced a RunMeta from the queue packet");
    equal(meta.repo, "/tmp/test-repo");
    equal(meta.base, "main");
    equal(meta.branch, `meridian/${RUN_ID}`);
    equal(meta.worktree, join(tmp, "runs", RUN_ID, "worktree"));
    store.writeMeta({ ...meta, status: "running" as const, updatedAt: "2026-01-01T00:00:00.000Z" });

    const channel = emptyChannel();
    const executor = scriptedExecutor(channel, [
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "human_decision",
            blockedQuestion: "decide",
            summary: "blocked out",
          },
        ],
      },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner());
    const bridge: BridgeBinding<unknown> = { beginRun: () => channel, endRun: () => {} };

    const executeRun = makeExecuteRun(ports, bridge);
    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "runs", RUN_ID, "worktree"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );

    const metaAfter = store.readMeta(RUN_ID);
    equal(metaAfter.status, "blocked");
    equal(metaAfter.blockedReason, "human_decision");
    // The frozen packet was created from the queue source.
    ok(
      store.readFrozenPacket(RUN_ID).includes("---"),
      "frozen packet was written from queue source",
    );
    // The ledger + gate were initialised on the fresh attempt.
    equal(store.readLedger(RUN_ID).outcomes.length, 1);
    ok(store.readGateState(RUN_ID));
    // The first seed was Q1.
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "prompt_sent" && e.promptName === "Q1"));
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: resume → reuses prior Daddy session ID, refreshes gate", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-resume-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());

    // Freeze packet (resume has already frozen from the fresh attempt).
    store.freezePacket(RUN_ID, PACKET_RAW);

    // Prior meta from the previous run session.
    store.writeMeta({
      runId: RUN_ID,
      status: "queued",
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: join(tmp, "runs", RUN_ID, "worktree"),
      babySessionId: "baby-old",
      daddySessionId: "daddy-prior",
      stallRetries: 0,
      reorientRetries: 2,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    // Prior gate state.
    store.writeGateState(
      RUN_ID,
      initialGateState(
        RUN_ID,
        ["src/index.ts"],
        [],
        {
          checkpointNudgeMs: 1_000_000,
          checkpointToolCalls: 50,
          checkpointFiles: 6,
          checkpointLoc: 80,
          mutationCommandPatterns: [],
        },
        "2026-01-01T00:00:00.000Z",
      ),
    );
    // Prior ledger.
    const shape = parsePacketShape(PACKET_RAW, RUN_ID);
    ok(shape.ok);
    store.writeLedger(store.initialLedger(shape.packet));
    store.replaceObligations(RUN_ID, []);

    let handshakeCalled = false;
    const resumePlanner: Planner = {
      handshake: async () => {
        handshakeCalled = true;
        return "daddy-new";
      },
      resumeSession: async (sid: string) => {
        equal(sid, "daddy-prior", "resumeSession receives the prior Daddy session ID");
        return sid;
      },
      consult: async () => ({
        status: "proceed",
        answer: "go",
        constraints: [],
        evidence_used: [],
        safe_next_action: "x",
        human_decision_needed: null,
      }),
      finalReview: async () => ({
        verdict: "accept",
        findings: [],
        notes: "ok",
        human_decision_needed: null,
      }),
    };

    const channel = emptyChannel();
    const executor = scriptedExecutor(channel, [
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "stop_condition",
            blockedQuestion: "done",
            summary: "resumed",
          },
        ],
      },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, resumePlanner);
    const bridge: BridgeBinding<unknown> = { beginRun: () => channel, endRun: () => {} };

    const executeRun = makeExecuteRun(ports, bridge);
    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "runs", RUN_ID, "worktree"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );

    const meta = store.readMeta(RUN_ID);
    equal(meta.status, "blocked");
    equal(meta.attempt, 2, "resume increments attempt");
    equal(meta.daddySessionId, "daddy-prior", "resume preserves prior Daddy session ID");
    equal(meta.babySessionId, "baby-1", "new Baby session created");
    equal(
      handshakeCalled,
      false,
      "handshake NOT called on resume — resumeSession was used instead",
    );
    // Gate was refreshed with current config thresholds.
    const gate = store.readGateState(RUN_ID);
    equal(gate.checkpointNudgeMs, 1200000);
    deepEqual(gate.mutationCommandPatterns, [
      "\\b(pnpm|npm|yarn)\\b.*\\bgenerate\\b",
      "task contracts",
      "dotnet-rivet",
    ]);
    // Prior stallRetries preserved (resume doesn't reset counters).
    equal(meta.stallRetries, 0);
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: resume replaces stale Daddy session before reconciliation", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-stale-daddy-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());

    store.freezePacket(RUN_ID, PACKET_RAW);
    store.writeMeta({
      runId: RUN_ID,
      status: "queued",
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: join(tmp, "runs", RUN_ID, "worktree"),
      babySessionId: "baby-old",
      daddySessionId: "daddy-stale",
      stallRetries: 0,
      reorientRetries: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.writeGateState(
      RUN_ID,
      initialGateState(
        RUN_ID,
        ["src/index.ts"],
        [],
        {
          checkpointNudgeMs: 1_000_000,
          checkpointToolCalls: 50,
          checkpointFiles: 6,
          checkpointLoc: 80,
          mutationCommandPatterns: [],
        },
        "2026-01-01T00:00:00.000Z",
      ),
    );
    const shape = parsePacketShape(PACKET_RAW, RUN_ID);
    ok(shape.ok);
    store.writeLedger(store.initialLedger(shape.packet));
    store.replaceObligations(RUN_ID, []);

    let resumeCalled = false;
    let handshakeCalled = false;
    const planner: Planner = {
      handshake: async () => {
        handshakeCalled = true;
        return "daddy-new";
      },
      resumeSession: async () => {
        resumeCalled = true;
        return "daddy-stale";
      },
      consult: async () => ({
        status: "proceed",
        answer: "go",
        constraints: [],
        evidence_used: [],
        safe_next_action: "submit",
        human_decision_needed: null,
      }),
      finalReview: async () => ({
        verdict: "accept",
        findings: [],
        notes: "ok",
        human_decision_needed: null,
      }),
    };

    const channel = emptyChannel();
    let abortCalled = false;
    let deleteCalled = false;
    const executor: Executor = {
      createSession: async () => "baby-new",
      sendMessage: async () => {
        channel.intents.push({
          kind: "report-accepted",
          status: "blocked",
          blockedReason: "stop_condition",
          blockedQuestion: "done",
          summary: "resumed",
        });
        return { info: { id: "m1", sessionID: "baby-new", tokens: {} }, parts: [] };
      },
      listMessages: async (sessionId: string) => {
        equal(sessionId, "daddy-stale");
        return [
          { info: { id: "daddy-msg", sessionID: sessionId, role: "assistant" }, parts: [] },
          { info: { id: "restarted-prompt", sessionID: sessionId, role: "user" }, parts: [] },
        ];
      },
      abortSession: async (sessionId: string) => {
        equal(sessionId, "daddy-stale");
        abortCalled = true;
      },
      deleteSession: async (sessionId: string) => {
        equal(sessionId, "daddy-stale");
        deleteCalled = true;
      },
    };
    const ports = makePorts(store, fakeRepo(), executor, planner);
    const bridge: BridgeBinding<unknown> = { beginRun: () => channel, endRun: () => {} };

    const executeRun = makeExecuteRun(ports, bridge);
    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "runs", RUN_ID, "worktree"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );

    const meta = store.readMeta(RUN_ID);
    equal(meta.daddySessionId, "daddy-new");
    equal(resumeCalled, false, "stale Daddy session is not resumed");
    equal(handshakeCalled, true, "fresh Daddy handshake replaces stale session");
    equal(abortCalled, true, "stale Daddy session is aborted");
    equal(deleteCalled, true, "stale Daddy session is deleted");
    const journal = store.readJournal(RUN_ID);
    ok(
      journal.some(
        (e) => e.event === "driver_note" && e.note === "replacing stale Daddy session daddy-stale",
      ),
    );
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: resume without checkpoint but prior accepted reconciliation → Q8b, gate re-latched for first-edit only", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-recon-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());

    store.freezePacket(RUN_ID, PACKET_RAW);

    store.writeMeta({
      runId: RUN_ID,
      status: "queued",
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: join(tmp, "runs", RUN_ID, "worktree"),
      babySessionId: "baby-old",
      daddySessionId: "daddy-prior",
      stallRetries: 0,
      reorientRetries: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    // Simulate the real gate state after reconciliation was accepted:
    // clearedGateState set phase to "cleared".
    store.writeGateState(RUN_ID, {
      ...initialGateState(
        RUN_ID,
        ["src/index.ts"],
        [],
        {
          checkpointNudgeMs: 1_000_000,
          checkpointToolCalls: 50,
          checkpointFiles: 6,
          checkpointLoc: 80,
          mutationCommandPatterns: [],
        },
        "2026-01-01T00:00:00.000Z",
      ),
      phase: { phase: "cleared" },
      lastAcceptedDecisionAt: "2026-01-01T00:00:00.000Z",
    });
    const shape = parsePacketShape(PACKET_RAW, RUN_ID);
    ok(shape.ok);
    store.writeLedger(store.initialLedger(shape.packet));
    store.replaceObligations(RUN_ID, []);

    // Prior accepted reconciliation — the last decision.
    store.appendDecision(RUN_ID, {
      timestamp: "2026-01-01T00:00:01.000Z",
      source: "daddy",
      questionType: "reconciliation",
      question: "reconstructed state",
      approach: "continue from outcome 2",
      evidence: [],
      status: "proceed",
      answer: "looks good",
      constraints: [],
    });

    let firstSeed = "";
    const capturingPlanner: Planner = {
      handshake: async () => "daddy-new",
      resumeSession: async (sid: string) => sid,
      consult: async () => ({
        status: "proceed",
        answer: "go",
        constraints: [],
        evidence_used: [],
        safe_next_action: "x",
        human_decision_needed: null,
      }),
      finalReview: async () => ({
        verdict: "accept",
        findings: [],
        notes: "ok",
        human_decision_needed: null,
      }),
    };
    const channel = emptyChannel();
    let sendCount = 0;
    const capturingExecutor: Executor = {
      createSession: async () => "baby-1",
      sendMessage: async (_sid, text) => {
        if (sendCount === 0) {
          firstSeed = text;
        }
        sendCount++;
        return { info: { id: "m1", sessionID: "s", tokens: {} }, parts: [] };
      },
      listMessages: async () => [],
      deleteSession: async () => {},
    };
    const ports = makePorts(store, fakeRepo(), capturingExecutor, capturingPlanner);
    const bridge: BridgeBinding<unknown> = { beginRun: () => channel, endRun: () => {} };

    const executeRun = makeExecuteRun(ports, bridge);
    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "runs", RUN_ID, "worktree"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );

    // Gate must be first-edit-latched (no reconciliation).
    const gate = store.readGateState(RUN_ID);
    equal(gate.phase.phase, "first-edit-latched", "gate re-latched for first-edit consult");
    // Seed must be Q8b (resume, not reconcile).
    ok(firstSeed.includes("resuming a run after a session rotation"), "Q8b resume seed");
    ok(!firstSeed.includes("RECONCILIATION"), "not the Q8 reconciliation seed");
    // Seed must include the full prior reconciliation outcome.
    ok(firstSeed.includes("reconstructed state"), "Q8b seed includes recon question");
    ok(firstSeed.includes("continue from outcome 2"), "Q8b seed includes recon approach");
    ok(firstSeed.includes("looks good"), "Q8b seed includes Daddy's verdict");
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: invalid frozen packet → meta failed, no throw", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-bad-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    store.freezePacket(RUN_ID, "not a packet");
    store.writeMeta({
      runId: RUN_ID,
      status: "running",
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: join(tmp, "wt"),
      stallRetries: 0,
      reorientRetries: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const ports = makePorts(store, fakeRepo(), scriptedExecutor(emptyChannel(), []), fakePlanner());
    const bridge: BridgeBinding<unknown> = { beginRun: () => emptyChannel(), endRun: () => {} };
    const executeRun = makeExecuteRun(ports, bridge);

    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "wt"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );

    equal(store.readMeta(RUN_ID).status, "failed");
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: resumed run with changed queue packet → fresh (Q1 seed, new sessions)", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-fresh-different-queue-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());

    // Frozen packet from a prior run attempt.
    const oldPacketRaw = `---
repo: /tmp/test-repo
base: main
summary: OLD packet
outcomes:
  - id: test-outcome
    description: A test outcome
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

old body
`;
    store.freezePacket(RUN_ID, oldPacketRaw);

    // Queue packet has been EDITED since the prior run.
    const newPacketRaw = `---
repo: /tmp/test-repo
base: main
summary: NEW packet
outcomes:
  - id: test-outcome
    description: A test outcome
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

new body
`;
    mkdirSync(join(tmp, "queue"), { recursive: true });
    writeFileSync(join(tmp, "queue", `${RUN_ID}.md`), newPacketRaw);

    // Prior meta from the previous run session.
    store.writeMeta({
      runId: RUN_ID,
      status: "queued",
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: join(tmp, "runs", RUN_ID, "worktree"),
      babySessionId: "baby-old",
      daddySessionId: "daddy-prior",
      stallRetries: 0,
      crashRetries: 1,
      reorientRetries: 0,
      reviewerUnreachable: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    let handshakeCalled = false;
    const resumePlanner: Planner = {
      handshake: async () => {
        handshakeCalled = true;
        return "daddy-new";
      },
      resumeSession: async (_sid: string) => {
        // Should NOT be called — this is a fresh start, not a resume.
        throw new Error("resumeSession should NOT be called on fresh start");
      },
      consult: async () => ({
        status: "proceed",
        answer: "go",
        constraints: [],
        evidence_used: [],
        safe_next_action: "x",
        human_decision_needed: null,
      }),
      finalReview: async () => ({
        verdict: "accept",
        findings: [],
        notes: "ok",
        human_decision_needed: null,
      }),
    };

    const channel = emptyChannel();
    const executor = scriptedExecutor(channel, [
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "stop_condition",
            blockedQuestion: "done",
            summary: "fresh after packet change",
          },
        ],
      },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, resumePlanner);
    const bridge: BridgeBinding<unknown> = { beginRun: () => channel, endRun: () => {} };

    const executeRun = makeExecuteRun(ports, bridge);
    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "runs", RUN_ID, "worktree"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );

    const meta = store.readMeta(RUN_ID);
    equal(meta.status, "blocked");
    equal(meta.attempt, 2, "attempt incremented");
    equal(meta.babySessionId, "baby-1", "new Baby session created");
    equal(meta.daddySessionId, "daddy-new", "new Daddy session via handshake");
    equal(handshakeCalled, true, "handshake called (not resumeSession) because packet changed");
    // The frozen packet was updated from the queue (new) packet.
    ok(
      store.readFrozenPacket(RUN_ID).includes("NEW packet"),
      "frozen packet re-written from queue on fresh",
    );
    // The first seed was Q1 (fresh), not Q2 (resume).
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "prompt_sent" && e.promptName === "Q1"));
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: run with prior meta but no baby session → fresh", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-fresh-no-baby-"));
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    store.freezePacket(RUN_ID, PACKET_RAW);

    // Prior meta WITHOUT a babySessionId (e.g. a crashed run where baby session was lost).
    store.writeMeta({
      runId: RUN_ID,
      status: "queued",
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: join(tmp, "runs", RUN_ID, "worktree"),
      daddySessionId: "daddy-prior",
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      reviewerUnreachable: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const channel = emptyChannel();
    const executor = scriptedExecutor(channel, [
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "stop_condition",
            blockedQuestion: "done",
            summary: "fresh",
          },
        ],
      },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner());
    const bridge: BridgeBinding<unknown> = { beginRun: () => channel, endRun: () => {} };

    const executeRun = makeExecuteRun(ports, bridge);
    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "runs", RUN_ID, "worktree"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );

    const meta = store.readMeta(RUN_ID);
    equal(meta.status, "blocked");
    equal(meta.attempt, 2);
    // The ledger + gate were initialised (fresh state).
    equal(store.readLedger(RUN_ID).outcomes.length, 1);
    // The first seed was Q1 (fresh).
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "prompt_sent" && e.promptName === "Q1"));
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: fresh start clears stale checkpoint/decision/review state", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-fresh-clears-stale-"));
    const clock = fixedClock();
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    // Seed a frozen packet so decideRunStart returns "resume" with babySessionId present.
    store.freezePacket(RUN_ID, PACKET_RAW);

    // Seed stale checkpoint.
    const c1 = {
      number: 1,
      reason: "checkpoint",
      summary: "stale checkpoint",
      outcomes: [{ id: "test-outcome", status: "done" as const, evidence: [] }],
      writtenAt: clock.nowIso(),
    };
    store.writeCheckpoint(RUN_ID, c1);
    equal(store.latestCheckpoint(RUN_ID)?.number, 1, "checkpoint seeded");

    // Seed stale decisions.
    store.appendDecision(RUN_ID, {
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "daddy" as const,
      questionType: "other",
      question: "q1",
      status: "proceed",
      answer: "a1",
      constraints: [],
    });
    strictEqual(store.readDecisions(RUN_ID).length, 1, "decisions seeded");

    // Seed stale review state.
    store.replaceObligations(RUN_ID, ["fix x"]);
    equal(store.readReviewState(RUN_ID).obligations.length, 1, "review state seeded");

    // Prior meta with babySessionId (simulates a resumed run whose packet was edited,
    // triggering a fresh start via decideRunStart).
    const newPacketRaw = `---
repo: /tmp/test-repo
base: main
summary: NEW packet
outcomes:
  - id: test-outcome
    description: A test outcome
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

new body
`;
    mkdirSync(join(tmp, "queue"), { recursive: true });
    writeFileSync(join(tmp, "queue", `${RUN_ID}.md`), newPacketRaw);

    store.writeMeta({
      runId: RUN_ID,
      status: "queued",
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: join(tmp, "runs", RUN_ID, "worktree"),
      babySessionId: "baby-old",
      daddySessionId: "daddy-prior",
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      reviewerUnreachable: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const channel = emptyChannel();
    const executor = scriptedExecutor(channel, [
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "stop_condition",
            blockedQuestion: "done",
            summary: "fresh after packet change",
          },
        ],
      },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner());
    const bridge: BridgeBinding<unknown> = { beginRun: () => channel, endRun: () => {} };

    const executeRun = makeExecuteRun(ports, bridge);
    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "runs", RUN_ID, "worktree"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );

    // Verify stale artifacts are cleared.
    equal(store.latestCheckpoint(RUN_ID), undefined, "stale checkpoint cleared on fresh start");
    strictEqual(store.readDecisions(RUN_ID).length, 0, "stale decisions cleared on fresh start");
    strictEqual(
      store.readReviewState(RUN_ID).obligations.length,
      0,
      "stale review state cleared on fresh start",
    );
    // The first seed was Q1 (fresh), not Q2 (resume with checkpoint).
    const journal = store.readJournal(RUN_ID);
    ok(journal.some((e) => e.event === "prompt_sent" && e.promptName === "Q1"));
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: fresh start clears stale checkpoint so unchanged-packet resume does not hit Q2", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-fresh-resume-q8-"));
    const clock = fixedClock();
    const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    // Phase 1: seed a prior session's checkpoint, decisions, review state.
    store.freezePacket(RUN_ID, PACKET_RAW);
    store.writeCheckpoint(RUN_ID, {
      number: 1,
      reason: "checkpoint",
      summary: "stale",
      outcomes: [{ id: "test-outcome", status: "not_started", evidence: [] }],
      writtenAt: clock.nowIso(),
    });

    // Phase 2: simulate a fresh start (packet was edited, so decideRunStart → fresh).
    const newPacketRaw = `---
repo: /tmp/test-repo
base: main
summary: NEW packet
outcomes:
  - id: test-outcome
    description: A test outcome
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

new body
`;
    mkdirSync(join(tmp, "queue"), { recursive: true });
    writeFileSync(join(tmp, "queue", `${RUN_ID}.md`), newPacketRaw);

    store.writeMeta({
      runId: RUN_ID,
      status: "queued",
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: join(tmp, "runs", RUN_ID, "worktree"),
      babySessionId: "baby-old",
      daddySessionId: "daddy-prior",
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      reviewerUnreachable: 0,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const channel = emptyChannel();
    const executor = scriptedExecutor(channel, [
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "stop_condition",
            blockedQuestion: "done",
            summary: "fresh",
          },
        ],
      },
    ]);
    const ports = makePorts(store, fakeRepo(), executor, fakePlanner());
    const bridge: BridgeBinding<unknown> = { beginRun: () => channel, endRun: () => {} };

    const executeRun = makeExecuteRun(ports, bridge);
    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "runs", RUN_ID, "worktree"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );

    // Verify checkpoint cleared.
    equal(store.latestCheckpoint(RUN_ID), undefined);

    // Phase 3: now simulate a second run with the SAME (unchanged) frozen packet
    // and babySessionId still present — this is a resume. Since checkpoint was cleared,
    // the resume seed should be Q8 (no checkpoint), not Q2.
    const channel2 = emptyChannel();
    const executor2 = scriptedExecutor(channel2, [
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "stop_condition",
            blockedQuestion: "done",
            summary: "resumed after fresh",
          },
        ],
      },
    ]);
    const resumePlanner: Planner = {
      handshake: async () => "daddy-new",
      resumeSession: async (sid: string) => sid,
      consult: async () => ({
        status: "proceed",
        answer: "go",
        constraints: [],
        evidence_used: [],
        safe_next_action: "x",
        human_decision_needed: null,
      }),
      finalReview: async () => ({
        verdict: "accept",
        findings: [],
        notes: "ok",
        human_decision_needed: null,
      }),
    };
    const ports2 = makePorts(store, fakeRepo(), executor2, resumePlanner);
    const bridge2: BridgeBinding<unknown> = { beginRun: () => channel2, endRun: () => {} };

    const executeRun2 = makeExecuteRun(ports2, bridge2);
    await executeRun2(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "runs", RUN_ID, "worktree"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports2.clock,
    );

    // The resumed run (Phase 3) should have used Q8 (reconciliation, no checkpoint), not Q2.
    // Journal contains both Phase 2's fresh Q1 and Phase 3's resume Q8 — check the last seed.
    const journal2 = store.readJournal(RUN_ID);
    const prompts = journal2.filter((e) => e.event === "prompt_sent");
    const seedPrompts = prompts.filter(
      (e) => e.promptName === "Q1" || e.promptName === "Q2" || e.promptName === "Q8",
    );
    ok(seedPrompts.length >= 2, "expected at least 2 seed prompts across both phases");
    const lastSeed = seedPrompts[seedPrompts.length - 1];
    equal(
      lastSeed!.promptName,
      "Q8",
      "Phase 3 resume after fresh with no checkpoint uses Q8, not Q2",
    );
    await cleanTemp(tmp);
  })();
});
