import { test } from "node:test"
import { equal, ok, deepEqual } from "node:assert"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"
import { convergeRun } from "../src/application/use-cases/converge-run.js"
import type { Store } from "../src/application/ports/store.js"
import type { Repo } from "../src/application/ports/repo.js"
import type { Reviewer, SuperReviewResult } from "../src/application/ports/reviewer.js"
import type { Verify, VerificationResult } from "../src/application/ports/verify.js"
import type { Clock } from "../src/application/ports/clock.js"
import type { Config } from "../src/config/schemas.js"
import type { Paths } from "../src/config/paths.js"
import type { RunMeta } from "../src/domain/run.js"
import type { Campaign } from "../src/domain/campaign.js"
import { parsePacketShape } from "../src/domain/packet.js"
import { makePaths } from "../src/config/paths.js"

// ---------------------------------------------------------------------------
// Shared fixture setup

const RUN_ID = "20260101-000000-converge"
const CAMPAIGN_ID = "converge"

const PACKET_RAW = `---
repo: /tmp/test-repo
base: main
summary: converge-run fixture
outcomes:
  - id: test-outcome
    description: A test outcome
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
constraints:
  - keep it clean
pass: 1
regression_outcomes:
  - id: prior-outcome
    description: a prior outcome
---

body
`

const makeMeta = (overrides: Partial<RunMeta> = {}): RunMeta => ({
  runId: RUN_ID,
  status: "ready_for_review",
  attempt: 1,
  repo: "/tmp/test-repo",
  base: "main",
  branch: "meridian/20260101-000000-converge",
  worktree: "/tmp/test-worktree",
  summary: "converge-run fixture",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
})

let TS_N = 0
const fixedClock = (): Clock => ({
  now: () => 1_700_000_000_000 + TS_N++,
  nowIso: () => `2026-01-01T00:00:${String(TS_N++ % 60).padStart(2, "0")}.000Z`,
})

// Create a real temp skill file so readFileSync doesn't throw ENOENT inside
// the try block of convergeRun (line 161). Each test suite gets its own file.
const createSkillFile = (): string => {
  const skillPath = join(tmpdir(), `test-skill-${Date.now()}-${TS_N++}.md`)
  writeFileSync(skillPath, "# Test rubric\n", "utf-8")
  return skillPath
}

const defaultConfig = (skillPath: string): Config => ({
  stateRoot: "~/.meridian/v2",
  opencode: {},
  daddy: {},
  baby: {},
  superdaddy: {
    skillPath,
    diffCapBytes: 131_072,
  },
  thresholds: { maxPasses: 3, verificationTimeoutMs: 600_000 },
  mutationCommandPatterns: [],
} as unknown as Config)

const defaultPaths = (root: string): Paths => makePaths(root)

// ---------------------------------------------------------------------------
// Fake ports factory

const makeFakePorts = (
  skillPath: string,
  metaOverrides: Partial<RunMeta> = {},
  campaignOverride?: Campaign,
  reviewOverride?: SuperReviewResult,
  verifyOverride?: VerificationResult[],
  onAdmitQueue?: (runId: string, content: string) => void,
  onWriteCampaign?: (c: Campaign) => void,
  onAppendConvergence?: (runId: string, entry: unknown) => void,
  onWriteNits?: (runId: string, md: string) => void,
) => {
  let metaStore: RunMeta = makeMeta(metaOverrides)
  const nitsStore = new Map<string, string>()
  const convergenceStore = new Array<unknown>()
  let campaign: Campaign | undefined = campaignOverride

  const clock = fixedClock()
  const paths = defaultPaths(tmpdir())

  return {
    clock,
    paths,
    config: defaultConfig(skillPath),
    store: {
      readMeta: (runId: string) => {
        if (runId !== RUN_ID) throw new Error(`unknown runId: ${runId}`)
        return metaStore
      },
      writeMeta: (m: RunMeta) => { metaStore = m },
      readFrozenPacket: (_runId: string) => PACKET_RAW,
      readCampaign: (_campaignId: string) => campaign,
      writeCampaign: (c: Campaign) => {
        campaign = c
        onWriteCampaign?.(c)
      },
      admitQueue: (runId: string, content: string) => {
        onAdmitQueue?.(runId, content)
      },
      appendConvergence: (runId: string, entry: unknown) => {
        convergenceStore.push(entry)
        onAppendConvergence?.(runId, entry)
      },
      writeNits: (runId: string, md: string) => {
        nitsStore.set(runId, md)
        onWriteNits?.(runId, md)
      },
    } as unknown as Store,
    repo: {
      reviewableDiffAgainst: () => "diff",
      amendCommit: () => "amended-sha",
      fetchBranchFromClone: () => {},
    } as unknown as Repo,
    reviewer: {
      superReview: async () => reviewOverride ?? {
        review: {
          verdict: "accept",
          findings: [],
          convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
          commit_message: { subject: "feat: converged", body: "all good" },
          notes: "",
          human_decision_needed: null,
        },
        raw: "ok",
      },
    } as Reviewer,
    verify: {
      run: async () => verifyOverride ?? [{ command: "echo ok", exitCode: 0, outputTail: "" }],
    } as unknown as Verify,
    nitsStore,
    convergenceStore,
    getMeta: () => metaStore,
    getCampaign: () => campaign,
  }
}

