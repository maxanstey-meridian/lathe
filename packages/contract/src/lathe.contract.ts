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
  | "stopped"
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

export interface StatusStoppedRunDto {
  runId: string;
  status: string;
}

export interface StatusDto {
  activeRuns: StatusActiveRunDto[];
  queued: StatusQueuedRunDto[];
  parked: StatusParkedRunDto[];
  campaigns: StatusCampaignDto[];
  staged: StatusStagedRunDto[];
  review: StatusReviewSummaryDto;
  stopped: StatusStoppedRunDto[];
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

export interface EnqueueContentRequest {
  content: string; // raw markdown packet content
  filename: string; // YYYYMMDD-HHMMSS-<slug>.md
}

export interface ValidatePacketRequest {
  content: string;
  filename?: string;
}

export interface ValidatePacketFrontmatter {
  repo: string;
  base: string;
  compare_commit: string;
  summary?: string;
  outcomes: Array<{ id: string; description: string }>;
  expected_surface: string[];
  suspicious_surface: string[];
  verification: Array<{ command: string }>;
  constraints: string[];
  autofix_commands: Array<{ command: string }>;
  campaign_id?: string;
  parent_run_id?: string;
  pass: number;
  regression_outcomes: Array<{ id: string; description: string }>;
  promoted: boolean;
}

export interface ValidatePacketResponse {
  ok: boolean;
  frontmatter: ValidatePacketFrontmatter | null;
  body: string;
  problems: string[];
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

/* ------------------- settings & restart DTOs ------------------- */

export interface ErrorResponse {
  code: string;
  message: string;
}

export interface RestartResponseDto {
  restarting: boolean;
}

export interface ReportDto {
  report: string;
}

export interface SettingsOpencodeDto {
  binary: string;
  port: number;
  bridgePort: number;
  expectedVersion: string;
}

export interface SettingsDaddyDto {
  providerId: string;
  modelId: string;
  agent: string;
  timeoutMs: number;
}

export interface SettingsBabyPromoteToDto {
  providerId: string;
  modelId: string;
}

export interface SettingsBabyDto {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiKey: string;
  agent: string;
  contextWindow: number;
  timeoutMs: number;
  turnSteps: number;
  thinkingMode: "budget" | "disabled";
  thinkingBudget: number | null;
  promoteTo?: SettingsBabyPromoteToDto;
}

export interface SettingsSuperdaddyDto {
  providerId: string;
  modelId: string;
  agent: string;
  timeoutMs: number;
  baseUrl: string;
  headerTimeoutMs: number;
  apiKey?: string;
  turnSteps: number;
  skillPath: string;
  packetSkillPath: string;
  diffCapBytes: number;
  transportRetries: number;
}

export interface SettingsThresholdsDto {
  rotationFraction: number;
  ladderParkAt: number;
  ladderRotateAt: number;
  checkpointNudgeMs: number;
  checkpointToolCalls: number;
  checkpointFiles: number;
  checkpointLoc: number;
  reportRejectionParkAt: number;
  checkpointBounceLimit: number;
  verificationTimeoutMs: number;
  maxPasses: number;
  maxReviewerUnreachable: number;
  promoteAtCap: boolean;
  maxStallRetries: number;
  maxCrashRetries: number;
  maxReorientRetries: number;
  maxRunMs: number;
  contextTokensFloor: number;
}

export interface SettingsConcurrencyDto {
  maxWorkers: number;
}

export interface SettingsDaemonDto {
  host: string;
  port: number;
}

export interface SettingsRepoSeedDto {
  copies: string[];
  writes: Record<string, string>;
}

export interface SettingsRepoDto {
  seed: SettingsRepoSeedDto;
}

export interface SettingsDto {
  stateRoot: string;
  opencode: SettingsOpencodeDto;
  daddy: SettingsDaddyDto;
  baby: SettingsBabyDto;
  superdaddy: SettingsSuperdaddyDto;
  thresholds: SettingsThresholdsDto;
  idleTimeoutMs: number;
  concurrency: SettingsConcurrencyDto;
  daemon: SettingsDaemonDto;
  mutationCommandPatterns: string[];
  repos: Record<string, SettingsRepoDto>;
}

/* ------------------- run ledger DTOs ------------------- */

export interface ReconciliationDto {
  fingerprint: string;
  reused: boolean;
  deltaKind?: string;
}

export interface DecisionDto {
  timestamp: string;
  source: "daddy" | "max";
  questionType: string;
  currentSlice?: string;
  question: string;
  approach?: string;
  evidence: string[];
  status: string;
  answer: string;
  constraints: string[];
  evidenceUsed?: string[];
  safeNextAction?: string;
  humanDecisionNeeded?: string | null;
  reconciliation?: ReconciliationDto;
  messageId?: string;
}

export interface OutcomeEntryDto {
  id: string;
  description: string;
  status: "not_started" | "in_progress" | "done" | "blocked";
  evidence: string[];
  state?: string;
  nextAction?: string;
  updatedAt: string;
}

export interface OutcomeLedgerDto {
  runId: string;
  outcomes: OutcomeEntryDto[];
  updatedAt: string;
}

/* ------------------- convergence DTOs ------------------- */

export type FindingSeverityDto = "P0" | "P1" | "P2" | "P3";

export interface FindingGroundingDto {
  kind: "command_fail" | "clause" | "none";
  ref: string;
}

export interface FindingDto {
  id: string;
  severity: FindingSeverityDto;
  title: string;
  evidence: string[];
  grounding: FindingGroundingDto;
  suggested_outcome_id?: string;
}

export interface ConvergenceSignalDto {
  recommend_stop: boolean;
  profile: {
    p0: number;
    p1: number;
    p2: number;
    p3: number;
  };
  rationale: string;
}

export interface CommitMessageDto {
  subject: string;
  body: string;
}

export interface SuperReviewDto {
  verdict: "accept" | "request_changes" | "escalate";
  findings: FindingDto[];
  convergence: ConvergenceSignalDto;
  commit_message: CommitMessageDto | null;
  notes: string;
  human_decision_needed: string | null;
}

export type ConvergeDecisionDto =
  | { action: "author"; blockers: FindingDto[]; promote: boolean }
  | { action: "stop" }
  | { action: "escalate"; reason: string };

export interface VerificationResultDto {
  command: string;
  exitCode: number;
  outputTail: string;
}

export type ConvergenceLogEntryDto =
  | {
      kind: "reviewed";
      at: string;
      runId: string;
      campaignId: string;
      pass: number;
      maxPasses: number;
      verification: { green: boolean; commands: VerificationResultDto[] };
      decision: ConvergeDecisionDto;
      amendedCommitSha: string | null;
      primary: SuperReviewDto;
      primaryRaw: string;
    }
  | {
      kind: "unreachable";
      at: string;
      runId: string;
      campaignId: string;
      pass: number;
      maxPasses: number;
      verification: { green: boolean; commands: VerificationResultDto[] };
      detail: string;
      attempt: number;
      budget: number;
    };

export type TailRunStatus =
  | "queued"
  | "running"
  | "interrupted"
  | "ready_for_review"
  | "blocked"
  | "failed"
  | "accepted"
  | "stopped";

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

export interface TailPaneLineDto {
  text: string;
  style: "think" | "text" | "tool";
  attachment?: string;
}

export interface TailAgentPanesDto {
  baby: TailPaneLineDto[];
  daddy: TailPaneLineDto[];
  super: TailPaneLineDto[];
}

export interface TailDriverSegmentDto {
  stream: "stdout" | "stderr";
  text: string;
}

export interface TailDriverCommandDto {
  commandId: string;
  phase: VerificationPhaseDto;
  command: string;
  startedAt: string;
  segments: TailDriverSegmentDto[];
  terminal: {
    status: "completed" | "error";
    exitCode: number;
    timedOut: boolean;
    finishedAt: string;
  } | null;
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
  panes: TailAgentPanesDto;
  driverCommands: TailDriverCommandDto[];
  journal: TailJournalLineDto[];
  lastSeq: number;
}

export type TailSpeaker = "baby" | "daddy" | "super";
export type TailLineStyle = "think" | "text";
export type VerificationPhaseDto = "report" | "convergence" | "autofix";

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
      promoted: boolean;
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
      status: "running" | "completed" | "error";
      tool: string;
      detail: string;
      input?: string;
    }
  | { kind: "tail.agent.panes.replaced"; runId: string; panes: TailAgentPanesDto }
  | {
      kind: "tail.driver.command";
      runId: string;
      phase: VerificationPhaseDto;
      commandId: string;
      command: string;
      status: "running";
      at: string;
    }
  | {
      kind: "tail.driver.command";
      runId: string;
      phase: VerificationPhaseDto;
      commandId: string;
      command: string;
      status: "completed" | "error";
      exitCode: number;
      timedOut: boolean;
      at: string;
    }
  | {
      kind: "tail.driver.delta";
      runId: string;
      phase: VerificationPhaseDto;
      commandId: string;
      stream: "stdout" | "stderr";
      text: string;
      at: string;
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
  | { kind: "tail.run.changed"; runId: string | null; snapshot: TailSnapshotDto | null }
  | { kind: "tail.ping" };

const TAIL_EVENT_KIND_MAP = {
  "tail.journal": true,
  "tail.stats": true,
  "tail.pane.delta": true,
  "tail.pane.tool": true,
  "tail.agent.panes.replaced": true,
  "tail.driver.command": true,
  "tail.driver.delta": true,
  "tail.super.verdict": true,
  "tail.run.changed": true,
  "tail.ping": true,
} as const satisfies Record<TailEvent["kind"], true>;

export const TAIL_EVENT_KINDS = Object.keys(TAIL_EVENT_KIND_MAP) as Array<keyof typeof TAIL_EVENT_KIND_MAP>;

export const TAIL_PROTOCOL_LIMITS = {
  paneLines: 300,
  lineChars: 8_000,
  driverCommands: 100,
  driverSegmentsPerCommand: 600,
  driverCharsPerCommand: 256_000,
  driverCharsPerRun: 2_000_000,
} as const;

/* ------------------- event stream payload (SSE sidecar) ------------------- */

export type LatheEvent =
  | { kind: "run.state"; runId: string; status: RunStatus; at: string }
  | { kind: "turn.started"; runId: string; pass: number; turn: number; at: string }
  | { kind: "gate.decision"; runId: string; decision: "allow" | "block" | "notice"; tool: string; at: string }
  | { kind: "tokens"; runId: string; contextTokens: number; window: number; at: string }
  | { kind: "verdict"; runId: string; reviewer: Reviewer; verdict: string; at: string }
  | { kind: "log"; runId: string; line: string; at: string };

/* ------------------------------- plan DTOs ------------------------------- */

export interface PlanDto {
  planId: string;
  title: string;
  tags: string[];
  queuedRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanDetailDto extends PlanDto {
  raw: string;
}

export interface CreatePlanRequest {
  content: string;
  filename: string;
  tags?: string[];
}

export interface UpdatePlanRequest {
  content?: string;
  tags?: string[];
}

export interface QueuePlanResponse {
  runId: string;
}

/* ------------------------------- contract ------------------------------- */

export interface LatheContract extends Contract<"LatheContract"> {
  enqueueRun: Endpoint<{
    method: "POST";
    route: "/runs";
    input: EnqueueRunRequest;
    response: RunSummaryDto;
    successStatus: 202;
    errors: [
      { status: 400; response: ErrorResponse; description: "invalid packet" },
      { status: 500; response: ErrorResponse; description: "internal error" },
    ];
  }>;

  enqueueContent: Endpoint<{
    method: "POST";
    route: "/runs/content";
    input: EnqueueContentRequest;
    response: RunSummaryDto;
    successStatus: 202;
    errors: [
      { status: 400; response: ErrorResponse; description: "invalid packet" },
      { status: 500; response: ErrorResponse; description: "internal error" },
    ];
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
    errors: [{ status: 404; response: ErrorResponse; description: "run not found" }];
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

  validatePacket: Endpoint<{
    method: "POST";
    route: "/packet";
    input: ValidatePacketRequest;
    response: ValidatePacketResponse;
    successStatus: 200;
  }>;

  stopRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/stop";
    params: { runId: string };
    response: RunSummaryDto;
    errors: [
      { status: 404; response: ErrorResponse; description: "run not found" },
      { status: 409; response: ErrorResponse; description: "run is terminal" },
    ];
  }>;

  answerRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/answer";
    input: AnswerRunRequest;
    params: { runId: string };
    response: RunSummaryDto;
    errors: [
      { status: 404; response: ErrorResponse; description: "run not found" },
      { status: 409; response: ErrorResponse; description: "run is not answerable" },
    ];
  }>;

  // DESTRUCTIVE: merges the run branch to base and deletes it. Legal ONLY when
  // the run isChainTip — the supervisor returns 409 on a mid-chain link
  // ([[lathe-force-accept-tipbranch-bug]] is what mid-chain accept breaks).
  acceptRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/accept";
    params: { runId: string };
    response: RunSummaryDto;
    errors: [
      { status: 404; response: ErrorResponse; description: "run not found" },
      { status: 409; response: ErrorResponse; description: "not a chain tip or accept refused" },
    ];
  }>;

  rejectRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/reject";
    input: RejectRunRequest;
    params: { runId: string };
    response: RunSummaryDto;
    errors: [
      { status: 404; response: ErrorResponse; description: "run not found" },
      { status: 409; response: ErrorResponse; description: "run is terminal" },
    ];
  }>;

