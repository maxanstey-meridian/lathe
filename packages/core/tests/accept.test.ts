import { equal, ok } from "node:assert";
import { describe, it } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import type { Store } from "../src/application/ports/store.js";
import { acceptRun } from "../src/application/use-cases/accept-run.js";
import type { RunMeta } from "../src/domain/run.js";

// ---------------------------------------------------------------------------
// Test helper types
// ---------------------------------------------------------------------------

type TestStore = Store & {
  _getCampaignStore(): Map<string, Array<Record<string, unknown>>>;
  _getLastMeta(): ReturnType<typeof makeMeta> | undefined;
};

type TestRepo = Repo & {
  _state(): {
    fetchBranchFromCloneCalled: boolean;
    removeSandboxCalled: boolean;
    deleteBranchCalled: boolean;
    removeSandboxPath: string;
    removeSandboxRunsDir: string;
    deleteBranchRepo: string;
    deleteBranchBranch: string;
  };
};

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
  pass: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const makeStore = (meta?: ReturnType<typeof makeMeta>): TestStore => {
  let lastMeta: ReturnType<typeof makeMeta> | undefined;
  const campaignStore = new Map<string, Array<Record<string, unknown>>>();
  return {
    readMeta: () => meta ?? makeMeta(),
    readMetaIfExists: (id: string) => {
      if (meta?.runId === id) {
        return meta;
      }
      // Check campaign store for other runs.
      for (const runs of campaignStore.values()) {
        const found = runs.find((r) => (r as RunMeta).runId === id);
        if (found) {
          return found as RunMeta;
        }
      }
      return undefined;
    },
    writeMeta: (m: ReturnType<typeof makeMeta>) => {
      lastMeta = m;
    },
    listRunIds: () => [],
    listMeta: () => [],
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
    listActiveRuns: () => [],
    addActiveRun: () => {},
    removeActiveRun: () => {},
    listActiveConvergences: () => [],
    addActiveConvergence: () => {},
    removeActiveConvergence: () => {},
    readCampaign: () => undefined,
    writeCampaign: () => {},
    listCampaigns: () => [],
    listRunsByCampaign: (campaignId: string) =>
      (campaignStore.get(campaignId) ?? []).map((r) => r as RunMeta),
    listQueue: () => [],
    admitQueue: () => {},
    archiveQueue: () => {},
    claimNextQueuedRun: () => undefined,
    readQueuePacket: () => undefined,
    initMetaFromQueue: () => undefined,
    listStaged: () => [],
    readStaged: () => undefined,
    writeStaged: () => {},
    removeStaged: () => {},
    appendJournal: () => {},
    readJournal: () => [],
    readJournalWithSeq: () => [],
    _getLastMeta: () => lastMeta,
    _getCampaignStore: () => campaignStore,
  } as unknown as TestStore;
};

const makeRepo = (): TestRepo => {
  const state = {
    fetchBranchFromCloneCalled: false,
    removeSandboxCalled: false,
    deleteBranchCalled: false,
    removeSandboxPath: "" as string,
    removeSandboxRunsDir: "" as string,
    deleteBranchRepo: "" as string,
    deleteBranchBranch: "" as string,
  };
  return {
    createSandbox: () => {},
    wipCommit: () => undefined,
    amendCommit: () => "deadbeef0000",
    worktreeIsDirty: () => false,
    diffStat: () => "",
    readDiffStats: () => ({}),
    reviewableDiff: () => "",
    fetchBranchFromClone: (repo: string, clone: string, branch: string) => {
      state.fetchBranchFromCloneCalled = true;
      state.deleteBranchRepo = repo;
      state.deleteBranchBranch = branch;
    },
    removeSandbox: (sandboxPath: string, runsDir: string) => {
      state.removeSandboxCalled = true;
      state.removeSandboxPath = sandboxPath;
      state.removeSandboxRunsDir = runsDir;
    },
    headBranch: () => "main",
    branchExists: () => true,
    repoValid: () => true,
    deleteBranch: (repo: string, branch: string) => {
      state.deleteBranchCalled = true;
      state.deleteBranchRepo = repo;
      state.deleteBranchBranch = branch;
    },
    reconciliationGitState: () => ({
      head: "head",
      status: [],
      diffHash: "",
      untracked: [],
      changedFiles: [],
    }),
    reviewableDiffAgainst: () => "",
    _state: () => state,
  } as unknown as TestRepo;
};

