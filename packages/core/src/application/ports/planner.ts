// Planner port: Daddy — the session handshake + consult + final review (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.

import type {
  AskPlannerInput,
  PlannerResponse,
  FinalReview,
} from "../../domain/review.js";
import type { ReviewState } from "../../domain/run.js";
import type { Packet } from "../../domain/packet.js";
import type { OutcomeLedger } from "../../domain/outcomes.js";
import type { SubmitReport } from "../../domain/report.js";
import type { DriverFacts } from "../../domain/prompts.js";

export type PlannerConsultContext = {
  reviewState: ReviewState;
  facts: DriverFacts;
};

export type Planner = {
  handshake(seedPrompt: string, directory: string, signal?: AbortSignal): Promise<string>;
  resumeSession(sessionId: string): Promise<string>;
  syncMaxDecisions?(
    decisions: { timestamp: string; question: string; answer: string }[],
    signal?: AbortSignal,
  ): Promise<void>;
  consult(
    input: AskPlannerInput,
    context?: PlannerConsultContext,
    signal?: AbortSignal,
  ): Promise<PlannerResponse>;
  finalReview(
    packet: Packet,
    ledger: OutcomeLedger,
    report: SubmitReport,
    signal?: AbortSignal,
  ): Promise<FinalReview>;
};
