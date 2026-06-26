import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TurnResponse } from "../src/domain/agent-response.js";
import {
  extractText,
  firstProviderError,
  harvestAssistantText,
} from "../src/domain/agent-response.js";

const assistant = (id: string, text: string): TurnResponse => ({
  info: { id, sessionID: "s", role: "assistant" },
  parts: text ? [{ type: "text", text }] : [],
});

describe("harvestAssistantText (the all-message harvest, pure half)", () => {
  it("recovers a verdict that lives only in a non-final message (the fix2 scar)", () => {
    // A multi-step turn ended on an EMPTY final message with the verdict emitted
    // in an earlier step. extractText reads only the final response → loses it.
    const final = assistant("final", "");
    assert.equal(extractText(final), "");

    const turns = [assistant("a1", '{"verdict":"accept"}'), final];
    assert.equal(harvestAssistantText(turns), '{"verdict":"accept"}');
  });

  it("concatenates text across every turn, newline-joined", () => {
    const turns = [assistant("a1", "part one"), assistant("a2", "part two")];
    assert.equal(harvestAssistantText(turns), "part one\npart two");
  });

  it("is empty for no turns / no text parts", () => {
    assert.equal(harvestAssistantText([]), "");
    assert.equal(harvestAssistantText([assistant("a1", "")]), "");
  });
});

describe("firstProviderError", () => {
  it("returns the first turn carrying a provider error, formatted with status", () => {
    const turns: TurnResponse[] = [
      assistant("a1", "fine"),
      {
        info: {
          id: "a2",
          sessionID: "s",
          role: "assistant",
          error: { name: "APIError", data: { statusCode: 503, message: "upstream" } },
        },
        parts: [],
      },
    ];
    assert.equal(firstProviderError(turns), "APIError (HTTP 503): upstream");
  });

  it("is null when no turn carried an error", () => {
    assert.equal(firstProviderError([assistant("a1", "ok"), assistant("a2", "done")]), null);
  });
});
