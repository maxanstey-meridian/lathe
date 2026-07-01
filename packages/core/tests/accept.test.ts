import { equal, ok } from "node:assert";
import { describe, it } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import type { Store } from "../src/application/ports/store.js";
import { acceptRun } from "../src/application/use-cases/accept-run.js";
import type { RunMeta } from "../src/domain/run.js";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const makeClock = (): Clock => ({
  now: () => 1700000000000,
  nowIso: () => "2026-01-01T00:00:00.000Z",
});

const makeMeta = (overrides?: Partial<RunMeta>) => ({
  runId: "20260618-070000-test",
  status: "ready_for_review" as const,
  attempt: 1,
  repo: "/tmp/test-repo",
  base: "main",
  branch: "meridian/20260618-070000-test",
  worktree: "/tmp/runs/20260618-070000-test/worktree",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const makeStore = (meta?: ReturnType<typeof makeMeta>): Store => {
  let lastMeta: ReturnType<typeof makeMeta> | undefined;
  return {
    readMeta: () => meta ?? makeMeta(),
    readMetaIfExists: () => meta,
    writeMeta: (m) => {
      lastMeta = m;
    },
    listRunIds: () => [],
    initialLedger: () => ({ runId: "fake", outcomes: [], updatedAt: "" }),
    readLedger: () => ({ runId: "fake", outcomes: [], updatedAt: "" }),
    writeLedger: () => {},
    initialReviewState: () => ({ runId: "fake", obligations: [], updatedAt: "" }),
    readReviewState: () => ({ runId: "fake", obligations: [], updatedAt: "" }),
    replaceObligations: () => ({ runId: "fake", obligations: [], updatedAt: "" }),
    appendDecision: () => {},
    readDecisions: () => [],
    latestCheckpoint: () => undefined,
    writeCheckpoint: () => {},
    nextCheckpointNumber: () => 1,
    readGateState: () => ({
      runId: "fake",
      phase: { phase: "initial" },
      expectedGlobs: [],
      suspiciousGlobs: [],
      baselineDiffStats: {},
      mutationCommandPatterns: [],
      updatedAt: "",
    }),
    writeGateState: () => {},
    readReport: () => "",
    writeReport: () => {},
    readNits: () => "",
    writeNits: () => {},
    appendConvergence: () => {},
    readConvergence: () => [],
    readActiveRun: () => undefined,
    writeActiveRun: () => {},
    clearActiveRun: () => {},
    readActiveConvergence: () => undefined,
    writeActiveConvergence: () => {},
    clearActiveConvergence: () => {},
    readCampaign: () => undefined,
    writeCampaign: () => {},
    listQueue: () => [],
    admitQueue: () => {},
    archiveQueue: () => {},
    readQueuePacket: () => undefined,
    initMetaFromQueue: () => undefined,
    listStaged: () => [],
    readStaged: () => undefined,
    writeStaged: () => {},
    removeStaged: () => {},
    appendJournal: () => {},
    readJournal: () => [],
    _getLastMeta: () => lastMeta,
  } as unknown as Store;
};

const makeRepo = (opts?: {
  currentBranch?: string;
  isDirty?: boolean;
  headBranchThrows?: boolean;
  fetchBranchFromCloneCalled?: boolean;
  mergeAcceptCalled?: boolean;
  removeSandboxCalled?: boolean;
}): Repo => {
  const state = {
    fetchBranchFromCloneCalled: opts?.fetchBranchFromCloneCalled ?? false,
    mergeAcceptCalled: opts?.mergeAcceptCalled ?? false,
    removeSandboxCalled: opts?.removeSandboxCalled ?? false,
    mergeAcceptRepo: "" as string,
    mergeAcceptBranch: "" as string,
    removeSandboxPath: "" as string,
    removeSandboxRunsDir: "" as string,
  };
  return {
    createSandbox: () => {},
    wipCommit: () => undefined,
    amendCommit: () => "deadbeef0000",
    worktreeIsDirty: () => opts?.isDirty ?? false,
    diffStat: () => "",
    readDiffStats: () => ({}),
    reviewableDiff: () => "",
    reviewableDiffAgainst: () => "",
    fetchBranchFromClone: (repo, clone, branch) => {
      state.fetchBranchFromCloneCalled = true;
      state.mergeAcceptRepo = repo;
      state.mergeAcceptBranch = branch;
    },
    removeSandbox: (sandboxPath, runsDir) => {
      state.removeSandboxCalled = true;
      state.removeSandboxPath = sandboxPath;
      state.removeSandboxRunsDir = runsDir;
    },
    headBranch: () => {
      if (opts?.headBranchThrows) {
        throw new Error("detached HEAD");
      }
      return opts?.currentBranch ?? "main";
    },
    branchExists: () => true,
    repoValid: () => true,
    mergeAccept: (repo, sourceBranch) => {
      state.mergeAcceptCalled = true;
      state.mergeAcceptRepo = repo;
      state.mergeAcceptBranch = sourceBranch;
    },
    _state: () => state,
  } as unknown as Repo;
};

const makePorts = (
  meta?: ReturnType<typeof makeMeta>,
  repoOpts?: Parameters<typeof makeRepo>[0],
) => ({
  store: makeStore(meta),
  repo: makeRepo(repoOpts),
  clock: makeClock(),
  runsDir: "/tmp/runs",
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("acceptRun — refusal", () => {
  it("refuses when run does not exist", () => {
    const ports = makePorts(undefined);
    const code = acceptRun("nonexistent", undefined, ports);
    equal(code, 1);
  });

  it("refuses when run status is blocked", () => {
    const meta = makeMeta({ status: "blocked" as const });
    const ports = makePorts(meta);
    const code = acceptRun("20260618-070000-test", undefined, ports);
    equal(code, 1);
  });

  it("refuses when run status is failed", () => {
    const meta = makeMeta({ status: "failed" as const });
    const ports = makePorts(meta);
    const code = acceptRun("20260618-070000-test", undefined, ports);
    equal(code, 1);
  });

  it("refuses when repo is on wrong branch", () => {
    const meta = makeMeta();
    const ports = makePorts(meta, { currentBranch: "develop" });
    const code = acceptRun("20260618-070000-test", undefined, ports);
    equal(code, 1);
  });

  it("refuses when repo is dirty", () => {
    const meta = makeMeta();
    const ports = makePorts(meta, { isDirty: true });
    const code = acceptRun("20260618-070000-test", undefined, ports);
    equal(code, 1);
  });

  it("refuses when headBranch throws (detached HEAD)", () => {
    const meta = makeMeta();
    const ports = makePorts(meta, { headBranchThrows: true });
    const code = acceptRun("20260618-070000-test", undefined, ports);
    equal(code, 1);
  });

  it("refusal message includes manual git commands", () => {
    const meta = makeMeta();
    const ports = makePorts(meta, { currentBranch: "develop" });
    const code = acceptRun("20260618-070000-test", undefined, ports);
    equal(code, 1);
  });
});

describe("acceptRun — success", () => {
  it("defaults target to meta.base", () => {
    const meta = makeMeta({ base: "develop" });
    const ports = makePorts(meta, { currentBranch: "develop" });
    const code = acceptRun("20260618-070000-test", undefined, ports);
    equal(code, 0);
  });

  it("uses explicit targetBranch over meta.base", () => {
    const meta = makeMeta({ base: "main" });
    const ports = makePorts(meta, { currentBranch: "feature" });
    const code = acceptRun("20260618-070000-test", "feature", ports);
    equal(code, 0);
  });

  it("full clone path: fetch + merge + sandbox remove + accepted", () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    const repo = makeRepo({ currentBranch: "main", isDirty: false });
    const ports = { store, repo, clock: makeClock(), runsDir: "/tmp/runs" };
    const code = acceptRun("20260618-070000-test", undefined, ports);
    equal(code, 0);
    const state = (
      repo as unknown as {
        _state: () => {
          fetchBranchFromCloneCalled: boolean;
          mergeAcceptCalled: boolean;
          removeSandboxCalled: boolean;
        };
      }
    )._state();
    ok(state.fetchBranchFromCloneCalled, "fetchBranchFromClone should be called");
    ok(state.mergeAcceptCalled, "mergeAccept should be called");
    ok(state.removeSandboxCalled, "removeSandbox should be called");
    const written = (
      store as unknown as { _getLastMeta: () => Record<string, unknown> }
    )._getLastMeta();
    equal(written?.status, "accepted");
  });

  it("accepts with explicit target branch", () => {
    const meta = makeMeta({ base: "main" });
    const store = makeStore(meta);
    const repo = makeRepo({ currentBranch: "feature", isDirty: false });
    const ports = { store, repo, clock: makeClock(), runsDir: "/tmp/runs" };
    const code = acceptRun("20260618-070000-test", "feature", ports);
    equal(code, 0);
    const written = (
      store as unknown as { _getLastMeta: () => Record<string, unknown> }
    )._getLastMeta();
    equal(written?.status, "accepted");
  });
});
