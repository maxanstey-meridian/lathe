import { equal, ok, deepEqual, rejects } from "node:assert";
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
import type {
  ConvergencePublication,
  RepositoryLease,
  RunTransition,
  Store,
} from "../src/application/ports/store.js";
import type { Verify, VerificationResult } from "../src/application/ports/verify.js";
import { convergeRun } from "../src/application/use-cases/converge-run.js";
import type { Config } from "../src/config/schemas.js";
import type { TurnResponse } from "../src/domain/agent-response.js";
import type { Campaign } from "../src/domain/campaign.js";
import type { ConvergenceOperation } from "../src/domain/convergence.js";
import type { JournalEvent } from "../src/domain/journal.js";
import type { VerificationCommand } from "../src/domain/packet.js";
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

const makeMeta = (overrides: Record<string, unknown> = {}) =>
  ({
    runId: RUN_ID,
    status: "ready_for_review",
    attempt: 1,
    repo: "/tmp/test-repo",
    base: "main",
    branch: "meridian/20260101-000000-converge",
    worktree: "/tmp/test-worktree",
    summary: "converge-run fixture",
    pass: 1,
    stallRetries: 0,
    crashRetries: 0,
    reorientRetries: 0,
    promoted: false,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as RunMeta;

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
    thresholds: { maxPasses: 3, verificationTimeoutMs: 600_000 },
    mutationCommandPatterns: [],
  }) as unknown as Config;

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
  let operation: ConvergenceOperation | undefined;

  const clock = fixedClock();

  return {
    clock,
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
      transitionRun: (transition: RunTransition) => {
        if ((metaStore.revision ?? 0) !== transition.expectedRevision) {
          throw new Error("revision conflict");
        }
        if (!transition.expectedStatuses.includes(metaStore.status)) {
          throw new Error("status conflict");
        }
        metaStore = { ...transition.meta, revision: (metaStore.revision ?? 0) + 1 };
        return metaStore;
      },
      readQueuePacket: (_runId: string) => PACKET_RAW,
      readCampaign: (_campaignId: string) => campaign,
      readConvergenceOperation: () => operation,
      persistConvergenceOperation: (next: ConvergenceOperation) => {
        operation = next;
      },
      publishConvergence: (publication: ConvergencePublication) => {
        onWriteCampaign?.(publication.campaign);
        onAppendJournal?.(RUN_ID, publication.event);
        onAppendConvergence?.(RUN_ID, publication.entry);
        if (publication.nits !== undefined) {
          onWriteNits?.(RUN_ID, publication.nits);
        }
        if (publication.followup) {
          onAdmitQueue?.(publication.followup.runId, publication.followup.raw);
        }
        operation = publication.operation;
        campaign = publication.campaign;
        convergenceStore.push(publication.entry);
        if (publication.nits !== undefined) {
          nitsStore.set(RUN_ID, publication.nits);
        }
        return publication.runTransition
          ? (metaStore = {
              ...publication.runTransition.meta,
              revision: (metaStore.revision ?? 0) + 1,
            })
          : undefined;
      },
      writeCampaign: (c: Campaign) => {
        campaign = c;
        onWriteCampaign?.(c);
      },
      admitQueue: (runId: string, content: string) => {
        onAdmitQueue?.(runId, content);
      },
      admitQueueWithCampaign: (
        runId: string,
        content: string,
        updated: Campaign,
        decision?: { runId: string; event: JournalEvent },
      ) => {
        campaign = updated;
        onAdmitQueue?.(runId, content);
        onWriteCampaign?.(updated);
        if (decision) {
          onAppendJournal?.(decision.runId, decision.event);
        }
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
      listActiveConvergences: () => (activeConvergence ? [activeConvergence] : []),
      addActiveConvergence: (convergence: ActiveConvergence) => {
        activeConvergence = convergence;
      },
      removeActiveConvergence: () => {
        activeConvergence = undefined;
      },
      readReport: () => "",
      acquireRepositoryLease: (repo: string, ownerId: string, runId: string) => ({
        repo,
        ownerId,
        runId,
        purpose: "execute" as const,
        epoch: 1,
        acquiredAt: clock.nowIso(),
        heartbeatAt: clock.nowIso(),
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      heartbeatRepositoryLease: (lease: RepositoryLease) => lease,
      releaseRepositoryLease: () => true,
    } as unknown as Store,
    repo: {
      reviewableDiffAgainst: () => "diff",
      reconciliationGitState: () => ({
        head: "head-before-amend",
        tree: "tree",
        commitMessage: "WIP",
        status: [],
        diffHash: "",
        untracked: [],
        changedFiles: [],
      }),
      amendCommit: () => "amended-sha",
      fetchBranchFromClone: () => {},
      resolveRevision: () => "head-before-amend",
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
    getOperation: () => operation,
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
  });

  await runner(RUN_ID);

  // Campaign should be converged
  ok(campaignWritten, "campaign should be written");
  equal(campaignWritten?.status, "converged");
  equal(campaignWritten?.passes.length, 1);
  equal(campaignWritten?.passes[0]!.runId, RUN_ID);
  equal(campaignWritten?.passes[0]!.pass, 1);

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
  });

  await runner(RUN_ID);

  // Campaign should be open
  ok(campaignWritten, "campaign should be written");
  equal(campaignWritten?.status, "open");
  equal(campaignWritten?.passes.length, 1);
  equal(campaignWritten?.passes[0]!.verdict, "request_changes");

  // Should admit ONE follow-up — super-daddy's AUTHORED intent + engine-stamped lineage.
  equal(admittedQueue.length, 1);
  const [followUpId, followUpContent] = admittedQueue[0]!;
  ok(followUpId.startsWith("20260101-"));
  ok(followUpId.endsWith("-converge-fix2"));

  const parsed = parsePacketShape(followUpContent, followUpId);
  ok(parsed.ok, "admitted packet must parse: " + (parsed.ok ? "" : parsed.problems.join("; ")));
  if (parsed.ok) {
    const fm = parsed.packet.frontmatter;
    // Authored intent survives verbatim — NOT copied from the parent packet.
    equal(fm.summary, "fix the failing typecheck");
    equal(fm.outcomes[0]!.id, "fix-a");
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
  equal(campaignWritten?.passes[0]!.groundedBlockers, 1); // only P0 is grounded

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
  equal(campaignWritten?.passes[0]?.verdict, "escalate");
  equal(campaignWritten?.passes[0]?.proposedVerdict, "request_changes");
  equal(
    (ports.convergenceStore[0] as { decision?: { action?: string } }).decision?.action,
    "escalate",
  );
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
  })(RUN_ID);

  const superReview = journalEvents.find(
    (
      e,
    ): e is {
      event: string;
      verdict: string;
      proposedVerdict: string;
      pass: number;
      findings: string[];
    } => typeof e === "object" && e !== null && (e as { event?: string }).event === "super_review",
  );
  ok(superReview, "a super_review journal event should be emitted");
  equal(
    journalEvents.some(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { event?: string; status?: string }).event === "super_review_status" &&
        (event as { status?: string }).status === "started",
    ),
    true,
    "reviewer start should be durable before the verdict",
  );
  equal(superReview.verdict, "request_changes");
  equal(superReview.proposedVerdict, "request_changes");
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
  });

  await runner(RUN_ID);

  const meta = ports.getMeta();
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "human_decision");
  ok(meta.blockedQuestion, "should have a question");

  ok(campaignWritten, "campaign should be written");
  equal(campaignWritten?.status, "needs_max");
});

