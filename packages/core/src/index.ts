// ---------------------------------------------------------------------------
// @lathe/core public surface.
//
// The barrel the server + CLI apps consume. Deep imports still work inside the
// package; cross-package consumers go through here so the boundary is explicit.
// Grows as P01–P05 promote internals (store ports, supervisor) to public API.
// ---------------------------------------------------------------------------

export { JournalEvent, renderJournalEvent } from "./domain/journal.js";
export { Config } from "./config/schemas.js";
export { loadConfig } from "./config/config.js";
export { makePaths, expandHome } from "./config/paths.js";
export type { Paths } from "./config/paths.js";

// ---------------------------------------------------------------------------
// Ports (types consumed by use cases — re-exported for the server barrel)
// ---------------------------------------------------------------------------

export type { Clock } from "./application/ports/clock.js";
export type { Repo } from "./application/ports/repo.js";
export type { Store } from "./application/ports/store.js";

// ---------------------------------------------------------------------------
// Infrastructure (concrete adapters consumed by the server)
// ---------------------------------------------------------------------------

export { SqliteStoreAdapter } from "./infrastructure/sqlite-store.js";
export { systemClock } from "./infrastructure/clock.js";
export { createEvents, createContextTokenReader } from "./infrastructure/opencode/events.js";
export type { OpencodeEvent } from "./application/ports/events.js";

// ---------------------------------------------------------------------------
// CLI composition root (buildRepo + runDriver — the server hosts these)
// ---------------------------------------------------------------------------

export { buildRepo, runDriver } from "./interfaces/cli/composition.js";

// ---------------------------------------------------------------------------
// Use cases (lifecycle methods delegate to these)
// ---------------------------------------------------------------------------

export { admitPacket } from "./application/use-cases/admit-packet.js";
export { validatePacket } from "./application/use-cases/validate-packet.js";
export { acceptRun } from "./application/use-cases/accept-run.js";
export { answerRun } from "./application/use-cases/answer-run.js";
export { promoteStaged } from "./application/use-cases/chain-promotion.js";
export {
  runLoop,
  recoverOrphanedRuns,
  recoverStaleActiveRuns,
  recoverStalledRunsAtStartup,
} from "./application/use-cases/run-loop.js";
export type {
  ExecuteRunCallback,
  ConvergeCallback,
  WaitForWorkCallback,
  RunLoopSeams,
} from "./application/use-cases/run-loop.js";

// ---------------------------------------------------------------------------
// Domain (pure helpers consumed by lifecycle methods)
// ---------------------------------------------------------------------------

export { parseStaged } from "./domain/chain.js";
export { parsePacketShape } from "./domain/packet.js";
export { isLatched, gateReason } from "./domain/gate.js";
export type { StagedInfo } from "./domain/chain.js";
export type { RunMeta } from "./domain/run.js";
export type { ValidatePacketResult } from "./application/use-cases/validate-packet.js";
