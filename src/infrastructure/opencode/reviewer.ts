// Reviewer adapter: super-daddy convergence reviewer (CONTRACT §18 S2, S11).
// harvestReview gathers text from EVERY assistant message (the 0-char-final-message scar).
// superReview catches ALL errors and fail-closes to an escalate verdict.

import type { Executor, ModelConfig } from "../../application/ports/executor.js";
import type { Reviewer, SuperReviewResult } from "../../application/ports/reviewer.js";
import type { TurnResponse } from "../../domain/agent-response.js";
import { extractText, messageError } from "../../domain/agent-response.js";
import { parseSuperReview } from "../../domain/convergence.js";
import type { SuperReviewInput } from "../../domain/prompts.js";
import { renderSuperReview } from "../../domain/prompts.js";

// ---------------------------------------------------------------------------
// Reviewer adapter implementation

// ReviewHarvest — adapter-local shape from the harvest. The raw text is the only
// thing that makes a parse failure debuggable; the error is distinct from
// "unparseable" (a provider error returns HTTP 200 with empty parts, so without
// surfacing it an infra failure is indistinguishable from a silent model).
type ReviewHarvest = { text: string; error: string | null };

// harvestReview — adapter-local. Calls executor.listMessages(sessionId), filters
// assistant messages, extracts text from ALL of them (not just the final one —
// super-daddy runs bash across several steps and the verdict often appears in an
// earlier step, leaving the final message empty). Falls back to the sendMessage
// response text if listing fails. Checks for provider errors across all turns.
// Reference: reference/src/super-review.ts:230-250
const harvestReview = async (
  executor: Executor,
  sessionId: string,
  response: TurnResponse,
): Promise<ReviewHarvest> => {
  try {
    const allMessages = await executor.listMessages(sessionId);
    const assistants = allMessages.filter((m) => m.info.role === "assistant");
    const text = assistants
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n");
    const error =
      messageError(response.info) ??
      assistants.map((m) => messageError(m.info)).find((e): e is string => e !== null) ??
      null;
    return { text: text.trim().length > 0 ? text : extractText(response), error };
  } catch {
    return { text: extractText(response), error: messageError(response.info) };
  }
};

export const createReviewer = (
  executor: Executor,
  superdaddyModel: ModelConfig,
  timeoutMs: number,
  directory: string,
): Reviewer => {
  let reviewerSessionId: string | undefined;
  let currentCampaignId: string | undefined;

  const superReview = async (input: SuperReviewInput): Promise<SuperReviewResult> => {
    // Campaign-scoped session rebind: delete the prior campaign's session when
    // the campaignId changes, so reviewer context doesn't leak across campaigns.
    // On the very first call both are undefined — skip deleteSession.
    if (reviewerSessionId !== undefined && input.campaignId !== currentCampaignId) {
      try {
        await executor.deleteSession(reviewerSessionId);
      } catch {}
      reviewerSessionId = undefined;
    }

    // Sessions are scoped to a directory. Created lazily on first superReview call,
    // or after a cross-campaign rebind.
    if (!reviewerSessionId) {
      reviewerSessionId = await executor.createSession("meridian-superdaddy", directory);
      currentCampaignId = input.campaignId;
    }

    const prompt = renderSuperReview(input);

    try {
      const response = await executor.sendMessage(
        reviewerSessionId,
        prompt,
        superdaddyModel,
        timeoutMs,
      );
      const { text: raw, error } = await harvestReview(executor, reviewerSessionId, response);

      // A provider/transport failure (model unavailable, 400, auth, rate-limit)
      // returns HTTP 200 with the failure on the turn's `error` and no text —
      // that is NOT the model returning a bad verdict. Throw the real reason so
      // the escalate below says e.g. "APIError (HTTP 400): …" instead of the
      // "unparseable" a 0-char parse would invent. (A timeout or a dead socket
      // already rejects out of sendMessage into the same catch.)
      if (error) {
        throw new Error(error);
      }

      return { review: parseSuperReview(raw), raw };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Unreachable reviewer fails CLOSED to escalate — never silently converge,
      // never author from no findings.
      return {
        review: {
          verdict: "escalate",
          findings: [],
          convergence: {
            recommend_stop: false,
            profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
            rationale: "reviewer unreachable",
          },
          commit_message: null,
          notes: `super-review unavailable: ${detail}`,
          human_decision_needed: "Super-daddy was unreachable — review the run manually.",
        },
        raw: `«reviewer threw before producing text»: ${detail}`,
      };
    }
  };

  return { superReview };
};
