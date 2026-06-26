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
export type Harvest = { text: string; error: string | null };

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
    return { text: text.trim().length > 0 ? text : extractText(response), error };
  } catch {
    // Listing failed — fall back to the single send response.
    return { text: extractText(response), error: messageError(response.info) };
  }
};