  requeueRun: Endpoint<{
    method: "POST";
    route: "/runs/{runId}/requeue";
    params: { runId: string };
    response: RunSummaryDto;
    errors: [
      { status: 404; response: ErrorResponse; description: "run not found" },
      { status: 409; response: ErrorResponse; description: "run is terminal" },
    ];
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
    errors: [{ status: 404; response: ErrorResponse; description: "run not found" }];
  }>;

  getSettings: Endpoint<{
    method: "GET";
    route: "/settings";
    response: SettingsDto;
  }>;

  updateSettings: Endpoint<{
    method: "PUT";
    route: "/settings";
    input: SettingsDto;
    response: SettingsDto;
    errors: [{ status: 400; response: ErrorResponse; description: "invalid config body" }];
  }>;

  restart: Endpoint<{
    method: "POST";
    route: "/restart";
    response: RestartResponseDto;
    successStatus: 200;
    errors: [{ status: 400; response: ErrorResponse; description: "restart not available" }];
  }>;

  getDecisions: Endpoint<{
    method: "GET";
    route: "/runs/{runId}/decisions";
    params: { runId: string };
    response: DecisionDto[];
    errors: [{ status: 404; response: ErrorResponse; description: "run not found" }];
  }>;

  getOutcomes: Endpoint<{
    method: "GET";
    route: "/runs/{runId}/outcomes";
    params: { runId: string };
    response: OutcomeLedgerDto;
    errors: [{ status: 404; response: ErrorResponse; description: "run not found" }];
  }>;

