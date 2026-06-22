// Store adapter: durable file IO, queue, and staged-chain registry.
// Implements the Store port over validated file IO (D5/D6) and the
// path layout of CONTRACT §3. The journal tolerates bad lines (J3).
//
// Constraints:
// - Injected Ports: Paths (layout), Repo (git-backed admission checks),
//   Clock (timestamp generation). Never imports from src/config/.
// - Atomic writes for state files (temp+rename); append for jsonl.
// - Never delete a packet — archive to rejected/ on failure (F3).

import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  appendFileSync,
  unlinkSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
// VerificationResult is an inline port type (not a Zod schema), so we build
// the ConvergenceLogEntry schema from scratch rather than reusing one.
import { z } from "zod";
import type { Clock } from "../application/ports/clock.js";
import type { Repo } from "../application/ports/repo.js";
import type { Store, QueueEntry, ConvergenceLogEntry } from "../application/ports/store.js";
import type { VerificationResult } from "../application/ports/verify.js";
import type { Paths } from "../config/paths.js";
import { Campaign as CampaignSchema } from "../domain/campaign.js";
import { parseStaged } from "../domain/chain.js";
import { SuperReview, Finding } from "../domain/convergence.js";
import { GateState as GateStateSchema } from "../domain/gate.js";
import type {
  RunMeta,
  OutcomeLedger,
  ReviewState,
  Decision,
  Checkpoint,
  GateState,
  ActiveRun,
  Packet,
  Campaign,
  SubmitReport,
} from "../domain/index.js";
import type { JournalEvent } from "../domain/journal.js";
import { JournalEvent as JournalEventSchema } from "../domain/journal.js";
import { OutcomeLedger as OutcomeLedgerSchema } from "../domain/outcomes.js";
import { Checkpoint as CheckpointSchema } from "../domain/outcomes.js";
import {
  parsePacketShape,
  stampBase,
  extractRepoFromYaml,
  extractBaseFromYaml,
} from "../domain/packet.js";
import { RunMeta as RunMetaSchema } from "../domain/run.js";
import { ReviewState as ReviewStateSchema } from "../domain/run.js";
import { Decision as DecisionSchema } from "../domain/run.js";
import { ActiveRun as ActiveRunSchema } from "../domain/run.js";
// ---------------------------------------------------------------------------
// Convergence log entry schema — local, matching the port's ConvergenceLogEntry
// shape (the port ships only the type; appendJsonl/readJsonl require a schema).
import {
  readValidated,
  readValidatedIfExists,
  writeValidated,
  writeAtomic,
  appendJsonl,
  readJsonl,
} from "../infrastructure/fsio.js";

const VerificationResultSchema = z.object({
  green: z.boolean(),
  commands: z.array(
    z.object({
      command: z.string(),
      exitCode: z.number(),
      outputTail: z.string(),
    }),
  ),
});

const ConvergeDecisionSchema = z.union([
  z.object({ action: z.literal("author"), blockers: z.array(Finding) }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("escalate"), reason: z.string() }),
]);

const ConvergenceLogEntrySchema = z.object({
  at: z.string(),
  runId: z.string(),
  campaignId: z.string(),
  pass: z.number().int(),
  maxPasses: z.number().int(),
  verification: VerificationResultSchema,
  decision: ConvergeDecisionSchema,
  amendedCommitSha: z.string().nullable(),
  primary: SuperReview,
  primaryRaw: z.string(),
});

// ---------------------------------------------------------------------------
// Archive helper — collision-safe with numeric suffix and .problems.txt sidecar
// (reference/src/queue.ts:19-27).

const archivePacket = (paths: Paths, packetPath: string, problems?: string[]): string => {
  mkdirSync(paths.rejectedDir, { recursive: true });
  const base = basename(packetPath);
  let dest = join(paths.rejectedDir, base);
  for (let n = 1; existsSync(dest); n++) {
    dest = join(paths.rejectedDir, base.replace(/\.md$/, `.${n}.md`));
  }
  renameSync(packetPath, dest);
  if (problems && problems.length > 0) {
    writeAtomic(`${dest}.problems.txt`, `${problems.join("\n")}\n`);
  }
  return dest;
};

// ---------------------------------------------------------------------------
// StoreAdapter

export class StoreAdapter implements Store {
  private constructor(
    private readonly paths: Paths,
    private readonly repo: Repo,
    private readonly clock: Clock,
  ) {}

  static create(paths: Paths, repo: Repo, clock: Clock): Store {
    return new StoreAdapter(paths, repo, clock);
  }

  // ---------------------------------------------------------------------------
  // Run state (meta)

