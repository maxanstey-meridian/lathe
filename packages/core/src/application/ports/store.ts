// Store port: validated durable state IO (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.
//
// Constraint: MUST NOT import from src/config/. Every param is a domain type or primitive.
// The adapter holds Paths internally and resolves paths per-method.

import type { StagedInfo } from "../../domain/chain.js";
import type {
  ConvergeDecision,
  ConvergenceOperation,
  SuperReview,
} from "../../domain/convergence.js";
import type {
  RunMeta,
  ReviewState,
  Decision,
  ActiveRun,
  ActiveConvergence,
} from "../../domain/run.js";
import type { Checkpoint, OutcomeLedger } from "../../domain/outcomes.js";
import type { GateState } from "../../domain/gate.js";
import type { Packet } from "../../domain/packet.js";
import type { Campaign } from "../../domain/campaign.js";
import type { SubmitReport } from "../../domain/report.js";
import type { JournalEvent } from "../../domain/journal.js";
import type { AcceptanceOperation, RunStartupOperation } from "../../domain/operations.js";
import type { Plan } from "../../domain/plan.js";
import type { RunStatus } from "../../domain/run.js";
import type { VerificationResult } from "./verify.js";

// Queue entry — inline; no domain function consumes it.
export type RepositoryLease = {
  repo: string;
  ownerId: string;
  runId: string;
  purpose: "execute" | "accept";
  epoch: number;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
};
export type QueueEntry = { runId: string; admittedAt: string };
export type ClaimedQueueEntry = QueueEntry & { lease: RepositoryLease };
export type JournalStats = { turn: number; contextTokens: number; rotations: number };
export type RunTransition = {
  runId: string;
  expectedRevision: number;
  expectedStatuses: RunStatus[];
  meta: RunMeta;
  activeRun?: ActiveRun | null;
  lease?: RepositoryLease;
  event?: JournalEvent;
};
export type CampaignAcceptance = {
  runId: string;
  expectedRevision: number;
  expectedStatus: "accepted" | "ready_for_review";
};
export type AnswerTransition = {
  runId: string;
  expectedRevision: number;
  expectedStatus: "blocked" | "failed";
  meta: RunMeta;
  decision: Decision;
  gateState?: GateState;
};
export type ConvergencePublication = {
  operation: ConvergenceOperation;
  campaign: Campaign;
  entry: ConvergenceLogEntry;
  event: JournalEvent;
  nits?: string;
  runTransition?: RunTransition;
  followup?: { runId: string; raw: string };
  lease: RepositoryLease;
};

export type ConvergenceLogEntry = {
  kind: "reviewed";
  at: string;
  runId: string;
  campaignId: string;
  pass: number;
  maxPasses: number;
  verification: { green: boolean; commands: VerificationResult[] };
  decision: ConvergeDecision;
  amendedCommitSha: string | null;
  primary: SuperReview;
  primaryRaw: string;
};

