import { equal, ok, deepEqual, rejects, strictEqual } from "node:assert";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp as mkdtempP, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Executor } from "../src/application/ports/executor.js";
import type { Planner } from "../src/application/ports/planner.js";
import type { Repo } from "../src/application/ports/repo.js";
import type { Store } from "../src/application/ports/store.js";
import type { Verify } from "../src/application/ports/verify.js";
import { makeExecuteRun, type BridgeBinding } from "../src/application/use-cases/execute-run.js";
import { rotateSession } from "../src/application/use-cases/rotation.js";
import type { RunPorts, RunChannel } from "../src/application/use-cases/run-runtime.js";
import { createConfigSource } from "../src/application/use-cases/run-runtime.js";
import { makePaths } from "../src/config/paths.js";
import { Config } from "../src/config/schemas.js";
import { initialGateState } from "../src/domain/gate.js";
import { parsePacketShape, type Packet } from "../src/domain/packet.js";
import { decideRunStart, type RunMeta } from "../src/domain/run.js";
import type { BridgeIntent } from "../src/domain/turn.js";
import { SqliteStoreAdapter } from "../src/infrastructure/sqlite-store.js";

const RUN_ID = "20260101-000000-execrun";

const makeTestExecuteRun = <Ref>(ports: RunPorts, bridge: BridgeBinding<Ref>) => {
  const execute = makeExecuteRun(ports, bridge);
  return (...args: Parameters<typeof execute>): ReturnType<typeof execute> => {
    const lease =
      args[5] ??
      ports.store
        .listRepositoryLeases()
        .find((candidate) => candidate.repo === args[1].repo && candidate.runId === args[0]) ??
      ports.store.acquireRepositoryLease(args[1].repo, `test:${args[0]}`, args[0], "execute");
    if (!lease) {
      throw new Error(`test could not acquire repository lease for ${args[0]}`);
    }
    return execute(args[0], args[1], args[2], args[3], args[4], lease);
  };
};