test("convergeRun: a publication failure leaves run and campaign unpublished", async () => {
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
          rationale: "operator decision required",
        },
        commit_message: null,
        notes: "",
        human_decision_needed: "choose the recovery policy",
      },
      raw: "escalate",
    },
    undefined,
    undefined,
    () => {
      throw new Error("campaign unavailable");
    },
  );

  await rejects(
    () =>
      convergeRun({
        store: ports.store,
        repo: ports.repo,
        reviewer: ports.reviewer,
        verify: ports.verify,
        clock: ports.clock,
        config: ports.config,
      })(RUN_ID),
    /campaign unavailable/,
  );

  equal(ports.getMeta().status, "ready_for_review");
  equal(ports.getCampaign(), undefined);
});

test("convergeRun: convergence log failure rejects the atomic publication", async () => {
  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => {
      throw new Error("convergence log unavailable");
    },
  );

  await rejects(
    () =>
      convergeRun({
        store: ports.store,
        repo: ports.repo,
        reviewer: ports.reviewer,
        verify: ports.verify,
        clock: ports.clock,
        config: ports.config,
      })(RUN_ID),
    /convergence log unavailable/,
  );

  equal(ports.getCampaign(), undefined);
  equal(ports.getMeta().status, "ready_for_review");
});

test("convergeRun: journal publishes the admitted verdict when an accept proposal is rejected", async () => {
  const journalEvents: Array<Record<string, unknown>> = [];
  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    undefined,
    undefined,
    undefined,
    [{ command: "echo bad", exitCode: 1, outputTail: "bad" }],
    undefined,
    undefined,
    undefined,
    undefined,
    (_runId, event) => journalEvents.push(event as Record<string, unknown>),
  );

  await convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
  })(RUN_ID);

  const event = journalEvents.find((candidate) => candidate.event === "super_review");
  equal(event?.verdict, "escalate");
  equal(event?.proposedVerdict, "accept");
  equal(ports.getCampaign()?.passes[0]?.verdict, "escalate");
  equal(ports.getCampaign()?.passes[0]?.proposedVerdict, "accept");
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
        attempt: 1,
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
  });

  await runner(RUN_ID);

  // Zero side effects — no writes at all
  equal(writeCount, 0);

  // Campaign unchanged
  deepEqual(ports.getCampaign(), existingCampaign);
});

