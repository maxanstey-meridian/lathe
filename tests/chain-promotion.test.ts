import { test } from "node:test"
import { equal, ok, strictEqual } from "node:assert"
import { mkdtemp as mkdtempP, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { StoreAdapter } from "../src/infrastructure/store.js"
import { makePaths } from "../src/config/paths.js"
import type { Clock } from "../src/application/ports/clock.js"
import type { Repo } from "../src/application/ports/repo.js"
import { promoteStaged } from "../src/application/use-cases/chain-promotion.js"
import { Campaign, CampaignStatus } from "../src/domain/campaign.js"

// ---------------------------------------------------------------------------
// Test helpers

const TS_COUNTER = { n: 0 }
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS_COUNTER.n++).padStart(2, "0")}.000Z`,
})

const fakeRepo = (opts?: {
  headBranch?: string
  branchExists?: boolean
  repoValid?: boolean
  fetchBranchFromCloneCalled?: boolean
  fetchBranchFromCloneRepo?: string
  fetchBranchFromCloneFrom?: string
  fetchBranchFromCloneBranch?: string
}): Repo => ({
  createSandbox: () => { throw new Error("unimplemented") },
  wipCommit: () => undefined,
  amendCommit: () => "",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => ({}),
  fetchBranchFromClone: () => {
    opts && (opts.fetchBranchFromCloneCalled = true)
    opts && (opts.fetchBranchFromCloneRepo = "repo")
    opts && (opts.fetchBranchFromCloneFrom = "from")
    opts && (opts.fetchBranchFromCloneBranch = "branch")
    return undefined
  },
  removeSandbox: () => { throw new Error("unimplemented") },
  headBranch: () => opts?.headBranch ?? "main",
  branchExists: () => opts?.branchExists ?? true,
  repoValid: () => opts?.repoValid ?? true,
  mergeAccept: () => { throw new Error("unimplemented") },
})

const makeMeta = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  runId: "20260101-000000-test",
  status: "queued",
  attempt: 1,
  repo: "/tmp/repo",
  base: "main",
  branch: "meridian/test",
  worktree: "/tmp/worktree",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
})

const cleanTemp = async (dir: string) => {
  try { await rm(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}

const stagedChildPacket = `---
repo: /tmp/repo
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`

const parentRunMeta = makeMeta({ runId: "20260101-000000-parent", status: "accepted" as const })
const tipRunMeta = makeMeta({ runId: "20260101-000000-tip", status: "accepted" as const, worktree: "/tmp/worktree-tip" })

const parentCampaignConverged = (tipRunId: string): Campaign => ({
  campaignId: "20260101-000000-parent",
  originalRunId: "20260101-000000-parent",
  originalIntent: "parent campaign",
  maxPasses: 3,
  status: "converged" as CampaignStatus,
  passes: [
    { runId: tipRunId, pass: 1, verdict: "accept" as const, groundedBlockers: 0, atIso: "2026-01-01T00:00:00.000Z" },
  ],
  updatedAt: "2026-01-01T00:00:00.000Z",
})

const parentCampaignNeedsMax: Campaign = {
  campaignId: "20260101-000000-parent",
  originalRunId: "20260101-000000-parent",
  originalIntent: "parent campaign",
  maxPasses: 3,
  status: "needs_max" as CampaignStatus,
  passes: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
}

const parentCampaignOpen: Campaign = {
  campaignId: "20260101-000000-parent",
  originalRunId: "20260101-000000-parent",
  originalIntent: "parent campaign",
  maxPasses: 3,
  status: "open" as CampaignStatus,
   passes: [
      { runId: "20260101-000000-pass1", pass: 1, verdict: "request_changes" as const, groundedBlockers: 0, atIso: "2026-01-01T00:00:00.000Z" },
    ],
  updatedAt: "2026-01-01T00:00:00.000Z",
}

// ---------------------------------------------------------------------------
// promoteStaged — promote-now (no parent)

test("promoteStaged: no parent → promote-now", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-pnow-"))
    const clock = fixedClock()
    const repo = fakeRepo()
    const store = StoreAdapter.create(makePaths(tmp), repo, clock)

    store.writeStaged("20260101-000000-child", stagedChildPacket)

    promoteStaged(store, repo)

    const queue = store.listQueue()
    equal(queue.length, 1)
    equal(queue[0].runId, "20260101-000000-child")
    strictEqual(store.readStaged("20260101-000000-child"), undefined)
    await cleanTemp(tmp)
  })()
})

// ---------------------------------------------------------------------------
// promoteStaged — promote-with-base (parent converged)

test("promoteStaged: parent converged → promote-with-base", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-pbase-"))
    const clock = fixedClock()
    const fetchOpts = { fetchBranchFromCloneCalled: false }
    const repo = fakeRepo(fetchOpts)
    const store = StoreAdapter.create(makePaths(tmp), repo, clock)

    const childPacket = `---
