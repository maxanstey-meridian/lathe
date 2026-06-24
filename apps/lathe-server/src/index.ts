// ---------------------------------------------------------------------------
// @lathe/server public surface.
//
// The Hono daemon factory + its supporting pieces. Handlers are stubbed (501)
// until P03; the event projection + bus + single-instance lock are real seeds
// the supervisor (P02) and SSE feed (P04) build on.
// ---------------------------------------------------------------------------

export { createApp, createEventBus } from "./app.js";
export type { Supervisor, NonChainTipError, TerminalRunError, RunNotFoundError } from "./supervisor.js";
export type { AppDeps, CreateAppOptions, EventBus } from "./app.js";
export { acquireSingleInstanceLock, DaemonAlreadyRunningError } from "./single-instance-lock.js";
export { projectJournalEvent } from "./event-projection.js";
export type { ProjectionContext } from "./event-projection.js";
export { configToDto } from "./config-to-dto.js";
