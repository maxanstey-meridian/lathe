// ---------------------------------------------------------------------------
// Liveness decisions (CONTRACT §5 R10, L3)
//
// Pure functions — no I/O, no clock. Boundary behavior is covered by liveness tests.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stall decision — ladder action on no-progress (CONTRACT §6 L3)
//
// Precedence: park (backstop always wins first) → rotate (every rotateAt
// dead turns) → nudge (default). A misconfigured rotateAt ≥ parkAt can
// never rotate forever — the backstop is the guarantee (R10/R3 scar).
// ---------------------------------------------------------------------------

export type StallAction = "park" | "rotate" | "nudge";

export const stallAction = (ladder: number, rotateAt: number, parkAt: number): StallAction => {
  if (ladder >= parkAt) {
    return "park";
  }
  if (rotateAt > 0 && ladder % rotateAt === 0) {
    return "rotate";
  }
  return "nudge";
};

// ---------------------------------------------------------------------------
// Stall recovery — bounded auto-requeue for wedged parks (CONTRACT §5 R10)
//
// Only a wedged park is recoverable: crashed and judgement parks (human_decision,
// scope_expansion, stop_condition) are never auto-retried. Bounded exactly like
// the convergence circuit breaker: auto-requeue up to maxStallRetries. At the
// cap, before escalating to Max, PROMOTE baby to the strong (daddy-class) model
// for one more set of retries — same task, bigger inference (promote-at-cap). A
// deterministic stall still can't requeue forever: the promoted run gets one
// fresh budget, then escalates.
// ---------------------------------------------------------------------------

export type StallRecoveryDecision =
  | { action: "requeue"; stallRetries: number }
  // Cap hit on baby's normal model: requeue with the strong model and a fresh
  // retry budget (stallRetries reset to 0). Fires at most once per run.
  | { action: "promote"; stallRetries: number }
  | { action: "escalate"; stallRetries: number }
  | { action: "none" };

export const decideStallRecovery = (
  meta: { status: string; blockedReason?: string; stallRetries: number; promoted?: boolean },
  maxStallRetries: number,
  promoteAtCap = true,
): StallRecoveryDecision => {
  if (meta.status !== "blocked" || meta.blockedReason !== "wedged") {
    return { action: "none" };
  }
  const used = meta.stallRetries ?? 0;
  if (used < maxStallRetries) {
    return { action: "requeue", stallRetries: used + 1 };
  }
  // Cap reached. One more set of retries on the strong model before parking for
  // Max — unless that's disabled, or the strong model ALSO stalled to the cap
  // (already promoted), in which case the stall is deterministic → escalate.
  if (promoteAtCap && !(meta.promoted ?? false)) {
    return { action: "promote", stallRetries: 0 };
  }
  return { action: "escalate", stallRetries: used };
};

// ---------------------------------------------------------------------------
// Crash recovery — bounded auto-requeue for crashed parks (CONTRACT §5 R10
// sibling)
//
// Pure function, mirrors decideStallRecovery. Only a crashed park is
// recoverable: wedged, judgement, and scope parks are never touched by this
// function (they have their own paths). Bounded exactly like stall recovery:
// auto-requeue up to maxCrashRetries. At the cap, escalate to Max.
// ---------------------------------------------------------------------------

export type CrashRecoveryDecision =
  | { action: "requeue"; crashRetries: number }
  | { action: "escalate"; crashRetries: number }
  | { action: "none" };

export const decideCrashRecovery = (
  meta: { status: string; blockedReason?: string; crashRetries: number },
  maxCrashRetries: number,
): CrashRecoveryDecision => {
  if (meta.status !== "blocked" || meta.blockedReason !== "crashed") {
    return { action: "none" };
  }
  const used = meta.crashRetries ?? 0;
  if (used < maxCrashRetries) {
    return { action: "requeue", crashRetries: used + 1 };
  }
  return { action: "escalate", crashRetries: used };
};

// ---------------------------------------------------------------------------
// Reorient bound — consecutive hallucination recoveries (CONTRACT §5 R11)
//
// The counter resets to 0 on any accepted planner decision (so it measures
// CONSECUTIVE misfires, not a lifetime total). At the cap the driver stops
// rotating and parks blocked/human_decision.
// ---------------------------------------------------------------------------

export type ReorientBound =
  | { allowed: true; escalating: false }
  | { allowed: false; escalating: true };

export const checkReorientBound = (used: number, maxReorientRetries: number): ReorientBound => {
  if (used >= maxReorientRetries) {
    return { allowed: false, escalating: true };
  }
  return { allowed: true, escalating: false };
};