  readMeta(runId: string): RunMeta {
    return readValidated(this.paths.metaFile(runId), RunMetaSchema);
  }

  readMetaIfExists(runId: string): RunMeta | undefined {
    return readValidatedIfExists(this.paths.metaFile(runId), RunMetaSchema);
  }

  writeMeta(meta: RunMeta): void {
    writeValidated(this.paths.metaFile(meta.runId), RunMetaSchema, {
      ...meta,
      updatedAt: this.clock.nowIso(),
    });
  }

  listRunIds(): string[] {
    const runsDir = this.paths.runsDir;
    if (!existsSync(runsDir)) return [];
    return readdirSync(runsDir)
      .filter((d) => existsSync(this.paths.metaFile(d)))
      .sort();
  }

  // ---------------------------------------------------------------------------
  // Outcome ledger

  initialLedger(packet: Packet): OutcomeLedger {
    return {
      runId: packet.runId,
      outcomes: packet.frontmatter.outcomes.map((o) => ({
        id: o.id,
        description: o.description,
        status: "not_started" as const,
        evidence: [],
        updatedAt: this.clock.nowIso(),
      })),
      updatedAt: this.clock.nowIso(),
    };
  }

  readLedger(runId: string): OutcomeLedger {
    return readValidated(this.paths.outcomesFile(runId), OutcomeLedgerSchema);
  }

  writeLedger(ledger: OutcomeLedger): void {
    writeValidated(this.paths.outcomesFile(ledger.runId), OutcomeLedgerSchema, {
      ...ledger,
      updatedAt: this.clock.nowIso(),
    });
  }

  // ---------------------------------------------------------------------------
  // Review state

  initialReviewState(runId: string): ReviewState {
    return {
      runId,
      obligations: [],
      updatedAt: this.clock.nowIso(),
    };
  }

  readReviewState(runId: string): ReviewState {
    return readValidated(this.paths.reviewStateFile(runId), ReviewStateSchema);
  }

  replaceObligations(runId: string, constraints: string[]): ReviewState {
    const next: ReviewState = {
      runId,
      obligations: constraints.map((c) => c.trim()).filter((c) => c.length > 0),
      lastDecisionAt: this.clock.nowIso(),
      updatedAt: this.clock.nowIso(),
    };
    writeValidated(this.paths.reviewStateFile(runId), ReviewStateSchema, next);
    return next;
  }

  // ---------------------------------------------------------------------------
  // Decisions (jsonl)

  appendDecision(runId: string, decision: Decision): void {
    appendJsonl(this.paths.decisionsFile(runId), DecisionSchema, decision);
  }

  readDecisions(runId: string): Decision[] {
    return readJsonl(this.paths.decisionsFile(runId), DecisionSchema);
  }

  // ---------------------------------------------------------------------------
  // Checkpoints (NNNN.json)

  latestCheckpoint(runId: string): Checkpoint | undefined {
    const dir = this.paths.checkpointsDir(runId);
    if (!existsSync(dir)) return undefined;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const last = files[files.length - 1];
    return last ? readValidated(join(dir, last), CheckpointSchema) : undefined;
  }

  writeCheckpoint(runId: string, checkpoint: Checkpoint): void {
    const dir = this.paths.checkpointsDir(runId);
    mkdirSync(dir, { recursive: true });
    writeValidated(
      join(dir, `${String(checkpoint.number).padStart(4, "0")}.json`),
      CheckpointSchema,
      checkpoint,
    );
  }

  nextCheckpointNumber(runId: string): number {
    const dir = this.paths.checkpointsDir(runId);
    if (!existsSync(dir)) return 1;
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length + 1;
  }

  // ---------------------------------------------------------------------------
  // Gate state

  readGateState(runId: string): GateState {
    return readValidated(this.paths.gateStateFile(runId), GateStateSchema);
  }

  writeGateState(runId: string, state: GateState): void {
    writeValidated(this.paths.gateStateFile(runId), GateStateSchema, {
      ...state,
      updatedAt: this.clock.nowIso(),
    });
  }

  // ---------------------------------------------------------------------------
  // Report (markdown — prose, not schema-validated)

  readReport(runId: string): string {
    if (!existsSync(this.paths.reportFile(runId))) return "";
    return readFileSync(this.paths.reportFile(runId), "utf-8");
  }

  writeReport(runId: string, report: SubmitReport, markdown: string): void {
    mkdirSync(dirname(this.paths.reportFile(runId)), { recursive: true });
    writeAtomic(this.paths.reportFile(runId), markdown);
  }

