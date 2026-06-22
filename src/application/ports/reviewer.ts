// Reviewer port: super-daddy convergence reviewer (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.

import type { SuperReview } from "../../domain/convergence.js";
import type { SuperReviewInput } from "../../domain/prompts.js";

// SuperReviewResult — inline; no domain function consumes it.
export type SuperReviewResult = { review: SuperReview; raw: string };

export type Reviewer = {
  superReview(input: SuperReviewInput): Promise<SuperReviewResult>;
};
