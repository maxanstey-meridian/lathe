// Reviewer port: super-daddy convergence reviewer (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.

import type { SuperReview } from "../../domain/convergence.js";
import type { AuthorFollowupInput, SuperReviewInput } from "../../domain/prompts.js";

// SuperReviewResult — a real review the model produced (verdict + raw text).
export type SuperReviewResult = { review: SuperReview; raw: string };

// The reviewer call has two outcomes on DIFFERENT axes, and conflating them is
// the cwd/socket-hang bug class: a real REVIEW (a verdict), or an UNREACHABLE
// transport failure (no verdict at all — the connection dropped). An unreachable
// result is retryable and must NEVER be recorded as a campaign pass or fed to
// decideConvergence; it is not the model escalating.
export type SuperReviewOutcome =
  | ({ kind: "reviewed" } & SuperReviewResult)
  | { kind: "unreachable"; detail: string; raw: string };

// authorFollowup has the SAME two-axis split as superReview: a real authored
// packet (markdown the engine then stamps + admits), or an UNREACHABLE transport
// failure (no packet — retryable, never a forged result). The use case validates
// the authored content on admission and re-asks/escalates if it does not parse.
export type AuthorFollowupOutcome =
  | { kind: "authored"; content: string; raw: string }
  | { kind: "unreachable"; detail: string; raw: string };

export type Reviewer = {
  superReview(
    input: SuperReviewInput,
    onSessionBound?: (sessionId: string) => void,
  ): Promise<SuperReviewOutcome>;
  authorFollowup(
    input: AuthorFollowupInput,
    onSessionBound?: (sessionId: string) => void,
  ): Promise<AuthorFollowupOutcome>;
};
