import { z } from "zod"

// ---------------------------------------------------------------------------
// Gate state (CONTRACT §10) — driver-written, plugin-read

export const DiffStat = z.object({ added: z.number(), removed: z.number() })

export const GateState = z.object({
  runId: z.string(),
  latched: z.boolean(),
  latchReason: z.string().optional(),
  firstEditApproved: z.boolean(),
  reconciliationRequired: z.boolean(),
  expectedGlobs: z.array(z.string()),
  suspiciousGlobs: z.array(z.string()),
  baselineDiffStats: z.record(z.string(), DiffStat),
  lastAcceptedDecisionAt: z.string().optional(),
  // Plumbed to the plugin (§10) so its allow-path checkpoint NOTICE uses the same
  // interval as the driver's per-turn nudge. Optional so gate-state written before
  // this field still validates on resume (the plugin falls back to 20 min).
  checkpointNudgeMs: z.number().int().optional(),
  // Volume-based checkpoint reminder (§10) — the work-interval cadence reborn as a
  // non-blocking SHOUT. The plugin reads these and appends the SAME message a block
  // would show (without throwing) once Baby has done this much work since its last
  // planner check-in: `checkpointToolCalls` tool calls (any tool, reads included),
  // or `checkpointFiles`/`checkpointLoc` of diff. Optional → gate-state from before
  // these fields still validates (plugin falls back to no volume reminder).
  checkpointToolCalls: z.number().int().optional(),
  checkpointFiles: z.number().int().optional(),
  checkpointLoc: z.number().int().optional(),
  mutationCommandPatterns: z.array(z.string()).default([]),
  updatedAt: z.string(),
})
export type GateState = z.infer<typeof GateState>

// The gate a fresh run starts with (R2/G5): first-edit is unapproved (the first
// edit demands an accepted planner decision), nothing is reconciling, and the
// config-derived cadence limits are stamped in so the plugin and driver agree.
// Pure: the caller supplies `nowIso`. The expected/suspicious surface come from
// the packet frontmatter; the cadence limits + mutation patterns from config.
export const initialGateState = (
  runId: string,
  expectedGlobs: string[],
  suspiciousGlobs: string[],
  limits: {
    checkpointNudgeMs: number
    checkpointToolCalls: number
    checkpointFiles: number
    checkpointLoc: number
    mutationCommandPatterns: string[]
  },
  nowIso: string,
): GateState => ({
  runId,
  latched: false,
  firstEditApproved: false,
  reconciliationRequired: false,
  expectedGlobs,
  suspiciousGlobs,
  baselineDiffStats: {},
  checkpointNudgeMs: limits.checkpointNudgeMs,
  checkpointToolCalls: limits.checkpointToolCalls,
  checkpointFiles: limits.checkpointFiles,
  checkpointLoc: limits.checkpointLoc,
  mutationCommandPatterns: limits.mutationCommandPatterns,
  updatedAt: nowIso,
})
