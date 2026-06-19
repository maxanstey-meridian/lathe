// Planner port: Daddy — the session handshake + consult + final review (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.

import type { AskPlannerInput, PlannerResponse, FinalReview, Packet, OutcomeLedger, SubmitReport } from "../../domain/index.js"

export type Planner = {
  handshake(seedPrompt: string): Promise<string>
  resumeSession(sessionId: string): Promise<string>
  consult(input: AskPlannerInput): Promise<PlannerResponse>
  finalReview(packet: Packet, reviewableDiff: string, ledger: OutcomeLedger, report: SubmitReport): Promise<FinalReview>
}
