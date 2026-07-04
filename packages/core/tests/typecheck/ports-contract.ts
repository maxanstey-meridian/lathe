// Compile-time port contract checks.
//
// These structural fakes prove each application port can be implemented as a
// plain object with no casts. They are intentionally not imported by runtime
// code; `tsc -p tsconfig.typecheck.json` typechecks this file to catch port
// drift when a port method is added, removed, or reshaped.

import type { Caffeinate } from "../../src/application/ports/caffeinate.js";
import type { Clock } from "../../src/application/ports/clock.js";
import type { Executor } from "../../src/application/ports/executor.js";
import type { Planner } from "../../src/application/ports/planner.js";
import type { Repo } from "../../src/application/ports/repo.js";
import type { Reviewer } from "../../src/application/ports/reviewer.js";
import type { Store } from "../../src/application/ports/store.js";
import type { Verify } from "../../src/application/ports/verify.js";

const _clockContract: Clock = {
  now: () => 0,
  nowIso: () => "00000000-00:00:00.000Z",
};

const _executorContract: Executor = {
  createSession: async () => "fake-session-id",
  sendMessage: async () => ({ info: { id: "msg", sessionID: "sid" }, parts: [] }),
  listMessages: async () => [],
  abortSession: async () => {},
  deleteSession: async () => {},
};

const _repoContract: Repo = {
  createSandbox: () => {},
  wipCommit: () => undefined,
  amendCommit: () => "deadbeef0000",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => ({}),
  reviewableDiff: () => "",
  reviewableDiffAgainst: () => "",
  reconciliationGitState: () => ({
    head: "head",
    status: [],
    diffHash: "diff",
    untracked: [],
    changedFiles: [],
  }),
  fetchBranchFromClone: () => {},
  removeSandbox: () => {},
  headBranch: () => "main",
  branchExists: () => true,
  repoValid: () => true,
  mergeAccept: () => {},
};

const _storeContract: Store = {
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
    crashRetries: 0,
    reorientRetries: 0,
    reviewerUnreachable: 0,
    promoted: false,
  }),
  readMetaIfExists: () => undefined,
  writeMeta: () => {},
  listRunIds: () => [],
  listMeta: () => [],
  initialLedger: () => ({ runId: "fake", outcomes: [], updatedAt: "00000000-00:00:00.000Z" }),
  readLedger: () => ({ runId: "fake", outcomes: [], updatedAt: "00000000-00:00:00.000Z" }),
  writeLedger: () => {},
  initialReviewState: () => ({
    runId: "fake",
    obligations: [],
    updatedAt: "00000000-00:00:00.000Z",
  }),
  readReviewState: () => ({ runId: "fake", obligations: [], updatedAt: "00000000-00:00:00.000Z" }),
  replaceObligations: () => ({
    runId: "fake",
    obligations: [],
    updatedAt: "00000000-00:00:00.000Z",
  }),
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
    updatedAt: "00000000-00:00:00.000Z",
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
  readJournalSince: () => [],
  clearResumeArtifacts: () => {},
};

const _plannerContract: Planner = {
  handshake: async () => "PLANNER_OK",
  resumeSession: async () => "PLANNER_OK",
  consult: async () => ({
    status: "proceed",
    answer: "proceed",
    constraints: [],
    evidence_used: [],
    safe_next_action: "continue",
    human_decision_needed: null,
  }),
  finalReview: async () => ({
    verdict: "accept",
    findings: [],
    notes: "accept",
    human_decision_needed: null,
  }),
};

const _reviewerContract: Reviewer = {
  superReview: async () => ({
    kind: "reviewed",
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
  authorFollowup: async () => ({ kind: "authored", content: "", raw: "" }),
};

const _verifyContract: Verify = {
  run: async () => [],
  runAutoFix: async () => {},
};

const _caffeinateContract: Caffeinate = {
  holdPowerAssertion: async () => {},
};