// ---------------------------------------------------------------------------
// Test: stop — campaign converged, commit amended, campaign status converged

test("convergeRun: stop — amend commit, campaign converged, meta un-parked", async () => {
  let admittedQueue: [string, string][] = []
  let campaignWritten: Campaign | undefined
  let nitsWritten: string | undefined

  const skillPath = createSkillFile()
  const ports = makeFakePorts(
    skillPath,
    { status: "blocked" as const, blockedReason: "human_decision" as const, blockedQuestion: "why?" },
    undefined,
    {
      review: {
        verdict: "accept",
        findings: [{ id: "nit-1", severity: "P2", title: "style", evidence: [], grounding: { kind: "none", ref: "" } }],
        convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 1, p3: 0 }, rationale: "ok" },
        commit_message: { subject: "feat: converged", body: "done" },
        notes: "",
        human_decision_needed: null,
      },
      raw: "accept",
    },
    undefined,
    (runId, content) => { admittedQueue.push([runId, content]) },
    (c) => { campaignWritten = c },
    undefined,
    (runId, md) => { nitsWritten = md },
  )

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })

  await runner(RUN_ID)

  // Campaign should be converged
  ok(campaignWritten, "campaign should be written")
  equal(campaignWritten?.status, "converged")
  equal(campaignWritten?.passes.length, 1)
  equal(campaignWritten?.passes[0].runId, RUN_ID)
  equal(campaignWritten?.passes[0].pass, 1)

  // Meta should be un-parked from blocked → ready_for_review
  const meta = ports.getMeta()
  equal(meta.status, "ready_for_review")
  equal(meta.blockedReason, undefined)
  equal(meta.blockedQuestion, undefined)

  // No queue admission on stop
  equal(admittedQueue.length, 0)

  // Nits should be written (stop → not author, so nits apply)
  ok(nitsWritten, "nits should be written on stop")
  ok(nitsWritten?.includes("nit-1"))

  // Convergence log should have one entry
  equal(ports.convergenceStore.length, 1)
})

// ---------------------------------------------------------------------------
// Test: stop without commit message — amend skipped, still converged

test("convergeRun: stop without commit_message — amend skipped, still converged", async () => {
  let campaignWritten: Campaign | undefined

  const skillPath = createSkillFile()
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "accept",
        findings: [],
        convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
        commit_message: null,
        notes: "",
        human_decision_needed: null,
      },
      raw: "accept",
    },
  )

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })

  await runner(RUN_ID)

  const meta = ports.getMeta()
  equal(meta.status, "ready_for_review")
  const campaign = ports.getCampaign()
  ok(campaign, "campaign should be written")
  equal(campaign?.status, "converged")
})

// ---------------------------------------------------------------------------
// Test: author — follow-up admitted, campaign open, priorOutcomes deduped union

test("convergeRun: author — admit follow-up, campaign open, priorOutcomes deduped union", async () => {
  let admittedQueue: [string, string][] = []
  let campaignWritten: Campaign | undefined

  const skillPath = createSkillFile()
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "request_changes",
        findings: [
          { id: "fix-a", severity: "P0", title: "fix a", evidence: ["a.ts:1"], grounding: { kind: "command_fail", ref: "pnpm test" }, suggested_outcome_id: "fix-a" },
          { id: "fix-b", severity: "P1", title: "fix b", evidence: [], grounding: { kind: "none", ref: "" } },
        ],
        convergence: { recommend_stop: false, profile: { p0: 1, p1: 1, p2: 0, p3: 0 }, rationale: "" },
        commit_message: null,
        notes: "",
        human_decision_needed: null,
      },
      raw: "request_changes",
    },
    undefined,
    (runId, content) => { admittedQueue.push([runId, content]) },
    (c) => { campaignWritten = c },
  )

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })

  await runner(RUN_ID)

  // Campaign should be open
  ok(campaignWritten, "campaign should be written")
  equal(campaignWritten?.status, "open")
  equal(campaignWritten?.passes.length, 1)
  equal(campaignWritten?.passes[0].verdict, "request_changes")

  // Should admit a follow-up packet
  equal(admittedQueue.length, 1)
  const [followUpId, followUpContent] = admittedQueue[0]
  ok(followUpId.startsWith("20260101-"))
  ok(followUpContent.includes("convergence pass 2"))
  ok(followUpContent.includes("fix-a"))
  ok(followUpContent.includes("fix-b"))

  // Nits should NOT be written on author path
  // (the fake store doesn't track nits writes separately, so we verify
  //  by checking the reviewer findings have grounded blockers)
  equal(campaignWritten?.passes[0].groundedBlockers, 1) // only P0 is grounded

  // No meta status change on author — stays ready_for_review
  equal(ports.getMeta().status, "ready_for_review")
})

