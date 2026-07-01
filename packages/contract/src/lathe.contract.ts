/**
 * Lathe daemon API contract (rivet-ts, type-only).
 *
 * Reflected -> OpenAPI 3.1 -> openapi-fetch client (per rivet-ts). Served with
 * Hono via registerRivetHonoRoutes<LatheContract>. This file never exists at
 * runtime — the reflector reads it with the TS compiler API.
 *
 * The live event stream is deliberately NOT an Endpoint here: rivet-ts models
 * request/response only. `LatheEvent` is exported as the typed payload, and the
 * daemon serves it over a SIDECAR `GET /events` Hono streamSSE route. Clients
 * consume it with EventSource and narrow on `kind`. The contract owns the event
 * TYPE; it does not carry the push transport.
 *
 * Reference shape only — P00 (by hand) drops this into packages/contract/src
 * and wires the codegen pipeline. DTOs may tighten once core's real run/config
 * shapes are mapped, but routes + the event union are the committed surface.
 */
import type { Contract, Endpoint } from "rivet-ts";

/* ------------------------------- DTOs ------------------------------- */

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "converged" // super-daddy passed; awaiting accept/reject
  | "accepted" // merged to base, branch deleted
  | "aborted"
  | "failed";

export type Reviewer = "daddy" | "superdaddy";

export interface RunSummaryDto {
  runId: string;
  campaignId: string;
  packet: string; // packet slug
  status: RunStatus;
  pass: number;
  turn: number;
  contextTokens: number;
  contextWindow: number;
  isChainTip: boolean; // accept is only legal here
  startedAt: string; // ISO
  updatedAt: string; // ISO
}

export interface RunDetailDto extends RunSummaryDto {
  base: string;
  branch: string;
  worktreePath: string;
  parentRunId: string | null;
  expectedSurface: string[];
  lastVerdict: string | null; // latest reviewer verdict summary
  outcomes: string;
  blockedReason: string | null;
  blockedQuestion: string | null;
}

export interface StatusActiveRunDto {
  runId: string;
  outcomes: string;
  gateLatched: string | null;
  recentEvents: Array<{ at: string; event: string }>;
}

export interface StatusQueuedRunDto {
  runId: string;
}

export interface StatusParkedRunDto {
  runId: string;
  blockedReason: string | null;
  blockedQuestion: string | null;
  stallRetries: number;
}

export interface StatusCampaignDto {
  campaignId: string;
  status: string;
  pass: number;
  maxPasses: number;
  originalIntent: string;
}

export interface StatusStagedRunDto {
  runId: string;
  parentRunId: string | null;
}

export interface StatusReviewSummaryDto {
  readyForReview: number;
  failed: number;
}

export interface StatusDto {
  activeRun: StatusActiveRunDto | null;
  queued: StatusQueuedRunDto[];
  parked: StatusParkedRunDto[];
  campaigns: StatusCampaignDto[];
  staged: StatusStagedRunDto[];
  review: StatusReviewSummaryDto;
}

export interface ReviewRunDto {
  runId: string;
  status: string;
  outcomes: string;
  branch: string;
  repo: string;
  base: string;
  blockedQuestion: string | null;
}

export interface ReviewDto {
  runs: ReviewRunDto[];
}

export interface EnqueueRunRequest {
  packetPath: string; // absolute path to a single packet .md
}

export interface EnqueueChainRequest {
  chainDir: string; // dir of ordered packet .md files
}

export interface RejectRunRequest {
  reason?: string | null;
}

export interface AnswerRunRequest {
  answer: string;
}

export interface ModelConfigDto {
  baby: { modelId: string; baseUrl: string; contextWindow: number };
  daddy: { modelId: string; provider: string };
  superdaddy: { modelId: string };
}

export interface ConfigDto {
  models: ModelConfigDto;
  thresholds: {
    ladderParkAt: number;
    ladderRotateAt: number;
    maxPasses: number;
    turnSteps: number;
  };
}

export type TailRunStatus =
  | "queued"
  | "running"
  | "interrupted"
  | "ready_for_review"
  | "blocked"
  | "failed"
  | "accepted"
  | "aborted";

export interface TailModelsDto {
  baby: string;
  promoted: string;
  daddy: string;
  super: string;
}

export interface TailJournalLineDto {
  seq: number;
  at: string;
  line: string;
  event: string;
  driver: boolean;
}