  getReport: Endpoint<{
    method: "GET";
    route: "/runs/{runId}/report";
    params: { runId: string };
    response: ReportDto;
    errors: [{ status: 404; response: ErrorResponse; description: "run not found" }];
  }>;

  getConvergence: Endpoint<{
    method: "GET";
    route: "/runs/{runId}/convergence";
    params: { runId: string };
    response: ConvergenceLogEntryDto[];
    errors: [{ status: 404; response: ErrorResponse; description: "run not found" }];
  }>;

  // --- Plans shelf ---

  listPlans: Endpoint<{
    method: "GET";
    route: "/plans";
    response: PlanDto[];
  }>;

  getPlan: Endpoint<{
    method: "GET";
    route: "/plans/{planId}";
    params: { planId: string };
    response: PlanDetailDto;
    errors: [{ status: 404; response: ErrorResponse; description: "plan not found" }];
  }>;

  createPlan: Endpoint<{
    method: "POST";
    route: "/plans";
    input: CreatePlanRequest;
    response: PlanDto;
    successStatus: 201;
  }>;

  updatePlan: Endpoint<{
    method: "PUT";
    route: "/plans/{planId}";
    input: UpdatePlanRequest;
    params: { planId: string };
    response: PlanDto;
    errors: [{ status: 404; response: ErrorResponse; description: "plan not found" }];
  }>;

  deletePlan: Endpoint<{
    method: "DELETE";
    route: "/plans/{planId}";
    params: { planId: string };
    response: { deleted: boolean };
    successStatus: 200;
    errors: [{ status: 404; response: ErrorResponse; description: "plan not found" }];
  }>;

  queuePlan: Endpoint<{
    method: "POST";
    route: "/plans/{planId}/queue";
    params: { planId: string };
    response: QueuePlanResponse;
    successStatus: 200;
    errors: [
      { status: 404; response: ErrorResponse; description: "plan not found" },
      { status: 400; response: ErrorResponse; description: "plan failed admission" },
    ];
  }>;
}
