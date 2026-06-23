// ---------------------------------------------------------------------------
// @lathe/core public surface.
//
// The barrel the server + CLI apps consume. Deep imports still work inside the
// package; cross-package consumers go through here so the boundary is explicit.
// Grows as P01–P05 promote internals (store ports, supervisor) to public API.
// ---------------------------------------------------------------------------

export { JournalEvent, renderJournalEvent } from "./domain/journal.js";
export { Config } from "./config/schemas.js";
export { makePaths, expandHome } from "./config/paths.js";
export type { Paths } from "./config/paths.js";