test("convergeRun: same runId new attempt is reviewed again", async () => {
  const existingCampaign: Campaign = {
    campaignId: CAMPAIGN_ID,
    originalRunId: RUN_ID,
    originalIntent: "x",
    status: "needs_max",
    maxPasses: 3,
    passes: [
      {
        runId: RUN_ID,
        attempt: 1,
        pass: 1,
        verdict: "request_changes",
        groundedBlockers: 1,
        atIso: "2026-01-01T00:00:00.000Z",
      },
    ],
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  let convergenceEntries = 0;

  const skillPath = createSkillFile();
  const ports = makeFakePorts(
    skillPath,
    { attempt: 2 },
    existingCampaign,
    undefined,
    undefined,
    undefined,
    undefined,
    () => {
      convergenceEntries++;
    },
  );

  const runner = convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
  });

  await runner(RUN_ID);

  equal(convergenceEntries, 1, "a new attempt for the same run id must be reviewed");
  const campaign = ports.getCampaign();
  ok(campaign, "campaign should be updated");
  equal(campaign?.status, "converged");
  equal(campaign?.passes.length, 1, "new attempt supersedes the stale pass for this run id");
  equal(campaign?.passes[0]!.attempt, 2);
  equal(campaign?.passes[0]!.verdict, "accept");
});

test("convergeRun: resumes a decided operation without repeating verification or review", async () => {
  const skillPath = createSkillFile();
  const ports = makeFakePorts(skillPath);
  let verificationCalls = 0;
  let reviewerCalls = 0;
  ports.verify.run = async () => {
    verificationCalls++;
    return [{ command: "echo ok", exitCode: 0, outputTail: "" }];
  };
  const baseReview = ports.reviewer.superReview;
  ports.reviewer.superReview = async (...args) => {
    reviewerCalls++;
    return baseReview(...args);
  };
  const publish = ports.store.publishConvergence.bind(ports.store);
  let failOnce = true;
  ports.store.publishConvergence = (publication) => {
    if (failOnce) {
      failOnce = false;
      throw new Error("forced publication failure");
    }
    return publish(publication);
  };
  const runner = convergeRun(ports);

  await rejects(() => runner(RUN_ID), /forced publication failure/);
  await runner(RUN_ID);

  equal(verificationCalls, 1);
  equal(reviewerCalls, 1);
  equal(ports.getCampaign()?.status, "converged");
});