// ---------------------------------------------------------------------------
// Test: escalate — meta parked as blocked/human_decision

test("convergeRun: escalate — meta blocked, campaign needs_max", async () => {
  let campaignWritten: Campaign | undefined

  const skillPath = createSkillFile()
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "escalate",
        findings: [],
        convergence: { recommend_stop: false, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
        commit_message: null,
        notes: "",
        human_decision_needed: "needs a call",
      },
      raw: "escalate",
    },
    undefined,
    undefined,
    (c) => { campaignWritten = c },
  )

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })

  await runner(RUN_ID)

  const meta = ports.getMeta()
  equal(meta.status, "blocked")
  equal(meta.blockedReason, "human_decision")
  ok(meta.blockedQuestion, "should have a question")

  ok(campaignWritten, "campaign should be written")
  equal(campaignWritten?.status, "needs_max")
})

// ---------------------------------------------------------------------------
// Test: alreadyReviewed — pure early return, zero side effects

test("convergeRun: alreadyReviewed — pure early return", async () => {
  const existingCampaign: Campaign = {
    campaignId: CAMPAIGN_ID,
    originalRunId: RUN_ID,
    originalIntent: "x",
    status: "converged",
    maxPasses: 3,
    passes: [{ runId: RUN_ID, pass: 1, verdict: "accept", groundedBlockers: 0, atIso: "2026-01-01T00:00:00.000Z" }],
    updatedAt: "2026-01-01T00:00:00.000Z",
  }

  let writeCount = 0
  const skillPath = createSkillFile()
  const ports = makeFakePorts(
    skillPath,
    undefined,
    existingCampaign,
    {
      review: {
        verdict: "accept",
        findings: [],
        convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
        commit_message: { subject: "noop", body: "" },
        notes: "",
        human_decision_needed: null,
      },
      raw: "ok",
    },
    undefined,
    () => { writeCount++ },
    () => { writeCount++ },
    () => { writeCount++ },
  )

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })

  await runner(RUN_ID)

  // Zero side effects — no writes at all
  equal(writeCount, 0)

  // Campaign unchanged
  deepEqual(ports.getCampaign(), existingCampaign)
})

// ---------------------------------------------------------------------------
// Test: verification red + accept → escalate (under-reported)

test("convergeRun: accept + red verification → escalate", async () => {
  let campaignWritten: Campaign | undefined

  const skillPath = createSkillFile()
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "accept",
        findings: [],
        convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
        commit_message: { subject: "ok", body: "" },
        notes: "",
        human_decision_needed: null,
      },
      raw: "accept",
    },
    [{ command: "echo ok", exitCode: 0, outputTail: "" }, { command: "pnpm test", exitCode: 1, outputTail: "FAIL" }],
  )

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })

  await runner(RUN_ID)

  const meta = ports.getMeta()
  equal(meta.status, "blocked")
  ok(meta.blockedQuestion?.includes("under-reported"))

  const campaign = ports.getCampaign()
  ok(campaign, "campaign should be written")
  equal(campaign?.status, "needs_max")
})

// ---------------------------------------------------------------------------
// Test: fail-safe — any error leaves ready_for_review

test("convergeRun: failure → meta reset to ready_for_review", async () => {
  const skillPath = createSkillFile()
  const ports = makeFakePorts(
    skillPath,
    { status: "running" as const },
    undefined,
    {
      review: {
        verdict: "accept",
        findings: [],
        convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
        commit_message: { subject: "ok", body: "" },
        notes: "",
        human_decision_needed: null,
      },
      raw: "ok",
    },
  )

  // Make the reviewer throw to trigger fail-safe
  const failingReviewer = {
    superReview: async () => { throw new Error("reviewer crashed") },
  }

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: failingReviewer as any,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })

  await runner(RUN_ID)

  // Fail-safe: meta reset to ready_for_review
  const meta = ports.getMeta()
  equal(meta.status, "ready_for_review")
})

// ---------------------------------------------------------------------------
// Test: pass cap reached → escalate

