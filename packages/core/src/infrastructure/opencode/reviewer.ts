// Reviewer adapter: super-daddy convergence reviewer (CONTRACT §18 S2, S11).
// harvestReview gathers text from EVERY assistant message (the 0-char-final-message scar).
// superReview separates a real REVIEW from an UNREACHABLE transport failure:
// transient drops are retried, then resolve to an `unreachable` outcome (never a
// forged escalate verdict). The use case decides what unreachable means for run
// state. A parse failure stays a reviewed escalate (parseSuperReview fails closed).

import type { Executor, ModelConfig } from "../../application/ports/executor.js";
import type { Reviewer, SuperReviewOutcome } from "../../application/ports/reviewer.js";
import type { TurnResponse } from "../../domain/agent-response.js";
import { extractText, messageError } from "../../domain/agent-response.js";
import { parseSuperReview } from "../../domain/convergence.js";
import type { SuperReviewInput } from "../../domain/prompts.js";
import { renderSuperReview } from "../../domain/prompts.js";
import { classifyReviewerError, describeUnreachable } from "../../domain/reviewer-transport.js";

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

// Small backoff between transport retries — a fresh connection after a dropped
// socket usually lands; the delay just avoids hammering a flapping backend.
const backoff = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));

export const createReviewer = (
  executor: Executor,
  superdaddyModel: ModelConfig,
  timeoutMs: number,
  maxTransportRetries = 2,
): Reviewer => {
  let reviewerSessionId: string | undefined;
  let currentWorktree: string | undefined;

  const superReview = async (input: SuperReviewInput): Promise<SuperReviewOutcome> => {
    // The session's cwd is fixed at creation, and super-daddy MUST run verification
    // and `git diff HEAD` in the run's worktree (renderSuperReview promises "your cwd
    // is the run's worktree"). Each run/pass has its own worktree, so when it changes
    // the prior session points at a stale cwd — delete and rebind. This also isolates
    // context across campaigns: different campaigns never share a worktree.
    // On the very first call both are undefined — skip deleteSession.
    if (reviewerSessionId !== undefined && input.worktree !== currentWorktree) {
      try {
        await executor.deleteSession(reviewerSessionId);
      } catch {}
      reviewerSessionId = undefined;
    }

    // Created lazily on first superReview call, or after a worktree rebind. Scoped to
    // the run's worktree so super-daddy's bash + read tools land inside the change
    // surface — NOT paths.root, which is not a git repo (the cwd-escalate bug).
    if (!reviewerSessionId) {
      reviewerSessionId = await executor.createSession("meridian-superdaddy", input.worktree);
      currentWorktree = input.worktree;
    }

    const prompt = renderSuperReview(input);

    // A transport drop is NOT a verdict — it must be retried, never recorded as
    // a pass. Classify each failure: TRANSIENT (socket hang up, 5xx, reset) →
    // retry up to maxTransportRetries; FATAL (auth, 400) → stop immediately.
    // Either way the call resolves to an `unreachable` outcome the use case can
    // treat as retryable; we never forge an escalate SuperReview here. A parse
    // failure is different — parseSuperReview fails closed to an escalate VERDICT
    // (a real reviewed outcome), so it stays on the reviewed branch below.
    let lastDetail = "unknown error";
    for (let attempt = 0; ; attempt++) {
      let detail: string;
      try {
        const response = await executor.sendMessage(
          reviewerSessionId,
          prompt,
          superdaddyModel,
          timeoutMs,
        );
        const { text: raw, error } = await harvestReview(executor, reviewerSessionId, response);

        // A provider/transport failure returns HTTP 200 with the failure on the
        // turn's `error` and no text — not the model returning a bad verdict.
        // Surface the real reason ("APIError (HTTP 503): …") for classification.
        if (error) {
          detail = error;
        } else {
          return { kind: "reviewed", review: parseSuperReview(raw), raw };
        }
      } catch (err) {
        // A timeout or dead socket rejects out of sendMessage to here.
        detail = err instanceof Error ? err.message : String(err);
      }

      lastDetail = detail;
      const isTransient = classifyReviewerError(detail) === "transient";
      if (isTransient && attempt < maxTransportRetries) {
        await backoff(attempt);
        continue;
      }
      break;
    }

    // Retries exhausted (or a fatal error) — unreachable, NOT escalate.
    return {
      kind: "unreachable",
      detail: describeUnreachable(lastDetail),
      raw: `«reviewer unreachable»: ${lastDetail}`,
    };
  };

  return { superReview };
};