test("convergeRun: recovery observes a completed amend instead of replaying it", async () => {
  const ports = makeFakePorts(createSkillFile());
  let head = "head-before-amend";
  let amendCalls = 0;
  ports.repo.reconciliationGitState = () => ({
    head,
    tree: "tree",
    commitMessage: head === "head-after-amend" ? "feat: converged\n\nall good" : "WIP",
    status: [],
    diffHash: "",
    untracked: [],
    changedFiles: [],
  });
  ports.repo.amendCommit = () => {
    amendCalls++;
    head = "head-after-amend";
    throw new Error("simulated crash after git committed the amendment");
  };

  const runner = convergeRun(ports);
  await rejects(() => runner(RUN_ID), /simulated crash/);
  equal(ports.getOperation()?.phase, "amend_started");

  await runner(RUN_ID);
  equal(amendCalls, 1);
  equal(ports.getOperation()?.phase, "published");
  equal(ports.getCampaign()?.status, "converged");
});

test("convergeRun: replays a decided stored follow-up without loading the packet skill or reauthoring", async () => {
  const skillPath = createSkillFile();
  let admittedContent: string | undefined;
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
    (_runId, content) => {
      admittedContent = content;
    },
  );
  const controller = new AbortController();
  const persist = ports.store.persistConvergenceOperation.bind(ports.store);
  ports.store.persistConvergenceOperation = (operation, lease) => {
    persist(operation, lease);
    if (operation.phase === "decided" && operation.followup) {
      controller.abort();
    }
  };
  let authorCalls = 0;
  const authorFollowup = ports.reviewer.authorFollowup;
  ports.reviewer.authorFollowup = async (...args) => {
    authorCalls++;
    return authorFollowup(...args);
  };

  await convergeRun(ports)(RUN_ID, controller.signal);
  const stored = ports.getOperation();
  const storedPacket = stored && "followup" in stored ? stored.followup?.packet : undefined;
  ok(storedPacket);
  equal(admittedContent, undefined);

  ports.config.superdaddy.packetSkillPath = "/does/not/exist/packet-skill.md";
  ports.reviewer.authorFollowup = async () => {
    throw new Error("stored follow-up must not be reauthored");
  };
  await convergeRun(ports)(RUN_ID);

  equal(authorCalls, 1);
  equal(admittedContent, storedPacket);
  equal(ports.getOperation()?.phase, "published");
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
  const journalEvents: Array<Record<string, unknown>> = [];
  const ports = makeFakePorts(
    skillPath,
    { status: "running" as const },
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
    undefined,
    undefined,
    undefined,
    (_runId, event) => journalEvents.push(event as Record<string, unknown>),
  );

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
  });

  await rejects(() => runner(RUN_ID), /reviewer crashed/);

  // Recovery preserves the completed work for an explicit convergence retry.
  const meta = ports.getMeta();
  equal(meta.status, "ready_for_review");
  const failed = journalEvents.find(
    (event) => event.event === "super_review_status" && event.status === "failed",
  );
  equal(failed?.detail, "reviewer crashed");
});

// ---------------------------------------------------------------------------
// Test: one unreachable review parks explicitly without creating a pass

