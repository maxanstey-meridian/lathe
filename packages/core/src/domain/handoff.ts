import { z } from "zod";
import { jsonCandidates } from "./structured-extraction.js";

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
// Extract balanced top-level JSON objects from daddy's prose response (via the
// single shared scanner), then validate against the VerifyVerdict schema.
// ---------------------------------------------------------------------------

// Parse a verify verdict, or null if nothing validates.
export const tryParseVerifyVerdict = (raw: string): VerifyVerdict | null => {
  for (const candidate of jsonCandidates(raw)) {
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
