import { equal, ok, deepEqual } from "node:assert";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Executor, ModelConfig } from "../src/application/ports/executor.js";
import type { Repo } from "../src/application/ports/repo.js";
import type {
  Reviewer,
  SuperReviewResult,
  SuperReviewOutcome,
} from "../src/application/ports/reviewer.js";
import type { Store } from "../src/application/ports/store.js";
import type { Verify, VerificationResult } from "../src/application/ports/verify.js";
import { convergeRun } from "../src/application/use-cases/converge-run.js";
import type { Paths } from "../src/config/paths.js";
import { makePaths } from "../src/config/paths.js";
import type { Config } from "../src/config/schemas.js";
import type { TurnResponse } from "../src/domain/agent-response.js";
import type { Campaign } from "../src/domain/campaign.js";
import { parsePacketShape } from "../src/domain/packet.js";
import type { ActiveConvergence, RunMeta } from "../src/domain/run.js";
import { createReviewer } from "../src/infrastructure/opencode/reviewer.js";

// ---------------------------------------------------------------------------
// Shared fixture setup

const RUN_ID = "20260101-000000-converge";
const CAMPAIGN_ID = "converge";

const PACKET_RAW = `---
repo: /tmp/test-repo
base: main
compare_commit: main
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
`;

// What the fake super-daddy "authors" on request_changes: intent fields only,
// no lineage — the engine stamps repo/base/campaign_id/parent_run_id/pass/
// regression_outcomes. Mirrors a real authoring reply (with leading
// narration the extractor must strip).
const AUTHORED_FOLLOWUP = `Here is the follow-up packet:

---
summary: "fix the failing typecheck"
outcomes:
  - id: fix-a
    description: "the a.ts typecheck passes"
expected_surface:
  - "src/a.ts"
verification:
  - command: "pnpm test"
---

# fix the typecheck

Repair the blocker.
`;

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
});

let TS_N = 0;
const fixedClock = (): Clock => ({
  now: () => 1_700_000_000_000 + TS_N++,
  nowIso: () => `2026-01-01T00:00:${String(TS_N++ % 60).padStart(2, "0")}.000Z`,
});

// Create a real temp skill file so readFileSync doesn't throw ENOENT inside
// the try block of convergeRun (line 161). Each test suite gets its own file.
const createSkillFile = (): string => {
  const skillPath = join(tmpdir(), `test-skill-${Date.now()}-${TS_N++}.md`);
  writeFileSync(skillPath, "# Test rubric\n", "utf-8");
  return skillPath;
};

const defaultConfig = (skillPath: string): Config =>
  ({
    stateRoot: "/tmp/lathe-test-state",
    opencode: {},
    daddy: {},
    baby: {},
    superdaddy: {
      skillPath,
      packetSkillPath: skillPath,
      diffCapBytes: 131_072,
    },
    thresholds: { maxPasses: 3, maxReviewerUnreachable: 3, verificationTimeoutMs: 600_000 },
    mutationCommandPatterns: [],
  }) as unknown as Config;

const defaultPaths = (root: string): Paths => makePaths(root);

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
  onAppendJournal?: (runId: string, event: unknown) => void,
) => {
  let metaStore: RunMeta = makeMeta(metaOverrides);
  const nitsStore = new Map<string, string>();
  const convergenceStore = new Array<unknown>();
  let activeConvergence: ActiveConvergence | undefined;
  let campaign: Campaign | undefined = campaignOverride;

  const clock = fixedClock();
  const paths = defaultPaths(tmpdir());

  return {
    clock,
    paths,
    config: defaultConfig(skillPath),
    store: {
      readMeta: (runId: string) => {
        if (runId !== RUN_ID) {
          throw new Error(`unknown runId: ${runId}`);
        }
        return metaStore;
      },
      writeMeta: (m: RunMeta) => {
        metaStore = m;
      },
      readQueuePacket: (_runId: string) => PACKET_RAW,
      readCampaign: (_campaignId: string) => campaign,
      writeCampaign: (c: Campaign) => {
        campaign = c;
        onWriteCampaign?.(c);
      },
      admitQueue: (runId: string, content: string) => {
        onAdmitQueue?.(runId, content);
      },
      appendConvergence: (runId: string, entry: unknown) => {
        convergenceStore.push(entry);
        onAppendConvergence?.(runId, entry);
      },
      appendJournal: (runId: string, event: unknown) => {
        onAppendJournal?.(runId, event);
      },
      writeNits: (runId: string, md: string) => {
        nitsStore.set(runId, md);
        onWriteNits?.(runId, md);
      },
      readActiveConvergence: () => activeConvergence,
      writeActiveConvergence: (convergence: ActiveConvergence) => {
        activeConvergence = convergence;
      },
      clearActiveConvergence: () => {
        activeConvergence = undefined;
      },
      readReport: () => "",
    } as unknown as Store,
    repo: {
      reviewableDiffAgainst: () => "diff",
      amendCommit: () => "amended-sha",
      fetchBranchFromClone: () => {},
    } as unknown as Repo,
    reviewer: {
      superReview: async (): Promise<SuperReviewOutcome> => {
        const reviewed: SuperReviewResult = reviewOverride ?? {
          review: {
            verdict: "accept",
            findings: [],
            convergence: {
              recommend_stop: true,
              profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
              rationale: "",
            },
            commit_message: { subject: "feat: converged", body: "all good" },
            notes: "",
            human_decision_needed: null,
          },
          raw: "ok",
        };
        return { kind: "reviewed", ...reviewed };
      },
      authorFollowup: async () => ({
        kind: "authored",
        content: AUTHORED_FOLLOWUP,
        raw: AUTHORED_FOLLOWUP,
      }),
    } as Reviewer,
    verify: {
      run: async () => verifyOverride ?? [{ command: "echo ok", exitCode: 0, outputTail: "" }],
      runAutoFix: async () => {},
    } as unknown as Verify,
    nitsStore,
    convergenceStore,
    getActiveConvergence: () => activeConvergence,
    getMeta: () => metaStore,
    getCampaign: () => campaign,
  };
};