export interface TailSnapshotDto {
  runId: string;
  summary: string | null;
  status: TailRunStatus;
  startedAt: string | null;
  models: TailModelsDto;
  promoted: boolean;
  budget: number;
  worktree: string;
  outcomesDone: number;
  outcomesTotal: number;
  gateReason: string | null;
  contextTokens: number;
  turn: number;
  rotations: number;
  journal: TailJournalLineDto[];
  lastSeq: number;
}

export type TailSpeaker = "baby" | "daddy" | "super";
export type TailLineStyle = "think" | "text";

export type TailEvent =
  | {
      kind: "tail.journal";
      runId: string;
      seq: number;
      at: string;
      line: string;
      event: string;
      driver: boolean;
    }
  | {
      kind: "tail.stats";
      runId: string;
      seq?: number;
      at: string;
      contextTokens: number;
      turn: number;
      rotations: number;
      outcomesDone: number;
      outcomesTotal: number;
      gateReason: string | null;
      status: TailRunStatus;
    }
  | {
      kind: "tail.pane.delta";
      runId: string;
      speaker: TailSpeaker;
      style: TailLineStyle;
      text: string;
    }
  | {
      kind: "tail.pane.tool";
      runId: string;
      speaker: TailSpeaker;
      status: "completed" | "error";
      tool: string;
      detail: string;
    }
  | {
      kind: "tail.super.verdict";
      runId: string;
      seq: number;
      at: string;
      verdict: string;
      pass: number;
      findings: string[];
      lines: string[];
    }
  | { kind: "tail.run.changed"; runId: string; snapshot: TailSnapshotDto | null }
  | { kind: "tail.ping" };

/* ------------------- event stream payload (SSE sidecar) ------------------- */

export type LatheEvent =
  | { kind: "run.state"; runId: string; status: RunStatus; at: string }
  | { kind: "turn.started"; runId: string; pass: number; turn: number; at: string }
  | { kind: "gate.decision"; runId: string; decision: "allow" | "block" | "notice"; tool: string; at: string }
  | { kind: "tokens"; runId: string; contextTokens: number; window: number; at: string }
  | { kind: "verdict"; runId: string; reviewer: Reviewer; verdict: string; at: string }
  | { kind: "log"; runId: string; line: string; at: string };

/* ------------------------------- contract ------------------------------- */

export interface LatheContract extends Contract<"LatheContract"> {
  enqueueRun: Endpoint<{
    method: "POST";
    route: "/runs";
    input: EnqueueRunRequest;
    response: RunSummaryDto;
    successStatus: 202;
  }>;

  enqueueChain: Endpoint<{
    method: "POST";
    route: "/chains";
    input: EnqueueChainRequest;
    response: RunSummaryDto[];
    successStatus: 202;
  }>;

  listRuns: Endpoint<{
    method: "GET";
    route: "/runs";
    response: RunSummaryDto[];
  }>;

  getRun: Endpoint<{
    method: "GET";
    route: "/runs/{runId}";
    params: { runId: string };
    response: RunDetailDto;
  }>;

  getStatus: Endpoint<{
    method: "GET";
    route: "/status";
    response: StatusDto;
  }>;

  getReview: Endpoint<{
    method: "GET";
    route: "/review";
    response: ReviewDto;
  }>;

  abortRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/abort";
    params: { runId: string };
    response: RunSummaryDto;
  }>;

  answerRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/answer";
    input: AnswerRunRequest;
    params: { runId: string };
    response: RunSummaryDto;
  }>;

  // DESTRUCTIVE: merges the run branch to base and deletes it. Legal ONLY when
  // the run isChainTip — the supervisor returns 409 on a mid-chain link
  // ([[lathe-force-accept-tipbranch-bug]] is what mid-chain accept breaks).
  acceptRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/accept";
    params: { runId: string };
    response: RunSummaryDto;
  }>;

  rejectRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/reject";
    input: RejectRunRequest;
    params: { runId: string };
    response: RunSummaryDto;
  }>;

  getConfig: Endpoint<{
    method: "GET";
    route: "/config";
    response: ConfigDto;
  }>;

  getActiveTail: Endpoint<{
    method: "GET";
    route: "/tail/active";
    response: TailSnapshotDto | null;
  }>;

  getTail: Endpoint<{
    method: "GET";
    route: "/tail/{runId}";
    params: { runId: string };
    response: TailSnapshotDto;
  }>;
}