export type Store = {
  // Run state (meta)
  readMeta(runId: string): RunMeta;
  readMetaIfExists(runId: string): RunMeta | undefined;
  /** Insert bootstrap metadata. Existing run identities are never overwritten. */
  writeMeta(meta: RunMeta): void;
  transitionRun(transition: RunTransition): RunMeta;
  readRunStartup(runId: string, attempt: number): RunStartupOperation | undefined;
  persistRunStartup(operation: RunStartupOperation, lease?: RepositoryLease): void;
  initializeRunStartup(
    operation: RunStartupOperation,
    ledger: OutcomeLedger,
    reviewState: ReviewState,
    gateState: GateState,
    lease?: RepositoryLease,
  ): void;
  activateRunStartup(
    operation: RunStartupOperation,
    transition: RunTransition & { lease: RepositoryLease },
  ): RunMeta;
  /** Atomically validate exact campaign member revisions and mark every member accepted. */
  acceptCampaign(
    members: CampaignAcceptance[],
    acceptedInto: string,
    lease?: RepositoryLease,
  ): RunMeta[];
  readAcceptanceOperation(campaignId: string): AcceptanceOperation | undefined;
  persistAcceptanceOperation(operation: AcceptanceOperation, lease?: RepositoryLease): void;
  commitAcceptanceOperation(operation: AcceptanceOperation, lease: RepositoryLease): RunMeta[];
  /** Atomically persist the operator decision, authoritative gate state, and run transition. */
  answerRun(transition: AnswerTransition): RunMeta;
  listRunIds(): string[];
  listMeta(): RunMeta[];

  // Outcome ledger
  initialLedger(packet: Packet): OutcomeLedger;
  readLedger(runId: string): OutcomeLedger;
  listLedgers(): OutcomeLedger[];
  writeLedger(ledger: OutcomeLedger): void;

  // Review state
  initialReviewState(runId: string): ReviewState;
  readReviewState(runId: string): ReviewState;
  replaceObligations(runId: string, constraints: string[]): ReviewState;

  // Decisions (jsonl)
  appendDecision(runId: string, decision: Decision): void;
  readDecisions(runId: string): Decision[];

  // Checkpoints
  latestCheckpoint(runId: string): Checkpoint | undefined;
  writeCheckpoint(runId: string, checkpoint: Checkpoint): void;
  nextCheckpointNumber(runId: string): number;

  // Gate state
  readGateState(runId: string): GateState;
  writeGateState(runId: string, state: GateState): void;

  // Report (markdown; CONTRACT §11)
  readReport(runId: string): string;
  writeReport(runId: string, report: SubmitReport, markdown: string): void;

  // Nits (markdown)
  readNits(runId: string): string;
  writeNits(runId: string, markdown: string): void;

  // Convergence (jsonl)
  appendConvergence(runId: string, entry: ConvergenceLogEntry): void;
  readConvergence(runId: string): ConvergenceLogEntry[];
  readConvergenceOperation(runId: string, attempt: number): ConvergenceOperation | undefined;
  persistConvergenceOperation(operation: ConvergenceOperation, lease: RepositoryLease): void;
  publishConvergence(publication: ConvergencePublication): RunMeta | undefined;

  // Active run pointer — multi-row keyed by runId
  listActiveRuns(): ActiveRun[];
  /** Rebuild the gate plugin projection from authoritative SQLite state. */
  syncActiveRunProjection(): void;
  addActiveRun(run: ActiveRun): void;
  removeActiveRun(runId: string): void;

  // Active convergence pointer — multi-row keyed by runId
  listActiveConvergences(): ActiveConvergence[];
  addActiveConvergence(convergence: ActiveConvergence): void;
  removeActiveConvergence(runId: string): void;

  // Campaign
  readCampaign(campaignId: string): Campaign | undefined;
  writeCampaign(campaign: Campaign): void;
  /** Commit follow-up metadata and campaign state together; packet markdown is a recoverable projection. */
  admitQueueWithCampaign(
    runId: string,
    raw: string,
    campaign: Campaign,
    decision?: { runId: string; event: JournalEvent },
  ): void;
  listCampaigns(): Campaign[];
  listRunsByCampaign(campaignId: string): RunMeta[];

  // Queue (list/admit/archive/claim)
  listQueue(): QueueEntry[];
  admitQueue(runId: string, raw: string): void;
  archiveQueue(runId: string): void;
  /** Atomically claim one queued run and acquire its repository lease. */
  claimNextQueuedRun(excludedRepos: string[], ownerId?: string): ClaimedQueueEntry | undefined;
  acquireRepositoryLease(
    repo: string,
    ownerId: string,
    runId: string,
    purpose: RepositoryLease["purpose"],
  ): RepositoryLease | undefined;
  listRepositoryLeases(): RepositoryLease[];
  heartbeatRepositoryLease(lease: RepositoryLease): RepositoryLease | undefined;
  releaseRepositoryLease(lease: RepositoryLease): boolean;

  // Queue packet read — fresh-run raw packet source
  readQueuePacket(runId: string): string | undefined;

  // Staged-chain registry
  listStaged(): StagedInfo[];
  readStaged(runId: string): string | undefined;
  writeStaged(runId: string, raw: string): void;
  removeStaged(runId: string): void;

  // Journal (append-only event log, CONTRACT §3)
  appendJournal(runId: string, event: JournalEvent): void;
  readJournal(runId: string): JournalEvent[];
  readJournalWithSeq(runId: string): { seq: number; event: JournalEvent }[];
  readJournalSinceForRun(runId: string, seq: number): { seq: number; event: JournalEvent }[];
  readRecentJournal(runId: string, limit: number): JournalEvent[];
  readRecentJournalWithSeq(runId: string, limit: number): { seq: number; event: JournalEvent }[];
  readJournalStats(runId: string): JournalStats;
  latestJournalSeq(): number;

  // Global resumable journal — cross-run, gap-free, sorted by seq.
  // The daemon's /events SSE spine consumes this for a single resuming stream.
  readJournalSince(seq: number): { seq: number; runId: string; event: JournalEvent }[];

  // Fresh-start cleanup: remove checkpoint files, decisions, review state
  // that a prior session wrote — a fresh attempt must not inherit resume-only
  // durable state for a later unchanged-packet pickup to mistake for in-progress.
  clearResumeArtifacts(runId: string): void;

  // Plans shelf — pre-queue draft packets stored in SQLite
  listPlans(): Plan[];
  readPlan(planId: string): Plan | undefined;
  writePlan(plan: Plan): void;
  deletePlan(planId: string): void;
};