// ---------------------------------------------------------------------------
// Test: stop — campaign converged, commit amended, campaign status converged

test("convergeRun: stop — amend commit, campaign converged, meta un-parked", async () => {
  let admittedQueue: [string, string][] = [];
  let campaignWritten: Campaign | undefined;
  let nitsWritten: string | undefined;

  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    {
      status: "blocked" as const,
      blockedReason: "human_decision" as const,
      blockedQuestion: "why?",
    },
    undefined,
    {
      review: {
        verdict: "accept",
        findings: [
          {
            id: "nit-1",
            severity: "P2",
            title: "style",
            evidence: [],
            grounding: { kind: "none", ref: "" },
          },
        ],
        convergence: {
          recommend_stop: true,
          profile: { p0: 0, p1: 0, p2: 1, p3: 0 },
          rationale: "ok",
        },
        commit_message: { subject: "feat: converged", body: "done" },
        notes: "",
        human_decision_needed: null,
      },
      raw: "accept",
    },
    undefined,
    (runId, content) => {
      admittedQueue.push([runId, content]);
    },
    (c) => {
      campaignWritten = c;
    },
    undefined,
    (runId, md) => {
      nitsWritten = md;
    },
  );

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  // Campaign should be converged
  ok(campaignWritten, "campaign should be written");
  equal(campaignWritten?.status, "converged");
  equal(campaignWritten?.passes.length, 1);
  equal(campaignWritten?.passes[0].runId, RUN_ID);
  equal(campaignWritten?.passes[0].pass, 1);

  // Meta should be un-parked from blocked → ready_for_review
  const meta = ports.getMeta();
  equal(meta.status, "ready_for_review");
  equal(meta.blockedReason, undefined);
  equal(meta.blockedQuestion, undefined);

  // No queue admission on stop
  equal(admittedQueue.length, 0);

  // Nits should be written (stop → not author, so nits apply)
  ok(nitsWritten, "nits should be written on stop");
  ok(nitsWritten?.includes("nit-1"));

  // Convergence log should have one entry
  equal(ports.convergenceStore.length, 1);
  equal(ports.getActiveConvergence(), undefined);
});

// ---------------------------------------------------------------------------
// Test: stop without commit message — amend skipped, still converged

test("convergeRun: stop without commit_message — amend skipped, still converged", async () => {
  const skillPath = createSkillFile();
  const ports = makeFakePorts(skillPath, undefined, undefined, {
    review: {
      verdict: "accept",
      findings: [],
      convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
      commit_message: null,
      notes: "",
      human_decision_needed: null,
    },
    raw: "accept",
  });

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  const meta = ports.getMeta();
  equal(meta.status, "ready_for_review");
  const campaign = ports.getCampaign();
  ok(campaign, "campaign should be written");
  equal(campaign?.status, "converged");
});

// ---------------------------------------------------------------------------
// Test: author — follow-up admitted, campaign open, priorOutcomes deduped union

