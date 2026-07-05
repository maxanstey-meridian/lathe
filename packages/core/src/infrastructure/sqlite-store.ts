// SqliteStoreAdapter: durable SQLite IO behind the Store port.
// Implements the Store port over node:sqlite DatabaseSync (WAL mode).
// Structured state and non-packet artifacts live in SQLite. Packet markdown
// remains the live editable run packet at paths.packetFile(runId).
//
// Constraints:
// - Injected Ports: Paths (layout), Repo (git-backed admission), Clock.
//   Never imports from src/config/.
// - Synchronous only: node:sqlite DatabaseSync is sync.
// - JSON-through-Zod: row payloads stored as JSON text, parsed through
//   the domain Zod schemas.
// - Clock-stamping happens BEFORE JSON.stringify.
// - PRAGMA user_version for schema versioning.
// - Queue: unified into runs table — status = 'queued' IS the queue.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
} from "../domain/packet.js";
import { RunMeta as RunMetaSchema } from "../domain/run.js";
import { ReviewState as ReviewStateSchema } from "../domain/run.js";
import { Decision as DecisionSchema } from "../domain/run.js";
import { ActiveRun as ActiveRunSchema } from "../domain/run.js";
import { ActiveConvergence as ActiveConvergenceSchema } from "../domain/run.js";

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
// SQLite helpers

type JsonRow = Record<string, unknown>;

const jsonParse = (value: string): JsonRow => JSON.parse(value);
const jsonStringify = (value: unknown): string => JSON.stringify(value);

const writeTextAtomic = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
};

// ---------------------------------------------------------------------------
// SqliteStoreAdapter

