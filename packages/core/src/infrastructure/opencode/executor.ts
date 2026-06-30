// Executor adapter: thin HTTP client over the opencode API.
// sendMessage uses node:http.request (NOT fetch — the >300s turn-death scar).
// createSession/listMessages/abortSession/deleteSession use fetch (short calls only).

import { request as httpRequest } from "node:http";
import type { Executor, ModelConfig } from "../../application/ports/executor.js";
import type { Config } from "../../config/schemas.js";
import type { TurnResponse } from "../../domain/agent-response.js";

// ---------------------------------------------------------------------------
// Streaming body parser
// SSE / NDJSON bodies carry data: lines or bare JSON lines;
// the complete message (info + parts) is among the payloads.

const parseStreamingBody = (body: string): TurnResponse => {
  const payloads: unknown[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "[DONE]") {
      continue;
    }
    const data = trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed;
    if (data === "[DONE]") {
      continue;
    }
    try {
      payloads.push(JSON.parse(data));
    } catch {
      /* skip unparseable */
    }
  }
  const complete = payloads.find(
    (p): p is TurnResponse => typeof p === "object" && p !== null && "info" in p && "parts" in p,
  );
  if (!complete) {
    throw new Error("streaming response contained no complete message payload");
  }
  return complete;
};

export const createOpencodeClient = (config: Config): Executor => {
  const base = `http://127.0.0.1:${config.opencode.port}`;

  // Sessions are scoped to a directory via the query param:
  // Baby and Daddy both live in the run's worktree, so file access inside it
  // is internal and the repo never trips external-directory permission asks.
  const createSession = async (title: string, directory: string): Promise<string> => {
    const res = await fetch(`${base}/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      throw new Error(`session create failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      throw new Error(`session create returned no id: ${JSON.stringify(data)}`);
    }
    return data.id;
  };

  // node:http, not fetch: a turn's response can take as long as the model takes.
  // undici's fetch can abort long-running responses before the configured model
  // timeout. The only timeout here is ours.
  const sendMessage = (
    sessionId: string,
    text: string,
    model: ModelConfig,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TurnResponse> =>
    new Promise<TurnResponse>((resolve, reject) => {
      const payload = JSON.stringify({
        model: { providerID: model.providerId, modelID: model.modelId },
        agent: model.agent,
        parts: [{ type: "text", text }],
      });
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idleMs = config.idleTimeoutMs;
      const armIdle = (): void => {
        if (idleMs === false) {
          return;
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => {
          req.destroy(new Error(`no data for ${idleMs}ms — connection stalled`));
        }, idleMs);
      };
      const req = httpRequest(
        `${base}/session/${sessionId}/message`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          // Arm the idle timer when the response starts (headers received).
          // It resets on each data chunk. If silence exceeds idleTimeoutMs,
          // the request is destroyed.
          armIdle();
          res.on("data", (c: Buffer) => {
            // Reset the idle timer on every chunk of data.
            armIdle();
            chunks.push(c);
          });
          res.on("end", () => {
            cleanup();
            const body = Buffer.concat(chunks).toString("utf-8");
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`message send failed: ${res.statusCode} ${body.slice(0, 500)}`));
              return;
            }
            try {
              const contentType = res.headers["content-type"] ?? "";
              if (contentType.includes("application/json") || contentType.includes("text/plain")) {
                resolve(JSON.parse(body) as TurnResponse);
              } else {
                resolve(parseStreamingBody(body));
              }
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          });
          res.on("error", (err) => {
            cleanup();
            reject(err);
          });
        },
      );
      // Two ways the request settles early: our own deadline, or the caller
      // aborting (MCP request cancelled). Both destroy the socket, which surfaces
      // as a req 'error' → reject, which the caller's catch then handles.
      const timer = setTimeout(
        () => req.destroy(new Error(`turn exceeded ${timeoutMs}ms`)),
        timeoutMs,
      );
      const onAbort = (): void => {
        req.destroy(new Error("request cancelled by caller (abandoned)"));
      };
      const cleanup = (): void => {
        clearTimeout(timer);
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        signal?.removeEventListener("abort", onAbort);
      };
      req.on("error", (err) => {
        cleanup();
        reject(err);
      });
      if (signal?.aborted === true) {
        req.destroy(new Error("request cancelled by caller (abandoned)"));
      } else {
        signal?.addEventListener("abort", onAbort, { once: true });
      }
      req.end(payload);
    });

  const listMessages = async (sessionId: string): Promise<TurnResponse[]> => {
    const res = await fetch(`${base}/session/${sessionId}/message`);
    if (!res.ok) {
      throw new Error(`message list failed: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as TurnResponse[];
  };

  const abortSession = async (sessionId: string): Promise<void> => {
    const res = await fetch(`${base}/session/${sessionId}/abort`, { method: "POST" });
    if (!res.ok) {
      throw new Error(`session abort failed: ${res.status} ${await res.text()}`);
    }
  };

  const deleteSession = async (sessionId: string): Promise<void> => {
    await fetch(`${base}/session/${sessionId}`, { method: "DELETE" });
  };

  return { createSession, sendMessage, listMessages, abortSession, deleteSession };
};
