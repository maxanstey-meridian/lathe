// Compile-time typecheck fixture: structural fakes that prove every port shape
// is usable. Zero `as` casts — if a cast is needed, the port shape is wrong.
//
// These are no-ops: they do nothing at runtime and are never imported by
// production code. They exist solely to satisfy the type system.

import type { Clock } from "./application/ports/clock.js"
import type { Executor } from "./application/ports/executor.js"
import type { Repo } from "./application/ports/repo.js"
import type { Store } from "./application/ports/store.js"
import type { Planner } from "./application/ports/planner.js"
import type { Reviewer } from "./application/ports/reviewer.js"
import type { Verify } from "./application/ports/verify.js"
import type { Caffeinate } from "./application/ports/caffeinate.js"

// ---------------------------------------------------------------------------
// Clock fake

const fakeClock: Clock = {
  now: () => 0,
  nowIso: () => "00000000-00:00:00.000Z",
}

// ---------------------------------------------------------------------------
// Executor fake

const fakeExecutor: Executor = {
  createSession: async () => "fake-session-id",
  sendMessage: async () => ({ info: { id: "msg", sessionID: "sid" }, parts: [] }),
  listMessages: async () => [],
  deleteSession: async () => {},
}

// ---------------------------------------------------------------------------
// Repo fake

const fakeRepo: Repo = {
  createSandbox: () => {},
  wipCommit: () => undefined,
  amendCommit: () => "deadbeef0000",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => ({}),
  reviewableDiff: () => "",
  reviewableDiffAgainst: () => "",
  fetchBranchFromClone: () => {},
  removeSandbox: () => {},
  headBranch: () => "main",
  branchExists: () => true,
  isCloneSandbox: () => false,
  repoValid: () => true,
  mergeAccept: () => {},
}

// ---------------------------------------------------------------------------
// Store fake

const fakeStore: Store = {
  readMeta: () => ({
    runId: "fake",
    status: "queued",
    attempt: 1,
    repo: "",
    base: "",
    branch: "",
    worktree: "",
    updatedAt: "00000000-00:00:00.000Z",
    stallRetries: 0,
    reorientRetries: 0,
  }),
  readMetaIfExists: () => undefined,
  writeMeta: () => {},
  listRunIds: () => [],
  initialLedger: () => ({ runId: "fake", outcomes: [], updatedAt: "00000000-00:00:00.000Z" }),
  readLedger: () => ({ runId: "fake", outcomes: [], updatedAt: "00000000-00:00:00.000Z" }),
  writeLedger: () => {},
  initialReviewState: () => ({ runId: "fake", obligations: [], updatedAt: "00000000-00:00:00.000Z" }),
  readReviewState: () => ({ runId: "fake", obligations: [], updatedAt: "00000000-00:00:00.000Z" }),
  replaceObligations: () => ({ runId: "fake", obligations: [], updatedAt: "00000000-00:00:00.000Z" }),
  appendDecision: () => {},
  readDecisions: () => [],
  latestCheckpoint: () => undefined,
  writeCheckpoint: () => {},
  nextCheckpointNumber: () => 1,
  readGateState: () => ({
    runId: "fake",
    latched: false,
    firstEditApproved: false,
    reconciliationRequired: false,
    expectedGlobs: [],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    mutationCommandPatterns: [],
    updatedAt: "00000000-00:00:00.000Z",
  }),
  writeGateState: () => {},
  readReport: () => "",
  writeReport: () => {},
  readNits: () => "",
  writeNits: () => {},
  appendConvergence: () => {},
  readConvergence: () => [],
  freezePacket: () => {},
  readFrozenPacket: () => "",
  readActiveRun: () => undefined,
  writeActiveRun: () => {},
  clearActiveRun: () => {},
  readCampaign: () => undefined,
  writeCampaign: () => {},
  listCampaigns: () => [],
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
}

// ---------------------------------------------------------------------------
// Planner fake

const fakePlanner: Planner = {
  handshake: async () => "PLANNER_OK",
  resumeSession: async () => "PLANNER_OK",
  consult: async () => ({ status: "proceed", answer: "proceed", constraints: [], evidence_used: [], safe_next_action: "continue", human_decision_needed: null }),
  finalReview: async () => ({ verdict: "accept", findings: [], notes: "accept", human_decision_needed: null }),
}

// ---------------------------------------------------------------------------
// Reviewer fake

const fakeReviewer: Reviewer = {
  superReview: async () => ({
    review: {
      verdict: "accept",
      findings: [],
      convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
      commit_message: null,
      notes: "",
      human_decision_needed: null,
    },
    raw: "",
  }),
}

// ---------------------------------------------------------------------------
// Verify fake

const fakeVerify: Verify = {
  run: async () => [],
  runAutoFix: async () => {},
}

// ---------------------------------------------------------------------------
// Caffeinate fake

const fakeCaffeinate: Caffeinate = {
  holdPowerAssertion: async () => {},
}
