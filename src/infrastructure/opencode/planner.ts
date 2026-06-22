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

// ---------------------------------------------------------------------------
// Planner adapter implementation

export const createPlanner = (
  executor: Executor,
  daddyModel: ModelConfig,
  daddyTimeoutMs: number,
  directory: string,
): Planner => {
  let daddySessionId: string | undefined;

  const handshake = async (seedPrompt: string): Promise<string> => {
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

  // M4: the re-ask loop — tryParse → on null, diagnose → jsonReaskNudge → retry → tryParse → on null, fail-closed.
  // Reference: reference/src/bridge.ts:125-139
  // Port contract: returns PlannerResponse directly (NOT { planner } — that's the bridge's internal shape).
  const consult = async (input: Parameters<Planner["consult"]>[0]): Promise<PlannerResponse> => {
    if (!daddySessionId) throw new Error("handshake must be called before consult");
    const prompt = renderPlannerQuestion(
      input.questionType,
      input.currentSlice,
      input.question,
      input.approach,
      input.evidence,
      undefined, // reviewState — port doesn't carry it; the driver adds it
      undefined, // facts — port doesn't carry it; the driver adds it
    );

    const response = await executor.sendMessage(daddySessionId, prompt, daddyModel, daddyTimeoutMs);
    const text = extractText(response);
    let parsed = tryParsePlannerResponse(text);
    if (parsed) return parsed;

    // Re-ask with concrete reason (M4)
    const reason = diagnosePlannerParse(text);
    const nudge = jsonReaskNudge(reason);
    const retry = await executor.sendMessage(daddySessionId, nudge, daddyModel, daddyTimeoutMs);
    const retryText = extractText(retry);
    parsed = tryParsePlannerResponse(retryText);
    if (parsed) return parsed;

    // Fail closed to stop
    return parsePlannerResponse("");
  };

  // V7: fails closed to request_changes on ANY error (transport, parse, timeout).
  // Re-asks ONCE on a parse miss, then fails closed.
  // Reference: reference/src/bridge.ts:55-87
  const finalReview = async (
    packet: Packet,
    reviewableDiff: string,
    ledger: OutcomeLedger,
    report: SubmitReport,
  ): Promise<FinalReview> => {
    if (!daddySessionId) throw new Error("handshake must be called before finalReview");
    const prompt = renderFinalReview(packet, reviewableDiff, ledger, report);

    try {
      const response = await executor.sendMessage(
        daddySessionId,
        prompt,
        daddyModel,
        daddyTimeoutMs,
      );
      const raw = extractText(response);
      const parsed = tryParseFinalReview(raw);
      if (parsed) return parsed;

      // Re-ask with concrete reason (M4)
      const reason = diagnosePlannerParse(raw);
      const nudge = jsonReaskNudge(reason);
      const retry = await executor.sendMessage(daddySessionId, nudge, daddyModel, daddyTimeoutMs);
      const retryText = extractText(retry);
      const retryParsed = tryParseFinalReview(retryText);
      if (retryParsed) return retryParsed;

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

  return { handshake, resumeSession, consult, finalReview };
};
