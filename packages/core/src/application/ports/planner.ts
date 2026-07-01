// Planner port: Daddy — the session handshake + consult + final review (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.

import type {
  AskPlannerInput,
  PlannerResponse,
  FinalReview,
  Packet,
  OutcomeLedger,
  SubmitReport,
  ReviewState,
  DriverFacts,
} from "../../domain/index.js";

export type PlannerConsultContext = {
  reviewState: ReviewState;
  facts: DriverFacts;
};

export type Planner = {
  handshake(seedPrompt: string, directory: string): Promise<string>;
  resumeSession(sessionId: string): Promise<string>;
  syncMaxDecisions?(
    decisions: { timestamp: string; question: string; answer: string }[],
  ): Promise<void>;
  consult(input: AskPlannerInput, context?: PlannerConsultContext): Promise<PlannerResponse>;
  finalReview(packet: Packet, ledger: OutcomeLedger, report: SubmitReport): Promise<FinalReview>;
};
