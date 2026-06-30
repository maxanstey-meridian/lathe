// SqliteStoreAdapter: durable SQLite IO behind the Store port.
// Implements the Store port over node:sqlite DatabaseSync (WAL mode).
// Blobs (report, nits, frozen packet), checkpoints, staged registry,
// and queue packets stay file-backed via injected Paths — parity with
// the file adapter's behaviour.
//
// Constraints:
// - Injected Ports: Paths (layout), Repo (git-backed admission), Clock.
//   Never imports from src/config/.
// - Synchronous only: node:sqlite DatabaseSync is sync.
// - JSON-through-Zod: row payloads stored as JSON text, parsed through
//   the EXACT same Zod schemas the file adapter uses.
// - Clock-stamping happens BEFORE JSON.stringify, identical to StoreAdapter.
// - PRAGMA user_version for schema versioning (no parallel table).
// - Queue: file inbox stays external; listQueue scans queueDir for fresh
//   packets + queries runs table for requeued (replicates StoreAdapter.listQueue).
// - Staged: file-backed (paths.stagedDir + fsio writeAtomic), identical to StoreAdapter.

import {
  existsSync,
  readFileSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, dirname, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { Clock } from "../application/ports/clock.js";
import type { Repo } from "../application/ports/repo.js";
import type { Store, QueueEntry, ConvergenceLogEntry } from "../application/ports/store.js";
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
  ActiveConvergence,
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
  freshQueuePriority,
} from "../domain/packet.js";
import { RunMeta as RunMetaSchema } from "../domain/run.js";
import { ReviewState as ReviewStateSchema } from "../domain/run.js";
import { Decision as DecisionSchema } from "../domain/run.js";
import { ActiveRun as ActiveRunSchema } from "../domain/run.js";
import { ActiveConvergence as ActiveConvergenceSchema } from "../domain/run.js";
import { writeAtomic, writeValidated } from "../infrastructure/fsio.js";

// ---------------------------------------------------------------------------
// Convergence log entry schema — local, matching the port's ConvergenceLogEntry
// shape (the port ships only the type; appendJsonl/readJsonl require a schema).

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
  z.object({ action: z.literal("author"), blockers: z.array(Finding), promote: z.boolean() }),
  z.object({ action: z.literal("stop") }),
  z.object({ action: z.literal("escalate"), reason: z.string() }),
]);

const ConvergenceLogHeadSchema = {
  at: z.string(),
  runId: z.string(),
  campaignId: z.string(),
  pass: z.number().int(),
  maxPasses: z.number().int(),
  verification: VerificationResultSchema,
};

const ReviewedConvergenceSchema = z.object({
  kind: z.literal("reviewed").default("reviewed"),
  ...ConvergenceLogHeadSchema,
  decision: ConvergeDecisionSchema,
  amendedCommitSha: z.string().nullable(),
  primary: SuperReview,
  primaryRaw: z.string(),
});

const UnreachableConvergenceSchema = z.object({
  kind: z.literal("unreachable"),
  ...ConvergenceLogHeadSchema,
  detail: z.string(),
  attempt: z.number().int(),
  budget: z.number().int(),
});

const ConvergenceLogEntrySchema = z.union([
  UnreachableConvergenceSchema,
  ReviewedConvergenceSchema,
]);

// ---------------------------------------------------------------------------
// Archive helper — collision-safe with numeric suffix and .problems.txt sidecar

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
// SQLite helpers

type JsonRow = Record<string, unknown>;

const jsonParse = (value: string): JsonRow => JSON.parse(value);
const jsonStringify = (value: unknown): string => JSON.stringify(value);

// ---------------------------------------------------------------------------
// SqliteStoreAdapter

