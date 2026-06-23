/**
 * STAGING REFERENCE — drop into apps/lathe-server/src in P00.
 *
 * Maps the validated core `Config` (config/schemas.ts) onto the read-only
 * `ConfigDto` the GUI's "twizzles" panel renders. Read-only for the MVP —
 * GET /config only. A future PATCH lands behind its own endpoint + validation.
 *
 * NOTE: `turnSteps` in the DTO maps to baby.turnSteps (Baby's per-turn step
 * cap — the knob the operator actually twizzles). daddy/superdaddy have their
 * own turnSteps; expose those separately if the panel needs them.
 */
import type { Config } from "@lathe/core";
import type { ConfigDto } from "@lathe/contract";

export const configToDto = (c: Config): ConfigDto => ({
  models: {
    baby: {
      modelId: c.baby.modelId,
      baseUrl: c.baby.baseUrl,
      contextWindow: c.baby.contextWindow,
    },
    daddy: {
      modelId: c.daddy.modelId,
      provider: c.daddy.providerId,
    },
    superdaddy: {
      modelId: c.superdaddy.modelId,
    },
  },
  thresholds: {
    ladderParkAt: c.thresholds.ladderParkAt,
    ladderRotateAt: c.thresholds.ladderRotateAt,
    maxPasses: c.thresholds.maxPasses,
    turnSteps: c.baby.turnSteps,
  },
});