test("convergeRun: author — admit follow-up, campaign open, priorOutcomes deduped union", async () => {
  let admittedQueue: [string, string][] = [];
  let campaignWritten: Campaign | undefined;

  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "request_changes",
        findings: [
          {
            id: "fix-a",
            severity: "P0",
            title: "fix a",
            evidence: ["a.ts:1"],
            grounding: { kind: "command_fail", ref: "pnpm test" },
            suggested_outcome_id: "fix-a",
          },
          {
            id: "fix-b",
            severity: "P1",
            title: "fix b",
            evidence: [],
            grounding: { kind: "none", ref: "" },
          },
        ],
        convergence: {
          recommend_stop: false,
          profile: { p0: 1, p1: 1, p2: 0, p3: 0 },
          rationale: "",
        },
        commit_message: null,
        notes: "",
        human_decision_needed: null,
      },
      raw: "request_changes",
    },
    undefined,
    (runId, content) => {
      admittedQueue.push([runId, content]);
    },
    (c) => {
      campaignWritten = c;
    },
  );

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  // Campaign should be open
  ok(campaignWritten, "campaign should be written");
  equal(campaignWritten?.status, "open");
  equal(campaignWritten?.passes.length, 1);
  equal(campaignWritten?.passes[0].verdict, "request_changes");

  // Should admit ONE follow-up — super-daddy's AUTHORED intent + engine-stamped lineage.
  equal(admittedQueue.length, 1);
  const [followUpId, followUpContent] = admittedQueue[0];
  ok(followUpId.startsWith("20260101-"));
  ok(followUpId.endsWith("-converge-fix2"));

  const parsed = parsePacketShape(followUpContent, followUpId);
  ok(parsed.ok, "admitted packet must parse: " + (parsed.ok ? "" : parsed.problems.join("; ")));
  if (parsed.ok) {
    const fm = parsed.packet.frontmatter;
    // Authored intent survives verbatim — NOT copied from the parent packet.
    equal(fm.summary, "fix the failing typecheck");
    equal(fm.outcomes[0].id, "fix-a");
    deepEqual(fm.expected_surface, ["src/a.ts"]);
    // Lineage is stamped by the engine, not authored. With no parent/campaign_id
    // in the packet, the campaign id derives from the run id itself.
    equal(fm.campaign_id, RUN_ID);
    equal(fm.parent_run_id, RUN_ID);
    equal(fm.pass, 2);
    equal(fm.base, "meridian/20260101-000000-converge");
    // Prior outcomes sealed as regressions (none collide with the authored fix).
    const regIds = fm.regression_outcomes.map((o) => o.id).sort();
    deepEqual(regIds, ["prior-outcome", "test-outcome"]);
  }

  // Nits should NOT be written on author path
  // (the fake store doesn't track nits writes separately, so we verify
  //  by checking the reviewer findings have grounded blockers)
  equal(campaignWritten?.passes[0].groundedBlockers, 1); // only P0 is grounded

  // No meta status change on author — stays ready_for_review
  equal(ports.getMeta().status, "ready_for_review");
});

// ---------------------------------------------------------------------------
// Test: author, but super-daddy emits an unadmittable packet → retry once, then park

test("convergeRun: author but the authored packet never admits → one retry, then parks for Max", async () => {
  let admittedQueue: [string, string][] = [];
  let campaignWritten: Campaign | undefined;

  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "request_changes",
        findings: [
          {
            id: "fix-a",
            severity: "P0",
            title: "fix a",
            evidence: ["a.ts:1"],
            grounding: { kind: "command_fail", ref: "pnpm test" },
          },
        ],
        convergence: {
          recommend_stop: false,
          profile: { p0: 1, p1: 0, p2: 0, p3: 0 },
          rationale: "",
        },
        commit_message: null,
        notes: "",
        human_decision_needed: null,
      },
      raw: "request_changes",
    },
    undefined,
    (runId, content) => {
      admittedQueue.push([runId, content]);
    },
    (c) => {
      campaignWritten = c;
    },
  );

  // super-daddy returns prose with no packet — unadmittable on both tries.
  let authorCalls = 0;
  ports.reviewer = {
    superReview: ports.reviewer.superReview,
    authorFollowup: async () => {
      authorCalls++;
      return { kind: "authored", content: "I could not produce a packet, sorry.", raw: "x" };
    },
  } as Reviewer;

  await convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })(RUN_ID);

  // One retry feeding back the admission problems, then give up.
  equal(authorCalls, 2);
  // Nothing admitted — the malformed packet never reaches the queue.
  equal(admittedQueue.length, 0);
  // Parked for Max with the cause, not silently stalled.
  const meta = ports.getMeta();
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "human_decision");
  ok(meta.blockedQuestion?.includes("could not author an admittable"));
  ok(campaignWritten, "campaign should be written");
  equal(campaignWritten?.status, "needs_max");
});

