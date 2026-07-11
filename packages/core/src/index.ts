// ---------------------------------------------------------------------------
// @lathe/core public surface.
//
// The barrel the server + CLI apps consume. Deep imports still work inside the
// package; cross-package consumers go through here so the boundary is explicit.
// Grows as P01–P05 promote internals (store ports, supervisor) to public API.
// ---------------------------------------------------------------------------

export { JournalEvent, renderJournalEvent, isDriverEvent } from "./domain/journal.js";
export { Config } from "./config/schemas.js";
export { loadConfig } from "./config/config.js";
export { makePaths, expandHome } from "./config/paths.js";
export type { Paths } from "./config/paths.js";

// ---------------------------------------------------------------------------
// Ports (types consumed by use cases — re-exported for the server barrel)
// ---------------------------------------------------------------------------

export type { Clock } from "./application/ports/clock.js";
export type { Repo } from "./application/ports/repo.js";
export { RunTransitionConflictError } from "./application/errors/run-transition-conflict.js";
export type { Store } from "./application/ports/store.js";
export { noopDriverOutput } from "./application/ports/driver-output.js";
export type {
  DriverOutput,
  VerificationPhase,
  VerificationProcessEvent,
} from "./application/ports/driver-output.js";

// ---------------------------------------------------------------------------
// Infrastructure (concrete adapters consumed by the server)
// ---------------------------------------------------------------------------

export { SqliteStoreAdapter } from "./infrastructure/sqlite-store.js";
export { systemClock } from "./infrastructure/clock.js";
export {
  createEvents,
  createContextTokenReader,
  createMessageHistoryReader,
} from "./infrastructure/opencode/events.js";
export type {
  OpencodeEvent,
  OpencodeMessage,
  OpencodeMessagePart,
} from "./application/ports/events.js";

// ---------------------------------------------------------------------------
// Composition root (buildRepo + runDriver — the server hosts these)
// ---------------------------------------------------------------------------

export { buildRepo, runDriver } from "./composition.js";

// ---------------------------------------------------------------------------
// Use cases (lifecycle methods delegate to these)
// ---------------------------------------------------------------------------

export { admitPacket } from "./application/use-cases/admit-packet.js";
export { validatePacket } from "./application/use-cases/validate-packet.js";
export { acceptRun } from "./application/use-cases/accept-run.js";
export { recoverAcceptedCleanup } from "./application/use-cases/recover-acceptance-cleanup.js";
export { answerRun } from "./application/use-cases/answer-run.js";
export { promoteStaged } from "./application/use-cases/chain-promotion.js";
export {
  runLoop,
  parkOrphanedRuns,
  recoverStaleActiveRuns,
} from "./application/use-cases/run-loop.js";
export type {
  ExecuteRunCallback,
  ConvergeCallback,
  WaitForWorkCallback,
  RunAbort,
  RunLoopSeams,
} from "./application/use-cases/run-loop.js";
export { createConfigSource } from "./application/use-cases/run-runtime.js";
export type { ConfigSource } from "./application/use-cases/run-runtime.js";

// ---------------------------------------------------------------------------
// Domain (pure helpers consumed by lifecycle methods)
// ---------------------------------------------------------------------------

export { parseStaged } from "./domain/chain.js";
export { parsePacketShape } from "./domain/packet.js";
export { isLatched, gateReason } from "./domain/gate.js";
export type { StagedInfo } from "./domain/chain.js";
export type { RunMeta } from "./domain/run.js";
export type { Plan } from "./domain/plan.js";
export type { ValidatePacketResult } from "./application/use-cases/validate-packet.js";
