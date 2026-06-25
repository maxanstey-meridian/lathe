// Store port: validated durable state IO (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.
//
// Constraint: MUST NOT import from src/config/. Every param is a domain type or primitive.
// The adapter holds Paths internally and resolves paths per-method.

import type { StagedInfo } from "../../domain/chain.js";
import type { ConvergeDecision, SuperReview } from "../../domain/convergence.js";
import type {
  RunMeta,
  ReviewState,
  Decision,
  Checkpoint,
  GateState,
  ActiveRun,
  OutcomeLedger,
  Packet,
  Campaign,
  SubmitReport,
} from "../../domain/index.js";
import type { JournalEvent } from "../../domain/journal.js";
import type { VerificationResult } from "./verify.js";

// Queue entry — inline; no domain function consumes it.
export type QueueEntry = { runId: string; admittedAt: string };

// Convergence log entry — a discriminated union so an UNREACHABLE attempt (transport drop, no verdict)
// is logged honestly instead of forging an escalate SuperReview. The shared head
// (at/runId/campaignId/pass/maxPasses/verification) is on both branches.
type ConvergenceLogHead = {
  at: string;
  runId: string;
  campaignId: string;
  pass: number;
  maxPasses: number;
  verification: { green: boolean; commands: VerificationResult[] };
};

export type ConvergenceLogEntry =
  | (ConvergenceLogHead & {
      kind: "reviewed";
      decision: ConvergeDecision;
      amendedCommitSha: string | null;
      primary: SuperReview;
      primaryRaw: string;
    })
  | (ConvergenceLogHead & {
      kind: "unreachable";
      // 1-based index of this consecutive drop; budget = maxReviewerUnreachable.
      detail: string;
      attempt: number;
      budget: number;
    });

export type Store = {
  // Run state (meta)
  readMeta(runId: string): RunMeta;
  readMetaIfExists(runId: string): RunMeta | undefined;
  writeMeta(meta: RunMeta): void;
  listRunIds(): string[];

  // Outcome ledger
  initialLedger(packet: Packet): OutcomeLedger;
  readLedger(runId: string): OutcomeLedger;
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

  // Packet freeze
  freezePacket(runId: string, raw: string): void;
  readFrozenPacket(runId: string): string;

  // Active run pointer
  readActiveRun(): ActiveRun | undefined;
  writeActiveRun(run: ActiveRun): void;
  clearActiveRun(): void;

  // Campaign
  readCampaign(campaignId: string): Campaign | undefined;
  writeCampaign(campaign: Campaign): void;
  listCampaigns(): Campaign[];

  // Queue (list/admit/archive)
  listQueue(): QueueEntry[];
  admitQueue(runId: string, raw: string): void;
  archiveQueue(runId: string): void;

  // Queue packet read — fresh-run raw packet source
  readQueuePacket(runId: string): string | undefined;

  // Meta from queue — build minimal RunMeta from a fresh queue packet
  initMetaFromQueue(runId: string): RunMeta | undefined;

  // Staged-chain registry
  listStaged(): StagedInfo[];
  readStaged(runId: string): string | undefined;
  writeStaged(runId: string, raw: string): void;
  removeStaged(runId: string): void;

  // Journal (append-only event log, CONTRACT §3)
  appendJournal(runId: string, event: JournalEvent): void;
  readJournal(runId: string): JournalEvent[];

  // Global resumable journal — cross-run, gap-free, sorted by seq.
  // The daemon's /events SSE spine consumes this for a single resuming stream.
  readJournalSince(seq: number): { seq: number; runId: string; event: JournalEvent }[];
};