const PACKET_RAW = `---
repo: /tmp/test-repo
base: main
compare_commit: main
baby_model: codestral-latest
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
  resolveRevision: () => "abc",
  reconciliationGitState: () => ({
    head: "abc",
    status: [] as string[],
    diffHash: "",
    untracked: [],
    changedFiles: [],
  }),
  fetchBranchFromClone: () => {},
  removeSandbox: () => {},
  headBranch: () => "main",
  branchExists: () => true,
  repoValid: () => true,
  deleteBranch: () => {},
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
  turnComplete: false,
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

const makePorts = (
  store: Store,
  repo: Repo,
  executor: Executor,
  planner: Planner,
  config = Config.parse({}),
): RunPorts => ({
  driverOutput: { verification: () => {} },
  configSource: createConfigSource(config),
  store,
  repo,
  executor,
  planner,
  clock: fixedClock(),
  verify: {
    run: async () => [{ command: "echo ok", exitCode: 0, outputTail: "ok" }],
    runAutoFix: async () => {},
  } satisfies Verify,
});

const cleanTemp = async (dir: string) => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

const admitAndClaim = (store: Store): void => {
  store.admitQueue(RUN_ID, PACKET_RAW);
  ok(store.claimNextQueuedRun([]));
};

const replaceMeta = (store: Store, meta: RunMeta): void => {
  const current = store.readMeta(meta.runId);
  store.transitionRun({
    runId: meta.runId,
    expectedRevision: current.revision ?? 0,
    expectedStatuses: [current.status],
    meta,
  });
};

// ---------------------------------------------------------------------------
// decideRunStart (run lifecycle: fresh vs resume)
// ---------------------------------------------------------------------------

test("decideRunStart: no prior meta → fresh", () => {
  equal(decideRunStart(undefined).mode, "fresh");
  equal(decideRunStart(undefined).mode, "fresh");
});

test("decideRunStart: prior meta but no babySessionId → fresh", () => {
  const meta = { babySessionId: undefined, daddySessionId: "daddy-old", attempt: 1 };
  equal(decideRunStart(meta).mode, "fresh");
});

test("decideRunStart: prior meta with babySessionId → resume", () => {
  const meta = { babySessionId: "baby-old", daddySessionId: "daddy-old", attempt: 1 };
  equal(decideRunStart(meta).mode, "resume");
});

// ---------------------------------------------------------------------------
// rotation (O5/O6)

test("rotateSession: replaces the session, updates meta, latches first-edit (with checkpoint)", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "rot-cp-"));
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
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
      crashRetries: 0,
      reorientRetries: 0,
      promoted: false,
      pass: 1,
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
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
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
      crashRetries: 0,
      reorientRetries: 0,
      promoted: false,
      pass: 1,
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

test("rotateSession: persists the replacement before deleting the old session", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "rot-order-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
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
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  store.writeGateState(
    RUN_ID,
    initialGateState(
      RUN_ID,
      [],
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
  const calls: string[] = [];
  const transitionRun = store.transitionRun.bind(store);
  store.transitionRun = (transition) => {
    calls.push("persist");
    return transitionRun(transition);
  };
  const executor: Executor = {
    ...scriptedExecutor(emptyChannel(), []),
    createSession: async () => {
      calls.push("create:new");
      return "baby-1";
    },
    deleteSession: async (sessionId) => {
      calls.push(`delete:${sessionId}`);
      if (sessionId === "baby-0") {
        throw new Error("old cleanup failed");
      }
    },
  };

  const newId = await rotateSession(
    makePorts(store, fakeRepo(), executor, fakePlanner()),
    packet,
    "/tmp/wt",
    "baby-0",
    3,
    false,
  );

  equal(newId, "baby-1");
  deepEqual(calls, ["create:new", "persist", "delete:baby-0"]);
  equal(store.readMeta(RUN_ID).babySessionId, "baby-1");
  await cleanTemp(tmp);
});

test("rotateSession: deletes the new session when persisting its pointer fails", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "rot-persist-failure-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
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
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    pass: 1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const deleted: string[] = [];
  store.transitionRun = () => {
    throw new Error("persist failed");
  };
  const executor: Executor = {
    ...scriptedExecutor(emptyChannel(), []),
    createSession: async () => "baby-1",
    deleteSession: async (sessionId) => {
      deleted.push(sessionId);
    },
  };

  await rejects(
    rotateSession(
      makePorts(store, fakeRepo(), executor, fakePlanner()),
      packet,
      "/tmp/wt",
      "baby-0",
      3,
      false,
    ),
    /persist failed/,
  );
  deepEqual(deleted, ["baby-1"]);
  await cleanTemp(tmp);
});

test("rotateSession: fences replacement persistence with the current repository lease", async () => {
  const packet = parseFixture();
  const lease = {
    repo: "/tmp/test-repo",
    ownerId: "worker",
    runId: RUN_ID,
    purpose: "execute" as const,
    epoch: 1,
    acquiredAt: "now",
    heartbeatAt: "now",
    expiresAt: "later",
  };
  let observedLease: typeof lease | undefined;
  const store = {
    readMeta: () => ({
      runId: RUN_ID,
      status: "running" as const,
      attempt: 1,
      repo: lease.repo,
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: "/tmp/wt",
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      promoted: false,
      pass: 1,
      updatedAt: "now",
    }),
    transitionRun: (transition: { lease?: typeof lease; meta: { babySessionId?: string } }) => {
      observedLease = transition.lease;
      return transition.meta;
    },
    readGateState: () =>
      initialGateState(
        RUN_ID,
        [],
        [],
        {
          checkpointNudgeMs: 1,
          checkpointToolCalls: 1,
          checkpointFiles: 1,
          checkpointLoc: 1,
          mutationCommandPatterns: [],
        },
        "now",
      ),
    writeGateState: () => {},
    appendJournal: () => {},
  } as unknown as Store;

  await rotateSession(
    makePorts(store, fakeRepo(), scriptedExecutor(emptyChannel(), [], ["baby-1"]), fakePlanner()),
    packet,
    "/tmp/wt",
    "baby-0",
    3,
    false,
    lease,
  );

  strictEqual(observedLease, lease);
});

// ---------------------------------------------------------------------------
// execute-run (R2)

test("makeExecuteRun: fresh run → init state → terminal status in meta", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-fresh-"));
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    admitAndClaim(store);

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
    const bridge: BridgeBinding<unknown> = {
      beginRun: () => channel,
      endRun: (_ref, _runId) => {},
    };

    const executeRun = makeTestExecuteRun(ports, bridge);
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
    equal(store.listActiveRuns().length, 0);
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: persists started phases before creating planner and executor sessions", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "exec-session-started-"));
  const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  admitAndClaim(store);
  const observed: string[] = [];
  const controller = new AbortController();
  let handshakeSignal: AbortSignal | undefined;
  const channel = emptyChannel();
  const planner: Planner = {
    ...fakePlanner(),
    handshake: async (_seed, _directory, signal) => {
      handshakeSignal = signal;
      observed.push(store.readRunStartup(RUN_ID, 1)!.phase);
      return "daddy-session";
    },
  };
  const executor: Executor = {
    ...scriptedExecutor(channel, [
      {
        intents: [
          {
            kind: "report-accepted",
            status: "blocked",
            blockedReason: "stop_condition",
            blockedQuestion: "done",
            summary: "done",
          },
        ],
      },
    ]),
    createSession: async () => {
      observed.push(store.readRunStartup(RUN_ID, 1)!.phase);
      return "baby-session";
    },
  };
  const executeRun = makeTestExecuteRun(makePorts(store, fakeRepo(), executor, planner), {
    beginRun: () => channel,
    endRun: () => {},
  });

  await executeRun(
    RUN_ID,
    {
      repo: "/tmp/test-repo",
      worktree: join(tmp, "wt"),
      base: "main",
      branch: `meridian/${RUN_ID}`,
    },
    {},
    fixedClock(),
    controller.signal,
  );

  deepEqual(observed, ["planner_session_started", "executor_session_started"]);
  strictEqual(handshakeSignal, controller.signal);
  await cleanTemp(tmp);
});

test("makeExecuteRun: lease loss before finalization prevents WIP commit and durable outcome", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "exec-finalize-lease-loss-"));
  try {
    let wipCommits = 0;
    const repo: Repo = {
      ...fakeRepo(),
      wipCommit: () => {
        wipCommits++;
        return "unexpected";
      },
    };
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, fixedClock());
    admitAndClaim(store);
    const channel = emptyChannel();
    const ports = makePorts(
      store,
      repo,
      scriptedExecutor(channel, [
        {
          intents: [
            {
              kind: "report-accepted",
              status: "blocked",
              blockedReason: "stop_condition",
              blockedQuestion: "done",
              summary: "done",
            },
          ],
        },
      ]),
      fakePlanner(),
    );
    store.heartbeatRepositoryLease = () => undefined;

    await rejects(
      makeTestExecuteRun(ports, { beginRun: () => channel, endRun: () => {} })(
        RUN_ID,
        {
          repo: "/tmp/test-repo",
          worktree: join(tmp, "wt"),
          base: "main",
          branch: `meridian/${RUN_ID}`,
        },
        {},
        ports.clock,
      ),
      /repository lease lost/,
    );

    equal(wipCommits, 0);
    equal(store.readMeta(RUN_ID).status, "running");
    equal(
      store.readJournal(RUN_ID).some((event) => event.event === "committed"),
      false,
    );
  } finally {
    await cleanTemp(tmp);
  }
});

const executeReopenedStartup = async (
  phase: "planner_session_created" | "executor_session_created",
): Promise<void> => {
  const tmp = await mkdtempP(join(tmpdir(), `exec-reopen-${phase}-`));
  try {
    const paths = makePaths(tmp);
    const repo = fakeRepo();
    const clock = fixedClock();
    const initialStore = SqliteStoreAdapter.create(paths, repo, clock);
    initialStore.admitQueue(RUN_ID, PACKET_RAW);
    const claimed = initialStore.claimNextQueuedRun([], "first-driver")!;
    const packet = parseFixture();
    let startup = initialStore.readRunStartup(RUN_ID, 1)!;
    initialStore.initializeRunStartup(
      startup,
      initialStore.initialLedger(packet),
      initialStore.initialReviewState(RUN_ID),
      initialGateState(
        RUN_ID,
        packet.frontmatter.expected_surface,
        [],
        {
          checkpointNudgeMs: 1,
          checkpointToolCalls: 1,
          checkpointFiles: 1,
          checkpointLoc: 1,
          mutationCommandPatterns: [],
        },
        clock.nowIso(),
      ),
      claimed.lease,
    );
    startup = initialStore.readRunStartup(RUN_ID, 1)!;
    for (const next of ["sandbox_ready", "setup_completed", "planner_session_started"] as const) {
      initialStore.persistRunStartup({ ...startup, phase: next }, claimed.lease);
      startup = initialStore.readRunStartup(RUN_ID, 1)!;
    }
    initialStore.persistRunStartup(
      { ...startup, phase: "planner_session_created", plannerSessionId: "daddy-recovered" },
      claimed.lease,
    );
    startup = initialStore.readRunStartup(RUN_ID, 1)!;
    if (phase === "executor_session_created") {
      initialStore.persistRunStartup(
        {
          runId: RUN_ID,
          attempt: 1,
          phase: "executor_session_started",
          plannerSessionId: "daddy-recovered",
          updatedAt: clock.nowIso(),
        },
        claimed.lease,
      );
      initialStore.persistRunStartup(
        {
          runId: RUN_ID,
          attempt: 1,
          phase: "executor_session_created",
          plannerSessionId: "daddy-recovered",
          executorSessionId: "baby-recovered",
          updatedAt: clock.nowIso(),
        },
        claimed.lease,
      );
    }
    initialStore.releaseRepositoryLease(claimed.lease);

    const reopened = SqliteStoreAdapter.create(paths, repo, clock);
    const recovered = reopened.claimNextQueuedRun([], "reopened-driver")!;
    equal(recovered.runId, RUN_ID);
    let handshakes = 0;
    let resumes = 0;
    let executorCreates = 0;
    const channel = emptyChannel();
    const planner: Planner = {
      ...fakePlanner(),
      handshake: async () => {
        handshakes++;
        return "unexpected";
      },
      resumeSession: async (sessionId) => {
        resumes++;
        equal(sessionId, "daddy-recovered");
        return sessionId;
      },
    };
    const executor: Executor = {
      ...scriptedExecutor(channel, [
        {
          intents: [
            {
              kind: "report-accepted",
              status: "blocked",
              blockedReason: "stop_condition",
              blockedQuestion: "complete",
              summary: "complete",
            },
          ],
        },
      ]),
      createSession: async () => {
        executorCreates++;
        return "baby-created-after-reopen";
      },
    };
    const ports = makePorts(reopened, repo, executor, planner);
    await makeExecuteRun(ports, { beginRun: () => channel, endRun: () => {} })(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "runs", RUN_ID, "worktree"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      clock,
      undefined,
      recovered.lease,
    );

    equal(handshakes, 0);
    equal(resumes, 1);
    equal(executorCreates, phase === "planner_session_created" ? 1 : 0);
    equal(
      reopened.readMeta(RUN_ID).babySessionId,
      phase === "planner_session_created" ? "baby-created-after-reopen" : "baby-recovered",
    );
    equal(reopened.readRunStartup(RUN_ID, 1)?.phase, "active");
  } finally {
    await cleanTemp(tmp);
  }
};

test("makeExecuteRun: reopens SQLite and recovers planner_session_created", async () => {
  await executeReopenedStartup("planner_session_created");
});

test("makeExecuteRun: reopens SQLite and recovers executor_session_created", async () => {
  await executeReopenedStartup("executor_session_created");
});

test("makeExecuteRun: activation projection failure permits zero Executor turns", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "exec-activation-projection-"));
  const paths = makePaths(tmp);
  const store = SqliteStoreAdapter.create(paths, fakeRepo(), fixedClock());
  admitAndClaim(store);
  mkdirSync(join(paths.root, "active-run.json"), { recursive: true });

  let turns = 0;
  let bridgeActivations = 0;
  const executor: Executor = {
    createSession: async () => "baby-projection",
    sendMessage: async () => {
      turns++;
      throw new Error("Executor turn must not start");
    },
    listMessages: async () => [],
    abortSession: async () => {},
    deleteSession: async () => {},
  };
  const ports = makePorts(store, fakeRepo(), executor, fakePlanner());
  const executeRun = makeTestExecuteRun(ports, {
    beginRun: () => {
      bridgeActivations++;
      return emptyChannel();
    },
    endRun: () => {},
  });

  await rejects(
    executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree: join(tmp, "wt"),
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    ),
    /EISDIR/,
  );
  equal(bridgeActivations, 0);
  equal(turns, 0);
  await cleanTemp(tmp);
});

test("makeExecuteRun: fresh run executes configured repo setup commands after sandbox creation", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-setup-"));
    const worktree = join(tmp, "wt");
    const repo: Repo = {
      ...fakeRepo(),
      createSandbox: () => {
        mkdirSync(worktree, { recursive: true });
      },
    };
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, fixedClock());
    admitAndClaim(store);

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
    const ports = makePorts(
      store,
      repo,
      executor,
      fakePlanner(),
      Config.parse({
        repos: {
          "/tmp/test-repo": {
            setup: {
              commands: [{ command: "printf setup-ok > setup-marker.txt", dir: "." }],
            },
          },
        },
      }),
    );
    const bridge: BridgeBinding<unknown> = {
      beginRun: () => channel,
      endRun: (_ref, _runId) => {},
    };

    const executeRun = makeTestExecuteRun(ports, bridge);
    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree,
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );

    equal(readFileSync(join(worktree, "setup-marker.txt"), "utf-8"), "setup-ok");
    const journal = store.readJournal(RUN_ID);
    ok(
      journal.some(
        (e) => e.event === "driver_note" && e.note === "setup: printf setup-ok > setup-marker.txt",
      ),
    );
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: setup success is not reclassified while a descendant retains its pipes", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "exec-setup-pipes-"));
  try {
    const worktree = join(tmp, "wt");
    const repo: Repo = {
      ...fakeRepo(),
      createSandbox: () => mkdirSync(worktree, { recursive: true }),
    };
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, fixedClock());
    admitAndClaim(store);
    const channel = emptyChannel();
    const ports = makePorts(
      store,
      repo,
      scriptedExecutor(channel, [
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
      ]),
      fakePlanner(),
      Config.parse({
        thresholds: { verificationTimeoutMs: 250 },
        repos: {
          "/tmp/test-repo": {
            setup: { commands: [{ command: "sleep 1 & disown; exit 0", dir: "." }] },
          },
        },
      }),
    );
    const executeRun = makeTestExecuteRun(ports, {
      beginRun: () => channel,
      endRun: () => {},
    });

    const startedAt = Date.now();
    await executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree,
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
    );
    ok(Date.now() - startedAt < 900, "setup timeout should clean up inherited pipes promptly");
  } finally {
    await cleanTemp(tmp);
  }
});

test("makeExecuteRun: rejects a setup directory symlink escaping the worktree before starting sessions", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "exec-setup-symlink-"));
  try {
    const worktree = join(tmp, "wt");
    const outside = join(tmp, "outside");
    const repo: Repo = {
      ...fakeRepo(),
      createSandbox: () => {
        mkdirSync(worktree, { recursive: true });
        mkdirSync(outside, { recursive: true });
        symlinkSync(outside, join(worktree, "escaped"));
      },
    };
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, fixedClock());
    admitAndClaim(store);
    let plannerSessions = 0;
    let executorSessions = 0;
    const planner: Planner = {
      ...fakePlanner(),
      handshake: async () => {
        plannerSessions++;
        return "daddy-session";
      },
    };
    const executor: Executor = {
      ...scriptedExecutor(emptyChannel(), []),
      createSession: async () => {
        executorSessions++;
        return "baby-session";
      },
    };
    const ports = makePorts(
      store,
      repo,
      executor,
      planner,
      Config.parse({
        repos: {
          "/tmp/test-repo": {
            setup: { commands: [{ command: "printf escaped > marker.txt", dir: "escaped" }] },
          },
        },
      }),
    );
    const executeRun = makeTestExecuteRun(ports, {
      beginRun: () => emptyChannel(),
      endRun: () => {},
    });

    await rejects(
      executeRun(
        RUN_ID,
        {
          repo: "/tmp/test-repo",
          worktree,
          base: "main",
          branch: `meridian/${RUN_ID}`,
        },
        {},
        ports.clock,
      ),
      /setup command cwd escapes sandbox: escaped/,
    );

    equal(plannerSessions, 0);
    equal(executorSessions, 0);
  } finally {
    await cleanTemp(tmp);
  }
});

test("makeExecuteRun: aborts a running setup command before starting sessions", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "exec-setup-abort-"));
  try {
    const worktree = join(tmp, "wt");
    const pidFile = join(worktree, "setup.pid");
    const repo: Repo = {
      ...fakeRepo(),
      createSandbox: () => mkdirSync(worktree, { recursive: true }),
    };
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, fixedClock());
    admitAndClaim(store);
    let plannerSessions = 0;
    let executorSessions = 0;
    const planner: Planner = {
      ...fakePlanner(),
      handshake: async () => {
        plannerSessions++;
        return "daddy-session";
      },
    };
    const executor: Executor = {
      ...scriptedExecutor(emptyChannel(), []),
      createSession: async () => {
        executorSessions++;
        return "baby-session";
      },
    };
    const ports = makePorts(
      store,
      repo,
      executor,
      planner,
      Config.parse({
        repos: {
          "/tmp/test-repo": {
            setup: { commands: [{ command: "printf %s $$ > setup.pid; sleep 30", dir: "." }] },
          },
        },
      }),
    );
    const executeRun = makeTestExecuteRun(ports, {
      beginRun: () => emptyChannel(),
      endRun: () => {},
    });
    const controller = new AbortController();
    const execution = executeRun(
      RUN_ID,
      {
        repo: "/tmp/test-repo",
        worktree,
        base: "main",
        branch: `meridian/${RUN_ID}`,
      },
      {},
      ports.clock,
      controller.signal,
    );

    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        readFileSync(pidFile, "utf-8");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const setupPid = Number(readFileSync(pidFile, "utf-8"));
    controller.abort();

    await rejects(execution, (error: Error) => error.name === "AbortError");
    equal(plannerSessions, 0);
    equal(executorSessions, 0);
    await rejects(
      Promise.resolve().then(() => process.kill(setupPid, 0)),
      (error: NodeJS.ErrnoException) => error.code === "ESRCH",
    );
  } finally {
    await cleanTemp(tmp);
  }
});

test("makeExecuteRun: real fresh queue path — reads the live run packet", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-fresh-queue-"));
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());

    store.admitQueue(RUN_ID, PACKET_RAW);
    const meta = store.readMeta(RUN_ID);
    equal(meta.repo, "/tmp/test-repo");
    equal(meta.base, "main");
    equal(meta.branch, `meridian/${RUN_ID}`);
    equal(meta.worktree, join(tmp, "runs", RUN_ID, "worktree"));
    equal(meta.babyModel, "codestral-latest", "babyModel persisted from queue packet into meta");
    store.claimNextQueuedRun([]);

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
    const bridge: BridgeBinding<unknown> = {
      beginRun: () => channel,
      endRun: (_ref, _runId) => {},
    };

    const executeRun = makeTestExecuteRun(ports, bridge);
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
    equal(
      metaAfter.babyModel,
      "codestral-latest",
      "babyModel preserved through executeRun meta transition",
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
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    admitAndClaim(store);

    // Prior meta from the previous run session.
    replaceMeta(store, {
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
      reorientRetries: 2,
      promoted: false,
      pass: 1,
      startedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const activateRunStartup = store.activateRunStartup.bind(store);
    let activeStartedAt: string | undefined;
    store.activateRunStartup = (operation, transition) => {
      activeStartedAt = transition.activeRun?.startedAt ?? activeStartedAt;
      return activateRunStartup(operation, transition);
    };
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
    const bridge: BridgeBinding<unknown> = {
      beginRun: () => channel,
      endRun: (_ref, _runId) => {},
    };

    const executeRun = makeTestExecuteRun(ports, bridge);
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
    equal(meta.attempt, 1, "execution preserves the attempt acquired by the queue claim");
    equal(meta.daddySessionId, "daddy-prior", "resume preserves prior Daddy session ID");
    equal(meta.babySessionId, "baby-1", "new Baby session created");
    equal(meta.startedAt, "2025-01-01T00:00:00.000Z", "run history keeps its original start");
    ok(
      activeStartedAt && activeStartedAt !== meta.startedAt,
      "active claim receives a fresh timestamp",
    );
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
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    admitAndClaim(store);

    replaceMeta(store, {
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
      crashRetries: 0,
      reorientRetries: 0,
      promoted: false,
      pass: 1,
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
    let handshakeSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const planner: Planner = {
      handshake: async (_seed, _directory, signal) => {
        handshakeCalled = true;
        handshakeSignal = signal;
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
    const bridge: BridgeBinding<unknown> = {
      beginRun: () => channel,
      endRun: (_ref, _runId) => {},
    };

    const executeRun = makeTestExecuteRun(ports, bridge);
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
      controller.signal,
    );

    const meta = store.readMeta(RUN_ID);
    equal(meta.daddySessionId, "daddy-new");
    equal(resumeCalled, false, "stale Daddy session is not resumed");
    equal(handshakeCalled, true, "fresh Daddy handshake replaces stale session");
    strictEqual(handshakeSignal, controller.signal);
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
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    admitAndClaim(store);

    replaceMeta(store, {
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
      promoted: false,
      pass: 1,
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
      abortSession: async () => {},
    };

    const ports = makePorts(store, fakeRepo(), capturingExecutor, capturingPlanner);
    const bridge: BridgeBinding<unknown> = {
      beginRun: () => channel,
      endRun: (_ref, _runId) => {},
    };

    const executeRun = makeTestExecuteRun(ports, bridge);
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
    ok(firstSeed.includes("resuming after a session rotation"), "Q8b resume seed");
    ok(!firstSeed.includes("RECONCILIATION"), "not the Q8 reconciliation seed");
    // Seed must include the full prior reconciliation outcome.
    ok(firstSeed.includes("reconstructed state"), "Q8b seed includes recon question");
    ok(firstSeed.includes("continue from outcome 2"), "Q8b seed includes recon approach");
    ok(firstSeed.includes("looks good"), "Q8b seed includes Planner verdict");
    await cleanTemp(tmp);
  })();
});

test("makeExecuteRun: invalid queue packet → meta failed, no throw", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-bad-"));
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    const paths = makePaths(tmp);
    mkdirSync(paths.runDir(RUN_ID), { recursive: true });
    writeFileSync(paths.packetFile(RUN_ID), "not a packet");
    store.writeMeta({
      runId: RUN_ID,
      status: "running",
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: `meridian/${RUN_ID}`,
      worktree: join(tmp, "wt"),
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      promoted: false,
      pass: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.persistRunStartup({
      runId: RUN_ID,
      attempt: 1,
      phase: "claimed",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const ports = makePorts(store, fakeRepo(), scriptedExecutor(emptyChannel(), []), fakePlanner());
    const bridge: BridgeBinding<unknown> = {
      beginRun: () => emptyChannel(),
      endRun: (_ref, _runId) => {},
    };
    const executeRun = makeTestExecuteRun(ports, bridge);

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

test("makeExecuteRun: run with prior meta but no baby session → fresh", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "exec-fresh-no-baby-"));
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
    admitAndClaim(store);

    // Prior meta WITHOUT a babySessionId (e.g. a crashed run where baby session was lost).
    replaceMeta(store, {
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
      promoted: false,
      pass: 1,
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
    const bridge: BridgeBinding<unknown> = {
      beginRun: () => channel,
      endRun: (_ref, _runId) => {},
    };

    const executeRun = makeTestExecuteRun(ports, bridge);
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
    equal(meta.attempt, 1);
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
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    // Seed stale checkpoint.
    const c1 = {
      number: 1,
      reason: "checkpoint",
      summary: "stale checkpoint",
      outcomes: [{ id: "test-outcome", status: "done" as const, evidence: [] }],
      filesChanged: [],
      filesInspected: [],
      uncertainties: [],
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
      evidence: [],
    });
    strictEqual(store.readDecisions(RUN_ID).length, 1, "decisions seeded");

    // Seed stale review state.
    store.replaceObligations(RUN_ID, ["fix x"]);
    equal(store.readReviewState(RUN_ID).obligations.length, 1, "review state seeded");

    // Prior meta WITHOUT babySessionId — no session to resume → fresh start.
    const newPacketRaw = `---
