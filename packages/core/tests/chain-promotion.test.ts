import { equal, ok, strictEqual } from "node:assert";
import { mkdtemp as mkdtempP, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import { promoteStaged } from "../src/application/use-cases/chain-promotion.js";
import { makePaths } from "../src/config/paths.js";
import { Campaign, CampaignStatus } from "../src/domain/campaign.js";
import type { RunMeta } from "../src/domain/run.js";
import { SqliteStoreAdapter } from "../src/infrastructure/sqlite-store.js";

// ---------------------------------------------------------------------------
// Test helpers

const TS_COUNTER = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS_COUNTER.n++).padStart(2, "0")}.000Z`,
});

const fakeRepo = (opts?: {
  headBranch?: string;
  branchExists?: boolean;
  repoValid?: boolean;
  fetchBranchFromCloneCalled?: boolean;
  fetchBranchFromCloneRepo?: string;
  fetchBranchFromCloneFrom?: string;
  fetchBranchFromCloneBranch?: string;
  fetchBranchFromCloneCalls?: number;
  sourceSha?: string | null;
  sandboxSha?: string;
  raceOnFetch?: boolean;
}): Repo => ({
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
  resolveRevision: (path: string) => {
    if (path === "/tmp/repo") {
      if (opts?.sourceSha === undefined || opts.sourceSha === null) {
        throw new Error("missing ref");
      }
      return opts.sourceSha;
    }
    return opts?.sandboxSha ?? "tip-sha";
  },
  fetchBranchFromClone: (_repo, _clone, _branch, expectedOld, expectedNew) => {
    if (opts) {
      opts.fetchBranchFromCloneCalled = true;
      opts.fetchBranchFromCloneCalls = (opts.fetchBranchFromCloneCalls ?? 0) + 1;
      opts.fetchBranchFromCloneRepo = "repo";
      opts.fetchBranchFromCloneFrom = "from";
      opts.fetchBranchFromCloneBranch = "branch";
      if (opts.raceOnFetch) {
        opts.sourceSha = "external-race";
        throw new Error("CAS lost");
      }
      if ((opts.sourceSha ?? null) !== expectedOld) {
        throw new Error("CAS lost");
      }
      opts.sourceSha = expectedNew;
    }
    return undefined;
  },
  removeSandbox: () => {
    throw new Error("unimplemented");
  },
  headBranch: () => opts?.headBranch ?? "main",
  branchExists: () => opts?.branchExists ?? true,
  repoValid: () => opts?.repoValid ?? true,
  deleteBranch: () => {
    throw new Error("unimplemented");
  },
});

const makeMeta = (overrides: Partial<RunMeta> = {}): RunMeta => ({
  runId: "20260101-000000-test",
  status: "queued",
  attempt: 1,
  repo: "/tmp/repo",
  base: "main",
  branch: "meridian/test",
  worktree: "/tmp/worktree",
  pass: 1,
  stallRetries: 0,
  crashRetries: 0,
  reorientRetries: 0,
  promoted: false,
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const cleanTemp = async (dir: string) => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

const stagedChildPacket = `---
repo: /tmp/repo
compare_commit: main
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;

// Tip whose campaign converged but `lathe prepare` has NOT run yet: its branch
// still lives only in the clone sandbox, so promotion must fetch it.
const tipRunMeta = makeMeta({
  runId: "20260101-000000-tip",
  status: "ready_for_review" as const,
  worktree: "/tmp/worktree-tip",
});

// Tip already prepared: preparation fetched it into `acceptedInto` (here, "main") and
// destroyed the clone + the meridian/<tip> branch. Promotion must base off
// `acceptedInto` and skip the fetch — the canonical repo already has the work.
const tipRunMetaAccepted = makeMeta({
  runId: "20260101-000000-tip",
  status: "accepted" as const,
  base: "meridian/20260101-000000-tip-prev",
  branch: "meridian/20260101-000000-tip",
  worktree: "/tmp/worktree-tip",
  acceptedInto: "main",
});

