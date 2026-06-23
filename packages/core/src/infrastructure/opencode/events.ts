// Events adapter: subscribes to the serve instance's global SSE feed — the same
// stream the opencode TUI renders from (ported from reference/src/opencode.ts).
// Used by `meridian tail` for live token-level output; the driver never depends
// on it. node:http (not fetch): a long-lived GET that streams until closed.

import { request as httpRequest } from "node:http";
import type { Events, OpencodeEvent, EventSubscription } from "../../application/ports/events.js";
import type { Config } from "../../config/schemas.js";

export const createEvents = (config: Config): Events => ({
  subscribe: (directory: string, onEvent: (event: OpencodeEvent) => void): EventSubscription => {
    // The feed is per-instance, scoped by directory exactly like sessions — an
    // unscoped subscription sees only its own server.connected handshake.
    const url = `http://127.0.0.1:${config.opencode.port}/event?directory=${encodeURIComponent(directory)}`;
    const req = httpRequest(url, { method: "GET" }, (res) => {
      let buffer = "";
      res.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) {
            continue;
          }
          try {
            onEvent(JSON.parse(line.slice(5).trim()) as OpencodeEvent);
          } catch {
            /* partial or non-JSON frame — skip */
          }
        }
      });
    });
    req.on("error", () => {
      /* server gone — tail falls back to journal-only polling */
    });
    req.end();
    return { close: () => req.destroy() };
  },
});
