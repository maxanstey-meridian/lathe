// Executor port: the opencode session host interface (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.

import type { TurnResponse } from "../../domain/agent-response.js"

export type ModelConfig = { providerId: string; modelId: string; agent: string }

export type Executor = {
  createSession(title: string, directory: string): Promise<string>
  sendMessage(sessionId: string, text: string, model: ModelConfig, timeoutMs: number, signal?: AbortSignal): Promise<TurnResponse>
  listMessages(sessionId: string): Promise<TurnResponse[]>
  deleteSession(sessionId: string): Promise<void>
}
