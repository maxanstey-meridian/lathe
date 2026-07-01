import { doesNotMatch, match, strictEqual } from "node:assert";
import { describe, it } from "node:test";
import type {
  Packet,
  OutcomeLedger,
  Checkpoint,
  ReviewState,
  Decision,
  PlannerResponse,
  SubmitReport,
} from "../src/domain/index.js";
import {
  q1InitialSeed,
  q2RotationSeed,
  q3Continue,
  q4CheckpointDemand,
  q5TeardownDemand,
  q6ReportProperly,
  q7ReportRejected,
  q8ReconciliationSeed,
  qReorientSeed,
  softCheckpointNudge,
  ladderNudge,
  qPlannerDecision,
  qPlannerUnavailable,
  renderDaddySeed,
  renderPlannerQuestion,
  renderSuperReview,
  renderFinalReview,
  type SuperReviewInput,
} from "../src/domain/prompts.js";

const minPacket = (): Packet => ({
  runId: "20260618-070000-test",
  frontmatter: {
    repo: "test/repo",
    base: "main",
    compare_commit: "main",
    outcomes: [{ id: "test-outcome", description: "a test outcome" }],
    expected_surface: ["src/**"],
    verification: [{ command: "pnpm test" }],
    constraints: [],
  },
  body: "",
  raw: "---\nrepo: test/repo\n---\ntest body",
});

const minLedger = (runId = "20260618-070000-test"): OutcomeLedger => ({
  runId,
  outcomes: [
    {
      id: "test-outcome",
      description: "a test outcome",
      status: "not_started",
      evidence: [],
      updatedAt: "2026-06-18T00:00:00.000Z",
    },
  ],
  updatedAt: "2026-06-18T00:00:00.000Z",
});

const minCheckpoint = (): Checkpoint => ({
  number: 1,
  reason: "rotation",
  summary: "halfway through",
  outcomes: [{ id: "test-outcome", status: "in_progress", evidence: [], nextAction: "next step" }],
  filesChanged: [],
  filesInspected: [],
  uncertainties: ["some uncertainty"],
  writtenAt: "2026-06-18T00:00:00.000Z",
});

const minReview = (): ReviewState => ({
  runId: "20260618-070000-test",
  obligations: ["follow constraint A"],
  updatedAt: "2026-06-18T00:00:00.000Z",
});

const minDecisions = (): Decision[] => [];

const minPlanner = (): PlannerResponse => ({
  status: "proceed",
  answer: "proceed with the implementation",
  constraints: [],
  evidence_used: ["reference file"],
  safe_next_action: "write the file",
  human_decision_needed: null,
});

const minReport = (): SubmitReport => ({
  status: "ready_for_review",
  summary: "done",
  outcomeClaims: [{ id: "test-outcome", status: "done" }],
  filesChanged: [],
  behaviourChanged: [],
  sourceOfTruthFollowed: [],
  verificationClaims: [],
  escalations: [],
  remainingUncertainty: [],
});

const minSkillText = `# Meridian Skill

## Doctrine

D1. The driver is plumbing.`;