test("convergeRun: emits a super_review journal event with verdict + rendered findings (tail visibility)", async () => {
  const journalEvents: unknown[] = [];
  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "request_changes",
        findings: [
          {
            id: "fix-a",
            severity: "P0",
            title: "fix a",
            evidence: ["a.ts:1"],
            grounding: { kind: "command_fail", ref: "pnpm test" },
            suggested_outcome_id: "fix-a",
          },
          {
            id: "fix-b",
            severity: "P1",
            title: "fix b",
            evidence: [],
            grounding: { kind: "none", ref: "" },
          },
        ],
        convergence: {
          recommend_stop: false,
          profile: { p0: 1, p1: 1, p2: 0, p3: 0 },
          rationale: "",
        },
        commit_message: null,
        notes: "",
        human_decision_needed: null,
      },
      raw: "request_changes",
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (_runId, event) => {
      journalEvents.push(event);
    },
  );

  await convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })(RUN_ID);

  const superReview = journalEvents.find(
    (e): e is { event: string; verdict: string; pass: number; findings: string[] } =>
      typeof e === "object" && e !== null && (e as { event?: string }).event === "super_review",
  );
  ok(superReview, "a super_review journal event should be emitted");
  equal(superReview.verdict, "request_changes");
  equal(superReview.pass, 1);
  // ungrounded findings carry no marker; grounded ones append ⟨kind⟩
  deepEqual(superReview.findings, ["[P0] fix a ⟨command_fail⟩", "[P1] fix b"]);
});

// ---------------------------------------------------------------------------
// Test: escalate — meta parked as blocked/human_decision

test("convergeRun: escalate — meta blocked, campaign needs_max", async () => {
  let campaignWritten: Campaign | undefined;

  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "escalate",
        findings: [],
        convergence: {
          recommend_stop: false,
          profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
          rationale: "",
        },
        commit_message: null,
        notes: "",
        human_decision_needed: "needs a call",
      },
      raw: "escalate",
    },
    undefined,
    undefined,
    (c) => {
      campaignWritten = c;
    },
  );

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  const meta = ports.getMeta();
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "human_decision");
  ok(meta.blockedQuestion, "should have a question");

  ok(campaignWritten, "campaign should be written");
  equal(campaignWritten?.status, "needs_max");
});

// ---------------------------------------------------------------------------
// Test: alreadyReviewed — pure early return, zero side effects

test("convergeRun: alreadyReviewed — pure early return", async () => {
  const existingCampaign: Campaign = {
    campaignId: CAMPAIGN_ID,
    originalRunId: RUN_ID,
    originalIntent: "x",
    status: "converged",
    maxPasses: 3,
    passes: [
      {
        runId: RUN_ID,
        pass: 1,
        verdict: "accept",
        groundedBlockers: 0,
        atIso: "2026-01-01T00:00:00.000Z",
      },
    ],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  let writeCount = 0;
  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    undefined,
    existingCampaign,
    {
      review: {
        verdict: "accept",
        findings: [],
        convergence: {
          recommend_stop: true,
          profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
          rationale: "",
        },
        commit_message: { subject: "noop", body: "" },
        notes: "",
        human_decision_needed: null,
      },
      raw: "ok",
    },
    undefined,
    () => {
      writeCount++;
    },
    () => {
      writeCount++;
    },
    () => {
      writeCount++;
    },
  );

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  // Zero side effects — no writes at all
  equal(writeCount, 0);

  // Campaign unchanged
  deepEqual(ports.getCampaign(), existingCampaign);
});

// ---------------------------------------------------------------------------
// Test: verification red + accept → escalate (under-reported)

test("convergeRun: accept + red verification → escalate", async () => {
  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "accept",
        findings: [],
        convergence: {
          recommend_stop: true,
          profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
          rationale: "",
        },
        commit_message: { subject: "ok", body: "" },
        notes: "",
        human_decision_needed: null,
      },
      raw: "accept",
    },
    [
      { command: "echo ok", exitCode: 0, outputTail: "" },
      { command: "pnpm test", exitCode: 1, outputTail: "FAIL" },
    ],
  );

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  const meta = ports.getMeta();
  equal(meta.status, "blocked");
  ok(meta.blockedQuestion?.includes("under-reported"));

  const campaign = ports.getCampaign();
  ok(campaign, "campaign should be written");
  equal(campaign?.status, "needs_max");
});

// ---------------------------------------------------------------------------
// Test: fail-safe — any error leaves ready_for_review

test("convergeRun: failure → meta reset to ready_for_review", async () => {
  const skillPath = createSkillFile();
  const ports = makeFakePorts(skillPath, { status: "running" as const }, undefined, {
    review: {
      verdict: "accept",
      findings: [],
      convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
      commit_message: { subject: "ok", body: "" },
      notes: "",
      human_decision_needed: null,
    },
    raw: "ok",
  });

  // Make the reviewer throw to trigger fail-safe
  const failingReviewer = {
    superReview: async () => {
      throw new Error("reviewer crashed");
    },
  };

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: failingReviewer as any,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  // Fail-safe: meta reset to ready_for_review
  const meta = ports.getMeta();
  equal(meta.status, "ready_for_review");
});

// ---------------------------------------------------------------------------
// Test: super-daddy unreachable BELOW budget → retryable, no pass recorded

