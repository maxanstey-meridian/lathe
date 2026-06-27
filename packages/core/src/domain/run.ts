import { z } from "zod";

// ---------------------------------------------------------------------------
// Run lifecycle (CONTRACT §3, §5)

export const RunStatus = z.enum([
  "queued",
  "running",
  "interrupted",
  "ready_for_review",
  "blocked",
  "failed",
  "accepted",
  "aborted",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const BlockedReason = z.enum([
  "human_decision",
  "scope_expansion",
  "stop_condition",
  // A harness-detected stall: ladder, rotation bounce, consecutive turn
  // failures, or the run watchdog (§5 R10). Recoverable — auto-requeued up to
  // `maxStallRetries` before escalating to Max.
  "wedged",
  // A driver-level failure: executeRun itself threw (worktree/server/IO). NOT
  // auto-retried — a systemic fault would hot-loop on the same packet (§5 R10).
  "crashed",
]);
export type BlockedReason = z.infer<typeof BlockedReason>;

export const RunMeta = z.object({
  runId: z.string(),
  status: RunStatus,
  attempt: z.number().int().min(1),
  repo: z.string(),
  base: z.string(),
  branch: z.string(),
  worktree: z.string(),
  // The branch this run's work was merged INTO when `lathe accept` ran (CONTRACT
  // X1). Written by acceptRun alongside status: "accepted". The clone sandbox and
  // the run's own `meridian/<runId>` branch are destroyed by accept, so this is
  // the only record of where the converged work now lives — a staged child of an
  // accepted tip must base off this branch (the canonical repo already has it),
  // never the deleted sandbox branch. Absent until accepted.
  acceptedInto: z.string().optional(),
  // Copied from the packet at run start so `meridian tail` can show it without
  // re-parsing the packet (the run slug is the fallback when absent).
  summary: z.string().optional(),
  babySessionId: z.string().optional(),
  daddySessionId: z.string().optional(),
  // Super-daddy's convergence-reviewer session, rooted in the run's worktree
  // (same feed as baby). Written by converge-run as soon as the reviewer binds
  // its session so `lathe tail` can route super-daddy's live tool calls to its
  // pane — mirrors daddySessionId. Optional: absent before/after convergence.
  reviewerSessionId: z.string().optional(),
  blockedReason: BlockedReason.optional(),
  blockedQuestion: z.string().optional(),
  // P6: count of automatic post-stall requeues spent on this run (§5 R10).
  // Carried across resumes; reset to 0 when Max answers a park (a human looked).
  stallRetries: z.number().int().min(0).default(0),
  // Count of automatic crash recoveries spent on this run (§5 R10 sibling).
  // Carried across resumes; reset to 0 when Max answers a park (a human
  // looked). Mirrors stallRetries but for the crashed branch.
  crashRetries: z.number().int().min(0).default(0),
  // Count of consecutive reorients (hallucination recoveries) spent without an
  // intervening accepted planner decision — the misfire tripwire. Reset to 0 on
  // any accepted consult (the reseeded Baby recovered); at maxReorientRetries the
  // driver stops rotating and parks for Max.
  reorientRetries: z.number().int().min(0).default(0),
  // Count of CONSECUTIVE convergence attempts where super-daddy was UNREACHABLE
  // (a transport drop, not a verdict). A non-result is never recorded as a pass,
  // so the run stays retryable; this counter is the only memory of the drops.
  // Reset to 0 on any reviewed outcome. At thresholds.maxReviewerUnreachable the
  // driver stops self-retrying and parks for Max (Codex durably down/misconfig).
  reviewerUnreachable: z.number().int().min(0).default(0),
  // Whether baby's inference has been promoted to the strong (daddy-class) model
  // for this run — the last-ditch "one more set of retries on a bigger model"
  // before a retry cap escalates to Max (§5 R10 + promote-at-cap). Persisted so
  // it survives the requeue/resume that carries the promotion into the next
  // attempt; reset to false when Max answers a park (a human looked) so a later
  // stall cycle can promote again. Only the inference changes — the agent stays
  // "baby".
  promoted: z.boolean().default(false),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  updatedAt: z.string(),
});
export type RunMeta = z.infer<typeof RunMeta>;

// ---------------------------------------------------------------------------
// Review obligations (CONTRACT M5 — replacement semantics)

export const ReviewState = z.object({
  runId: z.string(),
  obligations: z.array(z.string()),
  lastDecisionAt: z.string().optional(),
  updatedAt: z.string(),
});
export type ReviewState = z.infer<typeof ReviewState>;

// ---------------------------------------------------------------------------
// Active run pointer (driver-written, plugin-read)

export const ActiveRun = z.object({
  runId: z.string(),
  runDir: z.string(),
  worktree: z.string(),
  babySessionId: z.string(),
  startedAt: z.string(),
});
export type ActiveRun = z.infer<typeof ActiveRun>;

export const ActiveConvergence = z.object({
  runId: z.string(),
  startedAt: z.string(),
});
export type ActiveConvergence = z.infer<typeof ActiveConvergence>;

// ---------------------------------------------------------------------------
// Decision (CONTRACT §9)

export const Decision = z.object({
  timestamp: z.string(),
  source: z.enum(["daddy", "max"]),
  questionType: z.string(),
  currentSlice: z.string().optional(),
  question: z.string(),
  approach: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  status: z.string(),
  answer: z.string(),
  constraints: z.array(z.string()).default([]),
  messageId: z.string().optional(),
});
export type Decision = z.infer<typeof Decision>;

// ---------------------------------------------------------------------------
// Run start decision — fresh vs resume (CONTRACT §3, §5 R10 sibling)
//
// Pure function, no I/O. Replaces the naive `babySessionId !== undefined`
// heuristic in execute-run.ts. Rules:
//   - no prior meta or no babySessionId → fresh (nothing to resume)
//   - a queue packet that EXISTS and DIFFERS from the frozen snapshot →
//     fresh (the spec was edited; a session must never continue under a
//     changed packet — sharpens K3 "fail closed if the file changed")
//   - otherwise → resume (live session + unchanged packet)
// ---------------------------------------------------------------------------

export type RunStartDecision = { mode: "resume" } | { mode: "fresh"; reason: string };

export const decideRunStart = (
  priorMeta: { babySessionId?: string; daddySessionId?: string; attempt?: number } | undefined,
  frozenPacket: string,
  queuePacket: string | undefined,
): RunStartDecision => {
  // No prior state — nothing to resume.
  if (!priorMeta) {
    return { mode: "fresh", reason: "no prior run state" };
  }

  // No baby session — nothing to resume.
  if (!priorMeta.babySessionId) {
    return { mode: "fresh", reason: "no prior baby session" };
  }

  // No frozen packet AND no queue packet — fresh (shouldn't happen in practice,
  // but if there's no packet at all, we can't resume meaningfully).
  if (!frozenPacket && !queuePacket) {
    return { mode: "fresh", reason: "no packet available" };
  }

  // Queue packet exists and differs from the frozen snapshot — the spec was
  // edited between runs. Restart fresh on the current packet.
  if (queuePacket && frozenPacket && queuePacket !== frozenPacket) {
    return { mode: "fresh", reason: "queue packet differs from frozen snapshot" };
  }

  // Queue packet exists but no frozen packet — the frozen snapshot is absent,
  // so we have nothing to resume from. Use the queue packet fresh.
  if (queuePacket && !frozenPacket) {
    return { mode: "fresh", reason: "no frozen snapshot, using queue packet" };
  }

  // Otherwise — prior session exists, packet is unchanged → resume.
  return { mode: "resume" };
};
