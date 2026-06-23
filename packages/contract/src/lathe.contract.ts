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
  | "rejected"
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
  EnqueueRun: Endpoint<{
    method: "POST";
    route: "/runs";
    input: EnqueueRunRequest;
    response: RunSummaryDto;
    successStatus: 202;
  }>;

  EnqueueChain: Endpoint<{
    method: "POST";
    route: "/chains";
    input: EnqueueChainRequest;
    response: RunSummaryDto[];
    successStatus: 202;
  }>;

  ListRuns: Endpoint<{
    method: "GET";
    route: "/runs";
    response: RunSummaryDto[];
  }>;

  GetRun: Endpoint<{
    method: "GET";
    route: "/runs/{runId}";
    response: RunDetailDto;
  }>;

  AbortRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/abort";
    response: RunSummaryDto;
  }>;

  // DESTRUCTIVE: merges the run branch to base and deletes it. Legal ONLY when
  // the run isChainTip — the supervisor returns 409 on a mid-chain link
  // ([[lathe-force-accept-tipbranch-bug]] is what mid-chain accept breaks).
  AcceptRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/accept";
    response: RunSummaryDto;
  }>;

  RejectRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/reject";
    input: RejectRunRequest;
    response: RunSummaryDto;
  }>;

  GetConfig: Endpoint<{
    method: "GET";
    route: "/config";
    response: ConfigDto;
  }>;
}