test("convergeRun: unreachable below budget → counter bumped, no pass, stays retryable", async () => {
  const skillPath = createSkillFile();
  const ports = makeFakePorts(skillPath, { status: "ready_for_review" as const });

  const unreachableReviewer = {
    superReview: async (): Promise<SuperReviewOutcome> => ({
      kind: "unreachable",
      detail: "Connection dropped: socket hang up",
      raw: "«reviewer unreachable»: socket hang up",
    }),
  };

  await convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: unreachableReviewer as Reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })(RUN_ID);

  const meta = ports.getMeta();
  // Run stays where it was (retryable) — a non-result must not park or converge.
  equal(meta.status, "ready_for_review", "stays ready_for_review for the next retry");
  equal(meta.reviewerUnreachable, 1, "consecutive-unreachable counter bumped");
  // NEVER record a campaign pass — that is what makes a retry a no-op.
  equal(ports.getCampaign(), undefined, "no campaign pass recorded");
  // Logged honestly as unreachable, not a forged verdict.
  equal(ports.convergenceStore.length, 1);
  const entry = ports.convergenceStore[0] as { kind: string; attempt: number; detail: string };
  equal(entry.kind, "unreachable");
  equal(entry.attempt, 1);
});

// ---------------------------------------------------------------------------
// Test: super-daddy unreachable AT budget → park for Max, counter reset, no pass

test("convergeRun: unreachable at budget → parks blocked, resets counter, no pass", async () => {
  const skillPath = createSkillFile();
  // budget = 3 (defaultConfig); start at 2 so this attempt is the 3rd.
  const ports = makeFakePorts(skillPath, {
    status: "ready_for_review" as const,
    reviewerUnreachable: 2,
  });

  const unreachableReviewer = {
    superReview: async (): Promise<SuperReviewOutcome> => ({
      kind: "unreachable",
      detail: "Connection dropped: socket hang up",
      raw: "x",
    }),
  };

  await convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: unreachableReviewer as Reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  })(RUN_ID);

  const meta = ports.getMeta();
  equal(meta.status, "blocked", "durable unreachable parks for Max");
  equal(meta.blockedReason, "human_decision");
  ok(meta.blockedQuestion?.includes("unreachable"), "park message names the cause");
  equal(meta.reviewerUnreachable, 0, "counter reset so a manual re-run starts fresh");
  // Still no campaign pass — a manual converge after fixing the connection works.
  equal(ports.getCampaign(), undefined, "no campaign pass recorded even at budget");
  const entry = ports.convergenceStore[0] as { kind: string; attempt: number };
  equal(entry.kind, "unreachable");
  equal(entry.attempt, 3);
});

// ---------------------------------------------------------------------------
// Test: pass cap reached → escalate

test("convergeRun: pass cap reached → escalate", async () => {
  let campaignWritten: Campaign | undefined;

  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    { attempt: 5 }, // meta.attempt = 5, pass = 1 from frontmatter
    undefined,
    {
      review: {
        verdict: "request_changes",
        findings: [
          {
            id: "still-broken",
            severity: "P0",
            title: "still broken",
            evidence: [],
            grounding: { kind: "command_fail", ref: "t" },
          },
        ],
        convergence: {
          recommend_stop: false,
          profile: { p0: 1, p1: 0, p2: 0, p3: 0 },
          rationale: "",
        },
        commit_message: null,
        notes: "",
        human_decision_needed: null,
      },
      raw: "rc",
    },
    undefined,
    undefined,
    (c) => {
      campaignWritten = c;
    },
  );

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  // pass = 1 (from frontmatter), maxPasses = 3 → not capped, should author
  ok(campaignWritten, "campaign should be written");
  equal(campaignWritten?.status, "open");
  equal(campaignWritten?.passes.length, 1);
});

// ---------------------------------------------------------------------------
// Test: the reported bug — ESCALATE at the pass cap promotes instead of parking.
// Run 20260625-142532-lathe-http-surface-fix3 parked here; it must now author a
// PROMOTED follow-up (Baby's harness on Daddy's model) for one last attempt.

