// System clock adapter: real Date calls, injected via the Clock port
// (ARCHITECTURE §3.3).

import type { Clock } from "../application/ports/clock.js"

export const systemClock: Clock = {
  now: () => Date.now(),
  nowIso: () => new Date().toISOString(),
}