export class SqliteStoreAdapter implements Store {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly paths: Paths,
    private readonly repo: Repo,
    private readonly clock: Clock,
  ) {}

  static create(paths: Paths, repo: Repo, clock: Clock): Store {
    const db = new DatabaseSync(paths.dbFile);

    // WAL mode for concurrent reads during writes
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("PRAGMA synchronous=NORMAL;");
    db.exec("PRAGMA foreign_keys=ON;");
    db.exec("PRAGMA busy_timeout=5000;");

    // Schema versioning via PRAGMA user_version
    const row = db.prepare("PRAGMA user_version").get() as { user_version: number } | undefined;
    const version = row?.user_version ?? 0;
    if (version === 0) {
      createSchema(db);
      db.exec("PRAGMA user_version = 1;");
    }

    return new SqliteStoreAdapter(db, paths, repo, clock);
  }

  // ---------------------------------------------------------------------------
  // Run state (meta)

  readMeta(runId: string): RunMeta {
    const row = this.db.prepare("SELECT meta FROM runs WHERE run_id = ?").get(runId) as
      | { meta: string }
      | undefined;
    if (!row) {
      throw new Error(`run not found: ${runId}`);
    }
    const parsed = RunMetaSchema.parse(jsonParse(row.meta));
    return parsed;
  }

  readMetaIfExists(runId: string): RunMeta | undefined {
    const row = this.db.prepare("SELECT meta FROM runs WHERE run_id = ?").get(runId) as
      | { meta: string }
      | undefined;
    if (!row) {
      return undefined;
    }
    const parsed = RunMetaSchema.parse(jsonParse(row.meta));
    return parsed;
  }

  writeMeta(meta: RunMeta): void {
    const stamped: RunMeta = {
      ...meta,
      updatedAt: this.clock.nowIso(),
    };
    this.db
      .prepare("INSERT OR REPLACE INTO runs (run_id, meta) VALUES (?, ?)")
      .run(meta.runId, jsonStringify(stamped));
  }

  listRunIds(): string[] {
    const rows = this.db.prepare("SELECT run_id FROM runs ORDER BY run_id").all() as {
      run_id: string;
    }[];
    return rows.map((r) => r.run_id);
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
        state: undefined,
        nextAction: undefined,
        updatedAt: this.clock.nowIso(),
      })),
      updatedAt: this.clock.nowIso(),
    };
  }

  readLedger(runId: string): OutcomeLedger {
    const row = this.db.prepare("SELECT ledger FROM outcome_ledger WHERE run_id = ?").get(runId) as
      | { ledger: string }
      | undefined;
    if (!row) {
      throw new Error(`ledger not found: ${runId}`);
    }
    return OutcomeLedgerSchema.parse(jsonParse(row.ledger));
  }

  writeLedger(ledger: OutcomeLedger): void {
    const stamped: OutcomeLedger = {
      ...ledger,
      updatedAt: this.clock.nowIso(),
    };
    this.db
      .prepare("INSERT OR REPLACE INTO outcome_ledger (run_id, ledger) VALUES (?, ?)")
      .run(ledger.runId, jsonStringify(stamped));
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
    const row = this.db.prepare("SELECT state FROM review_state WHERE run_id = ?").get(runId) as
      | { state: string }
      | undefined;
    if (!row) {
      throw new Error(`review state not found: ${runId}`);
    }
    return ReviewStateSchema.parse(jsonParse(row.state));
  }

  replaceObligations(runId: string, constraints: string[]): ReviewState {
    const next: ReviewState = {
      runId,
      obligations: constraints.map((c) => c.trim()).filter((c) => c.length > 0),
      lastDecisionAt: this.clock.nowIso(),
      updatedAt: this.clock.nowIso(),
    };
    this.db
      .prepare("INSERT OR REPLACE INTO review_state (run_id, state) VALUES (?, ?)")
      .run(runId, jsonStringify(next));
    return next;
  }

  // ---------------------------------------------------------------------------
  // Decisions

  appendDecision(runId: string, decision: Decision): void {
    const validated = DecisionSchema.parse(decision);
    this.db
      .prepare("INSERT INTO decisions (run_id, decision) VALUES (?, ?)")
      .run(runId, jsonStringify(validated));
  }

  readDecisions(runId: string): Decision[] {
    const rows = this.db
      .prepare("SELECT decision FROM decisions WHERE run_id = ? ORDER BY seq")
      .all(runId) as { decision: string }[];
    return rows.map((r) => DecisionSchema.parse(jsonParse(r.decision)));
  }

  // ---------------------------------------------------------------------------
  // Convergence

  appendConvergence(runId: string, entry: ConvergenceLogEntry): void {
    const validated = ConvergenceLogEntrySchema.parse(entry);
    this.db
      .prepare("INSERT INTO convergence (run_id, entry) VALUES (?, ?)")
      .run(runId, jsonStringify(validated));
  }

  readConvergence(runId: string): ConvergenceLogEntry[] {
    const rows = this.db
      .prepare("SELECT entry FROM convergence WHERE run_id = ? ORDER BY seq")
      .all(runId) as { entry: string }[];
    return rows.map((r) => ConvergenceLogEntrySchema.parse(jsonParse(r.entry)));
  }

  // ---------------------------------------------------------------------------
  // Report (markdown — prose, not schema-validated)

  readReport(runId: string): string {
    if (!existsSync(this.paths.reportFile(runId))) {
      return "";
    }
    return readFileSync(this.paths.reportFile(runId), "utf-8");
  }

  writeReport(runId: string, report: SubmitReport, markdown: string): void {
    mkdirSync(dirname(this.paths.reportFile(runId)), { recursive: true });
    writeAtomic(this.paths.reportFile(runId), markdown);
  }

  // ---------------------------------------------------------------------------
  // Nits (markdown — prose)

  readNits(runId: string): string {
    if (!existsSync(this.paths.nitsFile(runId))) {
      return "";
    }
    return readFileSync(this.paths.nitsFile(runId), "utf-8");
  }

  writeNits(runId: string, markdown: string): void {
    mkdirSync(dirname(this.paths.nitsFile(runId)), { recursive: true });
    writeAtomic(this.paths.nitsFile(runId), markdown);
  }

  // ---------------------------------------------------------------------------
  // Convergence (jsonl — stored in SQLite table)

  // (already handled by appendConvergence / readConvergence above)

  // ---------------------------------------------------------------------------
  // Packet freeze (markdown — file-backed)

  freezePacket(runId: string, raw: string): void {
    const dir = this.paths.runDir(runId);
    mkdirSync(dir, { recursive: true });
    writeAtomic(this.paths.packetFile(runId), raw);
  }

  readFrozenPacket(runId: string): string {
    if (!existsSync(this.paths.packetFile(runId))) {
      return "";
    }
    return readFileSync(this.paths.packetFile(runId), "utf-8");
  }

  // ---------------------------------------------------------------------------
  // Active run pointer

  readActiveRun(): ActiveRun | undefined {
    const row = this.db.prepare("SELECT run FROM active_run WHERE key = '1'").get() as
      | { run: string }
      | undefined;
    if (!row) {
      return undefined;
    }
    return ActiveRunSchema.parse(jsonParse(row.run));
  }

  writeActiveRun(run: ActiveRun): void {
    this.db
      .prepare("INSERT OR REPLACE INTO active_run (key, run) VALUES ('1', ?)")
      .run(jsonStringify(run));
  }

  clearActiveRun(): void {
    this.db.prepare("DELETE FROM active_run WHERE key = '1'").run();
  }

  // ---------------------------------------------------------------------------
  // Active convergence pointer

  readActiveConvergence(): ActiveConvergence | undefined {
    const row = this.db
      .prepare("SELECT convergence FROM active_convergence WHERE key = '1'")
      .get() as { convergence: string } | undefined;
    if (!row) {
      return undefined;
    }
    return ActiveConvergenceSchema.parse(jsonParse(row.convergence));
  }

  writeActiveConvergence(convergence: ActiveConvergence): void {
    this.db
      .prepare("INSERT OR REPLACE INTO active_convergence (key, convergence) VALUES ('1', ?)")
      .run(jsonStringify(convergence));
  }

  clearActiveConvergence(): void {
    this.db.prepare("DELETE FROM active_convergence WHERE key = '1'").run();
  }

  // ---------------------------------------------------------------------------
  // Campaign

  readCampaign(campaignId: string): Campaign | undefined {
    const row = this.db
      .prepare("SELECT campaign FROM campaigns WHERE campaign_id = ?")
      .get(campaignId) as { campaign: string } | undefined;
    if (!row) {
      return undefined;
    }
    return CampaignSchema.parse(jsonParse(row.campaign));
  }

  writeCampaign(campaign: Campaign): void {
    const stamped: Campaign = {
      ...campaign,
      updatedAt: this.clock.nowIso(),
    };
    this.db
      .prepare("INSERT OR REPLACE INTO campaigns (campaign_id, campaign) VALUES (?, ?)")
      .run(campaign.campaignId, jsonStringify(stamped));
  }

  listCampaigns(): Campaign[] {
    const rows = this.db.prepare("SELECT campaign FROM campaigns ORDER BY campaign_id").all() as {
      campaign: string;
    }[];
    return rows.map((r) => CampaignSchema.parse(jsonParse(r.campaign)));
  }

  // ---------------------------------------------------------------------------
  // Queue — file inbox (NOT a SQLite index)
  //
  // The queue dir is an EXTERNAL inbox: `meridian plan` tells /packet skill to
  // write .md files directly to queueDir. A SQLite index would miss every
  // packet written externally. listQueue MUST replicate StoreAdapter.listQueue:
  //   requeued = query runs table WHERE status='queued'
  //   fresh = readdirSync(queueDir), filter .md, .sort() lexical, map with
  //           statSync mtime, filter !existsSync(runDir)
  //
  // admitQueue and archiveQueue operate on the filesystem (same as StoreAdapter).
  // ---------------------------------------------------------------------------

  listQueue(): QueueEntry[] {
    mkdirSync(this.paths.queueDir, { recursive: true });

    // Requeued runs: meta.status === "queued", listed first (F2).
    // Query runs table instead of scanning meta.json files.
    const requeued: QueueEntry[] = this.db
      .prepare("SELECT meta FROM runs ORDER BY run_id")
      .all()
      .map((r) => {
        const meta = RunMetaSchema.parse(JSON.parse(String(r.meta)));
        if (meta.status === "queued") {
          return { runId: meta.runId, admittedAt: meta.updatedAt };
        }
        return null;
      })
      .filter((e): e is QueueEntry => e !== null);

    // Fresh packets in queue dir, lifecycle-priority sorted, excluding consumed runs.
    const fresh: QueueEntry[] = readdirSync(this.paths.queueDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .map((f) => {
        const runId = f.replace(/\.md$/, "");
        const fullPath = join(this.paths.queueDir, f);
        const mtime = statSync(fullPath).mtime.toISOString();
        return {
          runId,
          admittedAt: mtime,
          priority: freshQueuePriority(readFileSync(fullPath, "utf-8")),
        };
      })
      .filter((e) => !existsSync(this.paths.runDir(e.runId)))
      .sort((a, b) => a.priority - b.priority || a.runId.localeCompare(b.runId))
      .map(({ runId, admittedAt }) => ({ runId, admittedAt }));

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

    // (f) On success, write to queue dir (file-backed, same as StoreAdapter).
    mkdirSync(this.paths.queueDir, { recursive: true });
    writeAtomic(join(this.paths.queueDir, `${runId}.md`), stamped);
  }

  archiveQueue(runId: string): void {
    // Archive the queue file if it exists, else no-op (mirror dropFromQueue).
    const file = join(this.paths.queueDir, `${runId}.md`);
    if (!existsSync(file)) {
      return;
    }
    archivePacket(this.paths, file);
  }

  // ---------------------------------------------------------------------------
  // Queue packet read — fresh-run source (file-backed)

  readQueuePacket(runId: string): string | undefined {
    const file = join(this.paths.queueDir, `${runId}.md`);
    if (!existsSync(file)) {
      return undefined;
    }
    return readFileSync(file, "utf-8");
  }

  // ---------------------------------------------------------------------------
  // Meta from queue — build minimal RunMeta from a fresh queue packet.

  initMetaFromQueue(runId: string): RunMeta | undefined {
    const raw = this.readQueuePacket(runId);
    if (!raw) {
      return undefined;
    }
    const repo = extractRepoFromYaml(raw);
    const base = extractBaseFromYaml(raw);
    if (!repo || !base) {
      return undefined;
    }
    return {
      runId,
      status: "queued",
      attempt: 1,
      repo,
      base,
      branch: `meridian/${runId}`,
      worktree: join(this.paths.runDir(runId), "worktree"),
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      reviewerUnreachable: 0,
      promoted: false,
      updatedAt: this.clock.nowIso(),
    };
  }

  // ---------------------------------------------------------------------------
  // Gate state

  readGateState(runId: string): GateState {
    const row = this.db.prepare("SELECT state FROM gate_state WHERE run_id = ?").get(runId) as
      | { state: string }
      | undefined;
    if (!row) {
      throw new Error(`gate state not found: ${runId}`);
    }
    return GateStateSchema.parse(jsonParse(row.state));
  }

  writeGateState(runId: string, state: GateState): void {
    const stamped: GateState = {
      ...state,
      updatedAt: this.clock.nowIso(),
    };
    this.db
      .prepare("INSERT OR REPLACE INTO gate_state (run_id, state) VALUES (?, ?)")
      .run(runId, jsonStringify(stamped));
  }

  // ---------------------------------------------------------------------------
  // Checkpoints (file-backed — checkpoints dir, numbered .json files)

  latestCheckpoint(runId: string): Checkpoint | undefined {
    const dir = this.paths.checkpointsDir(runId);
    if (!existsSync(dir)) {
      return undefined;
    }
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    const last = files[files.length - 1];
    return last
      ? CheckpointSchema.parse(JSON.parse(readFileSync(join(dir, last), "utf-8")))
      : undefined;
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
    if (!existsSync(dir)) {
      return 1;
    }
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length + 1;
  }

  // ---------------------------------------------------------------------------
  // Staged-chain registry (file-backed — raw markdown, parsed by parseStaged)
  // Same filesystem pattern as StoreAdapter.listStaged/readStaged/writeStaged/removeStaged.
  // ---------------------------------------------------------------------------

  listStaged(): { runId: string; parentRunId: string | undefined; repo: string }[] {
    const stagedDir = this.paths.stagedDir;
    if (!existsSync(stagedDir)) {
      return [];
    }
    return readdirSync(stagedDir)
      .sort()
      .filter((f) => f.endsWith(".md"))
      .flatMap((f) => {
        const filePath = join(stagedDir, f);
        const raw = readFileSync(filePath, "utf-8");
        const result = parseStaged(raw, filePath);
        if (result.ok) {
          return [
            {
              runId: result.info.runId,
              parentRunId: result.info.parentRunId,
              repo: result.info.repo,
            },
          ];
        }
        return [];
      });
  }

  readStaged(runId: string): string | undefined {
    const file = this.paths.stagedFile(runId);
    if (!existsSync(file)) {
      return undefined;
    }
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
  // Fresh-start resume-artifact cleanup

  clearResumeArtifacts(runId: string): void {
    // Checkpoints (file-backed numbered .json files)
    const checkpointDir = this.paths.checkpointsDir(runId);
    if (existsSync(checkpointDir)) {
      rmSync(checkpointDir, { recursive: true, force: true });
    }
    // Decisions (SQLite row)
    this.db.prepare("DELETE FROM decisions WHERE run_id = ?").run(runId);
    // Review state (SQLite row)
    this.db.prepare("DELETE FROM review_state WHERE run_id = ?").run(runId);
  }

  // ---------------------------------------------------------------------------
  // Journal (append-only event log) — stored in SQLite events table

  appendJournal(runId: string, event: JournalEvent): void {
    const validated = JournalEventSchema.parse(event);
    this.db
      .prepare("INSERT INTO events (run_id, event) VALUES (?, ?)")
      .run(runId, jsonStringify(validated));
  }

  readJournal(runId: string): JournalEvent[] {
    const rows = this.db
      .prepare("SELECT event FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as { event: string }[];
    return rows.map((r) => JournalEventSchema.parse(jsonParse(r.event)));
  }

  // ---------------------------------------------------------------------------
  // Global resumable journal — cross-run, gap-free, sorted by seq

  readJournalSince(seq: number): { seq: number; runId: string; event: JournalEvent }[] {
    const rows = this.db
      .prepare("SELECT seq, run_id, event FROM events WHERE seq > ? ORDER BY seq")
      .all(seq) as { seq: number; run_id: string; event: string }[];
    return rows.map((r) => ({
      seq: r.seq,
      runId: r.run_id,
      event: JournalEventSchema.parse(jsonParse(r.event)),
    }));
  }

  // ---------------------------------------------------------------------------
  // Internal helpers

  private archiveAndFail(runId: string, raw: string, problems: string[]): void {
    mkdirSync(this.paths.queueDir, { recursive: true });
    const tempPath = join(this.paths.queueDir, `${runId}.md`);
    writeAtomic(tempPath, raw);
    archivePacket(this.paths, tempPath, problems);
  }
}

// ---------------------------------------------------------------------------
// Schema creation (runs, events, decisions, convergence, outcome_ledger,
// review_state, gate_state, active_run, campaigns).
//
// NO queue_index table: the queue dir is an external inbox.
// NO staged table: staged registry stays file-backed.
// ---------------------------------------------------------------------------

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs(
      run_id TEXT PRIMARY KEY,
      meta TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions(
      run_id TEXT NOT NULL,
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      decision TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS convergence(
      run_id TEXT NOT NULL,
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      entry TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outcome_ledger(
      run_id TEXT PRIMARY KEY,
      ledger TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS review_state(
      run_id TEXT PRIMARY KEY,
      state TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gate_state(
      run_id TEXT PRIMARY KEY,
      state TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_run(
      key TEXT PRIMARY KEY DEFAULT '1',
      run TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_convergence(
      key TEXT PRIMARY KEY DEFAULT '1',
      convergence TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaigns(
      campaign_id TEXT PRIMARY KEY,
      campaign TEXT NOT NULL
    );
  `);
}