test("convergeRun: escalate at the cap + promote enabled → authored follow-up is PROMOTED", async () => {
  let admittedRunId: string | undefined;
  let admittedContent: string | undefined;
  const journalEvents: { event: string; note?: string }[] = [];

  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    {}, // fresh meta: not previously promoted
    undefined,
    {
      review: {
        verdict: "escalate",
        findings: [
          {
            id: "still-broken",
            severity: "P0",
            title: "still broken",
            evidence: [],
            grounding: { kind: "command_fail", ref: "t" },
          },
        ],
        convergence: {
          recommend_stop: false,
          profile: { p0: 1, p1: 0, p2: 0, p3: 0 },
          rationale: "",
        },
        commit_message: null,
        notes: "",
        human_decision_needed: "restore the checker or waive it",
      },
      raw: "esc",
    },
    undefined,
    (runId, content) => {
      admittedRunId = runId;
      admittedContent = content;
    },
    undefined,
    undefined,
    undefined,
    (_runId, event) => {
      journalEvents.push(event as { event: string; note?: string });
    },
  );

  // pass(1) >= maxPasses(1) → at the cap, with the promotion escape hatch enabled.
  const thresholds = ports.config.thresholds as { maxPasses: number; promoteAtCap: boolean };
  thresholds.maxPasses = 1;
  thresholds.promoteAtCap = true;

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  ok(admittedContent, "a promoted follow-up must be admitted, not parked");
  const parsed = parsePacketShape(admittedContent ?? "", admittedRunId);
  ok(parsed.ok, "admitted packet must parse: " + (parsed.ok ? "" : parsed.problems.join("; ")));
  if (!parsed.ok) {
    return;
  }
  equal(parsed.packet.frontmatter.promoted, true);
  ok(
    journalEvents.some((e) => e.event === "driver_note" && (e.note ?? "").includes("PROMOTED")),
    "the promoted pass must be surfaced in the journal for the tail",
  );
});

test("convergeRun: escalate at the cap when ALREADY promoted → parks (no second promotion)", async () => {
  let admitted = false;
  let blockedMeta: RunMeta | undefined;

  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    {}, // meta; the ALREADY-promoted signal comes from the packet, not meta
    undefined,
    {
      review: {
        verdict: "escalate",
        findings: [
          {
            id: "still-broken",
            severity: "P0",
            title: "still broken",
            evidence: [],
            grounding: { kind: "command_fail", ref: "t" },
          },
        ],
        convergence: {
          recommend_stop: false,
          profile: { p0: 1, p1: 0, p2: 0, p3: 0 },
          rationale: "",
        },
        commit_message: null,
        notes: "",
        human_decision_needed: "restore the checker or waive it",
      },
      raw: "esc",
    },
    undefined,
    () => {
      admitted = true;
    },
  );

  const thresholds = ports.config.thresholds as { maxPasses: number; promoteAtCap: boolean };
  thresholds.maxPasses = 1;
  thresholds.promoteAtCap = true;
  // This run IS the promoted pass — its live packet carries promoted: true.
  ports.store.readQueuePacket = () => PACKET_RAW.replace("pass: 1", "pass: 1\npromoted: true");

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  blockedMeta = ports.getMeta();
  equal(admitted, false, "a promoted pass that fails again must NOT promote a second time");
  equal(blockedMeta?.status, "blocked");
});

// ---------------------------------------------------------------------------
// Test: request_changes with no findings → escalate

test("convergeRun: request_changes but zero findings → escalate", async () => {
  const skillPath = createSkillFile();
  const ports = makeFakePorts(skillPath, undefined, undefined, {
    review: {
      verdict: "request_changes",
      findings: [],
      convergence: {
        recommend_stop: false,
        profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
        rationale: "",
      },
      commit_message: null,
      notes: "",
      human_decision_needed: null,
    },
    raw: "rc",
  });

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  const meta = ports.getMeta();
  equal(meta.status, "blocked");
  ok(meta.blockedQuestion?.includes("named no findings"));
});

// ---------------------------------------------------------------------------
// Test: stop on meta already ready_for_review — no writeMeta call needed

test("convergeRun: stop with meta already ready_for_review — no unnecessary write", async () => {
  let metaWrites = 0;
  const originalMeta = makeMeta({ status: "ready_for_review" as const });
  const storedMeta = { ...originalMeta };

  const skillPath = createSkillFile();
  const clock = fixedClock();
  const paths = defaultPaths(tmpdir());

  const ports = {
    clock,
    paths,
    config: defaultConfig(skillPath),
    store: {
      readMeta: () => storedMeta,
      writeMeta: () => {
        metaWrites++;
      },
      readQueuePacket: () => PACKET_RAW,
      readCampaign: () => undefined,
      writeCampaign: () => {},
      admitQueue: () => {},
      appendConvergence: () => {},
      appendJournal: () => {},
      writeNits: () => "",
      readReport: () => "",
      readActiveConvergence: () => undefined,
      writeActiveConvergence: () => {},
      clearActiveConvergence: () => {},
    } as unknown as Store,
    repo: {
      reviewableDiffAgainst: () => "diff",
      amendCommit: () => "sha",
      fetchBranchFromClone: () => {},
    } as unknown as Repo,
    reviewer: {
      superReview: async (): Promise<SuperReviewOutcome> => ({
        kind: "reviewed",
        review: {
          verdict: "accept",
          findings: [],
          convergence: {
            recommend_stop: true,
            profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
            rationale: "",
          },
          commit_message: null,
          notes: "",
          human_decision_needed: null,
        },
        raw: "ok",
      }),
    } as any,
    verify: {
      run: async () => [{ command: "true", exitCode: 0, outputTail: "" }],
      runAutoFix: async () => {},
    } as unknown as Verify,
  };

  const runner = convergeRun(ports);
  await runner(RUN_ID);

  // Should NOT have written meta when status was already ready_for_review
  equal(metaWrites, 0);
});