  // ---------------------------------------------------------------------------
  // Nits (markdown — prose)

  readNits(runId: string): string {
    if (!existsSync(this.paths.nitsFile(runId))) return "";
    return readFileSync(this.paths.nitsFile(runId), "utf-8");
  }

  writeNits(runId: string, markdown: string): void {
    mkdirSync(dirname(this.paths.nitsFile(runId)), { recursive: true });
    writeAtomic(this.paths.nitsFile(runId), markdown);
  }

  // ---------------------------------------------------------------------------
  // Convergence (jsonl)

  appendConvergence(runId: string, entry: ConvergenceLogEntry): void {
    appendJsonl(this.paths.convergenceFile(runId), ConvergenceLogEntrySchema, entry);
  }

  readConvergence(runId: string): ConvergenceLogEntry[] {
    return readJsonl(this.paths.convergenceFile(runId), ConvergenceLogEntrySchema);
  }

  // ---------------------------------------------------------------------------
  // Packet freeze (markdown)

  freezePacket(runId: string, raw: string): void {
    const dir = this.paths.runDir(runId);
    mkdirSync(dir, { recursive: true });
    writeAtomic(this.paths.packetFile(runId), raw);
  }

  readFrozenPacket(runId: string): string {
    if (!existsSync(this.paths.packetFile(runId))) return "";
    return readFileSync(this.paths.packetFile(runId), "utf-8");
  }

  // ---------------------------------------------------------------------------
  // Active run pointer

  readActiveRun(): ActiveRun | undefined {
    return readValidatedIfExists(this.paths.activeRunFile, ActiveRunSchema);
  }

  writeActiveRun(run: ActiveRun): void {
    writeValidated(this.paths.activeRunFile, ActiveRunSchema, run);
  }

  clearActiveRun(): void {
    if (existsSync(this.paths.activeRunFile)) {
      unlinkSync(this.paths.activeRunFile);
    }
  }

  // ---------------------------------------------------------------------------
  // Campaign

  readCampaign(campaignId: string): Campaign | undefined {
    return readValidatedIfExists(this.paths.campaignFile(campaignId), CampaignSchema);
  }

  writeCampaign(campaign: Campaign): void {
    mkdirSync(this.paths.campaignDir(campaign.campaignId), { recursive: true });
    writeValidated(this.paths.campaignFile(campaign.campaignId), CampaignSchema, {
      ...campaign,
      updatedAt: this.clock.nowIso(),
    });
  }

  listCampaigns(): Campaign[] {
    const dir = this.paths.campaignsDir;
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .sort()
      .flatMap((campaignId) => {
        const c = readValidatedIfExists(this.paths.campaignFile(campaignId), CampaignSchema);
        return c ? [c] : [];
      });
  }

  // ---------------------------------------------------------------------------
  // Queue (list/admit/archive — F1 lexical order, F2 requeued-first, F3 never-delete)

  listQueue(): QueueEntry[] {
    mkdirSync(this.paths.queueDir, { recursive: true });

    // Requeued runs: meta.status === "queued", listed first (F2).
    const requeued: QueueEntry[] = this.listRunIds().flatMap((runId) => {
      const meta = this.readMetaIfExists(runId);
      if (meta?.status === "queued") {
        return [{ runId, admittedAt: meta.updatedAt }];
      }
      return [];
    });

    // Fresh packets in queue dir, sorted lexically (F1), excluding consumed runs.
    const fresh: QueueEntry[] = readdirSync(this.paths.queueDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => {
        const runId = f.replace(/\.md$/, "");
        const fullPath = join(this.paths.queueDir, f);
        const mtime = statSync(fullPath).mtime.toISOString();
        return { runId, admittedAt: mtime };
      })
      .filter((e) => !existsSync(this.paths.runDir(e.runId)));

    return [...requeued, ...fresh];
  }

