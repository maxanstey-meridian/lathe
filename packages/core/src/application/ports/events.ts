// Events port: the opencode serve instance's live SSE feed (CONTRACT X3, D4).
// The tail TUI subscribes for live token-level Baby/Daddy output; the driver
// itself never depends on it (turns are awaited POSTs). Interfaces only — zero
// runtime. Generic event shape so the port does not pull in opencode specifics.

export type OpencodeEvent = { id?: string; type: string; properties?: Record<string, unknown> };

export type OpencodeMessagePart = {
  id?: string;
  sessionID?: string;
  messageID?: string;
  type?: string;
  text?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  };
};

export type OpencodeMessage = {
  info?: { id?: string; sessionID?: string; role?: string };
  parts?: OpencodeMessagePart[];
};

export type EventSubscription = { close: () => void };

export type Events = {
  subscribe(
    directory: string,
    onEvent: (event: OpencodeEvent) => void,
    onReconnect?: () => void,
  ): EventSubscription;
};