const parentCampaignConverged = (tipRunId: string): Campaign => ({
  campaignId: "20260101-000000-parent",
  originalRunId: "20260101-000000-parent",
  originalIntent: "parent campaign",
  maxPasses: 3,
  status: "converged" as CampaignStatus,
  passes: [
    {
      runId: tipRunId,
      attempt: 1,
      pass: 1,
      verdict: "accept" as const,
      groundedBlockers: 0,
      atIso: "2026-01-01T00:00:00.000Z",
    },
  ],
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const parentCampaignNeedsMax: Campaign = {
  campaignId: "20260101-000000-parent",
  originalRunId: "20260101-000000-parent",
  originalIntent: "parent campaign",
  maxPasses: 3,
  status: "needs_max" as CampaignStatus,
  passes: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const parentCampaignOpen: Campaign = {
  campaignId: "20260101-000000-parent",
  originalRunId: "20260101-000000-parent",
  originalIntent: "parent campaign",
  maxPasses: 3,
  status: "open" as CampaignStatus,
  passes: [
    {
      runId: "20260101-000000-pass1",
      attempt: 1,
      pass: 1,
      verdict: "request_changes" as const,
      groundedBlockers: 0,
      atIso: "2026-01-01T00:00:00.000Z",
    },
  ],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// ---------------------------------------------------------------------------
// promoteStaged — promote-now (no parent)

test("promoteStaged: no parent → promote-now", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-pnow-"));
    const clock = fixedClock();
    const repo = fakeRepo({ sourceSha: null });
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

    store.writeStaged("20260101-000000-child", stagedChildPacket);

    promoteStaged(store, repo);

    const queue = store.listQueue();
    equal(queue.length, 1);
    equal(queue[0]!.runId, "20260101-000000-child");
    strictEqual(store.readStaged("20260101-000000-child"), undefined);
    await cleanTemp(tmp);
  })();
});

test("promoteStaged: leaves staged work untouched while the repository lease is held", async () => {
  const tmp = await mkdtempP(join(tmpdir(), "chain-promo-leased-"));
  const clock = fixedClock();
  const repo = fakeRepo({ sourceSha: null });
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);
  const runId = "20260101-000000-child";
  store.writeStaged(runId, stagedChildPacket);
  const lease = store.acquireRepositoryLease("/tmp/repo", "other-owner", "other-run", "execute");
  ok(lease);

  promoteStaged(store, repo);

  equal(store.listQueue().length, 0);
  ok(store.readStaged(runId));
  store.releaseRepositoryLease(lease);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// promoteStaged — promote-with-base (parent converged)

test("promoteStaged: parent converged → promote-with-base", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-pbase-"));
    const clock = fixedClock();
    const fetchOpts = { fetchBranchFromCloneCalled: false, sourceSha: null as string | null };
    const repo = fakeRepo(fetchOpts);
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

    const childPacket = `---
repo: /tmp/repo
compare_commit: main
parent_run_id: 20260101-000000-parent
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;

    store.writeStaged("20260101-000000-child", childPacket);
    store.writeCampaign(parentCampaignConverged("20260101-000000-tip"));
    store.writeMeta(tipRunMeta);

    promoteStaged(store, repo);

    const queue = store.listQueue();
    equal(queue.length, 1);
    equal(queue[0]!.runId, "20260101-000000-child");
    strictEqual(store.readStaged("20260101-000000-child"), undefined);
    ok(fetchOpts.fetchBranchFromCloneCalled, "fetchBranchFromClone should be called");
    // Base off the tip branch — its work lives only in the clone until accept.
    ok(
      store
        .readQueuePacket("20260101-000000-child")
        ?.includes("base: meridian/20260101-000000-tip"),
      "child should be based on the tip branch",
    );
    await cleanTemp(tmp);
  })();
});

test("promoteStaged: existing matching parent ref is CAS-proved before admission", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-existing-base-"));
    const repoState = {
      fetchBranchFromCloneCalled: false,
      sourceSha: "tip-sha" as string | null,
      sandboxSha: "tip-sha",
    };
    const repo = fakeRepo(repoState);
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, fixedClock());
    const childPacket = stagedChildPacket.replace(
      "compare_commit: main",
      "compare_commit: main\nparent_run_id: 20260101-000000-parent",
    );
    store.writeStaged("20260101-000000-child", childPacket);
    store.writeCampaign(parentCampaignConverged(tipRunMeta.runId));
    store.writeMeta(tipRunMeta);

    promoteStaged(store, repo);

    equal(store.listQueue().length, 1);
    equal(repoState.fetchBranchFromCloneCalled, true);
    strictEqual(store.readStaged("20260101-000000-child"), undefined);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// promoteStaged — accepted tip: base off acceptedInto, no fetch (regression for
// the strand where an accepted tip's deleted sandbox branch failed every sweep).

test("promoteStaged: tip already accepted → base off acceptedInto, no fetch", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-accepted-"));
    const clock = fixedClock();
    const fetchOpts = { fetchBranchFromCloneCalled: false, sourceSha: "tip-sha" as string | null };
    const repo = fakeRepo(fetchOpts);
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

    const childPacket = `---
repo: /tmp/repo
compare_commit: main
parent_run_id: 20260101-000000-parent
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;

    store.writeStaged("20260101-000000-child", childPacket);
    store.writeCampaign(parentCampaignConverged("20260101-000000-tip"));
    store.writeMeta(tipRunMetaAccepted);
    store.readAcceptanceOperation = () => ({
      campaignId: "20260101-000000-parent",
      phase: "cleaned",
      tipRunId: tipRunMetaAccepted.runId,
      acceptedInto: "main",
      expectedTipSha: "tip-sha",
      members: [
        {
          runId: tipRunMetaAccepted.runId,
          revision: tipRunMetaAccepted.revision ?? 0,
          status: "accepted",
          repo: tipRunMetaAccepted.repo,
          branch: tipRunMetaAccepted.branch,
          worktree: tipRunMetaAccepted.worktree,
          base: tipRunMetaAccepted.base,
          pass: tipRunMetaAccepted.pass ?? 1,
        },
      ],
      cleanedSandboxes: [tipRunMetaAccepted.runId],
      cleanedBranches: [],
      updatedAt: tipRunMetaAccepted.updatedAt,
    });

    promoteStaged(store, repo);

    const queue = store.listQueue();
    equal(queue.length, 1);
    equal(queue[0]!.runId, "20260101-000000-child");
    strictEqual(store.readStaged("20260101-000000-child"), undefined);
    // The work is already in the canonical repo on `acceptedInto` — never fetch
    // the destroyed sandbox branch.
    ok(
      !fetchOpts.fetchBranchFromCloneCalled,
      "fetchBranchFromClone must NOT be called for an accepted tip",
    );
    ok(
      store.readQueuePacket("20260101-000000-child")?.includes("base: main"),
      "child should be based on the branch the tip was accepted into",
    );
    await cleanTemp(tmp);
  })();
});