repo: /tmp/test-repo
base: main
compare_commit: main
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
    // Overwrite the live packet with a new version (simulates resume with changed packet).
    const paths = makePaths(tmp);
    mkdirSync(paths.runDir(RUN_ID), { recursive: true });
    writeFileSync(paths.packetFile(RUN_ID), newPacketRaw);

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
      promoted: false,
      pass: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.persistRunStartup({
      runId: RUN_ID,
      attempt: 1,
      phase: "claimed",
      updatedAt: clock.nowIso(),
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
    const bridge: BridgeBinding<unknown> = {
      beginRun: () => channel,
      endRun: (_ref, _runId) => {},
    };

    const executeRun = makeTestExecuteRun(ports, bridge);
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
    const store = SqliteStoreAdapter.create(makePaths(tmp), fakeRepo(), clock);

    // Phase 1: seed a prior session's checkpoint, decisions, review state.
    store.writeCheckpoint(RUN_ID, {
      number: 1,
      reason: "checkpoint",
      summary: "stale",
      outcomes: [{ id: "test-outcome", status: "not_started", evidence: [] }],
      filesChanged: [],
      filesInspected: [],
      uncertainties: [],
      writtenAt: clock.nowIso(),
    });

    // Phase 2: simulate a fresh start (no prior baby session → decideRunStart → fresh).
    const newPacketRaw = `---
repo: /tmp/test-repo
base: main
compare_commit: main
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
    const paths2 = makePaths(tmp);
    mkdirSync(paths2.runDir(RUN_ID), { recursive: true });
    writeFileSync(paths2.packetFile(RUN_ID), newPacketRaw);

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
      promoted: false,
      pass: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    store.persistRunStartup({
      runId: RUN_ID,
      attempt: 1,
      phase: "claimed",
      updatedAt: clock.nowIso(),
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
    const bridge: BridgeBinding<unknown> = {
      beginRun: () => channel,
      endRun: (_ref, _runId) => {},
    };

    const executeRun = makeTestExecuteRun(ports, bridge);
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

    // Phase 3: now simulate a second run — Phase 2's executeRun wrote babySessionId
    // to meta, so this is a resume. Since checkpoint was cleared in Phase 2, the
    // resume seed should be Q8 (no checkpoint), not Q2.
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
    const bridge2: BridgeBinding<unknown> = {
      beginRun: () => channel2,
      endRun: (_ref, _runId) => {},
    };

    const priorLease = store.listRepositoryLeases().at(0);
    if (priorLease) {
      store.releaseRepositoryLease(priorLease);
    }
    replaceMeta(store, {
      ...store.readMeta(RUN_ID),
      status: "queued",
      updatedAt: ports2.clock.nowIso(),
    });
    ok(store.claimNextQueuedRun([]));

    const executeRun2 = makeTestExecuteRun(ports2, bridge2);
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
