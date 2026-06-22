// Agent response shapes (opencode HTTP API). Pure types and pure helpers — the
// adapter name "opencode" never leaks into domain. Imported by the Executor port.
//
// Reference: reference/src/opencode.ts:270-310, 497-512.

export type MessagePart = {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    metadata?: Record<string, unknown>;
  };
};

export type MessageInfo = {
  id: string;
  sessionID: string;
  role?: string;
  providerID?: string;
  modelID?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  cost?: number;
  error?: {
    name?: string;
    data?: { message?: string; statusCode?: number; responseBody?: string };
  };
};

export type TurnResponse = { info: MessageInfo; parts: MessagePart[] };

// Pure helper: extract all text parts from a turn response.
export const extractText = (response: TurnResponse): string =>
  response.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n");

// Pure helper: extract all reasoning parts from a turn response.
export const extractReasoning = (response: TurnResponse): string =>
  response.parts
    .filter((p) => p.type === "reasoning" && p.text)
    .map((p) => p.text)
    .join("\n");

// Pure helper: whether a part represents a MERIDIAN GATE denial.
export const gateDeniedPart = (part: MessagePart): boolean =>
  part.type === "tool" &&
  part.state?.status === "error" &&
  `${part.state.output ?? ""}${part.state.error ?? ""}`.includes("MERIDIAN GATE");

// Pure helper: one-line rendering of a turn's provider error (MessageInfo.error),
// or null when the turn carried none.
export const messageError = (info: MessageInfo): string | null => {
  const e = info.error;
  if (!e) return null;
  const status = typeof e.data?.statusCode === "number" ? ` (HTTP ${e.data.statusCode})` : "";
  const detail = e.data?.message ?? e.name ?? "unknown provider error";
  return `${e.name ?? "provider error"}${status}: ${detail}`;
};
