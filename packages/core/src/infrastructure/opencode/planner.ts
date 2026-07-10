// Planner adapter: Daddy — session handshake + consult (with M4 re-ask) + final review (CONTRACT §9, V7).
// Both consult and finalReview run on daddy.timeoutMs via the Executor, NOT inside an MCP tool handler
// (the ~5min cancel scar, M3). The orchestrating loop (when to call consult) is the application turn-loop's job.

import type { Executor, ModelConfig } from "../../application/ports/executor.js";
import type { Planner } from "../../application/ports/planner.js";
import type { Packet, OutcomeLedger, SubmitReport } from "../../domain/index.js";
import { renderPlannerQuestion, renderFinalReview } from "../../domain/prompts.js";
import { ACCEPTED_STATUSES, type PlannerResponse, type FinalReview } from "../../domain/review.js";
import {
  tryParsePlannerResponse,
  diagnosePlannerParse,
  diagnoseFinalReviewParse,
  jsonReaskNudge,
  tryParseFinalReview,
} from "../../domain/review.js";
import { harvestReplySince, snapshotMessageBoundary } from "./harvest.js";

const MAX_REASKS = 3;

const isRepoInspectionTool = (name: string): boolean =>
  name === "read" ||
  name === "grep" ||
  name === "glob" ||
  name.startsWith("gitnexus_") ||
  name.includes("ast_grep");

const groundingIssue = (
  response: PlannerResponse | null,
  questionType: Parameters<Planner["consult"]>[0]["questionType"],
  toolNames: ReadonlySet<string>,
): string | null => {
  if (
    response &&
    questionType !== "reconciliation" &&
    ACCEPTED_STATUSES.includes(response.status) &&
    ![...toolNames].some(isRepoInspectionTool)
  ) {
    return "accepted response used no repository inspection tool in this consult";
  }
  return null;
};

const groundingReaskNudge = (reason: string): string =>
  `Your previous reply could not be accepted: ${reason}. Use read, grep, glob, GitNexus, or ast-grep now to verify the repository facts and proposed seams material to the decision. Then reply with ONLY the JSON verdict object, citing inspected files/facts in evidence_used.`;

// ---------------------------------------------------------------------------
// Planner adapter implementation