test("convergeRun: one unreachable review parks explicitly without a retry state", async () => {
  const skillPath = createSkillFile();
  const journalEvents: Array<Record<string, unknown>> = [];
  const ports = makeFakePorts(
    skillPath,
    { status: "ready_for_review" as const },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (_runId, event) => journalEvents.push(event as Record<string, unknown>),
  );

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
    reviewer: unreachableReviewer as unknown as Reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
  })(RUN_ID);

  const meta = ports.getMeta();
  equal(meta.status, "blocked");
  equal(meta.blockedReason, "human_decision");
  ok(meta.blockedQuestion?.includes("unreachable"));
  equal(ports.getCampaign(), undefined, "no campaign pass recorded");
  equal(ports.convergenceStore.length, 0, "a transport failure is not a convergence result");
  const statuses = journalEvents.filter((event) => event.event === "super_review_status");
  deepEqual(
    statuses.map((event) => event.status),
    ["started", "failed"],
  );
});

test("convergeRun: cancellation during acceptance review is durable", async () => {
  const skillPath = createSkillFile();
  const journalEvents: Array<Record<string, unknown>> = [];
  const ports = makeFakePorts(
    skillPath,
    { status: "ready_for_review" as const },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (_runId, event) => journalEvents.push(event as Record<string, unknown>),
  );
  const controller = new AbortController();
  const reviewer: Reviewer = {
    superReview: async (...args) => {
      const outcome = await ports.reviewer.superReview(...args);
      controller.abort();
      return outcome;
    },
    authorFollowup: (...args) => ports.reviewer.authorFollowup(...args),
  };

  await convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
  })(RUN_ID, controller.signal);

  const statuses = journalEvents.filter((event) => event.event === "super_review_status");
  deepEqual(
    statuses.map((event) => event.status),
    ["started", "cancelled"],
  );
  equal(
    journalEvents.some((event) => event.event === "super_review"),
    false,
  );
});

test("convergeRun: cancellation after decision prevents publication and is durable", async () => {
  const skillPath = createSkillFile();
  const journalEvents: Array<Record<string, unknown>> = [];
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
        commit_message: null,
        notes: "",
        human_decision_needed: null,
      },
      raw: "accept",
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (_runId, event) => journalEvents.push(event as Record<string, unknown>),
  );
  const controller = new AbortController();
  const persist = ports.store.persistConvergenceOperation.bind(ports.store);
  let publications = 0;
  ports.store.persistConvergenceOperation = (operation, lease) => {
    persist(operation, lease);
    if (operation.phase === "decided") {
      controller.abort();
    }
  };
  ports.store.publishConvergence = () => {
    publications++;
    return undefined;
  };

  await convergeRun(ports)(RUN_ID, controller.signal);

  equal(publications, 0);
  equal(ports.getCampaign(), undefined);
  equal(ports.getMeta().status, "ready_for_review");
  equal(ports.getOperation()?.phase, "decided");
  equal(
    journalEvents.some((event) => event.event === "super_review"),
    false,
  );

  const replayController = new AbortController();
  replayController.abort();
  await convergeRun(ports)(RUN_ID, replayController.signal);

  equal(publications, 0);
  equal(ports.getOperation()?.phase, "decided");
  deepEqual(
    journalEvents
      .filter((event) => event.event === "super_review_status")
      .map((event) => event.status),
    ["started", "cancelled", "cancelled"],
  );
});

test("convergeRun: lease loss stops before amend", async () => {
  const skillPath = createSkillFile();
  const ports = makeFakePorts(skillPath);
  let amendCalls = 0;
  let heartbeats = 0;
  ports.store.heartbeatRepositoryLease = (lease) => (++heartbeats < 5 ? lease : undefined);
  ports.repo.amendCommit = () => {
    amendCalls++;
    return "sha";
  };

  await rejects(() => convergeRun(ports)(RUN_ID), /repository lease lost/);
  equal(amendCalls, 0);
});

test("convergeRun: fences convergence metadata transitions with the current lease", async () => {
  const skillPath = createSkillFile();
  const ports = makeFakePorts(skillPath);
  const lease = ports.store.acquireRepositoryLease("/repo", "worker", RUN_ID, "execute")!;
  const transitionRun = ports.store.transitionRun.bind(ports.store);
  const observed: Array<RepositoryLease | undefined> = [];
  ports.store.transitionRun = (transition) => {
    observed.push(transition.lease);
    return transitionRun(transition);
  };
  ports.reviewer.superReview = async () => ({ kind: "unreachable", detail: "offline", raw: "" });

  await convergeRun(ports)(RUN_ID, undefined, lease);

  deepEqual(observed, [lease]);
  equal(ports.getMeta().status, "blocked");
});

