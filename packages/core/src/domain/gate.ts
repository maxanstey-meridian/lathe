import { z } from "zod";

// ---------------------------------------------------------------------------
// Gate state (CONTRACT §10) — driver-written, plugin-read

export const DiffStat = z.object({ added: z.number(), removed: z.number() });

// The five gate phases. Invalid boolean combinations are unconstructable.
// Factories (initialGateState, clearedGateState, rotationGateState,
// relatchGate) are the only way to produce these values.
export const GatePhase = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("initial") }),
  z.object({ phase: z.literal("first-edit-latched"), reason: z.string() }),
  z.object({ phase: z.literal("reconciliation-latched"), reason: z.string() }),
  z.object({ phase: z.literal("cleared") }),
  z.object({ phase: z.literal("checkpoint-demand-latched"), reason: z.string() }),
]);
export type GatePhase = z.infer<typeof GatePhase>;

// Shared config fields orthogonal to the phase.
const GateStateFields = z.object({
  runId: z.string(),
  // Top-level (not inside phase): rotation spreads state, preserving this
  // sentinel across phase changes. The bridge's get_decisions uses it to
  // prevent stale decisions from re-clearing the gate.
  lastAcceptedDecisionAt: z.string().optional(),
  expectedGlobs: z.array(z.string()),
  suspiciousGlobs: z.array(z.string()),
  baselineDiffStats: z.record(z.string(), DiffStat),
  // Plumbed to the plugin (§10) so its allow-path checkpoint NOTICE uses the same
  // interval as the driver's per-turn nudge. Optional so gate-state written before
  // this field still validates on resume (the plugin falls back to 20 min).
  checkpointNudgeMs: z.number().int().optional(),
  // Volume-based checkpoint reminder (§10). The plugin reads these and appends the
  // same message a block would show (without throwing) once the executor has done
  // this much work since its last planner check-in: `checkpointToolCalls` tool calls (any tool, reads included),
  // or `checkpointFiles`/`checkpointLoc` of diff. Optional → gate-state from before
  // these fields still validates (plugin falls back to no volume reminder).
  checkpointToolCalls: z.number().int().optional(),
  checkpointFiles: z.number().int().optional(),
  checkpointLoc: z.number().int().optional(),
  mutationCommandPatterns: z.array(z.string()).default([]),
  updatedAt: z.string(),
});

const GateStateNew = GateStateFields.extend({ phase: GatePhase });

export const GateState = GateStateNew;
export type GateState = z.infer<typeof GateStateNew>;

// Read helpers — eliminate verbose phase narrowing at consumer sites.
export const isLatched = (gate: GateState): boolean =>
  gate.phase.phase !== "initial" && gate.phase.phase !== "cleared";

export const gateReason = (gate: GateState): string | undefined => {
  switch (gate.phase.phase) {
    case "first-edit-latched":
    case "reconciliation-latched":
    case "checkpoint-demand-latched":
      return gate.phase.reason;
    case "initial":
    case "cleared":
      return undefined;
  }
};

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
    checkpointNudgeMs: number;
    checkpointToolCalls: number;
    checkpointFiles: number;
    checkpointLoc: number;
    mutationCommandPatterns: string[];
  },
  nowIso: string,
): GateState => ({
  runId,
  phase: { phase: "initial" },
  expectedGlobs,
  suspiciousGlobs,
  baselineDiffStats: {},
  checkpointNudgeMs: limits.checkpointNudgeMs,
  checkpointToolCalls: limits.checkpointToolCalls,
  checkpointFiles: limits.checkpointFiles,
  checkpointLoc: limits.checkpointLoc,
  mutationCommandPatterns: limits.mutationCommandPatterns,
  updatedAt: nowIso,
});
