// ---------------------------------------------------------------------------
// Liveness decisions (CONTRACT §5 R10, L3)
//
// Pure functions — no I/O, no clock. The reference boundaries in
// reference/tests/core.test.mjs:907-968 are pin-tight.
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
// the convergence circuit breaker: auto-requeue up to maxStallRetries, then
// escalate so a deterministic stall can't requeue forever.
// ---------------------------------------------------------------------------

export type StallRecoveryDecision =
  | { action: "requeue"; stallRetries: number }
  | { action: "escalate"; stallRetries: number }
  | { action: "none" };

export const decideStallRecovery = (
  meta: { status: string; blockedReason?: string; stallRetries: number },
  maxStallRetries: number,
): StallRecoveryDecision => {
  if (meta.status !== "blocked" || meta.blockedReason !== "wedged") {
    return { action: "none" };
  }
  const used = meta.stallRetries ?? 0;
  return used < maxStallRetries
    ? { action: "requeue", stallRetries: used + 1 }
    : { action: "escalate", stallRetries: used };
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
