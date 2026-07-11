// Reviewer adapter: super-daddy convergence reviewer (CONTRACT §18 S2, S11).
// Reads replies through the shared all-message harvest (the 0-char-final-message
// scar). superReview separates a real REVIEW from an UNREACHABLE transport failure:
// transport drops resolve to an `unreachable` outcome (never a
// forged escalate verdict). The use case decides what unreachable means for run
// state. A parse failure stays a reviewed escalate (parseSuperReview fails closed).

import type { Executor, ModelConfig } from "../../application/ports/executor.js";
import type {
  AuthorFollowupOutcome,
  Reviewer,
  SuperReviewOutcome,
} from "../../application/ports/reviewer.js";
import { parseSuperReview } from "../../domain/convergence.js";
import type { AuthorFollowupInput, SuperReviewInput } from "../../domain/prompts.js";
import { renderFollowupAuthoring, renderSuperReview } from "../../domain/prompts.js";
import { describeUnreachable } from "../../domain/reviewer-transport.js";
import { harvestReplySince, snapshotMessageBoundary } from "./harvest.js";

// ---------------------------------------------------------------------------
// Reviewer adapter implementation

export const createReviewer = (
  executor: Executor,
  superdaddyModel: ModelConfig,
  timeoutMs: number,
): Reviewer => {
  let reviewerSessionId: string | undefined;
  let currentWorktree: string | undefined;

  // The session's cwd is fixed at creation, and super-daddy MUST run verification
  // and `git diff HEAD` in the run's worktree (renderSuperReview promises "your cwd
  // is the run's worktree"). Each run/pass has its own worktree, so when it changes
  // the prior session points at a stale cwd — delete and rebind. This also isolates
  // context across campaigns: different campaigns never share a worktree. The
  // authoring turn reuses whatever session the review just created (same worktree),
  // so the diff and findings are still in context. On the very first call both are
  // undefined — skip deleteSession. Scoped to the worktree, NOT paths.root (not a
  // git repo — the cwd-escalate bug).
  const ensureSession = async (worktree: string): Promise<string> => {
    if (reviewerSessionId !== undefined && worktree !== currentWorktree) {
      try {
        await executor.deleteSession(reviewerSessionId);
      } catch {}
      reviewerSessionId = undefined;
    }
    if (!reviewerSessionId) {
      reviewerSessionId = await executor.createSession("lathe-superdaddy", worktree);
      currentWorktree = worktree;
    }
    return reviewerSessionId;
  };

  // One turn against the super-daddy session. A transport failure is returned
  // explicitly; lifecycle policy belongs to convergeRun.
  type TurnOutcome = { kind: "text"; raw: string } | { kind: "unreachable"; detail: string };
  const runTurn = async (
    sessionId: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<TurnOutcome> => {
    if (signal?.aborted) {
      return { kind: "unreachable", detail: "aborted" };
    }
    try {
      const boundary = await snapshotMessageBoundary(executor, sessionId);
      const response = await executor.sendMessage(
        sessionId,
        prompt,
        superdaddyModel,
        timeoutMs,
        signal,
      );
      const { text: raw, error } = await harvestReplySince(executor, sessionId, boundary, response);

      // A provider/transport failure returns HTTP 200 with the failure on the
      // turn's `error` and no text — not the model returning a bad reply.
      // Surface the real reason ("APIError (HTTP 503): …") for classification.
      if (error) {
        return { kind: "unreachable", detail: error };
      } else {
        return { kind: "text", raw };
      }
    } catch (err) {
      return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
    }
  };

  const superReview = async (
    input: SuperReviewInput,
    onSessionBound?: (sessionId: string) => void,
    signal?: AbortSignal,
  ): Promise<SuperReviewOutcome> => {
    let sessionId: string;
    try {
      sessionId = await ensureSession(input.worktree);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        kind: "unreachable",
        detail: describeUnreachable(detail),
        raw: `«reviewer unreachable»: ${detail}`,
      };
    }
    // Surface the bound session BEFORE the turn so the caller (converge-run) can
    // record it in run meta — `lathe tail` then routes super-daddy's live tool
    // calls to its pane during the review, not after.
    onSessionBound?.(sessionId);
    const turn = await runTurn(sessionId, renderSuperReview(input), signal);

    // Retries exhausted (or a fatal error) — unreachable, NOT escalate. A parse
    // failure is different — parseSuperReview fails closed to an escalate VERDICT
    // (a real reviewed outcome), so it stays on the reviewed branch.
    if (turn.kind === "unreachable") {
      return {
        kind: "unreachable",
        detail: describeUnreachable(turn.detail),
        raw: `«reviewer unreachable»: ${turn.detail}`,
      };
    }
    return { kind: "reviewed", review: parseSuperReview(turn.raw), raw: turn.raw };
  };

  // The authoring turn — runs in the SAME session that just reviewed, so the diff
  // and the findings are in context. We do not parse here: the use case stamps the
  // lineage and validates on admission, re-asking (priorProblems) or escalating if
  // it does not parse. Returns the raw authored markdown, or unreachable.
  const authorFollowup = async (
    input: AuthorFollowupInput,
    onSessionBound?: (sessionId: string) => void,
    signal?: AbortSignal,
  ): Promise<AuthorFollowupOutcome> => {
    let sessionId: string;
    try {
      sessionId = await ensureSession(input.worktree);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return {
        kind: "unreachable",
        detail: describeUnreachable(detail),
        raw: `«author unreachable»: ${detail}`,
      };
    }
    onSessionBound?.(sessionId);
    const turn = await runTurn(sessionId, renderFollowupAuthoring(input), signal);
    if (turn.kind === "unreachable") {
      return {
        kind: "unreachable",
        detail: describeUnreachable(turn.detail),
        raw: `«author unreachable»: ${turn.detail}`,
      };
    }
    return { kind: "authored", content: turn.raw, raw: turn.raw };
  };

  return { superReview, authorFollowup };
};
