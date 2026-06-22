// Events port: the opencode serve instance's live SSE feed (CONTRACT X3, D4).
// The tail TUI subscribes for live token-level Baby/Daddy output; the driver
// itself never depends on it (turns are awaited POSTs). Interfaces only — zero
// runtime. Generic event shape so the port does not pull in opencode specifics.

export type OpencodeEvent = { type: string; properties?: Record<string, unknown> };

export type EventSubscription = { close: () => void };

export type Events = {
  subscribe(directory: string, onEvent: (event: OpencodeEvent) => void): EventSubscription;
};