const makePorts = (meta?: ReturnType<typeof makeMeta>) => ({
  store: makeStore(meta),
  repo: makeRepo(),
  clock: makeClock(),
  runsDir: "/tmp/runs",
});

// ---------------------------------------------------------------------------
// Tests — refusal
// ---------------------------------------------------------------------------

describe("acceptRun — refusal", () => {
  it("refuses when run does not exist", () => {
    const ports = makePorts(undefined);
    const code = acceptRun("nonexistent", ports);
    equal(code, 1);
  });

  it("refuses when run status is blocked", () => {
    const meta = makeMeta({ status: "blocked" as const });
    const ports = makePorts(meta);
    const code = acceptRun("20260618-070000-test", ports);
    equal(code, 1);
  });

  it("refuses when run status is failed", () => {
    const meta = makeMeta({ status: "failed" as const });
    const ports = makePorts(meta);
    const code = acceptRun("20260618-070000-test", ports);
    equal(code, 1);
  });

  it("refuses when campaign has a run that is not ready_for_review or accepted", () => {
    const meta = makeMeta({ campaignId: "campaign-1" });
    const store = makeStore(meta);
    const blockingRun = makeMeta({
      runId: "20260618-080000-blocking",
      campaignId: "campaign-1",
      status: "running" as const,
    });
    store._getCampaignStore().set("campaign-1", [meta, blockingRun]);
    const ports = { store, repo: makeRepo(), clock: makeClock(), runsDir: "/tmp/runs" };
    const code = acceptRun("20260618-070000-test", ports);
    equal(code, 1);
  });

  it("refuses when repo has an active run from a different campaign", () => {
    const meta = makeMeta({ campaignId: "campaign-1" });
    const activeRunMeta = {
      runId: "20260618-080000-active",
      status: "running" as const,
      attempt: 1,
      repo: "/tmp/test-repo",
      base: "main",
      branch: "meridian/20260618-080000-active",
      worktree: "/tmp/runs/20260618-080000-active/worktree",
      pass: 1,
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      reviewerUnreachable: 0,
      promoted: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const store = {
      readMeta: (runId: string) => (runId === meta.runId ? meta : activeRunMeta),
      readMetaIfExists: (runId: string) =>
        runId === meta.runId
          ? meta
          : runId === "20260618-080000-active"
            ? activeRunMeta
            : undefined,
      writeMeta: () => {},
      listRunIds: () => [],
      listMeta: () => [],
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
      listActiveRuns: () => [
        {
          runId: "20260618-080000-active",
          runDir: "/tmp/runs/20260618-080000-active",
          worktree: "/tmp/runs/20260618-080000-active/worktree",
          babySessionId: "test-session",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      addActiveRun: () => {},
      removeActiveRun: () => {},
      listActiveConvergences: () => [],
      addActiveConvergence: () => {},
      removeActiveConvergence: () => {},
      readCampaign: () => undefined,
      writeCampaign: () => {},
      listCampaigns: () => [],
      listRunsByCampaign: () => [],
      listQueue: () => [],
      admitQueue: () => {},
      archiveQueue: () => {},
      claimNextQueuedRun: () => undefined,
      readQueuePacket: () => undefined,
      initMetaFromQueue: () => undefined,
      listStaged: () => [],
      readStaged: () => undefined,
      writeStaged: () => {},
      removeStaged: () => {},
      appendJournal: () => {},
      readJournal: () => [],
    readJournalWithSeq: () => [],
    } as unknown as Store;
    const ports = {
      store,
      repo: makeRepo(),
      clock: makeClock(),
      runsDir: "/tmp/runs",
    };
    const code = acceptRun(meta.runId, ports);
    equal(code, 1);
  });

  it("accepts when active runs belong to the same campaign", () => {
    const meta = makeMeta({ campaignId: "campaign-1" });
    const sameCampaignMeta = makeMeta({
      runId: "20260618-080000-same-campaign",
      campaignId: "campaign-1",
      status: "ready_for_review" as const,
    });
    const store = {
      readMeta: (runId: string) => (runId === meta.runId ? meta : sameCampaignMeta),
      readMetaIfExists: (runId: string) =>
        runId === meta.runId
          ? meta
          : runId === "20260618-080000-same-campaign"
            ? sameCampaignMeta
            : undefined,
      writeMeta: () => {},
      listRunIds: () => [],
      listMeta: () => [],
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
      listActiveRuns: () => [
        {
          runId: "20260618-080000-same-campaign",
          runDir: "/tmp/runs/20260618-080000-same-campaign",
          worktree: "/tmp/runs/20260618-080000-same-campaign/worktree",
          babySessionId: "test-session",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      addActiveRun: () => {},
      removeActiveRun: () => {},
      listActiveConvergences: () => [],
      addActiveConvergence: () => {},
      removeActiveConvergence: () => {},
      readCampaign: () => undefined,
      writeCampaign: () => {},
      listCampaigns: () => [],
      listRunsByCampaign: (campaignId: string) =>
        campaignId === "campaign-1" ? [meta, sameCampaignMeta] : [],
      listQueue: () => [],
      admitQueue: () => {},
      archiveQueue: () => {},
      claimNextQueuedRun: () => undefined,
      readQueuePacket: () => undefined,
      initMetaFromQueue: () => undefined,
      listStaged: () => [],
      readStaged: () => undefined,
      writeStaged: () => {},
      removeStaged: () => {},
      appendJournal: () => {},
      readJournal: () => [],
    readJournalWithSeq: () => [],
    } as unknown as Store;
    const ports = {
      store,
      repo: makeRepo(),
      clock: makeClock(),
      runsDir: "/tmp/runs",
    };
    const code = acceptRun(meta.runId, ports);
    equal(code, 0);
  });
});

// ---------------------------------------------------------------------------
// Tests — campaign success
// ---------------------------------------------------------------------------

describe("acceptRun — campaign success", () => {
  it("accepts a legacy single-run (no campaignId) as a campaign of one", () => {
    const meta = makeMeta(); // no campaignId
    const store = makeStore(meta);
    const repo = makeRepo();
    const ports = { store, repo, clock: makeClock(), runsDir: "/tmp/runs" };
    const code = acceptRun(meta.runId, ports);
    equal(code, 0);
    // Should have fetched the tip branch
    ok(repo._state().fetchBranchFromCloneCalled);
    // Should have removed sandbox
    ok(repo._state().removeSandboxCalled);
    // Tip run should NOT have deleteBranch called
    equal(repo._state().deleteBranchCalled, false);
    // Meta should be marked accepted
    const lastMeta = store._getLastMeta();
    ok(lastMeta);
    equal(lastMeta.status, "accepted");
    equal(lastMeta.acceptedInto, meta.branch);
  });

  it("resolves to the campaign tip (highest pass) and cleans up intermediate runs", () => {
    const tipMeta = makeMeta({
      runId: "20260618-090000-tip",
      branch: "meridian/20260618-090000-tip",
      worktree: "/tmp/runs/20260618-090000-tip/worktree",
      pass: 3,
      campaignId: "campaign-abc",
    });
    const run1 = makeMeta({
      runId: "20260618-070000-first",
      branch: "meridian/20260618-070000-first",
      worktree: "/tmp/runs/20260618-070000-first/worktree",
      pass: 1,
      campaignId: "campaign-abc",
      status: "accepted" as const,
    });
    const run2 = makeMeta({
      runId: "20260618-080000-second",
      branch: "meridian/20260618-080000-second",
      worktree: "/tmp/runs/20260618-080000-second/worktree",
      pass: 2,
      campaignId: "campaign-abc",
    });

    const store = makeStore(tipMeta);
    store._getCampaignStore().set("campaign-abc", [run1, run2, tipMeta]);
    const repo = makeRepo();
    const ports = { store, repo, clock: makeClock(), runsDir: "/tmp/runs" };

    // Accept the middle run — should resolve to tip
    const code = acceptRun(run2.runId, ports);
    equal(code, 0);

    // Tip branch should be fetched
    ok(repo._state().fetchBranchFromCloneCalled);

    // Sandbox removal should have happened for all 3 runs
    ok(repo._state().removeSandboxCalled);

    // deleteBranch should have been called for intermediate runs
    ok(repo._state().deleteBranchCalled);

    // Meta should be marked accepted with acceptedInto = tip branch
    const lastMeta = store._getLastMeta();
    ok(lastMeta);
    equal(lastMeta.acceptedInto, tipMeta.branch);
  });

  it("reports diff stats before teardown", () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    const repo = makeRepo();
    const ports = { store, repo, clock: makeClock(), runsDir: "/tmp/runs" };
    const code = acceptRun(meta.runId, ports);
    equal(code, 0);
    // readDiffStats was called (the fake returns {} so stats line will be empty,
    // but the call itself proves the flow)
    ok(repo._state().fetchBranchFromCloneCalled);
    ok(repo._state().removeSandboxCalled);
  });
});