  admitQueue(runId: string, raw: string): void {
    const problems: string[] = [];

    // (a) Extract repo path and base from raw frontmatter YAML block.
    const repoPath = extractRepoFromYaml(raw);
    const baseInFm = extractBaseFromYaml(raw);
    if (!repoPath) {
      problems.push("no repo specified in frontmatter");
      this.archiveAndFail(runId, raw, problems);
      return;
    }

    // (b) headBranch via Repo port — only when base is absent (K1: explicit base
    // is a deliberate override; stampBase no-ops on explicit base).
    let headBranch: string = "";
    if (!baseInFm) {
      try {
        headBranch = this.repo.headBranch(repoPath);
      } catch {
        problems.push(
          "headBranch failed: repo is not a valid git repository or is in a detached HEAD state",
        );
        this.archiveAndFail(runId, raw, problems);
        return;
      }
    }

    // (c) Stamp base from HEAD (no-ops if base is already present in frontmatter).
    const stamped = stampBase(raw, headBranch);

    // (d) Shape validation via parsePacketShape.
    const shape = parsePacketShape(stamped, runId);
    if (!shape.ok) {
      this.archiveAndFail(runId, stamped, shape.problems);
      return;
    }

    // (e) Filesystem verify: repo is a valid git repository, base branch exists.
    if (!this.repo.repoValid(repoPath)) {
      problems.push(`repo is not a valid git repository: ${repoPath}`);
      this.archiveAndFail(runId, stamped, problems);
      return;
    }
    const base = shape.packet.frontmatter.base;
    if (!this.repo.branchExists(repoPath, base)) {
      problems.push(`base branch "${base}" does not exist in repo`);
      this.archiveAndFail(runId, stamped, problems);
      return;
    }

    // (f) On success, write to queue dir.
    mkdirSync(this.paths.queueDir, { recursive: true });
    writeAtomic(join(this.paths.queueDir, `${runId}.md`), stamped);
  }

  archiveQueue(runId: string): void {
    // Archive the queue file if it exists, else no-op (mirror dropFromQueue).
    const file = join(this.paths.queueDir, `${runId}.md`);
    if (!existsSync(file)) return;
    archivePacket(this.paths, file);
  }

  // ---------------------------------------------------------------------------
  // Staged-chain registry (CONTRACT §19)

  listStaged(): StagedInfo[] {
    const stagedDir = this.paths.stagedDir;
    if (!existsSync(stagedDir)) return [];
    return readdirSync(stagedDir)
      .sort()
      .filter((f) => f.endsWith(".md"))
      .flatMap((f) => {
        const filePath = join(stagedDir, f);
        const raw = readFileSync(filePath, "utf-8");
        const result = parseStaged(raw, filePath);
        if (result.ok) return [result.info];
        return [];
      });
  }

  readStaged(runId: string): string | undefined {
    const file = this.paths.stagedFile(runId);
    if (!existsSync(file)) return undefined;
    return readFileSync(file, "utf-8");
  }

  writeStaged(runId: string, raw: string): void {
    const dir = dirname(this.paths.stagedFile(runId));
    mkdirSync(dir, { recursive: true });
    writeAtomic(this.paths.stagedFile(runId), raw);
  }

  removeStaged(runId: string): void {
    const file = this.paths.stagedFile(runId);
    if (existsSync(file)) {
      unlinkSync(file);
    }
  }

  // ---------------------------------------------------------------------------
  // Journal (append-only event log, CONTRACT §13, J3 lenient read)

  appendJournal(runId: string, event: JournalEvent): void {
    appendJsonl(this.paths.journalFile(runId), JournalEventSchema, event);
  }

  readJournal(runId: string): JournalEvent[] {
    return readJsonl(this.paths.journalFile(runId), JournalEventSchema);
  }

  // ---------------------------------------------------------------------------
  // Queue packet read — fresh-run source

  readQueuePacket(runId: string): string | undefined {
    const file = join(this.paths.queueDir, `${runId}.md`);
    if (!existsSync(file)) return undefined;
    return readFileSync(file, "utf-8");
  }

  // ---------------------------------------------------------------------------
  // Meta from queue — build minimal RunMeta from a fresh queue packet.
  // Derives worktree path via this adapter's paths; I/O lives on the store.

  initMetaFromQueue(runId: string): RunMeta | undefined {
    const raw = this.readQueuePacket(runId);
    if (!raw) return undefined;
    const repo = extractRepoFromYaml(raw);
    const base = extractBaseFromYaml(raw);
    if (!repo || !base) return undefined;
    return {
      runId,
      status: "queued",
      attempt: 1,
      repo,
      base,
      branch: `meridian/${runId}`,
      worktree: join(this.paths.runDir(runId), "worktree"),
      stallRetries: 0,
      reorientRetries: 0,
      updatedAt: this.clock.nowIso(),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers

  private archiveAndFail(runId: string, raw: string, problems: string[]): void {
    // Write the raw (possibly stamped) to a temp queue file so archive can relocate it.
    mkdirSync(this.paths.queueDir, { recursive: true });
    const tempPath = join(this.paths.queueDir, `${runId}.md`);
    writeAtomic(tempPath, raw);
    archivePacket(this.paths, tempPath, problems);
  }
}

// ---------------------------------------------------------------------------
// Import type alias needed for listStaged return type.

import type { StagedInfo } from "../domain/chain.js";
