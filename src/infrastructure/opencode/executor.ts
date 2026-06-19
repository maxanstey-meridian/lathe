// Executor adapter: thin HTTP client over the opencode API (reference/src/opencode.ts:270-446).
// sendMessage uses node:http.request (NOT fetch — the >300s turn-death scar).
// createSession/listMessages/deleteSession use fetch (short calls only).

import { request as httpRequest } from "node:http"
import type { Config } from "../../config/schemas.js"
import type { TurnResponse } from "../../domain/agent-response.js"
import type { Executor, ModelConfig } from "../../application/ports/executor.js"

// ---------------------------------------------------------------------------
// Streaming body parser (reference/src/opencode.ts:312-333)
// SSE / NDJSON bodies carry data: lines or bare JSON lines;
// the complete message (info + parts) is among the payloads.

const parseStreamingBody = (body: string): TurnResponse => {
  const payloads: unknown[] = []
  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === "[DONE]") continue
    const data = trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed
    if (data === "[DONE]") continue
    try {
      payloads.push(JSON.parse(data))
    } catch {
      /* skip unparseable */
    }
  }
  const complete = payloads.find(
    (p): p is TurnResponse =>
      typeof p === "object" && p !== null && "info" in p && "parts" in p,
  )
  if (!complete) throw new Error("streaming response contained no complete message payload")
  return complete
}

export const createOpencodeClient = (config: Config): Executor => {
  const base = `http://127.0.0.1:${config.opencode.port}`

  // Sessions are scoped to a directory via the query param (proven live):
  // Baby and Daddy both live in the run's worktree, so file access inside it
  // is internal and the repo never trips external-directory permission asks.
  const createSession = async (title: string, directory: string): Promise<string> => {
    const res = await fetch(`${base}/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    })
    if (!res.ok) throw new Error(`session create failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as { id?: string }
    if (!data.id) throw new Error(`session create returned no id: ${JSON.stringify(data)}`)
    return data.id
  }

  // node:http, not fetch: a turn's response can take as long as the model
  // takes (30-min default for a local 35B). undici's fetch kills any request
  // whose headers/body stall past ~300s — learned live when every Baby turn
  // longer than 5 minutes died with "fetch failed". The only timeout here is
  // ours.
  const sendMessage = (sessionId: string, text: string, model: ModelConfig, timeoutMs: number, signal?: AbortSignal): Promise<TurnResponse> =>
    new Promise<TurnResponse>((resolve, reject) => {
      const payload = JSON.stringify({
        model: { providerID: model.providerId, modelID: model.modelId },
        agent: model.agent,
        parts: [{ type: "text", text }],
      })
      const req = httpRequest(
        `${base}/session/${sessionId}/message`,
        { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          const chunks: Buffer[] = []
          res.on("data", (c: Buffer) => chunks.push(c))
          res.on("end", () => {
            cleanup()
            const body = Buffer.concat(chunks).toString("utf-8")
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`message send failed: ${res.statusCode} ${body.slice(0, 500)}`))
              return
            }
            try {
              const contentType = res.headers["content-type"] ?? ""
              if (contentType.includes("application/json") || contentType.includes("text/plain")) {
                resolve(JSON.parse(body) as TurnResponse)
              } else {
                resolve(parseStreamingBody(body))
              }
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          })
          res.on("error", (err) => {
            cleanup()
            reject(err)
          })
        },
      )
      // Two ways the request settles early: our own deadline, or the caller
      // aborting (MCP request cancelled). Both destroy the socket, which surfaces
      // as a req 'error' → reject, which the caller's catch then handles.
      const timer = setTimeout(() => req.destroy(new Error(`turn exceeded ${timeoutMs}ms`)), timeoutMs)
      const onAbort = (): void => {
        req.destroy(new Error("request cancelled by caller (abandoned)"))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      req.on("error", (err) => {
        cleanup()
        reject(err)
      })
      if (signal?.aborted === true) {
        req.destroy(new Error("request cancelled by caller (abandoned)"))
      } else {
        signal?.addEventListener("abort", onAbort, { once: true })
      }
      req.end(payload)
    })

  const listMessages = async (sessionId: string): Promise<TurnResponse[]> => {
    const res = await fetch(`${base}/session/${sessionId}/message`)
    if (!res.ok) throw new Error(`message list failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as TurnResponse[]
  }

  const deleteSession = async (sessionId: string): Promise<void> => {
    await fetch(`${base}/session/${sessionId}`, { method: "DELETE" })
  }

  return { createSession, sendMessage, listMessages, deleteSession }
}