describe("prompts — Q-table renderers", () => {
  describe("q1InitialSeed", () => {
    it("includes BRIDGE_CONTRACT and outcome ledger", () => {
      const prompt = q1InitialSeed(minPacket(), minLedger());
      match(prompt, /meridian-bridge_ask_planner/);
      match(prompt, /## Outcome ledger/);
      match(prompt, /Daddy is available repeatedly/);
      match(prompt, /exact prior instruction/);
    });

    it("includes sealed-files section when packet has regression_outcomes", () => {
      const packet = {
        ...minPacket(),
        frontmatter: {
          ...minPacket().frontmatter,
          regression_outcomes: [{ id: "prior-outcome", description: "prior work delivered" }],
        },
      };
      const prompt = q1InitialSeed(packet, minLedger());
      match(prompt, /## Sealed files \(prior converged work\)/);
      match(prompt, /\[prior-outcome\]: prior work delivered/);
      match(prompt, /do NOT modify/);
    });

    it("omits sealed-files section when regression_outcomes is empty", () => {
      const prompt = q1InitialSeed(minPacket(), minLedger());
      const sealedIdx = prompt.indexOf("## Sealed files");
      strictEqual(sealedIdx, -1);
    });

    it("places sealed-files section between handoff packet and Start", () => {
      const packet = {
        ...minPacket(),
        frontmatter: {
          ...minPacket().frontmatter,
          regression_outcomes: [{ id: "a", description: "b" }],
        },
      };
      const prompt = q1InitialSeed(packet, minLedger());
      match(prompt, /## The handoff packet[\s\S]*## Sealed files[\s\S]*## Start/);
    });
  });

  describe("q2RotationSeed", () => {
    it("includes checkpoint, diff, and status line", () => {
      const ledger = {
        ...minLedger(),
        outcomes: [
          {
            ...minLedger().outcomes[0],
            status: "in_progress" as const,
            state: "mid-impl",
            nextAction: "next step",
          },
        ],
      };
      const prompt = q2RotationSeed(
        minPacket(),
        ledger,
        minCheckpoint(),
        minReview(),
        minDecisions(),
      );
      match(prompt, /## Predecessor's checkpoint/);
      match(prompt, /## Where the run stands/);
      match(prompt, /In progress: test-outcome/);
    });
  });

  describe("q3Continue", () => {
    it("names all legal exits", () => {
      const prompt = q3Continue();
      match(prompt, /continue with the next step/);
      match(prompt, /meridian-bridge_ask_planner/);
      match(prompt, /meridian-bridge_submit_report/);
    });
  });

  describe("q4CheckpointDemand", () => {
    it("includes reason and obligations", () => {
      const prompt = q4CheckpointDemand("gate latched", minReview());
      match(prompt, /Reason: gate latched/);
      match(prompt, /review obligations/);
    });
  });

  describe("q5TeardownDemand", () => {
    it("forces tool call and includes ledger", () => {
      const prompt = q5TeardownDemand(minLedger());
      match(prompt, /THIS MUST BE A TOOL CALL/);
      match(prompt, /meridian-bridge_write_checkpoint/);
      match(prompt, /Current ledger for reference:/);
    });
  });

  describe("q6ReportProperly", () => {
    it("directs to submit_report", () => {
      const prompt = q6ReportProperly();
      match(prompt, /meridian-bridge_submit_report/);
    });
  });

  describe("q7ReportRejected", () => {
    it("lists problems and instructions", () => {
      const prompt = q7ReportRejected(["missing verification", "stale ledger"]);
      match(prompt, /- missing verification/);
      match(prompt, /- stale ledger/);
    });
  });

  describe("q8ReconciliationSeed", () => {
    it("says no valid checkpoint and requires reconciliation", () => {
      const prompt = q8ReconciliationSeed(minPacket(), minLedger(), minReview(), minDecisions());
      match(prompt, /No valid checkpoint/);
      match(prompt, /TRIGGER reconciliation/);
      match(prompt, /questionType "reconciliation"/);
      match(prompt, /Do not inspect, compare, reconstruct, or prove/);
    });
  });

  describe("qReorientSeed", () => {
    it("injects planner.answer and planner.safe_next_action", () => {
      const p = minPlanner();
      const prompt = qReorientSeed(minPacket(), minLedger(), minReview(), minDecisions(), p);
      match(prompt, new RegExp(p.answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      match(prompt, new RegExp(p.safe_next_action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      match(prompt, /DERAILED/);
    });
  });

  describe("softCheckpointNudge", () => {
    it("includes minutes and says NOT blocked", () => {
      const prompt = softCheckpointNudge(25);
      match(prompt, /~25 min/);
      match(prompt, /NOT blocked/);
      match(prompt, /call meridian-bridge_ask_planner now/);
      match(prompt, /Prose is not a routed question/);
      doesNotMatch(prompt, /Daddy's eyes/);
    });
  });

  describe("ladderNudge", () => {
    it("includes count and wedged warning", () => {
      const prompt = ladderNudge(3);
      match(prompt, /3 consecutive turns/);
      match(prompt, /wedged/);
    });
  });

  describe("qPlannerDecision", () => {
    it("embeds JSON.stringify({ planner }) of the argument", () => {
      const p = {
        status: "proceed" as const,
        answer: "go",
        constraints: [] as string[],
        evidence_used: [],
        safe_next_action: "do it",
        human_decision_needed: null,
      };
      const prompt = qPlannerDecision(p as PlannerResponse);
      match(prompt, /"status":\s*"proceed"/);
      // Verify the planner JSON payload is present
      match(prompt, /"answer":\s*"go"/);
    });

    it("includes revise_slice directive when applicable", () => {
      const p = {
        status: "revise_slice" as const,
        answer: "too broad",
        constraints: ["narrow scope"],
        evidence_used: [],
        safe_next_action: "",
        human_decision_needed: null,
      };
      const prompt = qPlannerDecision(p as PlannerResponse);
      match(prompt, /revise_slice/);
      match(prompt, /narrows or expands/);
      match(prompt, /owner files/);
    });

    it("includes promote_run directive when applicable", () => {
      const p = {
        status: "promote_run" as const,
        answer: "same failed tactic twice",
        constraints: [],
        evidence_used: ["failing command repeated"],
        safe_next_action: "inspect the generated Nuxt aliases, then fix the test harness",
        human_decision_needed: null,
      };
      const prompt = qPlannerDecision(p as PlannerResponse);
      match(prompt, /promote_run/);
      match(prompt, /restarting you on the promotion model/);
      match(prompt, /stuck in tool\/harness mechanics/);
    });
  });

  describe("qPlannerUnavailable", () => {
    it("includes detail and retry instruction", () => {
      const prompt = qPlannerUnavailable("transport timeout");
      match(prompt, /transport timeout/);
      match(prompt, /Call meridian-bridge_ask_planner once more/);
    });
  });

  describe("renderDaddySeed", () => {
    it("contains the PLANNER_OK handshake", () => {
      const prompt = renderDaddySeed("---\nrepo: test\n---\nbody");
      match(prompt, /Reply to this message with exactly: PLANNER_OK/);
    });
  });

  describe("renderPlannerQuestion", () => {
    it("includes all required sections", () => {
      const prompt = renderPlannerQuestion(
        "repo_procedure",
        "slice 1",
        "what?",
        "plan",
        ["evidence"],
        minReview(),
      );
      match(prompt, /## Review obligation lifecycle/);
      match(prompt, /## Contradiction handling/);
      match(prompt, /Repeating the prior answer without reconciling/);
      match(prompt, /## Escalation discriminator/);
      match(prompt, /promote_run: the plan is clear/);
      match(prompt, /## Approach audit/);
      match(prompt, /## Requirement sanity audit/);
      match(prompt, /has Baby only produced a nicer-looking shape/);
      match(prompt, /## Packet feasibility audit/);
      match(prompt, /must expand, must split, or needs Max/);
      match(prompt, /Current slice:/);
    });

    it("allows revise_slice to expand the executable slice when repo seams require it", () => {
      const prompt = renderPlannerQuestion(
        "handoff_interpretation",
        "UI retry panel",
        "Do I keep only the currently wired knob?",
        "I will omit backend render changes and mark retry UI done.",
        ["renderSegment only accepts takes", "packet requires five retry knobs"],
        minReview(),
      );

      match(prompt, /too broad, too narrow, infeasible, or wrong/);
      match(prompt, /may EXPAND the executable slice/);
      match(prompt, /Do not hide behind the packet's expected_surface/);
      match(prompt, /cannot be delivered inside its declared surface or constraints/);
    });

    it("describes promote_run as evidence-backed executor promotion, not missing requirements", () => {
      const prompt = renderPlannerQuestion(
        "other",
        "Nuxt harness repair",
        "Should I keep trying the same mock?",
        "I retried the same vi.mock path after Daddy told me to inspect .nuxt aliases.",
        ["same failing command twice", "Daddy instruction not applied"],
        minReview(),
      );

      match(prompt, /promote_run — task is valid/);
      match(prompt, /repeated the same failed tactic/);
      match(prompt, /failed to apply a concrete Daddy instruction/);
      match(prompt, /Use once per run/);
      match(prompt, /Never use for missing product\/security\/data\/legal decisions/);
    });

    it("does not let Daddy stop just because verification output is missing", () => {
      const prompt = renderPlannerQuestion(
        "other",
        "typecheck-and-fix",
        "What are the exact remaining pnpm typecheck errors?",
        "The previous turn tried to run typecheck but did not capture the output.",
        ["pnpm typecheck output was not captured"],
        minReview(),
      );

      match(prompt, /Do NOT use stop merely because command output is missing/);
      match(prompt, /run the exact command, capture the output/);
      match(prompt, /missing command output is not enough/);
      match(prompt, /do not answer stop just because you cannot infer output/);
    });

    it("makes reconciliation Daddy-owned from driver evidence", () => {
      const prompt = renderPlannerQuestion(
        "reconciliation",
        "reconciliation",
        "reconcile",
        "driver-owned",
        ["current fingerprint: abc"],
        minReview(),
      );
      match(prompt, /Baby did not reconstruct the state/);
      match(prompt, /driver supplied durable state and git evidence/);
      doesNotMatch(prompt, /executor has reconstructed state/i);
    });
  });

  describe("renderSuperReview", () => {
    it("contains the MUST_EXECUTE mandate", () => {
      const input: SuperReviewInput = {
        packet: minPacket(),
        reportText: "(no report)",
        skillText: minSkillText,
        pass: 1,
        maxPasses: 3,
      };
      const prompt = renderSuperReview(input);
      match(prompt, /YOU MUST EXECUTE — read-only review is not enough/);
      match(prompt, /RUN the verification commands below yourself/);
    });

    it("contains the <<<RUBRIC ... RUBRIC block", () => {
      const input: SuperReviewInput = {
        packet: minPacket(),
        reportText: "(no report)",
        skillText: minSkillText,
        pass: 1,
        maxPasses: 3,
      };
      const prompt = renderSuperReview(input);
      match(prompt, /<<<RUBRIC/);
      match(prompt, /RUBRIC/);
    });

    it("contains the recommend_stop MUST be false rule", () => {
      const input: SuperReviewInput = {
        packet: minPacket(),
        reportText: "(no report)",
        skillText: minSkillText,
        pass: 1,
        maxPasses: 3,
      };
      const prompt = renderSuperReview(input);
      match(prompt, /recommend_stop MUST be false if ANY verification command exited non-zero/);
    });
  });

  describe("renderFinalReview", () => {
    it("includes outcome lines and files changed, with no embedded diff", () => {
      const report = minReport();
      const prompt = renderFinalReview(minPacket(), minLedger(), report);
      match(prompt, /## Packet outcomes/);
      match(prompt, /test-outcome: a test outcome/);
      match(prompt, /## Verification commands/);
      // The reviewer inspects the worktree directly — no diff slice is injected.
      doesNotMatch(prompt, /## Reviewable diff/);
      match(prompt, /full read-only access to this worktree/);
      match(prompt, /has Baby only produced a nicer-looking shape/);
      match(prompt, /leaves\s+downstream work with a coherent model to build on/);
    });

    it("lists files changed when present", () => {
      const report: SubmitReport = {
        ...minReport(),
        filesChanged: [
          {
            path: "src/main.ts",
            classification: "expected",
            reason: "part of scope",
            action: "kept",
          },
        ],
      };
      const prompt = renderFinalReview(minPacket(), minLedger(), report);
      match(prompt, /src\/main\.ts/);
    });
  });
});
