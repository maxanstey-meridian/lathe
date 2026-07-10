// Shared reply harvest for the opencode adapters (the I/O half of the all-message
// harvest). The daddy planner (consult, final-review) and the super-daddy reviewer
// both read a model reply the SAME way: list every assistant message in the session
// and concatenate their text — never just the final turn, which a multi-step
// mini-model can leave empty with the verdict in an earlier step (the
// 0-char-final-message scar that parked cli-cutover-fix2). The pure text/error
// extraction lives in domain/agent-response; this is only the listMessages call and
// the single-response fallback.

import type { Executor } from "../../application/ports/executor.js";
import type { TurnResponse } from "../../domain/agent-response.js";
import {
  extractText,
  firstProviderError,
  harvestAssistantText,
  messageError,
} from "../../domain/agent-response.js";

// The raw harvested text plus any provider error. The error is distinct from
// "unparseable": a provider failure returns HTTP 200 with empty parts, so without
// surfacing it an infra failure reads as a silent model.
export type Harvest = { text: string; error: string | null; toolNames: string[] };

const toolNamesFrom = (turns: TurnResponse[]): string[] =>
  turns
    .flatMap((turn) => turn.parts)
    .filter((part) => part.type === "tool" && typeof part.tool === "string")
    .map((part) => part.tool as string);

export type MessageBoundary = { ok: true; lastMessageId: string | null } | { ok: false };

export const snapshotMessageBoundary = async (
  executor: Executor,
  sessionId: string,
): Promise<MessageBoundary> => {
  try {
    const all = await executor.listMessages(sessionId);
    return { ok: true, lastMessageId: all.at(-1)?.info.id ?? null };
  } catch {
    return { ok: false };
  }
};

export const harvestReplySince = async (
  executor: Executor,
  sessionId: string,
  boundary: MessageBoundary,
  response: TurnResponse,
): Promise<Harvest> => {
  try {
    const all = await executor.listMessages(sessionId);
    let currentExchange: TurnResponse[];
    if (!boundary.ok) {
      currentExchange = [];
    } else if (boundary.lastMessageId === null) {
      currentExchange = all;
    } else {
      const start = all.findIndex((m) => m.info.id === boundary.lastMessageId) + 1;
      currentExchange = start > 0 ? all.slice(start) : [];
    }
    const assistants = currentExchange.filter((m) => m.info.role === "assistant");
    const text = harvestAssistantText(assistants);
    const error = messageError(response.info) ?? firstProviderError(assistants);
    return {
      text: text.trim().length > 0 ? text : extractText(response),
      error,
      toolNames: assistants.length > 0 ? toolNamesFrom(assistants) : toolNamesFrom([response]),
    };
  } catch {
    return {
      text: extractText(response),
      error: messageError(response.info),
      toolNames: toolNamesFrom([response]),
    };
  }
};

export const harvestReply = async (
  executor: Executor,
  sessionId: string,
  response: TurnResponse,
): Promise<Harvest> => {
  try {
    const all = await executor.listMessages(sessionId);
    const assistants = all.filter((m) => m.info.role === "assistant");
    const text = harvestAssistantText(assistants);
    const error = messageError(response.info) ?? firstProviderError(assistants);
    // Fall back to the single send response if the harvest came back empty (e.g. a
    // fresh session whose list does not yet include this turn).
    return {
      text: text.trim().length > 0 ? text : extractText(response),
      error,
      toolNames: assistants.length > 0 ? toolNamesFrom(assistants) : toolNamesFrom([response]),
    };
  } catch {
    // Listing failed — fall back to the single send response.
    return {
      text: extractText(response),
      error: messageError(response.info),
      toolNames: toolNamesFrom([response]),
    };
  }
};

export const harvestLatestReply = async (
  executor: Executor,
  sessionId: string,
  response: TurnResponse,
): Promise<Harvest> => {
  try {
    const all = await executor.listMessages(sessionId);
    const latestAssistant = [...all].reverse().find((m) => m.info.role === "assistant");
    if (!latestAssistant) {
      return {
        text: extractText(response),
        error: messageError(response.info),
        toolNames: toolNamesFrom([response]),
      };
    }
    const text = harvestAssistantText([latestAssistant]);
    return {
      text: text.trim().length > 0 ? text : extractText(response),
      error: messageError(response.info),
      toolNames: toolNamesFrom([latestAssistant]),
    };
  } catch {
    return {
      text: extractText(response),
      error: messageError(response.info),
      toolNames: toolNamesFrom([response]),
    };
  }
};
