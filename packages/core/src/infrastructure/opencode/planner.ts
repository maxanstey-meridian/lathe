// Planner adapter: Daddy — session handshake + consult (with M4 re-ask) + final review (CONTRACT §9, V7).
// Both consult and finalReview run on daddy.timeoutMs via the Executor, NOT inside an MCP tool handler
// (the ~5min cancel scar, M3). The orchestrating loop (when to call consult) is the application turn-loop's job.

import type { Executor, ModelConfig } from "../../application/ports/executor.js";
import type { Planner } from "../../application/ports/planner.js";
import { extractText } from "../../domain/agent-response.js";
import type { Packet, OutcomeLedger, SubmitReport } from "../../domain/index.js";
import { renderPlannerQuestion, renderFinalReview } from "../../domain/prompts.js";
import type { PlannerResponse, FinalReview } from "../../domain/review.js";
import {
  tryParsePlannerResponse,
  diagnosePlannerParse,
  jsonReaskNudge,
  parsePlannerResponse,
  parseFinalReview,
  tryParseFinalReview,
} from "../../domain/review.js";
import { harvestLatestReply, harvestReply } from "./harvest.js";

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
    daddySessionId = await executor.createSession("meridian-planner", directory);
    const response = await executor.sendMessage(daddySessionId, seedPrompt, daddyModel, 30000);
    const text = extractText(response);
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

    const response = await executor.sendMessage(daddySessionId, prompt, daddyModel, daddyTimeoutMs);
    const text = extractText(response).trim();
    if (!text.includes("DADDY_SYNC_OK")) {
      throw new Error(`Daddy sync failed: expected DADDY_SYNC_OK, got: ${text.slice(0, 200)}`);
    }
  };

  // M4: the re-ask loop — tryParse → on null, diagnose → jsonReaskNudge → retry → tryParse → on null, fail-closed.
  // Port contract: returns PlannerResponse directly (NOT { planner } — that's the bridge's internal shape).
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

    const response = await executor.sendMessage(daddySessionId, prompt, daddyModel, daddyTimeoutMs);
    // All-message harvest, not just the final turn — a multi-step turn can leave the
    // final message empty with the verdict in an earlier step (the fix2 scar).
    const { text } = await harvestReply(executor, daddySessionId, response);
    let parsed = tryParsePlannerResponse(text);
    if (parsed) {
      return parsed;
    }

    // Re-ask with concrete reason (M4)
    const reason = diagnosePlannerParse(text);
    const nudge = jsonReaskNudge(reason);
    const retry = await executor.sendMessage(daddySessionId, nudge, daddyModel, daddyTimeoutMs);
    const { text: retryText } = await harvestReply(executor, daddySessionId, retry);
    parsed = tryParsePlannerResponse(retryText);
    if (parsed) {
      return parsed;
    }

    // Fail closed to stop
    return parsePlannerResponse("");
  };

  // V7: fails closed to request_changes on ANY error (transport, parse, timeout).
  // Re-asks ONCE on a parse miss, then fails closed.
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
      const response = await executor.sendMessage(
        daddySessionId,
        prompt,
        daddyModel,
        daddyTimeoutMs,
      );
      const { text: raw } = await harvestLatestReply(executor, daddySessionId, response);
      const parsed = tryParseFinalReview(raw);
      if (parsed) {
        return parsed;
      }

      // Re-ask with concrete reason (M4)
      const reason = diagnosePlannerParse(raw);
      const nudge = jsonReaskNudge(reason);
      const retry = await executor.sendMessage(daddySessionId, nudge, daddyModel, daddyTimeoutMs);
      const { text: retryText } = await harvestLatestReply(executor, daddySessionId, retry);
      const retryParsed = tryParseFinalReview(retryText);
      if (retryParsed) {
        return retryParsed;
      }

      // Fail closed to request_changes
      return parseFinalReview("");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        verdict: "request_changes",
        findings: [`final review unavailable: ${detail} — retry meridian-bridge_submit_report`],
        notes: "planner unreachable",
        human_decision_needed: null,
      };
    }
  };

  return { handshake, resumeSession, syncMaxDecisions, consult, finalReview };
};
