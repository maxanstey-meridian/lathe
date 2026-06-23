// Reviewer port: super-daddy convergence reviewer (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.

import type { SuperReview } from "../../domain/convergence.js";
import type { SuperReviewInput } from "../../domain/prompts.js";

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

export type Reviewer = {
  superReview(input: SuperReviewInput): Promise<SuperReviewOutcome>;
};
