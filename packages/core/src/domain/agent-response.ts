// Agent response shapes (opencode HTTP API). Pure types and pure helpers — the
// adapter name "opencode" never leaks into domain. Imported by the Executor port.

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

// Pure helper: the all-message harvest's pure half. Concatenate text from EVERY
// given turn, not just the last one — a multi-step turn (mini-model running bash
// across several steps) can end on an EMPTY final message with the real content in
// an earlier step (the 0-char-final-message scar). The adapter filters to assistant
// turns and supplies them; this just reads their text. No opencode dependency.
export const harvestAssistantText = (turns: TurnResponse[]): string =>
  turns
    .flatMap((t) => t.parts)
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n");

// Pure helper: the first provider error across a set of turns, or null if none
// carried one. A provider/transport failure rides on a turn's info.error with HTTP
// 200 and empty parts, so without this an infra failure is indistinguishable from a
// silent model.
export const firstProviderError = (turns: TurnResponse[]): string | null =>
  turns.map((t) => messageError(t.info)).find((e): e is string => e !== null) ?? null;

export const isContextOverflowError = (info: MessageInfo): boolean => {
  const error = info.error;
  if (!error) {
    return false;
  }

  const name = error.name ?? "";
  const message = error.data?.message ?? "";
  const responseBody = error.data?.responseBody ?? "";
  const detail = `${name}\n${message}\n${responseBody}`.toLowerCase();

  return (
    name === "ContextOverflowError" ||
    detail.includes("exceed_context_size_error") ||
    detail.includes("exceeds the available context size")
  );
};

// Pure helper: extract all reasoning parts from a turn response.
export const extractReasoning = (response: TurnResponse): string =>
  response.parts
    .filter((p) => p.type === "reasoning" && p.text)
    .map((p) => p.text)
    .join("\n");

// Pure helper: whether a part represents a LATHE GATE denial.
export const gateDeniedPart = (part: MessagePart): boolean =>
  part.type === "tool" &&
  part.state?.status === "error" &&
  `${part.state.output ?? ""}${part.state.error ?? ""}`.includes("LATHE GATE");

// Pure helper: one-line rendering of a turn's provider error (MessageInfo.error),
// or null when the turn carried none.
export const messageError = (info: MessageInfo): string | null => {
  const e = info.error;
  if (!e) {
    return null;
  }
  const status = typeof e.data?.statusCode === "number" ? ` (HTTP ${e.data.statusCode})` : "";
  const detail = e.data?.message ?? e.name ?? "unknown provider error";
  return `${e.name ?? "provider error"}${status}: ${detail}`;
};