test("promoteStaged: differing existing parent ref leaves child staged", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-stale-ref-"));
    const repoState = {
      fetchBranchFromCloneCalled: false,
      sourceSha: "external-sha" as string | null,
      sandboxSha: "tip-sha",
    };
    const repo = fakeRepo(repoState);
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, fixedClock());
    const childPacket = stagedChildPacket.replace(
      "compare_commit: main",
      "compare_commit: main\nparent_run_id: 20260101-000000-parent",
    );
    store.writeStaged("20260101-000000-child", childPacket);
    store.writeCampaign(parentCampaignConverged(tipRunMeta.runId));
    store.writeMeta(tipRunMeta);

    promoteStaged(store, repo);

    equal(store.listQueue().length, 0);
    equal(store.readStaged("20260101-000000-child"), childPacket);
    equal(repoState.fetchBranchFromCloneCalled, false);
    await cleanTemp(tmp);
  })();
});

test("promoteStaged: parent ref CAS race leaves child staged on every replay", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-ref-race-"));
    const repoState = {
      fetchBranchFromCloneCalled: false,
      fetchBranchFromCloneCalls: 0,
      sourceSha: null as string | null,
      sandboxSha: "tip-sha",
      raceOnFetch: true,
    };
    const repo = fakeRepo(repoState);
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, fixedClock());
    const childPacket = stagedChildPacket.replace(
      "compare_commit: main",
      "compare_commit: main\nparent_run_id: 20260101-000000-parent",
    );
    store.writeStaged("20260101-000000-child", childPacket);
    store.writeCampaign(parentCampaignConverged(tipRunMeta.runId));
    store.writeMeta(tipRunMeta);

    promoteStaged(store, repo);
    promoteStaged(store, repo);

    equal(store.listQueue().length, 0);
    equal(store.readStaged("20260101-000000-child"), childPacket);
    equal(repoState.fetchBranchFromCloneCalls, 1);
    equal(repoState.sourceSha, "external-race");
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// promoteStaged — hold (parent needs_max)

