import { z } from "zod";
import { balancedObjects, jsonCandidates } from "./structured-extraction.js";

// ---------------------------------------------------------------------------
// Planner (CONTRACT §9) — ask_repo_first is deleted in v2 (M3)

export const PlannerStatus = z.enum([
  "proceed",
  "proceed_with_constraints",
  "revise_slice",
  // Baby has drifted/hallucinated (inventing files, paths, or projects that
  // don't exist; acting on a confabulated premise) but the correct fix is clear
  // and needs no human. The driver discards Baby's session and reseeds a fresh
  // one handed the fix from safe_next_action — NOT a terminal park. Bounded by
  // maxReorientRetries, then falls through to a human_decision park.
  "reorient",
  "human_required",
  "stop",
]);
export type PlannerStatus = z.infer<typeof PlannerStatus>;

export const ACCEPTED_STATUSES: readonly PlannerStatus[] = ["proceed", "proceed_with_constraints"];

export const QuestionType = z.enum([
  "repo_procedure",
  "architecture_discoverable",
  "handoff_interpretation",
  "stop_condition",
  "diff_audit",
  "reconciliation",
  "other",
]);
export type QuestionType = z.infer<typeof QuestionType>;

export const PlannerResponse = z.object({
  status: PlannerStatus,
  answer: z.string(),
  constraints: z.array(z.string()).default([]),
  evidence_used: z.array(z.string()).default([]),
  safe_next_action: z.string(),
  human_decision_needed: z.string().nullable().default(null),
});
export type PlannerResponse = z.infer<typeof PlannerResponse>;

// The executor's ask_planner submission. The bridge captures this and hands it
// to the driver, which runs the Daddy consult OFF the MCP request path: a
// synchronous Daddy call held across the tool result is cancelled by opencode's
// MCP client at ~5min (a multi-minute consult then reads as "planner
// unavailable" and crashes the run). The driver runs it on its own 1h budget.
export type AskPlannerInput = {
  questionType: QuestionType;
  currentSlice: string;
  question: string;
  approach: string;
  evidence: string[];
};

// Final review (CONTRACT V7) — Daddy's one non-mechanical acceptance check.
// A purpose-built verdict: the mid-run slice statuses (proceed_with_constraints,
// revise_slice) don't map to a terminal judgement, so overloading them would
// muddy both.
export const FinalReviewVerdict = z.enum(["accept", "request_changes", "escalate"]);
export type FinalReviewVerdict = z.infer<typeof FinalReviewVerdict>;

export const FinalReview = z.object({
  verdict: FinalReviewVerdict,
  findings: z.array(z.string()).default([]),
  notes: z.string().default(""),
  human_decision_needed: z.string().nullable().default(null),
});
export type FinalReview = z.infer<typeof FinalReview>;

// ---------------------------------------------------------------------------
// Fail-closed parsers (CONTRACT §18 S11, §9 M9)
// The candidate scanner is single-sourced in structured-extraction.ts; each parser
// picks the builder its scar needs (full jsonCandidates vs balanced-only).

// Parse a planner response, or null if nothing validates. Robust to verbose
// reasoning models that bury the verdict in prose or fenced blocks.
export const tryParsePlannerResponse = (raw: string): PlannerResponse | null => {
  for (const candidate of jsonCandidates(raw)) {
    try {
      const parsed = PlannerResponse.safeParse(JSON.parse(candidate));
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
};

// Fail closed: a planner whose reply still won't parse becomes a hard stop.
export const parsePlannerResponse = (raw: string): PlannerResponse =>
  tryParsePlannerResponse(raw) ?? {
    status: "stop",
    answer: "Planner returned invalid or malformed JSON; treating as stop.",
    constraints: [],
    evidence_used: [],
    safe_next_action: "Re-ask with a narrower question, or park for Max.",
    human_decision_needed: null,
  };

// Why the last reply could not be accepted. Prefers a schema
// error (valid JSON, wrong shape — directly actionable) over a JSON syntax error
// (usually a truncated or prose-wrapped reply). Fed verbatim into the re-ask.
export const diagnosePlannerParse = (raw: string): string => {
  let syntaxError: string | null = null;
  for (const candidate of jsonCandidates(raw)) {
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch (err) {
      syntaxError ??= err instanceof Error ? err.message : String(err);
      continue;
    }
    const parsed = PlannerResponse.safeParse(value);
    if (parsed.success) {
      continue;
    } // a valid candidate exists — caller would not be here
    return parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
  }
  return syntaxError ?? "no JSON object found in the reply";
};

// Sent back to Daddy on the same session when his reply did not parse, carrying
// the concrete reason: most misses are a verbose model burying or truncating the
// JSON, recoverable in one re-ask (Baby recovered exactly this way live).
export const jsonReaskNudge = (reason: string): string =>
  `Your previous reply could not be accepted: ${reason}. Reply again with ONLY the JSON verdict object in the response shape above — no reasoning, no markdown fences, nothing before the opening { or after the closing }.`;

// The frontmatter sibling of jsonReaskNudge — one re-ask family, two formats. Same
// discipline (concrete reason + "emit ONLY the block, nothing around it"), specialised
// for the super-daddy authoring path, where a too-generic re-ask let an invalid YAML
// escape survive both attempts (the cli-cutover park).
export const frontmatterReaskNudge = (reason: string): string =>
  `Your previous reply could not be accepted: ${reason}. Reply again with ONLY the corrected packet — its YAML frontmatter block (starting at the opening \`---\`) then the markdown body — with no prose, narration, or code fences around it. Do not apologise or explain.`;

// Parse a final-review response, or null if nothing validates. Mirrors
// parseSuperReview's scan: every balanced {...} object, LAST first (the real
// verdict trails any prose example), return the FIRST candidate that validates.
export const tryParseFinalReview = (raw: string): FinalReview | null => {
  for (const candidate of balancedObjects(raw).reverse()) {
    try {
      const parsed = FinalReview.safeParse(JSON.parse(candidate));
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      /* not this object — try the next-earlier one */
    }
  }
  return null;
};

// Fail closed: a final-review that still won't parse becomes request_changes.
export const parseFinalReview = (raw: string): FinalReview =>
  tryParseFinalReview(raw) ?? {
    verdict: "request_changes",
    findings: [
      "Daddy's final-review response was not valid JSON; failing closed to request_changes.",
    ],
    notes: "unparseable verdict",
    human_decision_needed: null,
  };