// ---------------------------------------------------------------------------
// Test: pass from packet.frontmatter.pass, not meta.attempt

test("convergeRun: pass from packet.frontmatter.pass, not meta.attempt", async () => {
  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    { attempt: 5 }, // meta.attempt = 5, but pass = 1 from packet
    undefined,
    {
      review: {
        verdict: "accept",
        findings: [],
        convergence: {
          recommend_stop: true,
          profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
          rationale: "",
        },
        commit_message: { subject: "ok", body: "" },
        notes: "",
        human_decision_needed: null,
      },
      raw: "ok",
    },
  );

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  // Campaign should record pass=1, not attempt=5
  const campaign = ports.getCampaign();
  ok(campaign, "campaign should be written");
  equal(campaign?.passes[0].pass, 1);
});

// ---------------------------------------------------------------------------
// Test: stop with maxPasses: 1 and pass: 1 → capped, not stopped

test("convergeRun: stop on pass cap (maxPasses=1, pass=1) → should stop if accept+green", async () => {
  let campaignWritten: Campaign | undefined;

  const skillPath = createSkillFile();
  const config = {
    ...defaultConfig(skillPath),
    thresholds: { maxPasses: 1, verificationTimeoutMs: 600_000 },
  } as unknown as Config;

  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    {
      review: {
        verdict: "accept",
        findings: [],
        convergence: {
          recommend_stop: true,
          profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
          rationale: "",
        },
        commit_message: { subject: "ok", body: "" },
        notes: "",
        human_decision_needed: null,
      },
      raw: "ok",
    },
    undefined,
    undefined,
    (c) => {
      campaignWritten = c;
    },
    undefined,
    undefined,
  );

  ports.config = config;

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  // pass=1, maxPasses=1, accept+green → stop (cap is pass >= maxPasses,
  // but accept+green is stop before cap check in decideConvergence)
  ok(campaignWritten, "campaign should be written");
  equal(campaignWritten?.status, "converged");
});

// ---------------------------------------------------------------------------
// Test: autofix runs with expected_surface, not repo-wide

test("convergeRun: autofix is called with expected_surface, not repo-wide", async () => {
  let autofixCalls: { commands: { command: string }[]; surface: string[] }[] = [];

  const skillPath = createSkillFile();
  const ports = makeFakePorts(skillPath, undefined, undefined, {
    review: {
      verdict: "accept",
      findings: [],
      convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
      commit_message: { subject: "ok", body: "" },
      notes: "",
      human_decision_needed: null,
    },
    raw: "ok",
  });

  // Override the verify port with a spy that captures runAutoFix calls.
  const originalVerify = ports.verify;
  ports.verify = {
    ...originalVerify,
    runAutoFix: async (commands, expectedSurface, _worktree, _timeoutMs) => {
      autofixCalls.push({ commands, surface: expectedSurface });
    },
  } as any;

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  // Autofix should have been called exactly once.
  equal(autofixCalls.length, 1);
  const call = autofixCalls[0];

  // The surface should be exactly what's in the packet.
  deepEqual(call.surface, ["src/index.ts"]);

  // No autofix_commands in the packet, so empty commands list.
  equal(call.commands.length, 0);
});

// ---------------------------------------------------------------------------
// Test: autofix with commands and surface passes surface as args

test("convergeRun: autofix with commands runs with expected_surface args", async () => {
  let autofixCalls: { commands: { command: string }[]; surface: string[] }[] = [];
  let autofixRunCalled = false;

  const skillPath = createSkillFile();

  // Create a packet with autofix_commands.
  const PACKET_WITH_AUTOFIX = `---
repo: /tmp/test-repo
base: main
compare_commit: main
summary: converge-run fixture
outcomes:
  - id: test-outcome
    description: A test outcome
expected_surface:
  - src/index.ts
  - src/utils/*.ts
verification:
  - command: echo ok
autofix_commands:
  - command: oxlint --fix
constraints:
  - keep it clean
pass: 1
regression_outcomes:
  - id: prior-outcome
    description: a prior outcome
---

body
`;

  const ports = makeFakePorts(skillPath, undefined, undefined, {
    review: {
      verdict: "accept",
      findings: [],
      convergence: {
        recommend_stop: true,
        profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
        rationale: "",
      },
      commit_message: { subject: "ok", body: "" },
      notes: "",
      human_decision_needed: null,
    },
    raw: "ok",
  });

  // Override readQueuePacket to return the packet with autofix.
  (ports.store as any).readQueuePacket = () => PACKET_WITH_AUTOFIX;

  ports.verify = {
    ...ports.verify,
    runAutoFix: async (commands, expectedSurface, _worktree, _timeoutMs) => {
      autofixRunCalled = true;
      autofixCalls.push({ commands, surface: expectedSurface });
    },
  } as any;

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  ok(autofixRunCalled, "runAutoFix should have been called");
  equal(autofixCalls.length, 1);
  const call = autofixCalls[0];

  // Commands from packet frontmatter.
  equal(call.commands.length, 1);
  equal(call.commands[0].command, "oxlint --fix");

  // Surface from packet frontmatter.
  deepEqual(call.surface, ["src/index.ts", "src/utils/*.ts"]);
});