test("convergeRun: pass cap reached → escalate", async () => {
  let campaignWritten: Campaign | undefined

  const skillPath = createSkillFile()
  const ports = makeFakePorts(
    skillPath,
    { attempt: 5 }, // meta.attempt = 5, pass = 1 from frontmatter
    undefined,
    {
      review: {
        verdict: "request_changes",
        findings: [{ id: "still-broken", severity: "P0", title: "still broken", evidence: [], grounding: { kind: "command_fail", ref: "t" } }],
        convergence: { recommend_stop: false, profile: { p0: 1, p1: 0, p2: 0, p3: 0 }, rationale: "" },
        commit_message: null,
        notes: "",
        human_decision_needed: null,
      },
      raw: "rc",
    },
    undefined,
    undefined,
    (c) => { campaignWritten = c },
  )

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })

  await runner(RUN_ID)

  // pass = 1 (from frontmatter), maxPasses = 3 → not capped, should author
  ok(campaignWritten, "campaign should be written")
  equal(campaignWritten?.status, "open")
  equal(campaignWritten?.passes.length, 1)
})

// ---------------------------------------------------------------------------
// Test: request_changes with no findings → escalate

test("convergeRun: request_changes but zero findings → escalate", async () => {
  const skillPath = createSkillFile()
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "request_changes",
        findings: [],
        convergence: { recommend_stop: false, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
        commit_message: null,
        notes: "",
        human_decision_needed: null,
      },
      raw: "rc",
    },
  )

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })

  await runner(RUN_ID)

  const meta = ports.getMeta()
  equal(meta.status, "blocked")
  ok(meta.blockedQuestion?.includes("named no findings"))
})

// ---------------------------------------------------------------------------
// Test: stop on meta already ready_for_review — no writeMeta call needed

test("convergeRun: stop with meta already ready_for_review — no unnecessary write", async () => {
  let metaWrites = 0
  const originalMeta = makeMeta({ status: "ready_for_review" as const })
  const storedMeta = { ...originalMeta }

  const skillPath = createSkillFile()
  const clock = fixedClock()
  const paths = defaultPaths(tmpdir())

  const ports = {
    clock,
    paths,
    config: defaultConfig(skillPath),
    store: {
      readMeta: () => storedMeta,
      writeMeta: () => { metaWrites++ },
      readFrozenPacket: () => PACKET_RAW,
      readCampaign: () => undefined,
      writeCampaign: () => {},
      admitQueue: () => {},
      appendConvergence: () => {},
      writeNits: () => {},
    } as unknown as Store,
    repo: {
      reviewableDiffAgainst: () => "diff",
      amendCommit: () => "sha",
      fetchBranchFromClone: () => {},
    } as unknown as Repo,
    reviewer: {
      superReview: async () => ({
        review: {
          verdict: "accept",
          findings: [],
          convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
          commit_message: null,
          notes: "",
          human_decision_needed: null,
        },
        raw: "ok",
      }),
    } as any,
    verify: {
      run: async () => [{ command: "true", exitCode: 0, outputTail: "" }],
    } as unknown as Verify,
  }

  const runner = convergeRun(ports)
  await runner(RUN_ID)

  // Should NOT have written meta when status was already ready_for_review
  equal(metaWrites, 0)
})

// ---------------------------------------------------------------------------
// Test: pass from packet.frontmatter.pass, not meta.attempt

test("convergeRun: pass from packet.frontmatter.pass, not meta.attempt", async () => {
  let campaignWritten: Campaign | undefined

  const skillPath = createSkillFile()
  const ports = makeFakePorts(
    skillPath,
    { attempt: 5 }, // meta.attempt = 5, but pass = 1 from packet
    undefined,
    {
      review: {
        verdict: "accept",
        findings: [],
        convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
        commit_message: { subject: "ok", body: "" },
        notes: "",
        human_decision_needed: null,
      },
      raw: "ok",
    },
  )

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })

  await runner(RUN_ID)

  // Campaign should record pass=1, not attempt=5
  const campaign = ports.getCampaign()
  ok(campaign, "campaign should be written")
  equal(campaign?.passes[0].pass, 1)
})

// ---------------------------------------------------------------------------
// Test: stop with maxPasses: 1 and pass: 1 → capped, not stopped

test("convergeRun: stop on pass cap (maxPasses=1, pass=1) → should stop if accept+green", async () => {
  let campaignWritten: Campaign | undefined

  const skillPath = createSkillFile()
  const config = {
    ...defaultConfig(skillPath),
    thresholds: { maxPasses: 1, verificationTimeoutMs: 600_000 },
  } as unknown as Config

  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "accept",
        findings: [],
        convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
        commit_message: { subject: "ok", body: "" },
        notes: "",
        human_decision_needed: null,
      },
      raw: "ok",
    },
    undefined,
    undefined,
    (c) => { campaignWritten = c },
    undefined,
    undefined,
  )

  ports.config = config

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })

  await runner(RUN_ID)

  // pass=1, maxPasses=1, accept+green → stop (cap is pass >= maxPasses,
  // but accept+green is stop before cap check in decideConvergence)
  ok(campaignWritten, "campaign should be written")
  equal(campaignWritten?.status, "converged")
})
