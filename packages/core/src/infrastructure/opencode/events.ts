// Events adapter: subscribes to the serve instance's global SSE feed — the same
// stream the opencode TUI renders from.
// Used by `lathe tail` for live token-level output; the driver never depends
// on it. node:http (not fetch): a long-lived GET that streams until closed.

import { request as httpRequest } from "node:http";
import type { Events, OpencodeEvent, EventSubscription } from "../../application/ports/events.js";
import type { Config } from "../../config/schemas.js";

type OpenCodeMessage = {
  info?: {
    role?: string;
    tokens?: {
      total?: number;
    };
  };
  parts?: Array<{
    type?: string;
    tokens?: {
      total?: number;
    };
  }>;
};

const latestAssistantContextTokens = (messages: OpenCodeMessage[]): number | undefined => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.info?.role !== "assistant") {
      continue;
    }
    const infoTotal = message.info.tokens?.total;
    if (typeof infoTotal === "number") {
      return infoTotal;
    }
    const finishTotal = [...(message.parts ?? [])]
      .reverse()
      .find((part) => part.type === "step-finish" && typeof part.tokens?.total === "number")
      ?.tokens?.total;
    if (typeof finishTotal === "number") {
      return finishTotal;
    }
  }
  return undefined;
};

export const createEvents = (config: Config): Events => ({
  subscribe: (directory: string, onEvent: (event: OpencodeEvent) => void): EventSubscription => {
    // The feed is per-instance, scoped by directory exactly like sessions — an
    // unscoped subscription sees only its own server.connected handshake.
    const url = `http://127.0.0.1:${config.opencode.port}/event?directory=${encodeURIComponent(directory)}`;
    let closed = false;
    let req: ReturnType<typeof httpRequest> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;

    const scheduleReconnect = (): void => {
      if (closed || reconnect) {
        return;
      }
      req?.destroy();
      reconnect = setTimeout(() => {
        reconnect = undefined;
        connect();
      }, 1_000);
    };

    const connect = (): void => {
      req = httpRequest(url, { method: "GET" }, (res) => {
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
        res.on("end", scheduleReconnect);
        res.on("close", scheduleReconnect);
      });
      req.on("error", scheduleReconnect);
      req.end();
    };

    connect();
    return {
      close: () => {
        closed = true;
        if (reconnect) {
          clearTimeout(reconnect);
        }
        req?.destroy();
      },
    };
  },
});

export const createContextTokenReader = (config: Config) => {
  const base = `http://127.0.0.1:${config.opencode.port}`;
  return async (sessionId: string, signal?: AbortSignal): Promise<number | undefined> => {
    const res = await fetch(`${base}/session/${sessionId}/message`, { signal });
    if (!res.ok) {
      return undefined;
    }
    return latestAssistantContextTokens((await res.json()) as OpenCodeMessage[]);
  };
};