test("convergeRun: cancellation after authorFollowup closes the durable review status", async () => {
  const skillPath = createSkillFile();
  const journalEvents: Array<Record<string, unknown>> = [];
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
    undefined,
    undefined,
    undefined,
    undefined,
    (_runId, event) => journalEvents.push(event as Record<string, unknown>),
  );
  const controller = new AbortController();
  const baseReviewer = ports.reviewer;
  ports.reviewer = {
    superReview: (...args) => baseReviewer.superReview(...args),
    authorFollowup: async (...args) => {
      const authored = await baseReviewer.authorFollowup(...args);
      controller.abort();
      return authored;
    },
  } as Reviewer;

  await convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer: ports.reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
  })(RUN_ID, controller.signal);

  const statuses = journalEvents.filter((event) => event.event === "super_review_status");
  deepEqual(
    statuses.map((event) => event.status),
    ["started", "cancelled"],
  );
});

test("convergeRun: aborted reviewer rejection journals cancellation, not failure", async () => {
  const skillPath = createSkillFile();
  const journalEvents: Array<Record<string, unknown>> = [];
  const ports = makeFakePorts(
    skillPath,
    { status: "ready_for_review" as const },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (_runId, event) => journalEvents.push(event as Record<string, unknown>),
  );
  const controller = new AbortController();
  const reviewer: Reviewer = {
    superReview: async () => {
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    },
    authorFollowup: (...args) => ports.reviewer.authorFollowup(...args),
  };

  await convergeRun({
    store: ports.store,
    repo: ports.repo,
    reviewer,
    verify: ports.verify,
    clock: ports.clock,
    config: ports.config,
  })(RUN_ID, controller.signal);

  const statuses = journalEvents.filter((event) => event.event === "super_review_status");
  deepEqual(
    statuses.map((event) => event.status),
    ["started", "cancelled"],
  );
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
  });

  await runner(RUN_ID);

  // pass = 1 (from frontmatter), maxPasses = 3 → not capped, should author
  ok(campaignWritten, "campaign should be written");
  equal(campaignWritten?.status, "open");
  equal(campaignWritten?.passes.length, 1);
});

// ---------------------------------------------------------------------------
// A human-owned decision is an absolute stop, including at the pass cap. The
// promotion escape hatch applies only when no human decision is required.