repo: /tmp/repo
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
`

    store.writeStaged("20260101-000000-child", childPacket)
    store.writeCampaign(parentCampaignConverged("20260101-000000-tip"))
    store.writeMeta(tipRunMeta)

    promoteStaged(store, repo)

    const queue = store.listQueue()
    equal(queue.length, 1)
    equal(queue[0].runId, "20260101-000000-child")
    strictEqual(store.readStaged("20260101-000000-child"), undefined)
    ok(fetchOpts.fetchBranchFromCloneCalled, "fetchBranchFromClone should be called")
    await cleanTemp(tmp)
  })()
})

// ---------------------------------------------------------------------------
// promoteStaged — hold (parent needs_max)

test("promoteStaged: parent needs_max → hold", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-hold-"))
    const clock = fixedClock()
    const repo = fakeRepo()
    const store = StoreAdapter.create(makePaths(tmp), repo, clock)

    const childPacket = `---
repo: /tmp/repo
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
`

    store.writeStaged("20260101-000000-child", childPacket)
    store.writeCampaign(parentCampaignNeedsMax)

    promoteStaged(store, repo)

    strictEqual(store.listQueue().length, 0)
    equal(store.readStaged("20260101-000000-child"), childPacket)
    await cleanTemp(tmp)
  })()
})

// ---------------------------------------------------------------------------
// promoteStaged — wait (parent not converged)

test("promoteStaged: parent not converged → wait", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-wait-"))
    const clock = fixedClock()
    const repo = fakeRepo()
    const store = StoreAdapter.create(makePaths(tmp), repo, clock)

    const childPacket = `---
repo: /tmp/repo
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
`

    store.writeStaged("20260101-000000-child", childPacket)
    store.writeCampaign(parentCampaignOpen)

    promoteStaged(store, repo)

    strictEqual(store.listQueue().length, 0)
    equal(store.readStaged("20260101-000000-child"), childPacket)
    await cleanTemp(tmp)
  })()
})

// ---------------------------------------------------------------------------
// promoteStaged — no parent campaign started

test("promoteStaged: parent campaign not found → wait", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-wait-nocamp-"))
    const clock = fixedClock()
    const repo = fakeRepo()
    const store = StoreAdapter.create(makePaths(tmp), repo, clock)

    const childPacket = `---
repo: /tmp/repo
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
`

    store.writeStaged("20260101-000000-child", childPacket)

    promoteStaged(store, repo)

    strictEqual(store.listQueue().length, 0)
    equal(store.readStaged("20260101-000000-child"), childPacket)
    await cleanTemp(tmp)
  })()
})

// ---------------------------------------------------------------------------
// promoteStaged — staged child not found → skip

test("promoteStaged: staged child not found → skip", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-skip-"))
    const clock = fixedClock()
    const repo = fakeRepo()
    const store = StoreAdapter.create(makePaths(tmp), repo, clock)

    // Write campaign but no staged child — promoteStaged reads staged, finds nothing.
    store.writeCampaign(parentCampaignConverged("20260101-000000-tip"))

    promoteStaged(store, repo)

    strictEqual(store.listQueue().length, 0)
    await cleanTemp(tmp)
  })()
})

// ---------------------------------------------------------------------------
// promoteStaged — multiple staged children

test("promoteStaged: multiple staged → mixed decisions", () => {
  return (async () => {
    const tmp = await mkdtempP(join(tmpdir(), "chain-promo-multi-"))
    const clock = fixedClock()
    const repo = fakeRepo()
    const store = StoreAdapter.create(makePaths(tmp), repo, clock)

    // Child without parent → promote-now
    store.writeStaged("20260101-000000-no-parent", stagedChildPacket)

    // Child with converged parent → promote-with-base
    const childWithParent = `---
repo: /tmp/repo
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
`
    store.writeStaged("20260101-000000-converged", childWithParent)
    store.writeCampaign(parentCampaignConverged("20260101-000000-tip"))
    store.writeMeta(tipRunMeta)

    promoteStaged(store, repo)

    const queue = store.listQueue()
    equal(queue.length, 2)
    strictEqual(store.readStaged("20260101-000000-no-parent"), undefined)
    strictEqual(store.readStaged("20260101-000000-converged"), undefined)
    await cleanTemp(tmp)
  })()
})