export class SqliteStoreAdapter implements Store {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly paths: Paths,
    private readonly repo: Repo,
    private readonly clock: Clock,
  ) {}

  static create(paths: Paths, repo: Repo, clock: Clock): SqliteStoreAdapter {
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
      db.exec("PRAGMA user_version = 3;");
    } else if (version === 1) {
      migrateV1toV2(db);
      db.exec("PRAGMA user_version = 3;");
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
    // Ensure the run directory exists for live packet markdown, sandbox/worktree,
    // and handoff runtime artifacts that still live on the filesystem.
    mkdirSync(this.paths.runDir(meta.runId), { recursive: true });
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

  listMeta(): RunMeta[] {
    const rows = this.db.prepare("SELECT meta FROM runs ORDER BY run_id").all() as {
      meta: string;
    }[];
    return rows.map((r) => RunMetaSchema.parse(jsonParse(r.meta)));
  }

  listRunsByCampaign(campaignId: string): RunMeta[] {
    const rows = this.db
      .prepare(
        "SELECT meta FROM runs WHERE json_extract(meta, '$.campaignId') = ? ORDER BY json_extract(meta, '$.pass') ASC",
      )
      .all(campaignId) as { meta: string }[];
    return rows.map((r) => RunMetaSchema.parse(jsonParse(r.meta)));
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
  // Report (markdown — prose, stored as TEXT in SQLite)

  readReport(runId: string): string {
    const row = this.db.prepare("SELECT markdown FROM reports WHERE run_id = ?").get(runId) as
      | { markdown: string }
      | undefined;
    return row?.markdown ?? "";
  }

  writeReport(runId: string, report: SubmitReport, markdown: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO reports (run_id, markdown) VALUES (?, ?)")
      .run(runId, markdown);
  }

  // ---------------------------------------------------------------------------
  // Nits (markdown — prose, stored as TEXT in SQLite)

  readNits(runId: string): string {
    const row = this.db.prepare("SELECT markdown FROM nits WHERE run_id = ?").get(runId) as
      | { markdown: string }
      | undefined;
    return row?.markdown ?? "";
  }

  writeNits(runId: string, markdown: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO nits (run_id, markdown) VALUES (?, ?)")
      .run(runId, markdown);
  }

  // ---------------------------------------------------------------------------
  // Convergence (jsonl — stored in SQLite table)

  // (already handled by appendConvergence / readConvergence above)

  // ---------------------------------------------------------------------------
  // Active run pointer — multi-row keyed by runId

  listActiveRuns(): ActiveRun[] {
    const rows = this.db.prepare("SELECT run FROM active_run").all() as { run: string }[];
    return rows.map((r) => ActiveRunSchema.parse(jsonParse(r.run)));
  }

  addActiveRun(run: ActiveRun): void {
    this.db
      .prepare("INSERT OR REPLACE INTO active_run (run_id, run) VALUES (?, ?)")
      .run(run.runId, jsonStringify(run));
    this.syncActiveRunFile();
  }

  removeActiveRun(runId: string): void {
    this.db.prepare("DELETE FROM active_run WHERE run_id = ?").run(runId);
    this.syncActiveRunFile();
  }

  private syncActiveRunFile(): void {
    // Dual-write: the gate plugin runs inside Baby's opencode subprocess and
    // reads active-run.json synchronously from disk. SQLite is authoritative,
    // but the plugin has no daemon access — this file is the bridge.
    // Must always regenerate the full array after each mutation; never unlink.
    const runs = this.listActiveRuns();
    writeTextAtomic(join(this.paths.root, "active-run.json"), jsonStringify(runs));
  }

  // ---------------------------------------------------------------------------
  // Active convergence pointer — multi-row keyed by runId

  listActiveConvergences(): ActiveConvergence[] {
    const rows = this.db.prepare("SELECT convergence FROM active_convergence").all() as {
      convergence: string;
    }[];
    return rows.map((r) => ActiveConvergenceSchema.parse(jsonParse(r.convergence)));
  }

  addActiveConvergence(convergence: ActiveConvergence): void {
    this.db
      .prepare("INSERT OR REPLACE INTO active_convergence (run_id, convergence) VALUES (?, ?)")
      .run(convergence.runId, jsonStringify(convergence));
  }

  removeActiveConvergence(runId: string): void {
    this.db.prepare("DELETE FROM active_convergence WHERE run_id = ?").run(runId);
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
  // Queue — unified into the runs table (no queueDir)
  //
  // A queued run IS the queue: a run row with status = 'queued'. Admission
  // validates the packet, writes the live run packet file, and stamps meta
  // with status = 'queued'. listQueue is a SQL query. archiveQueue marks
  // the run stopped. readQueuePacket reads the current live packet file.
  // ---------------------------------------------------------------------------

  listQueue(): QueueEntry[] {
    return this.db
      .prepare(
        "SELECT run_id, meta FROM runs WHERE json_extract(meta, '$.status') = 'queued' ORDER BY CASE WHEN json_extract(meta, '$.attempt') > 1 THEN 0 ELSE 1 END, run_id",
      )
      .all()
      .map((r) => {
        const meta = RunMetaSchema.parse(JSON.parse(String(r.meta)));
        return { runId: meta.runId, admittedAt: meta.updatedAt };
      });
  }

  claimNextQueuedRun(
    excludedRepos: string[],
    seams?: { beforeUpdate?: (runId: string) => void },
  ): QueueEntry | undefined {
    // Build the SELECT with optional repo exclusion.
    let selectSql = "SELECT run_id, meta FROM runs WHERE json_extract(meta, '$.status') = 'queued'";
    if (excludedRepos.length > 0) {
      const placeholders = excludedRepos.map(() => "?").join(", ");
      selectSql += ` AND json_extract(meta, '$.repo') NOT IN (${placeholders})`;
    }
    selectSql +=
      " ORDER BY CASE WHEN json_extract(meta, '$.attempt') > 1 THEN 0 ELSE 1 END, run_id LIMIT 1";

    // CAS retry loop: pick a candidate, attempt conditional UPDATE, retry if another worker snatched it.
    const bindArgs = excludedRepos.length > 0 ? excludedRepos : [];
    for (;;) {
      const row = this.db.prepare(selectSql).all(...bindArgs) as {
        run_id: string;
        meta: string;
      }[];
      if (row.length === 0) {
        return undefined;
      }

      const runId = row.at(0)!.run_id;
      seams?.beforeUpdate?.(runId);
      const nowIso = this.clock.nowIso();
      const result = this.db
        .prepare(
          "UPDATE runs SET meta = json_set(meta, '$.status', 'running', '$.updatedAt', ?) WHERE run_id = ? AND json_extract(meta, '$.status') = 'queued'",
        )
        .run(nowIso, runId);

      if (result.changes === 1) {
        const meta = this.readMeta(runId);
        return { runId: meta.runId, admittedAt: meta.updatedAt };
      }
      // changes === 0: another worker claimed it — retry loop.
    }
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

    // (b) headBranch via Repo port — only when base is absent.
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

    // (f) On success: write the live editable run packet + write meta as queued.
    mkdirSync(this.paths.runDir(runId), { recursive: true });
    writeTextAtomic(this.paths.packetFile(runId), stamped);

    // Campaign fields from packet frontmatter (optional campaign_id, pass defaults to 1).
    const campaignId = shape.packet.frontmatter.campaign_id;
    const pass = shape.packet.frontmatter.pass ?? 1;
    this.writeMeta({
      runId,
      status: "queued",
      attempt: 1,
      repo: repoPath,
      base,
      branch: `meridian/${runId}`,
      worktree: join(this.paths.runDir(runId), "worktree"),
      ...(campaignId !== undefined ? { campaignId } : {}),
      pass,
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      reviewerUnreachable: 0,
      promoted: false,
      updatedAt: this.clock.nowIso(),
    });
  }

  archiveQueue(runId: string): void {
    // Mark the run stopped in SQLite. The live packet file stays in the run
    // dir (harmless; the run is terminal).
    const meta = this.readMetaIfExists(runId);
    if (meta) {
      this.writeMeta({ ...meta, status: "stopped" as const, updatedAt: this.clock.nowIso() });
    }
  }

  // ---------------------------------------------------------------------------
  // Live packet read — admission writes the initial run packet here, and resume
  // re-reads the current content so dev edits are observed.

  readQueuePacket(runId: string): string | undefined {
    const file = this.paths.packetFile(runId);
    if (!existsSync(file)) {
      return undefined;
    }
    return readFileSync(file, "utf-8");
  }

  /** Read rejected packet for inspection. */
  readRejected(runId: string): { raw: string; problems: string | null } | undefined {
    const row = this.db
      .prepare("SELECT raw, problems FROM rejected WHERE run_id = ?")
      .get(runId) as { raw: string; problems: string | null } | undefined;
    return row;
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
      pass: 1,
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
    // Dual-write: the gate plugin reads gate-state.json synchronously from the
    // run directory. SQLite is authoritative, but the plugin has no daemon access.
    writeTextAtomic(join(this.paths.runDir(runId), "gate-state.json"), jsonStringify(stamped));
  }

  // ---------------------------------------------------------------------------
  // Checkpoints (stored in SQLite checkpoints table)

  latestCheckpoint(runId: string): Checkpoint | undefined {
    const row = this.db
      .prepare("SELECT data FROM checkpoints WHERE run_id = ? ORDER BY number DESC LIMIT 1")
      .get(runId) as { data: string } | undefined;
    return row ? CheckpointSchema.parse(jsonParse(row.data)) : undefined;
  }

  writeCheckpoint(runId: string, checkpoint: Checkpoint): void {
    const validated = CheckpointSchema.parse(checkpoint);
    this.db
      .prepare("INSERT OR REPLACE INTO checkpoints (run_id, number, data) VALUES (?, ?, ?)")
      .run(runId, validated.number, jsonStringify(validated));
  }

  nextCheckpointNumber(runId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM checkpoints WHERE run_id = ?")
      .get(runId) as { count: number };
    return row.count + 1;
  }

  // ---------------------------------------------------------------------------
  // Staged-chain registry (stored in SQLite staged table)

  listStaged(): { runId: string; parentRunId: string | undefined; repo: string }[] {
    const rows = this.db
      .prepare("SELECT run_id, parent_run_id, repo FROM staged ORDER BY run_id")
      .all() as { run_id: string; parent_run_id: string | null; repo: string }[];
    return rows.map((r) => ({
      runId: r.run_id,
      parentRunId: r.parent_run_id ?? undefined,
      repo: r.repo,
    }));
  }

  readStaged(runId: string): string | undefined {
    const row = this.db.prepare("SELECT raw FROM staged WHERE run_id = ?").get(runId) as
      | { raw: string }
      | undefined;
    return row?.raw;
  }

  writeStaged(runId: string, raw: string): void {
    const parsed = parseStaged(raw, `${runId}.md`);
    if (!parsed.ok) {
      return;
    }
    this.db
      .prepare(
        "INSERT OR REPLACE INTO staged (run_id, raw, parent_run_id, repo) VALUES (?, ?, ?, ?)",
      )
      .run(runId, raw, parsed.info.parentRunId ?? null, parsed.info.repo);
  }

  removeStaged(runId: string): void {
    this.db.prepare("DELETE FROM staged WHERE run_id = ?").run(runId);
  }

  // ---------------------------------------------------------------------------
  // Fresh-start resume-artifact cleanup

  clearResumeArtifacts(runId: string): void {
    this.db.prepare("DELETE FROM checkpoints WHERE run_id = ?").run(runId);
    this.db.prepare("DELETE FROM decisions WHERE run_id = ?").run(runId);
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
    this.db
      .prepare("INSERT OR REPLACE INTO rejected (run_id, raw, problems) VALUES (?, ?, ?)")
      .run(runId, raw, problems.length > 0 ? problems.join("\n") : null);
  }
}

// ---------------------------------------------------------------------------
// Schema creation (runs, events, decisions, convergence, outcome_ledger,
// review_state, gate_state, active_run, campaigns, reports, nits,
// checkpoints, staged, rejected).
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
      run_id TEXT PRIMARY KEY,
      run TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS active_convergence(
      run_id TEXT PRIMARY KEY,
      convergence TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS campaigns(
      campaign_id TEXT PRIMARY KEY,
      campaign TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports(
      run_id TEXT PRIMARY KEY,
      markdown TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nits(
      run_id TEXT PRIMARY KEY,
      markdown TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkpoints(
      run_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY(run_id, number)
    );

    CREATE TABLE IF NOT EXISTS staged(
      run_id TEXT PRIMARY KEY,
      raw TEXT NOT NULL,
      parent_run_id TEXT,
      repo TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rejected(
      run_id TEXT PRIMARY KEY,
      raw TEXT NOT NULL,
      problems TEXT
    );
  `);
}

function migrateV1toV2(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports(
      run_id TEXT PRIMARY KEY,
      markdown TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nits(
      run_id TEXT PRIMARY KEY,
      markdown TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS checkpoints(
      run_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY(run_id, number)
    );

    CREATE TABLE IF NOT EXISTS staged(
      run_id TEXT PRIMARY KEY,
      raw TEXT NOT NULL,
      parent_run_id TEXT,
      repo TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rejected(
      run_id TEXT PRIMARY KEY,
      raw TEXT NOT NULL,
      problems TEXT
    );
  `);
}