test("convergeRun: human decision at the cap + promote enabled → parks for Max", async () => {
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
  });

  await runner(RUN_ID);

  equal(admittedContent, undefined);
  equal(admittedRunId, undefined);
  equal(ports.getMeta().status, "blocked");
  equal(ports.getMeta().blockedReason, "human_decision");
  equal(ports.getCampaign()?.status, "needs_max");
  ok(
    !journalEvents.some((e) => e.event === "driver_note" && (e.note ?? "").includes("PROMOTED")),
    "a human-owned decision must not emit a promoted-pass note",
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
  let storedOperation: ConvergenceOperation | undefined;

  const skillPath = createSkillFile();
  const clock = fixedClock();

  const ports = {
    clock,
    config: defaultConfig(skillPath),
    store: {
      readMeta: () => storedMeta,
      writeMeta: () => {
        metaWrites++;
      },
      readQueuePacket: () => PACKET_RAW,
      readCampaign: () => undefined,
      readConvergenceOperation: () => storedOperation,
      persistConvergenceOperation: (operation: ConvergenceOperation) => {
        storedOperation = operation;
      },
      publishConvergence: (publication: ConvergencePublication) => {
        storedOperation = publication.operation;
        return undefined;
      },
      writeCampaign: () => {},
      admitQueue: () => {},
      appendConvergence: () => {},
      appendJournal: () => {},
      writeNits: () => "",
      readReport: () => "",
      listActiveConvergences: () => [],
      addActiveConvergence: () => {},
      removeActiveConvergence: () => {},
      acquireRepositoryLease: (repo: string, ownerId: string, runId: string) => ({
        repo,
        ownerId,
        runId,
        purpose: "execute",
        epoch: 1,
        acquiredAt: clock.nowIso(),
        heartbeatAt: clock.nowIso(),
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      heartbeatRepositoryLease: (lease: any) => lease,
      releaseRepositoryLease: () => true,
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
  });

  await runner(RUN_ID);

  // Campaign should record pass=1, not attempt=5
  const campaign = ports.getCampaign();
  ok(campaign, "campaign should be written");
  equal(campaign?.passes[0]!.pass, 1);
  equal(campaign?.passes[0]!.attempt, 5);
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
    runAutoFix: async (
      commands: VerificationCommand[],
      expectedSurface: string[],
      _worktree: string,
      _timeoutMs: number,
    ) => {
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
  });

  await runner(RUN_ID);

  // Autofix should have been called exactly once.
  equal(autofixCalls.length, 1);
  const call = autofixCalls[0]!;

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
    runAutoFix: async (
      commands: VerificationCommand[],
      expectedSurface: string[],
      _worktree: string,
      _timeoutMs: number,
    ) => {
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
  });

  await runner(RUN_ID);

  ok(autofixRunCalled, "runAutoFix should have been called");
  equal(autofixCalls.length, 1);
  const call = autofixCalls[0]!;

  // Commands from packet frontmatter.
  equal(call.commands.length, 1);
  equal(call.commands[0]!.command, "oxlint --fix");

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
    runAutoFix: async (
      commands: VerificationCommand[],
      _expectedSurface: string[],
      _worktree: string,
      _timeoutMs: number,
    ) => {
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
  });

  await runner(RUN_ID);

  ok(autofixRunCalled, "runAutoFix should have been called");
  equal(capturedCommands.length, 0, "autofix_commands should be empty from packet");
});

test("convergeRun: ambiguous autofix recovery parks without replay or promotion", async () => {
  const ports = makeFakePorts(createSkillFile());
  let autofixCalls = 0;
  ports.verify.runAutoFix = async () => {
    autofixCalls++;
    throw new Error("crash after autofix effect");
  };

  await rejects(() => convergeRun(ports)(RUN_ID), /crash after autofix effect/);
  equal(ports.getOperation()?.phase, "autofix_started");

  ports.verify.runAutoFix = async () => {
    throw new Error("autofix must not replay");
  };
  await convergeRun(ports)(RUN_ID);

  equal(autofixCalls, 1);
  equal(ports.getOperation()?.phase, "autofix_started");
  equal(ports.getMeta().status, "blocked");
  equal(ports.getMeta().blockedReason, "human_decision");
  ok(ports.getMeta().blockedQuestion?.includes("no durable completion evidence"));
  equal(ports.getCampaign(), undefined);
});

