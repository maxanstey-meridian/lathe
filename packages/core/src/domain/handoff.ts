import { z } from "zod";

// ---------------------------------------------------------------------------
// Handoff artifact — baby writes progress to disk between turns / rotations
// (verify-handoff protocol). Plain objects, no port dependency.
// ---------------------------------------------------------------------------

export const CompletedStep = z.object({
  description: z.string().min(1),
  files: z.array(z.string()).default([]),
});
export type CompletedStep = z.infer<typeof CompletedStep>;

export const HandoffArtifact = z.object({
  runId: z.string(),
  timestamp: z.string(),
  completedSteps: z.array(CompletedStep).default([]),
  remainingWork: z.array(z.string()).default([]),
  decisionsMade: z.array(z.string()).default([]),
  resumeFrom: z.string().default(""),
});
export type HandoffArtifact = z.infer<typeof HandoffArtifact>;

// ---------------------------------------------------------------------------
// Verify verdict — daddy's lightweight spot-check response to verify_handoff.
// Strict TS, no any/as. Parse goes through a Zod schema.
// ---------------------------------------------------------------------------

export const TrustEntry = z.object({
  description: z.string().min(1),
  files: z.array(z.string()).default([]),
});
export type TrustEntry = z.infer<typeof TrustEntry>;

export const IssueEntry = z.object({
  file: z.string(),
  problem: z.string(),
});
export type IssueEntry = z.infer<typeof IssueEntry>;

export const VerifyVerdict = z.object({
  ok: z.boolean(),
  trusted: z.array(TrustEntry).default([]),
  issues: z.array(IssueEntry).default([]),
  resumeHint: z.string().default(""),
});
export type VerifyVerdict = z.infer<typeof VerifyVerdict>;

// ---------------------------------------------------------------------------
// Fail-closed parser (CONTRACT §18 S11)
// Extract balanced top-level JSON objects from daddy's prose response,
// then validate against the VerifyVerdict schema.
// ---------------------------------------------------------------------------

// Balanced top-level objects, ignoring braces inside JSON strings.
// Mirrors extractBalancedObjects from domain/review.ts.
const extractBalancedObjects = (text: string): string[] => {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) {
        start = i;
      }
      depth += 1;
    } else if (ch === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return objects;
};

// Candidate JSON substrings to try, best-first: fenced blocks then every
// balanced object (last-first, since reasoning models trail the real verdict).
const verifyVerdictCandidates = (raw: string): string[] => {
  const cleaned = raw.trim();
  const candidates: string[] = [];

  const fences = [...cleaned.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g)]
    .map((m) => m[1]?.trim())
    .filter((s): s is string => Boolean(s));
  candidates.push(...fences.reverse());

  candidates.push(...extractBalancedObjects(cleaned).reverse());

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    candidates.push(cleaned.slice(start, end + 1));
  }
  candidates.push(cleaned);

  return candidates;
};

// Parse a verify verdict, or null if nothing validates.
export const tryParseVerifyVerdict = (raw: string): VerifyVerdict | null => {
  for (const candidate of verifyVerdictCandidates(raw)) {
    try {
      const parsed = VerifyVerdict.safeParse(JSON.parse(candidate));
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
};

// Fail closed: a verify verdict that still won't parse becomes a hard stop.
// Packet spec: { ok: false, trusted: [], issues: [{ file: 'daddy-response',
// problem: 'could not parse verdict JSON' }], resumeHint: 'ask_planner to
// investigate' }.
export const parseVerifyVerdict = (raw: string): VerifyVerdict =>
  tryParseVerifyVerdict(raw) ?? {
    ok: false,
    trusted: [],
    issues: [{ file: "daddy-response", problem: "could not parse verdict JSON" }],
    resumeHint: "ask_planner to investigate",
  };