test("promoteStaged: parent needs_max → hold", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-hold-"));
    const clock = fixedClock();
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

    const childPacket = `---
repo: /tmp/repo
compare_commit: main
parent_run_id: 20260101-000000-parent
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;

    store.writeStaged("20260101-000000-child", childPacket);
    store.writeCampaign(parentCampaignNeedsMax);

    promoteStaged(store, repo);

    strictEqual(store.listQueue().length, 0);
    equal(store.readStaged("20260101-000000-child"), childPacket);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// promoteStaged — wait (parent not converged)

test("promoteStaged: parent not converged → wait", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-wait-"));
    const clock = fixedClock();
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

    const childPacket = `---
repo: /tmp/repo
compare_commit: main
parent_run_id: 20260101-000000-parent
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;

    store.writeStaged("20260101-000000-child", childPacket);
    store.writeCampaign(parentCampaignOpen);

    promoteStaged(store, repo);

    strictEqual(store.listQueue().length, 0);
    equal(store.readStaged("20260101-000000-child"), childPacket);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// promoteStaged — no parent campaign started

test("promoteStaged: parent campaign not found → wait", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-wait-nocamp-"));
    const clock = fixedClock();
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

    const childPacket = `---
repo: /tmp/repo
compare_commit: main
parent_run_id: 20260101-000000-parent
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;

    store.writeStaged("20260101-000000-child", childPacket);

    promoteStaged(store, repo);

    strictEqual(store.listQueue().length, 0);
    equal(store.readStaged("20260101-000000-child"), childPacket);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// promoteStaged — staged child not found → skip

test("promoteStaged: staged child not found → skip", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-skip-"));
    const clock = fixedClock();
    const repo = fakeRepo();
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

    // Write campaign but no staged child — promoteStaged reads staged, finds nothing.
    store.writeCampaign(parentCampaignConverged("20260101-000000-tip"));

    promoteStaged(store, repo);

    strictEqual(store.listQueue().length, 0);
    await cleanTemp(tmp);
  })();
});

// ---------------------------------------------------------------------------
// promoteStaged — multiple staged children

test("promoteStaged: multiple staged → mixed decisions", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-multi-"));
    const clock = fixedClock();
    const repo = fakeRepo({ sourceSha: null });
    const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

    // Child without parent → promote-now
    store.writeStaged("20260101-000000-no-parent", stagedChildPacket);

    // Child with converged parent → promote-with-base
    const childWithParent = `---
repo: /tmp/repo
compare_commit: main
parent_run_id: 20260101-000000-parent
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;
    store.writeStaged("20260101-000000-converged", childWithParent);
    store.writeCampaign(parentCampaignConverged("20260101-000000-tip"));
    store.writeMeta(tipRunMeta);

    promoteStaged(store, repo);

    const queue = store.listQueue();
    equal(queue.length, 2);
    strictEqual(store.readStaged("20260101-000000-no-parent"), undefined);
    strictEqual(store.readStaged("20260101-000000-converged"), undefined);
    await cleanTemp(tmp);
  })();
});