test("convergeRun: follow-up CAS failure stays retryable with the durable ref snapshot", async () => {
  const ports = makeFakePorts(createSkillFile(), undefined, undefined, {
    review: {
      verdict: "request_changes",
      findings: [
        {
          id: "fix",
          severity: "P0",
          title: "fix",
          evidence: ["a.ts:1"],
          grounding: { kind: "command_fail", ref: "test" },
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
  });
  let fetches = 0;
  let sourceSha = "stale";
  ports.repo.resolveRevision = (path) =>
    path === "/tmp/test-worktree" ? "sandbox-tip" : sourceSha;
  ports.repo.fetchBranchFromClone = (_repo, _clone, _branch, expectedOld, expectedNew) => {
    fetches++;
    equal(expectedOld, "stale");
    equal(expectedNew, "sandbox-tip");
    if (fetches === 1) {
      throw new Error("fetch unavailable");
    }
    sourceSha = "sandbox-tip";
  };

  await rejects(() => convergeRun(ports)(RUN_ID), /fetch unavailable/);
  equal(ports.getOperation()?.phase, "decided");
  ok(ports.getOperation() && "followup" in ports.getOperation()!);

  await convergeRun(ports)(RUN_ID);
  equal(fetches, 2);
  equal(ports.getOperation()?.phase, "published");
});

test("convergeRun: replay refuses a ref changed after durable follow-up publication intent", async () => {
  const ports = makeFakePorts(createSkillFile(), undefined, undefined, {
    review: {
      verdict: "request_changes",
      findings: [
        {
          id: "fix",
          severity: "P0",
          title: "fix",
          evidence: ["a.ts:1"],
          grounding: { kind: "command_fail", ref: "test" },
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
  });
  let sourceSha = "stale";
  let fetches = 0;
  ports.repo.resolveRevision = (path) =>
    path === "/tmp/test-worktree" ? "sandbox-tip" : sourceSha;
  ports.repo.fetchBranchFromClone = (_repo, _clone, _branch, expectedOld, expectedNew) => {
    fetches++;
    equal(expectedOld, "stale");
    equal(expectedNew, "sandbox-tip");
    sourceSha = "external-race";
    throw new Error("CAS lost");
  };
  const runner = convergeRun(ports);

  await rejects(() => runner(RUN_ID), /CAS lost/);
  equal(ports.getOperation()?.phase, "decided");
  ok(ports.getOperation() && "followupPublication" in ports.getOperation()!);
  await rejects(() => runner(RUN_ID), /changed from expected stale to external-race/);

  equal(fetches, 1);
  equal(ports.getCampaign(), undefined);
  equal(ports.getOperation()?.phase, "decided");
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
      info: { id: "m", sessionID: SUPER_SESSION, role: "assistant", modelID: "test" },
      parts: [{ type: "text", text: ACCEPT_JSON }],
    }),
    listMessages: async () => [],
    deleteSession: async () => {},
    abortSession: async () => {},
  };
  const reviewer = createReviewer(fakeExecutor, sdModel, 5000);

  let stored: RunMeta = makeMeta({ status: "ready_for_review" as const });
  let metaWrites = 0;
  let storedOperation: ConvergenceOperation | undefined;
  const skillPath = createSkillFile();
  const ports = {
    clock: fixedClock(),
    config: defaultConfig(skillPath),
    store: {
      readMeta: () => stored,
      writeMeta: (m: RunMeta) => {
        stored = m;
        metaWrites++;
      },
      transitionRun: (transition: RunTransition) => {
        stored = { ...transition.meta, revision: (stored.revision ?? 0) + 1 };
        metaWrites++;
        return stored;
      },
      readQueuePacket: () => PACKET_RAW,
      readCampaign: () => undefined,
      readConvergenceOperation: () => storedOperation,
      persistConvergenceOperation: (operation: ConvergenceOperation) => {
        storedOperation = operation;
      },
      publishConvergence: (publication: ConvergencePublication) => {
        storedOperation = publication.operation;
        return undefined;
      },
      writeCampaign: () => {},
      admitQueue: () => {},
      appendConvergence: () => {},
      appendJournal: () => {},
      writeNits: () => "",
      readReport: () => "",
      listActiveConvergences: () => [],
      addActiveConvergence: () => {},
      removeActiveConvergence: () => {},
      acquireRepositoryLease: (repo: string, ownerId: string, runId: string) => ({
        repo,
        ownerId,
        runId,
        purpose: "execute",
        epoch: 1,
        acquiredAt: ports.clock.nowIso(),
        heartbeatAt: ports.clock.nowIso(),
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
      heartbeatRepositoryLease: (lease: RepositoryLease) => lease,
      releaseRepositoryLease: () => true,
    } as unknown as Store,
    repo: {
      reconciliationGitState: () => ({
        head: "head-before-amend",
        tree: "tree",
        commitMessage: "WIP",
        status: [],
        diffHash: "",
        untracked: [],
        changedFiles: [],
      }),
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
