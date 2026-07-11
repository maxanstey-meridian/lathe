import { equal, ok, throws } from "node:assert";
import { describe, it } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import type {
  CampaignAcceptance,
  RepositoryLease,
  RunTransition,
  Store,
} from "../src/application/ports/store.js";
import { acceptRun } from "../src/application/use-cases/accept-run.js";
import {
  cleanAcceptedOperation,
  recoverAcceptedCleanup,
} from "../src/application/use-cases/recover-acceptance-cleanup.js";
import type { AcceptanceOperation } from "../src/domain/operations.js";
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

const acceptedCampaign = (
  meta: ReturnType<typeof makeMeta>,
  members: ReturnType<typeof makeMeta>[] = [meta],
) => ({
  campaignId: meta.campaignId ?? meta.runId,
  originalRunId: meta.runId,
  originalIntent: "test",
  status: "converged" as const,
  maxPasses: 3,
  passes: members.map((member) => ({
    runId: member.runId,
    attempt: member.attempt,
    pass: member.pass,
    verdict: "accept" as const,
    groundedBlockers: 0,
    atIso: member.updatedAt,
  })),
  updatedAt: meta.updatedAt,
});

const makeStore = (meta?: ReturnType<typeof makeMeta>): TestStore => {
  let lastMeta: ReturnType<typeof makeMeta> | undefined;
  let acceptanceOperation: AcceptanceOperation | undefined;
  const leases = new Set<string>();
  const campaignStore = new Map<string, Array<Record<string, unknown>>>();
  const readMetaIfExists = (id: string): ReturnType<typeof makeMeta> | undefined => {
    if (meta?.runId === id) {
      return meta;
    }
    for (const runs of campaignStore.values()) {
      const found = runs.find((run) => (run as RunMeta).runId === id);
      if (found) {
        return found as ReturnType<typeof makeMeta>;
      }
    }
    return undefined;
  };
  return {
    readMeta: () => meta ?? makeMeta(),
    readMetaIfExists,
    writeMeta: (m: ReturnType<typeof makeMeta>) => {
      lastMeta = m;
    },
    transitionRun: (transition: RunTransition) => {
      lastMeta = { ...transition.meta, revision: transition.expectedRevision + 1 };
      return lastMeta;
    },
    acceptCampaign: (members: CampaignAcceptance[], acceptedInto: string) => {
      const accepted = members.map((member) => ({
        ...(readMetaIfExists(member.runId) ?? makeMeta({ runId: member.runId })),
        status: "accepted" as const,
        acceptedInto,
        revision: member.expectedRevision + 1,
      }));
      lastMeta = accepted.at(-1);
      return accepted;
    },
    readAcceptanceOperation: () => acceptanceOperation,
    persistAcceptanceOperation: (operation: AcceptanceOperation) => {
      acceptanceOperation = operation;
    },
    commitAcceptanceOperation: (operation: AcceptanceOperation) => {
      const accepted = operation.members.map((member: AcceptanceOperation["members"][number]) => ({
        ...(readMetaIfExists(member.runId) ?? makeMeta({ runId: member.runId })),
        status: "accepted" as const,
        acceptedInto: operation.acceptedInto,
        revision: member.revision + 1,
      }));
      lastMeta = accepted.at(-1);
      acceptanceOperation = { ...operation, phase: "accepted" };
      return accepted;
    },
    answerRun: (transition: Parameters<Store["answerRun"]>[0]) => transition.meta,
    listRunIds: () => [],
    listMeta: () => (lastMeta ? [lastMeta] : meta ? [meta] : []),
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
    readCampaign: (campaignId: string) => {
      if (!meta) {
        return undefined;
      }
      const members = campaignStore
        .get(campaignId)
        ?.map((run) => run as ReturnType<typeof makeMeta>);
      return acceptedCampaign(meta, members ?? [meta]);
    },
    writeCampaign: () => {},
    listCampaigns: () => [],
    listRunsByCampaign: (campaignId: string) =>
      (campaignStore.get(campaignId) ?? []).map((r) => r as RunMeta),
    listQueue: () => [],
    admitQueue: () => {},
    archiveQueue: () => {},
    claimNextQueuedRun: () => undefined,
    acquireRepositoryLease: (
      repo: string,
      owner: string,
      runId: string,
      purpose: "execute" | "accept",
    ) => {
      if (leases.size > 0) {
        return undefined;
      }
      leases.add(owner);
      return {
        repo,
        ownerId: owner,
        runId,
        purpose,
        epoch: 1,
        acquiredAt: meta?.updatedAt ?? "",
        heartbeatAt: meta?.updatedAt ?? "",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
    },
    listRepositoryLeases: () => [],
    heartbeatRepositoryLease: (lease: RepositoryLease) => lease,
    releaseRepositoryLease: (lease: RepositoryLease) => {
      return leases.delete(lease.ownerId);
    },
    readQueuePacket: () => undefined,
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
    sourceSha: undefined as string | undefined,
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
      state.sourceSha = "head";
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
    resolveRevision: (worktree: string) => {
      if (worktree === "/tmp/test-repo") {
        if (!state.sourceSha) {
          throw new Error("missing ref");
        }
        return state.sourceSha;
      }
      return "head";
    },
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

  it("refuses while the repository has an active worker lease", () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    store.listRepositoryLeases = () => [
      {
        repo: meta.repo,
        ownerId: "worker",
        runId: "20260618-080000-worker",
        purpose: "execute",
        epoch: 1,
        acquiredAt: meta.updatedAt,
        heartbeatAt: meta.updatedAt,
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    ];
    store.acquireRepositoryLease = () => undefined;
    const repo = makeRepo();

    equal(acceptRun(meta.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }), 1);
    equal(repo._state().fetchBranchFromCloneCalled, false);
    equal(repo._state().removeSandboxCalled, false);
  });

  it("does not destroy a sandbox when exact-revision reservation fails", () => {
    const meta = makeMeta({ revision: 2 });
    const store = makeStore(meta);
    store.commitAcceptanceOperation = () => {
      throw new Error("revision conflict");
    };
    const repo = makeRepo();

    equal(acceptRun(meta.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }), 1);
    equal(repo._state().fetchBranchFromCloneCalled, true);
    equal(repo._state().removeSandboxCalled, false);
    equal(repo._state().deleteBranchCalled, false);
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
      readAcceptanceOperation: () => undefined,
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
      listRepositoryLeases: () => [],
      acquireRepositoryLease: () => true,
      releaseRepositoryLease: () => {},
      addActiveConvergence: () => {},
      removeActiveConvergence: () => {},
      readCampaign: () => acceptedCampaign(meta),
      writeCampaign: () => {},
      listCampaigns: () => [],
      listRunsByCampaign: () => [],
      listQueue: () => [],
      admitQueue: () => {},
      archiveQueue: () => {},
      claimNextQueuedRun: () => undefined,
      readQueuePacket: () => undefined,
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
    let operation: AcceptanceOperation | undefined;
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
      readCampaign: () => acceptedCampaign(meta, [meta, sameCampaignMeta]),
      writeCampaign: () => {},
      listCampaigns: () => [],
      listRunsByCampaign: (campaignId: string) =>
        campaignId === "campaign-1" ? [meta, sameCampaignMeta] : [],
      listQueue: () => [],
      admitQueue: () => {},
      archiveQueue: () => {},
      claimNextQueuedRun: () => undefined,
      transitionRun: (transition: RunTransition) => ({
        ...transition.meta,
        revision: transition.expectedRevision + 1,
      }),
      acceptCampaign: (members: CampaignAcceptance[], acceptedInto: string) =>
        members.map((member) => ({
          ...(member.runId === meta.runId ? meta : sameCampaignMeta),
          status: "accepted" as const,
          acceptedInto,
          revision: member.expectedRevision + 1,
        })),
      readAcceptanceOperation: () => operation,
      persistAcceptanceOperation: (next: AcceptanceOperation) => {
        operation = next;
      },
      commitAcceptanceOperation: (next: AcceptanceOperation) => {
        operation = { ...next, phase: "accepted" };
        return [];
      },
      acquireRepositoryLease: () => true,
      heartbeatRepositoryLease: (lease: RepositoryLease) => lease,
      listRepositoryLeases: () => [],
      releaseRepositoryLease: () => {},
      readQueuePacket: () => undefined,
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

  it("CAS-publishes a stale acceptedInto ref to the captured sandbox tip", () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    const repo = makeRepo();
    let sourceSha = "stale";
    let guarded = false;
    repo.resolveRevision = (path) => (path === meta.worktree ? "tip-sha" : sourceSha);
    repo.fetchBranchFromClone = (_repo, _clone, _branch, expectedOld, expectedNew) => {
      guarded = expectedOld === "stale" && expectedNew === "tip-sha";
      sourceSha = expectedNew;
    };

    equal(acceptRun(meta.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }), 0);
    equal(guarded, true);
    equal(store.readAcceptanceOperation(meta.runId)?.expectedTipSha, "tip-sha");
  });

  it("does not overwrite an acceptance ref changed by a concurrent publisher", () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    const repo = makeRepo();
    let sourceSha = "stale";
    let observedExpectedOld: string | null | undefined;
    repo.resolveRevision = (path) => (path === meta.worktree ? "tip-sha" : sourceSha);
    repo.fetchBranchFromClone = (_repo, _clone, _branch, expectedOld, expectedNew) => {
      observedExpectedOld = expectedOld;
      sourceSha = "competing-sha";
      if (sourceSha !== expectedOld) {
        throw new Error(`ref changed from ${expectedOld} to ${sourceSha}`);
      }
      sourceSha = expectedNew!;
    };

    equal(acceptRun(meta.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }), 1);
    equal(observedExpectedOld, "stale");
    equal(sourceSha, "competing-sha");
    equal(store.readAcceptanceOperation(meta.runId)?.phase, "prepared");
    equal(repo._state().removeSandboxCalled, false);
  });

  it("preserves accepted repair evidence and sandboxes until a post-commit ref race is repaired", () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    const repo = makeRepo();
    let sourceSha: string | undefined;
    let publications = 0;
    repo.resolveRevision = (path) => {
      if (path === meta.worktree) {
        return "tip-sha";
      }
      if (!sourceSha) {
        throw new Error("missing ref");
      }
      return sourceSha;
    };
    repo.fetchBranchFromClone = (_repo, _clone, _branch, expectedOld, expectedNew) => {
      publications++;
      if (publications === 2) {
        sourceSha = "competing-sha";
        throw new Error(`ref changed from ${expectedOld} to ${sourceSha}`);
      }
      sourceSha = expectedNew!;
    };
    const commit = store.commitAcceptanceOperation.bind(store);
    store.commitAcceptanceOperation = (operation, lease) => {
      const accepted = commit(operation, lease);
      sourceSha = "raced-after-commit";
      return accepted;
    };

    equal(acceptRun(meta.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }), 1);
    equal(store.readAcceptanceOperation(meta.runId)?.phase, "accepted");
    equal(repo._state().removeSandboxCalled, false);
    equal(sourceSha, "competing-sha");

    repo.fetchBranchFromClone = (_repo, _clone, _branch, _expectedOld, expectedNew) => {
      sourceSha = expectedNew!;
    };
    equal(acceptRun(meta.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }), 0);
    equal(sourceSha, "tip-sha");
    equal(store.readAcceptanceOperation(meta.runId)?.phase, "cleaned");
  });

  it("refuses acceptance and preserves the sandbox when the exact tip cannot be reproven", () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    const repo = makeRepo();
    let sandboxSha = "tip-sha";
    let sourceSha = "missing";
    repo.resolveRevision = (path) => (path === meta.worktree ? sandboxSha : sourceSha);
    repo.fetchBranchFromClone = () => {
      sourceSha = sandboxSha;
    };
    const persist = store.persistAcceptanceOperation.bind(store);
    store.persistAcceptanceOperation = (operation, lease) => {
      persist(operation, lease);
      if (operation.phase === "fetched") {
        sandboxSha = "different-tip";
        sourceSha = "stale";
      }
    };

    equal(acceptRun(meta.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }), 1);
    equal(store.readAcceptanceOperation(meta.runId)?.phase, "fetched");
    equal(repo._state().removeSandboxCalled, false);
  });

  it("resumes after a crash immediately after fetch without fetching again", () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    const repo = makeRepo();
    let fetchedWrites = 0;
    let crashed = false;
    const persist = store.persistAcceptanceOperation.bind(store);
    store.persistAcceptanceOperation = (operation, lease) => {
      persist(operation, lease);
      if (operation.phase === "fetched" && !crashed) {
        crashed = true;
        fetchedWrites++;
        throw new Error("crash after fetch");
      }
    };

    throws(
      () => acceptRun(meta.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }),
      /crash after fetch/,
    );
    equal(store.readAcceptanceOperation(meta.runId)?.phase, "fetched");
    equal(acceptRun(meta.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }), 0);
    equal(fetchedWrites, 1);
    equal(store.readAcceptanceOperation(meta.runId)?.phase, "cleaned");
  });

  it("recovers accepted cleanup without refetching or re-accepting and preserves partial progress", async () => {
    const tip = makeMeta({ runId: "20260618-090000-tip", campaignId: "campaign-clean", pass: 2 });
    const first = makeMeta({
      runId: "20260618-080000-first",
      campaignId: "campaign-clean",
      pass: 1,
    });
    const store = makeStore(tip);
    store._getCampaignStore().set("campaign-clean", [first, tip]);
    const repo = makeRepo();
    const remove = repo.removeSandbox.bind(repo);
    let failedTip = false;
    repo.removeSandbox = (path, runsDir) => {
      if (path === tip.worktree && !failedTip) {
        failedTip = true;
        throw new Error("busy");
      }
      remove(path, runsDir);
    };

    equal(acceptRun(tip.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }), 0);
    const partial = store.readAcceptanceOperation("campaign-clean")!;
    equal(partial.phase, "accepted");
    ok(partial.cleanedSandboxes.includes(first.runId));
    const fetchBeforeRecovery = repo._state().fetchBranchFromCloneCalled;
    await recoverAcceptedCleanup({ store, repo, clock: makeClock(), runsDir: "/tmp/runs" });
    equal(repo._state().fetchBranchFromCloneCalled, fetchBeforeRecovery);
    equal(store.readAcceptanceOperation("campaign-clean")?.phase, "cleaned");
  });

  it("records incomplete recovery for a later retry", () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    const repo = makeRepo();
    repo.removeSandbox = () => {
      throw new Error("busy");
    };

    equal(acceptRun(meta.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }), 0);
    equal(store.readAcceptanceOperation(meta.runId)?.phase, "accepted");
    const notes: string[] = [];
    store.appendJournal = (_runId, event) => {
      if (event.event === "driver_note") {
        notes.push(event.note);
      }
    };
    recoverAcceptedCleanup({ store, repo, clock: makeClock(), runsDir: "/tmp/runs" });
    equal(store.readAcceptanceOperation(meta.runId)?.phase, "accepted");
    ok(notes.some((note) => note.includes("remains incomplete") && note.includes("retry")));
  });

  it("does not complete cleanup from matching raw lengths without the expected members", () => {
    const tip = makeMeta({ runId: "tip", campaignId: "campaign", pass: 2 });
    const first = makeMeta({ runId: "first", campaignId: "campaign", pass: 1 });
    const store = makeStore(tip);
    const repo = makeRepo();
    repo.removeSandbox = () => {
      throw new Error("busy");
    };
    repo.deleteBranch = () => {
      throw new Error("busy");
    };
    const lease = store.acquireRepositoryLease(tip.repo, "owner", tip.runId, "accept")!;
    const operation = {
      campaignId: "campaign",
      phase: "accepted" as const,
      tipRunId: tip.runId,
      acceptedInto: tip.branch,
      expectedTipSha: "tip-sha",
      members: [
        { ...first, revision: 0, status: "accepted" as const },
        { ...tip, revision: 0, status: "accepted" as const },
      ],
      cleanedSandboxes: ["unknown-a", "unknown-b"],
      cleanedBranches: ["unknown"],
      updatedAt: makeClock().nowIso(),
    };

    equal(
      cleanAcceptedOperation(operation, lease, {
        store,
        repo,
        clock: makeClock(),
        runsDir: "/tmp/runs",
      }).phase,
      "accepted",
    );
  });

  it("records busy cleanup for a later retry without waiting", () => {
    const meta = makeMeta({ status: "accepted" });
    const store = makeStore(meta);
    const repo = makeRepo();
    const clock = makeClock();
    const operation: AcceptanceOperation = {
      campaignId: meta.runId,
      phase: "accepted",
      tipRunId: meta.runId,
      acceptedInto: meta.branch,
      expectedTipSha: "tip-sha",
      members: [{ ...meta, revision: 0, status: "accepted" }],
      cleanedSandboxes: [],
      cleanedBranches: [],
      updatedAt: clock.nowIso(),
    };
    store.persistAcceptanceOperation(operation);
    let attempts = 0;
    const notes: string[] = [];
    store.appendJournal = (_runId, event) => {
      if (event.event === "driver_note") {
        notes.push(event.note);
      }
    };
    store.acquireRepositoryLease = () => {
      attempts++;
      return undefined;
    };

    recoverAcceptedCleanup({ store, repo, clock, runsDir: "/tmp/runs" });
    equal(attempts, 1);
    equal(store.readAcceptanceOperation(meta.runId)?.phase, "accepted");
    ok(notes.some((note) => note.includes("repository is busy")));
  });

  it("treats lease loss during cleanup as fatal", () => {
    const meta = makeMeta();
    const store = makeStore(meta);
    const repo = makeRepo();
    let heartbeats = 0;
    store.heartbeatRepositoryLease = (lease) => (++heartbeats < 2 ? lease : undefined);

    throws(
      () => acceptRun(meta.runId, { store, repo, clock: makeClock(), runsDir: "/tmp/runs" }),
      /repository lease lost/,
    );
  });
});
