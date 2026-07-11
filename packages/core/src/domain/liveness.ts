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