// ---------------------------------------------------------------------------
// Test: no autofix_commands → runAutoFix is still called but no-op

test("convergeRun: empty autofix_commands → runAutoFix called with empty commands", async () => {
  let autofixRunCalled = false;
  let capturedCommands: { command: string }[] = [];

  const skillPath = createSkillFile();
  const ports = makeFakePorts(skillPath, undefined, undefined, {
    review: {
      verdict: "accept",
      findings: [],
      convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
      commit_message: { subject: "ok", body: "" },
      notes: "",
      human_decision_needed: null,
    },
    raw: "ok",
  });

  ports.verify = {
    ...ports.verify,
    runAutoFix: async (commands, _expectedSurface, _worktree, _timeoutMs) => {
      autofixRunCalled = true;
      capturedCommands = commands;
    },
  } as any;

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
    paths: ports.paths,
  });

  await runner(RUN_ID);

  ok(autofixRunCalled, "runAutoFix should have been called");
  equal(capturedCommands.length, 0, "autofix_commands should be empty from packet");
});

// ---------------------------------------------------------------------------
// Integration: the REAL reviewer adapter invokes onSessionBound, converge-run's
// callback writes reviewerSessionId into meta, and it SURVIVES the post-review
// meta writes (the refresh-after-review prevents clobbering). This is the live-
// streaming contract for `lathe tail`'s super-daddy pane — verified against the
// actual adapter + use case, not a fake.

test("convergeRun: records reviewerSessionId from the real adapter and preserves it post-review", async () => {
  const SUPER_SESSION = "super-daddy-session-42";
  const sdModel: ModelConfig = { providerId: "openai", modelId: "gpt-5.5", agent: "superdaddy" };
  const ACCEPT_JSON =
    '{"verdict":"accept","findings":[],"convergence":{"recommend_stop":true,"profile":{"p0":0,"p1":0,"p2":0,"p3":0},"rationale":"ok"},"commit_message":{"subject":"feat: x","body":""},"notes":"","human_decision_needed":null}';

  // Real adapter, fake executor: createSession returns the known session id;
  // sendMessage returns a parseable accept; listMessages empty → harvest falls
  // back to the sendMessage text.
  const fakeExecutor: Executor = {
    createSession: async () => SUPER_SESSION,
    sendMessage: async (): Promise<TurnResponse> => ({
      info: { id: "m", sessionID: SUPER_SESSION, role: "assistant", model: "test" },
      parts: [{ type: "text", text: ACCEPT_JSON }],
    }),
    listMessages: async () => [],
    deleteSession: async () => {},
  };
  const reviewer = createReviewer(fakeExecutor, sdModel, 5000, 1);

  let stored: RunMeta = makeMeta({ status: "ready_for_review" as const });
  let metaWrites = 0;
  const skillPath = createSkillFile();
  const ports = {
    clock: fixedClock(),
    paths: defaultPaths(tmpdir()),
    config: defaultConfig(skillPath),
    store: {
      readMeta: () => stored,
      writeMeta: (m: RunMeta) => {
        stored = m;
        metaWrites++;
      },
      readQueuePacket: () => PACKET_RAW,
      readCampaign: () => undefined,
      writeCampaign: () => {},
      admitQueue: () => {},
      appendConvergence: () => {},
      appendJournal: () => {},
      writeNits: () => "",
      readReport: () => "",
      readActiveConvergence: () => undefined,
      writeActiveConvergence: () => {},
      clearActiveConvergence: () => {},
    } as unknown as Store,
    repo: {
      amendCommit: () => "sha",
      fetchBranchFromClone: () => {},
    } as unknown as Repo,
    reviewer,
    verify: {
      run: async () => [{ command: "echo ok", exitCode: 0, outputTail: "" }],
      runAutoFix: async () => {},
    } as unknown as Verify,
  };

  await convergeRun(ports)(RUN_ID);

  // The real adapter's onSessionBound fired → converge-run wrote the session id.
  equal(
    stored.reviewerSessionId,
    SUPER_SESSION,
    "reviewerSessionId recorded from the real adapter",
  );
  // And it survived the post-review stop-branch meta writes (no clobber).
  ok(metaWrites >= 1, "meta was written");
  ok(
    stored.reviewerSessionId === SUPER_SESSION,
    "reviewerSessionId preserved through the stop decision's writes",
  );
});