export const createPlanner = (
  executor: Executor,
  daddyModel: ModelConfig,
  daddyTimeoutMs: number,
): Planner => {
  let daddySessionId: string | undefined;

  // directory is the run's worktree: Daddy's session roots there (read-only — it
  // has no write/edit/patch/bash) so it can inspect the actual code when a
  // reconciliation/handoff question can't be answered from inline evidence alone.
  const handshake = async (seedPrompt: string, directory: string): Promise<string> => {
    daddySessionId = await executor.createSession("lathe-planner", directory);
    const boundary = await snapshotMessageBoundary(executor, daddySessionId);
    const response = await executor.sendMessage(daddySessionId, seedPrompt, daddyModel, 30000);
    const { text } = await harvestReplySince(executor, daddySessionId, boundary, response);
    if (!text.includes("PLANNER_OK")) {
      throw new Error(`Daddy handshake failed: expected "PLANNER_OK", got: ${text.slice(0, 200)}`);
    }
    return daddySessionId;
  };

  const resumeSession = async (sessionId: string): Promise<string> => {
    daddySessionId = sessionId;
    return daddySessionId;
  };

  const syncMaxDecisions = async (
    decisions: { timestamp: string; question: string; answer: string }[],
  ): Promise<void> => {
    if (!daddySessionId) {
      throw new Error("handshake must be called before syncMaxDecisions");
    }
    if (decisions.length === 0) {
      return;
    }

    const body = decisions
      .map(
        (d) =>
          `- at: ${d.timestamp}\n  blocked question: ${d.question}\n  Max's authoritative answer: ${d.answer}`,
      )
      .join("\n");
    const prompt = `DADDY STATE SYNC — Max answered parked-run question(s). Treat these as authoritative run state for all later planning and final review. Do not rely on any older contrary premise from this session. Absorb this state and reply exactly DADDY_SYNC_OK.\n\n${body}`;

    const boundary = await snapshotMessageBoundary(executor, daddySessionId);
    const response = await executor.sendMessage(daddySessionId, prompt, daddyModel, daddyTimeoutMs);
    const { text } = await harvestReplySince(executor, daddySessionId, boundary, response);
    if (!text.includes("DADDY_SYNC_OK")) {
      throw new Error(`Daddy sync failed: expected DADDY_SYNC_OK, got: ${text.slice(0, 200)}`);
    }
  };

  // M4: the re-ask loop — tryParse → on null, diagnose → jsonReaskNudge → retry (up to MAX_REASKS).
  // After all retries exhausted, stop with raw replies for diagnosis.
  const consult = async (
    input: Parameters<Planner["consult"]>[0],
    context?: Parameters<Planner["consult"]>[1],
  ): Promise<PlannerResponse> => {
    if (!daddySessionId) {
      throw new Error("handshake must be called before consult");
    }
    const prompt = renderPlannerQuestion(
      input.questionType,
      input.currentSlice,
      input.question,
      input.approach,
      input.evidence,
      context?.reviewState,
      context?.facts,
    );

    const rawReplies: string[] = [];

    const boundary = await snapshotMessageBoundary(executor, daddySessionId);
    const response = await executor.sendMessage(daddySessionId, prompt, daddyModel, daddyTimeoutMs);
    const { text, toolNames } = await harvestReplySince(
      executor,
      daddySessionId,
      boundary,
      response,
    );
    const inspectedTools = new Set(toolNames);
    let parsed = tryParsePlannerResponse(text);
    let issue = groundingIssue(parsed, input.questionType, inspectedTools);
    if (parsed && !issue) {
      return parsed;
    }
    let lastRaw = text;
    rawReplies.push(text);

    for (let attempt = 0; attempt < MAX_REASKS; attempt++) {
      const reason = issue ?? diagnosePlannerParse(lastRaw);
      const nudge = issue ? groundingReaskNudge(reason) : jsonReaskNudge(reason);
      const retryBoundary = await snapshotMessageBoundary(executor, daddySessionId);
      const retry = await executor.sendMessage(daddySessionId, nudge, daddyModel, daddyTimeoutMs);
      const { text: retryText, toolNames: retryToolNames } = await harvestReplySince(
        executor,
        daddySessionId,
        retryBoundary,
        retry,
      );
      retryToolNames.forEach((name) => inspectedTools.add(name));
      parsed = tryParsePlannerResponse(retryText);
      issue = groundingIssue(parsed, input.questionType, inspectedTools);
      if (parsed && !issue) {
        return parsed;
      }
      lastRaw = retryText;
      rawReplies.push(retryText);
    }

    const lastIssue = issue ?? diagnosePlannerParse(lastRaw);
    return {
      status: "stop",
      answer: `Daddy could not produce a grounded, parseable consult response after ${MAX_REASKS + 1} attempts. Last issue: ${lastIssue}. Raw replies:\n${rawReplies.map((r, i) => `[attempt ${i + 1}]: ${r.slice(0, 500)}`).join("\n")}`,
      constraints: [],
      evidence_used: [],
      safe_next_action: "Inspect the raw replies in the journal and re-ask manually.",
      human_decision_needed: null,
    };
  };

  // V7: escalates on ANY error (transport, parse, timeout) — never returns request_changes
  // on a failure, because that sends Baby an impossible task. Re-asks up to MAX_REASKS
  // times on a parse miss, then escalates with raw replies for diagnosis.
  const finalReview = async (
    packet: Packet,
    ledger: OutcomeLedger,
    report: SubmitReport,
  ): Promise<FinalReview> => {
    if (!daddySessionId) {
      throw new Error("handshake must be called before finalReview");
    }
    const prompt = renderFinalReview(packet, ledger, report);

    try {
      const rawReplies: string[] = [];

      const boundary = await snapshotMessageBoundary(executor, daddySessionId);
      const response = await executor.sendMessage(
        daddySessionId,
        prompt,
        daddyModel,
        daddyTimeoutMs,
      );
      const { text: raw } = await harvestReplySince(executor, daddySessionId, boundary, response);
      let parsed = tryParseFinalReview(raw);
      if (parsed) {
        return parsed;
      }
      let lastRaw = raw;
      rawReplies.push(raw);

      for (let attempt = 0; attempt < MAX_REASKS; attempt++) {
        const reason = diagnoseFinalReviewParse(lastRaw);
        const nudge = jsonReaskNudge(reason);
        const retryBoundary = await snapshotMessageBoundary(executor, daddySessionId);
        const retry = await executor.sendMessage(daddySessionId, nudge, daddyModel, daddyTimeoutMs);
        const { text: retryText } = await harvestReplySince(
          executor,
          daddySessionId,
          retryBoundary,
          retry,
        );
        parsed = tryParseFinalReview(retryText);
        if (parsed) {
          return parsed;
        }
        lastRaw = retryText;
        rawReplies.push(retryText);
      }

      return {
        verdict: "escalate",
        findings: rawReplies.map((r, i) => `[attempt ${i + 1}] ${r.slice(0, 500)}`),
        notes: `Daddy's final-review response was not valid JSON after ${MAX_REASKS + 1} attempts.`,
        human_decision_needed: `Daddy could not produce a parseable final-review verdict after ${MAX_REASKS + 1} attempts. Raw replies are in the findings.`,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        verdict: "escalate",
        findings: [`final review unavailable: ${detail}`],
        notes: "planner unreachable",
        human_decision_needed:
          "Daddy was unreachable during final review. This is a transport issue, not a code issue.",
      };
    }
  };

  return { handshake, resumeSession, syncMaxDecisions, consult, finalReview };
};
