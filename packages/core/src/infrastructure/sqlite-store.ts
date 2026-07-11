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
// - One canonical additive schema is reconciled transactionally on open.
// - Queue: unified into runs table — status = 'queued' IS the queue.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

type ProcessIdentity = { state: "live"; token: string } | { state: "dead" } | { state: "unknown" };

const readProcessIdentity = (pid: number): ProcessIdentity => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH" || code === "EINVAL") {
      return { state: "dead" };
    }
    if (code !== "EPERM") {
      return { state: "unknown" };
    }
  }
  try {
    const startedAt = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return startedAt ? { state: "live", token: `${pid}:${startedAt}` } : { state: "dead" };
  } catch {
    return { state: "unknown" };
  }
};

const CURRENT_PROCESS_IDENTITY = readProcessIdentity(process.pid);
if (CURRENT_PROCESS_IDENTITY.state !== "live") {
  throw new Error("cannot determine process identity for repository lease safety");
}
const PROCESS_INSTANCE_TOKEN = CURRENT_PROCESS_IDENTITY.token;
import { RepositoryLeaseLostError } from "../application/errors/repository-lease-lost.js";
import { RunTransitionConflictError } from "../application/errors/run-transition-conflict.js";
import type { Clock } from "../application/ports/clock.js";
import type { Repo } from "../application/ports/repo.js";
import type {
  Store,
  QueueEntry,
  ClaimedQueueEntry,
  RepositoryLease,
  ConvergenceLogEntry,
  JournalStats,
  RunTransition,
  CampaignAcceptance,
  AnswerTransition,
  ConvergencePublication,
} from "../application/ports/store.js";
import type { Paths } from "../config/paths.js";
import { Campaign as CampaignSchema } from "../domain/campaign.js";
import { parseStaged } from "../domain/chain.js";
import {
  ConvergenceOperation as ConvergenceOperationSchema,
  SuperReview,
  Finding,
  type ConvergenceOperation,
} from "../domain/convergence.js";
import { GateState as GateStateSchema } from "../domain/gate.js";
import type {
  RunMeta,
  ReviewState,
  Decision,
  ActiveRun,
  ActiveConvergence,
} from "../domain/run.js";
import type { OutcomeLedger, Checkpoint } from "../domain/outcomes.js";
import type { GateState } from "../domain/gate.js";
import type { Packet } from "../domain/packet.js";
import type { Campaign } from "../domain/campaign.js";
import type { SubmitReport } from "../domain/report.js";
import type { JournalEvent } from "../domain/journal.js";
import { JournalEvent as JournalEventSchema } from "../domain/journal.js";
import {
  AcceptanceOperation as AcceptanceOperationSchema,
  RunStartupOperation as RunStartupOperationSchema,
  type AcceptanceOperation,
  type RunStartupOperation,
} from "../domain/operations.js";
import { OutcomeLedger as OutcomeLedgerSchema } from "../domain/outcomes.js";
import { Checkpoint as CheckpointSchema } from "../domain/outcomes.js";
import {
  parsePacketShape,
  stampBase,
  extractRepoFromYaml,
  extractBaseFromYaml,
} from "../domain/packet.js";
import type { Plan } from "../domain/plan.js";
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

const ConvergenceLogEntrySchema = ReviewedConvergenceSchema;

// ---------------------------------------------------------------------------
// SQLite helpers

type JsonRow = Record<string, unknown>;
// Synchronous Git/filesystem effects cannot be interrupted for a timer heartbeat.
// Keep enough headroom for one effect; use cases still renew before and after each one.
const LEASE_TTL_MS = 5 * 60_000;

const jsonParse = (value: string): JsonRow => JSON.parse(value);
const jsonStringify = (value: unknown): string => JSON.stringify(value);

const writeTextAtomic = (path: string, content: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, path);
  } finally {
    if (existsSync(tmp)) {
      unlinkSync(tmp);
    }
  }
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

    db.exec("BEGIN IMMEDIATE");
    try {
      const existingSchema = db.prepare("PRAGMA user_version").get() as { user_version: number };
      const hadRunsTable = !!db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
        .get();
      if (existingSchema.user_version < 7) {
        db.exec(
          "DROP TABLE IF EXISTS repository_leases; DROP TABLE IF EXISTS repository_lease_epochs; DROP TABLE IF EXISTS repository_lease_owners;",
        );
      }
      createSchema(db);
      const semantics = db
        .prepare("SELECT value FROM store_metadata WHERE key = 'attempt_semantics'")
        .get() as { value: string } | undefined;
      if (!semantics) {
        const runCount = (
          db.prepare("SELECT COUNT(*) AS count FROM runs").get() as { count: number }
        ).count;
        if (
          hadRunsTable &&
          runCount > 0 &&
          (existingSchema.user_version === 0 || existingSchema.user_version > 4)
        ) {
          throw new Error(
            `cannot determine attempt semantics for existing schema version ${existingSchema.user_version}; explicit migration required`,
          );
        }
        if (hadRunsTable && existingSchema.user_version >= 1 && existingSchema.user_version <= 4) {
          db.exec(`
            INSERT OR IGNORE INTO legacy_attempt_claims(run_id)
            SELECT run_id
            FROM runs
            WHERE json_extract(meta, '$.status') = 'queued'
          `);
        }
        db.prepare(
          "INSERT INTO store_metadata(key, value) VALUES ('attempt_semantics', 'claim_v2')",
        ).run();
      }
      db.exec("PRAGMA user_version = 7;");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const store = new SqliteStoreAdapter(db, paths, repo, clock);
    store.reconcilePacketProjections();
    return store;
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
      .prepare("INSERT INTO runs (run_id, meta) VALUES (?, ?)")
      .run(meta.runId, jsonStringify(stamped));
  }

  transitionRun(transition: RunTransition): RunMeta {
    if (transition.meta.runId !== transition.runId) {
      throw new Error(
        `run transition identity mismatch: row ${transition.runId}, meta ${transition.meta.runId}`,
      );
    }
    const activeRun = transition.activeRun
      ? ActiveRunSchema.parse(transition.activeRun)
      : transition.activeRun;
    if (activeRun && activeRun.runId !== transition.runId) {
      throw new Error(
        `run transition identity mismatch: row ${transition.runId}, active run ${activeRun.runId}`,
      );
    }
    const event = transition.event ? JournalEventSchema.parse(transition.event) : undefined;
    const current = this.readMeta(transition.runId);
    const currentRevision = current.revision ?? 0;
    if (currentRevision !== transition.expectedRevision) {
      throw new RunTransitionConflictError(
        `run ${transition.runId} revision conflict: expected ${transition.expectedRevision}, found ${currentRevision}`,
      );
    }
    if (!transition.expectedStatuses.includes(current.status)) {
      throw new RunTransitionConflictError(
        `run ${transition.runId} status conflict: expected ${transition.expectedStatuses.join("|")}, found ${current.status}`,
      );
    }

    const next = RunMetaSchema.parse({
      ...transition.meta,
      revision: currentRevision + 1,
      updatedAt: this.clock.nowIso(),
    });

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          "UPDATE runs SET meta = ? WHERE run_id = ? AND COALESCE(json_extract(meta, '$.revision'), 0) = ? AND json_extract(meta, '$.status') IN (SELECT value FROM json_each(?))",
        )
        .run(
          jsonStringify(next),
          transition.runId,
          transition.expectedRevision,
          jsonStringify(transition.expectedStatuses),
        );
      if (result.changes !== 1) {
        throw new RunTransitionConflictError(`run ${transition.runId} changed during transition`);
      }

      if (transition.activeRun === null) {
        this.db.prepare("DELETE FROM active_run WHERE run_id = ?").run(transition.runId);
        this.bumpActiveRunProjectionRevision();
      } else if (activeRun) {
        this.db
          .prepare("INSERT OR REPLACE INTO active_run (run_id, run) VALUES (?, ?)")
          .run(transition.runId, jsonStringify(activeRun));
        this.bumpActiveRunProjectionRevision();
      }
      if (transition.lease) {
        this.assertRepositoryLease(transition.lease);
      }
      if (event) {
        this.db
          .prepare("INSERT INTO events (run_id, event) VALUES (?, ?)")
          .run(transition.runId, jsonStringify(event));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    if (activeRun) {
      // Activation is a fail-safe boundary: the gate plugin must observe this
      // run before the caller is allowed to enter the Executor turn loop.
      this.syncActiveRunProjection();
    } else if (transition.activeRun === null) {
      this.trySyncActiveRunFile();
    }
    return next;
  }

  readRunStartup(runId: string, attempt: number): RunStartupOperation | undefined {
    const row = this.db
      .prepare("SELECT operation FROM run_startup_operations WHERE run_id = ? AND attempt = ?")
      .get(runId, attempt) as { operation: string } | undefined;
    return row ? RunStartupOperationSchema.parse(jsonParse(row.operation)) : undefined;
  }

  persistRunStartup(operation: RunStartupOperation, lease?: RepositoryLease): void {
    const value = RunStartupOperationSchema.parse({ ...operation, updatedAt: this.clock.nowIso() });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (lease) {
        this.assertRepositoryLease(lease);
      }
      const current = this.readRunStartup(value.runId, value.attempt);
      const nextPhases: Partial<
        Record<RunStartupOperation["phase"], RunStartupOperation["phase"][]>
      > = {
        claimed: ["setup_completed"],
        state_initialized: ["sandbox_ready"],
        sandbox_ready: ["setup_started", "setup_completed"],
        setup_started: ["setup_started", "setup_completed"],
        setup_completed: ["planner_session_started", "planner_session_created"],
        planner_session_started: ["planner_session_created"],
        planner_session_created: ["executor_session_started"],
        executor_session_started: ["executor_session_created"],
      };
      if (!current && value.phase === "claimed") {
        this.db
          .prepare(
            "INSERT INTO run_startup_operations(run_id, attempt, operation) VALUES (?, ?, ?)",
          )
          .run(value.runId, value.attempt, jsonStringify(value));
        this.db.exec("COMMIT");
        return;
      }
      if (!current || !nextPhases[current.phase]?.includes(value.phase)) {
        throw new RunTransitionConflictError(
          `invalid startup phase transition ${current?.phase ?? "missing"} -> ${value.phase}`,
        );
      }
      const result = this.db
        .prepare(
          "UPDATE run_startup_operations SET operation = ? WHERE run_id = ? AND attempt = ? AND json_extract(operation, '$.phase') = ?",
        )
        .run(jsonStringify(value), value.runId, value.attempt, current.phase);
      if (result.changes !== 1) {
        throw new RunTransitionConflictError(
          `startup operation changed for ${value.runId}/${value.attempt}`,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  initializeRunStartup(
    operation: RunStartupOperation,
    ledger: OutcomeLedger,
    reviewState: ReviewState,
    gateState: GateState,
    lease?: RepositoryLease,
  ): void {
    if (operation.phase !== "claimed") {
      throw new RunTransitionConflictError(
        `invalid startup phase transition ${operation.phase} -> state_initialized`,
      );
    }
    const value = RunStartupOperationSchema.parse({
      ...operation,
      phase: "state_initialized",
      updatedAt: this.clock.nowIso(),
    });
    const gate = GateStateSchema.parse({ ...gateState, updatedAt: this.clock.nowIso() });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (lease) {
        this.assertRepositoryLease(lease);
      }
      const result = this.db
        .prepare(
          "UPDATE run_startup_operations SET operation = ? WHERE run_id = ? AND attempt = ? AND json_extract(operation, '$.phase') = 'claimed'",
        )
        .run(jsonStringify(value), operation.runId, operation.attempt);
      if (result.changes !== 1) {
        throw new RunTransitionConflictError(
          `startup operation changed for ${operation.runId}/${operation.attempt}`,
        );
      }
      this.db.prepare("DELETE FROM checkpoints WHERE run_id = ?").run(operation.runId);
      this.db.prepare("DELETE FROM decisions WHERE run_id = ?").run(operation.runId);
      this.db
        .prepare("INSERT OR REPLACE INTO outcome_ledger(run_id, ledger) VALUES (?, ?)")
        .run(operation.runId, jsonStringify(ledger));
      this.db
        .prepare("INSERT OR REPLACE INTO review_state(run_id, state) VALUES (?, ?)")
        .run(operation.runId, jsonStringify(reviewState));
      this.db
        .prepare("INSERT OR REPLACE INTO gate_state(run_id, state) VALUES (?, ?)")
        .run(operation.runId, jsonStringify(gate));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.tryProjectGateState(operation.runId, gate);
  }

  activateRunStartup(
    operation: RunStartupOperation,
    transition: RunTransition & { lease: RepositoryLease },
  ): RunMeta {
    if (!transition.activeRun || !transition.event) {
      throw new Error("startup activation requires active run and event");
    }
    if (transition.runId !== operation.runId || transition.meta.runId !== operation.runId) {
      throw new Error("startup activation identity mismatch");
    }
    if (transition.event.event !== "run_started") {
      throw new Error("startup activation requires run_started event");
    }
    if (
      transition.activeRun.runId !== operation.runId ||
      transition.event.runId !== operation.runId
    ) {
      throw new Error("startup activation identity mismatch");
    }
    if (transition.event.attempt !== operation.attempt) {
      throw new Error("startup activation attempt mismatch");
    }
    if (transition.meta.attempt !== operation.attempt) {
      throw new Error("startup activation attempt mismatch");
    }
    const next = RunMetaSchema.parse({
      ...transition.meta,
      revision: transition.expectedRevision + 1,
      updatedAt: this.clock.nowIso(),
    });
    const active = ActiveRunSchema.parse(transition.activeRun);
    const event = JournalEventSchema.parse(transition.event);
    const value = RunStartupOperationSchema.parse({
      ...operation,
      phase: "active",
      updatedAt: this.clock.nowIso(),
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertRepositoryLease(transition.lease);
      const current = this.readMeta(operation.runId);
      if (current.attempt !== operation.attempt) {
        throw new RunTransitionConflictError(
          `startup activation attempt mismatch for ${operation.runId}`,
        );
      }
      const claimed = this.readRunStartup(operation.runId, operation.attempt);
      if (
        !claimed ||
        claimed.phase !== "executor_session_created" ||
        operation.phase !== "executor_session_created" ||
        claimed.plannerSessionId !== operation.plannerSessionId ||
        claimed.executorSessionId !== operation.executorSessionId
      ) {
        throw new RunTransitionConflictError(
          `startup operation changed for ${operation.runId}/${operation.attempt}`,
        );
      }
      if (
        next.babySessionId !== operation.executorSessionId ||
        next.daddySessionId !== operation.plannerSessionId ||
        active.babySessionId !== operation.executorSessionId
      ) {
        throw new Error("startup activation session identity mismatch");
      }
      const result = this.db
        .prepare(
          "UPDATE runs SET meta = ? WHERE run_id = ? AND COALESCE(json_extract(meta, '$.revision'), 0) = ? AND json_extract(meta, '$.status') IN (SELECT value FROM json_each(?))",
        )
        .run(
          jsonStringify(next),
          transition.runId,
          transition.expectedRevision,
          jsonStringify(transition.expectedStatuses),
        );
      if (result.changes !== 1) {
        throw new RunTransitionConflictError(
          `run ${transition.runId} changed during startup activation`,
        );
      }
      this.db
        .prepare("INSERT OR REPLACE INTO active_run(run_id, run) VALUES (?, ?)")
        .run(transition.runId, jsonStringify(active));
      this.bumpActiveRunProjectionRevision();
      this.db
        .prepare("INSERT INTO events(run_id, event) VALUES (?, ?)")
        .run(transition.runId, jsonStringify(event));
      const startupResult = this.db
        .prepare(
          "UPDATE run_startup_operations SET operation = ? WHERE run_id = ? AND attempt = ? AND json_extract(operation, '$.phase') = 'executor_session_created'",
        )
        .run(jsonStringify(value), value.runId, value.attempt);
      if (startupResult.changes !== 1) {
        throw new RunTransitionConflictError(
          `startup operation changed for ${operation.runId}/${operation.attempt}`,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.syncActiveRunProjection();
    return next;
  }

  acceptCampaign(
    members: CampaignAcceptance[],
    acceptedInto: string,
    lease?: RepositoryLease,
  ): RunMeta[] {
    if (
      members.length === 0 ||
      new Set(members.map((member) => member.runId)).size !== members.length
    ) {
      throw new Error("campaign acceptance requires distinct members");
    }
    const accepted: RunMeta[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (lease) {
        this.assertRepositoryLease(lease);
      }
      for (const member of members) {
        const row = this.db.prepare("SELECT meta FROM runs WHERE run_id = ?").get(member.runId) as
          | { meta: string }
          | undefined;
        if (!row) {
          throw new Error(`run not found: ${member.runId}`);
        }
        const current = RunMetaSchema.parse(jsonParse(row.meta));
        if ((current.revision ?? 0) !== member.expectedRevision) {
          throw new Error(
            `run ${member.runId} revision conflict: expected ${member.expectedRevision}, found ${current.revision ?? 0}`,
          );
        }
        if (current.status !== member.expectedStatus) {
          throw new Error(
            `run ${member.runId} status conflict: expected ${member.expectedStatus}, found ${current.status}`,
          );
        }
        const next = RunMetaSchema.parse({
          ...current,
          status: "accepted",
          acceptedInto,
          revision: member.expectedRevision + 1,
          updatedAt: this.clock.nowIso(),
        });
        const result = this.db
          .prepare(
            "UPDATE runs SET meta = ? WHERE run_id = ? AND COALESCE(json_extract(meta, '$.revision'), 0) = ? AND json_extract(meta, '$.status') = ?",
          )
          .run(jsonStringify(next), member.runId, member.expectedRevision, member.expectedStatus);
        if (result.changes !== 1) {
          throw new Error(`run ${member.runId} changed during acceptance`);
        }
        accepted.push(next);
      }
      this.db.exec("COMMIT");
      return accepted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  readAcceptanceOperation(campaignId: string): AcceptanceOperation | undefined {
    const row = this.db
      .prepare("SELECT operation FROM acceptance_operations WHERE campaign_id = ?")
      .get(campaignId) as { operation: string } | undefined;
    return row ? AcceptanceOperationSchema.parse(jsonParse(row.operation)) : undefined;
  }

  persistAcceptanceOperation(operation: AcceptanceOperation, lease?: RepositoryLease): void {
    const value = AcceptanceOperationSchema.parse({ ...operation, updatedAt: this.clock.nowIso() });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (lease) {
        this.assertRepositoryLease(lease);
      }
      const current = this.readAcceptanceOperation(value.campaignId);
      if (!current) {
        if (value.phase !== "prepared") {
          throw new RunTransitionConflictError("acceptance operation must begin in prepared phase");
        }
        this.db
          .prepare("INSERT INTO acceptance_operations(campaign_id, operation) VALUES (?, ?)")
          .run(value.campaignId, jsonStringify(value));
      } else {
        const sameSnapshot =
          current.tipRunId === value.tipRunId &&
          current.acceptedInto === value.acceptedInto &&
          current.expectedTipSha === value.expectedTipSha &&
          jsonStringify(current.members) === jsonStringify(value.members);
        if (!sameSnapshot) {
          throw new RunTransitionConflictError(
            `acceptance operation snapshot changed for ${value.campaignId}`,
          );
        }
        const containsAll = (next: string[], prior: string[]): boolean =>
          prior.every((runId) => next.includes(runId));
        const validTransition =
          (current.phase === "prepared" && value.phase === "fetched") ||
          (current.phase === "fetched" && value.phase === "fetched") ||
          (current.phase === "accepted" &&
            value.phase === "accepted" &&
            containsAll(value.cleanedSandboxes, current.cleanedSandboxes) &&
            containsAll(value.cleanedBranches, current.cleanedBranches)) ||
          (current.phase === "accepted" &&
            value.phase === "cleaned" &&
            containsAll(
              value.cleanedSandboxes,
              current.members.map((member) => member.runId),
            ) &&
            containsAll(
              value.cleanedBranches,
              current.members
                .filter((member) => member.runId !== current.tipRunId)
                .map((member) => member.runId),
            )) ||
          (current.phase === "cleaned" &&
            value.phase === "cleaned" &&
            jsonStringify(current.cleanedSandboxes) === jsonStringify(value.cleanedSandboxes) &&
            jsonStringify(current.cleanedBranches) === jsonStringify(value.cleanedBranches));
        if (!validTransition) {
          throw new RunTransitionConflictError(
            `invalid acceptance phase transition ${current.phase} -> ${value.phase}`,
          );
        }
        const result = this.db
          .prepare(
            "UPDATE acceptance_operations SET operation = ? WHERE campaign_id = ? AND json_extract(operation, '$.phase') = ?",
          )
          .run(jsonStringify(value), value.campaignId, current.phase);
        if (result.changes !== 1) {
          throw new RunTransitionConflictError(
            `acceptance operation changed for ${value.campaignId}`,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  commitAcceptanceOperation(operation: AcceptanceOperation, lease: RepositoryLease): RunMeta[] {
    const value = AcceptanceOperationSchema.parse({
      ...operation,
      phase: "accepted",
      updatedAt: this.clock.nowIso(),
    });
    const accepted: RunMeta[] = [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertRepositoryLease(lease);
      const currentOperation = this.readAcceptanceOperation(operation.campaignId);
      if (currentOperation?.phase !== "fetched") {
        throw new Error("acceptance operation is not fetched");
      }
      if (
        currentOperation.tipRunId !== operation.tipRunId ||
        currentOperation.acceptedInto !== operation.acceptedInto ||
        currentOperation.expectedTipSha !== operation.expectedTipSha ||
        jsonStringify(currentOperation.members) !== jsonStringify(operation.members)
      ) {
        throw new RunTransitionConflictError(
          `acceptance operation snapshot changed for ${operation.campaignId}`,
        );
      }
      for (const member of operation.members) {
        const current = this.readMeta(member.runId);
        if ((current.revision ?? 0) !== member.revision || current.status !== member.status) {
          throw new RunTransitionConflictError(`run ${member.runId} changed during acceptance`);
        }
        const next = RunMetaSchema.parse({
          ...current,
          status: "accepted",
          acceptedInto: operation.acceptedInto,
          revision: member.revision + 1,
          updatedAt: this.clock.nowIso(),
        });
        const result = this.db
          .prepare(
            "UPDATE runs SET meta = ? WHERE run_id = ? AND COALESCE(json_extract(meta, '$.revision'), 0) = ? AND json_extract(meta, '$.status') = ?",
          )
          .run(jsonStringify(next), member.runId, member.revision, member.status);
        if (result.changes !== 1) {
          throw new RunTransitionConflictError(`run ${member.runId} changed during acceptance`);
        }
        accepted.push(next);
      }
      const operationResult = this.db
        .prepare(
          "UPDATE acceptance_operations SET operation = ? WHERE campaign_id = ? AND json_extract(operation, '$.phase') = 'fetched'",
        )
        .run(jsonStringify(value), operation.campaignId);
      if (operationResult.changes !== 1) {
        throw new RunTransitionConflictError(
          `acceptance operation changed for ${operation.campaignId}`,
        );
      }
      this.db.exec("COMMIT");
      return accepted;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  answerRun(transition: AnswerTransition): RunMeta {
    if (transition.meta.runId !== transition.runId) {
      throw new Error(
        `run answer identity mismatch: row ${transition.runId}, meta ${transition.meta.runId}`,
      );
    }
    const decision = DecisionSchema.parse(transition.decision);
    const gateState = transition.gateState
      ? GateStateSchema.parse({ ...transition.gateState, updatedAt: this.clock.nowIso() })
      : undefined;
    if (gateState && gateState.runId !== transition.runId) {
      throw new Error(
        `run answer identity mismatch: row ${transition.runId}, gate state ${gateState.runId}`,
      );
    }
    const next = RunMetaSchema.parse({
      ...transition.meta,
      revision: transition.expectedRevision + 1,
      updatedAt: this.clock.nowIso(),
    });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          "UPDATE runs SET meta = ? WHERE run_id = ? AND COALESCE(json_extract(meta, '$.revision'), 0) = ? AND json_extract(meta, '$.status') = ?",
        )
        .run(
          jsonStringify(next),
          transition.runId,
          transition.expectedRevision,
          transition.expectedStatus,
        );
      if (result.changes !== 1) {
        throw new RunTransitionConflictError(`run ${transition.runId} changed during answer`);
      }
      this.db
        .prepare("INSERT INTO decisions (run_id, decision) VALUES (?, ?)")
        .run(transition.runId, jsonStringify(decision));
      if (gateState) {
        this.db
          .prepare("INSERT OR REPLACE INTO gate_state (run_id, state) VALUES (?, ?)")
          .run(transition.runId, jsonStringify(gateState));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (gateState) {
      this.tryProjectGateState(transition.runId, gateState);
    }
    return next;
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

  listLedgers(): OutcomeLedger[] {
    const rows = this.db.prepare("SELECT ledger FROM outcome_ledger").all() as { ledger: string }[];
    return rows.map((r) => OutcomeLedgerSchema.parse(jsonParse(r.ledger)));
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

  readConvergenceOperation(runId: string, attempt: number): ConvergenceOperation | undefined {
    const row = this.db
      .prepare("SELECT operation FROM convergence_operations WHERE run_id = ? AND attempt = ?")
      .get(runId, attempt) as { operation: string } | undefined;
    return row ? ConvergenceOperationSchema.parse(jsonParse(row.operation)) : undefined;
  }

  persistConvergenceOperation(operation: ConvergenceOperation, lease: RepositoryLease): void {
    const validated = ConvergenceOperationSchema.parse(operation);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertRepositoryLease(lease);
      const current = this.readConvergenceOperation(validated.runId, validated.attempt);
      if (!current) {
        if (validated.phase !== "autofix_started") {
          throw new RunTransitionConflictError(
            "convergence operation must begin in autofix_started phase",
          );
        }
        this.db
          .prepare(
            "INSERT INTO convergence_operations(run_id, attempt, operation) VALUES (?, ?, ?)",
          )
          .run(validated.runId, validated.attempt, jsonStringify(validated));
      } else {
        if (
          current.runId !== validated.runId ||
          current.attempt !== validated.attempt ||
          current.autofixFingerprint !== validated.autofixFingerprint
        ) {
          throw new RunTransitionConflictError(
            `convergence operation snapshot changed for ${validated.runId}/${validated.attempt}`,
          );
        }
        const validTransition =
          (current.phase === "autofix_started" && validated.phase === "autofix_applied") ||
          (current.phase === "autofix_applied" && validated.phase === "decided") ||
          (current.phase === "decided" &&
            validated.phase === "decided" &&
            !current.followup &&
            !!validated.followup) ||
          (current.phase === "decided" &&
            validated.phase === "decided" &&
            !!current.followup &&
            jsonStringify(current.followup) === jsonStringify(validated.followup) &&
            !current.followupPublication &&
            !!validated.followupPublication) ||
          (current.phase === "decided" && validated.phase === "amend_started") ||
          (current.phase === "decided" && validated.phase === "effect_applied") ||
          (current.phase === "amend_started" && validated.phase === "effect_applied");
        if (!validTransition) {
          throw new RunTransitionConflictError(
            `invalid convergence phase transition ${current.phase} -> ${validated.phase}`,
          );
        }
        const result = this.db
          .prepare(
            "UPDATE convergence_operations SET operation = ? WHERE run_id = ? AND attempt = ? AND json_extract(operation, '$.phase') = ?",
          )
          .run(jsonStringify(validated), validated.runId, validated.attempt, current.phase);
        if (result.changes !== 1) {
          throw new RunTransitionConflictError(
            `convergence operation changed for ${validated.runId}/${validated.attempt}`,
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  publishConvergence(publication: ConvergencePublication): RunMeta | undefined {
    const operation = ConvergenceOperationSchema.parse(publication.operation);
    if (operation.phase !== "published") {
      throw new Error("convergence publication requires published operation phase");
    }
    const campaign = CampaignSchema.parse({
      ...publication.campaign,
      updatedAt: this.clock.nowIso(),
    });
    const entry = ConvergenceLogEntrySchema.parse(publication.entry);
    const event = JournalEventSchema.parse(publication.event);
    const transition = publication.runTransition;
    if (
      campaign.campaignId !== operation.campaignId ||
      entry.runId !== operation.runId ||
      entry.campaignId !== operation.campaignId ||
      entry.pass !== operation.pass
    ) {
      throw new Error("convergence publication identity mismatch");
    }
    if (event.event !== "super_review" || event.pass !== operation.pass) {
      throw new Error("convergence publication event mismatch");
    }
    if (transition && transition.runId !== operation.runId) {
      throw new Error("convergence publication transition mismatch");
    }
    if (operation.followup?.runId !== publication.followup?.runId) {
      throw new Error("convergence publication follow-up mismatch");
    }
    const nextMeta = transition
      ? RunMetaSchema.parse({
          ...transition.meta,
          revision: transition.expectedRevision + 1,
          updatedAt: this.clock.nowIso(),
        })
      : undefined;
    const admission = publication.followup
      ? this.prepareQueueAdmission(publication.followup.runId, publication.followup.raw)
      : undefined;
    if (publication.followup && !admission) {
      throw new Error(`follow-up admission failed: ${publication.followup.runId}`);
    }
    if (admission && existsSync(this.paths.packetFile(publication.followup!.runId))) {
      throw new Error(`packet already exists without run metadata: ${publication.followup!.runId}`);
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertRepositoryLease(publication.lease);
      const current = this.readConvergenceOperation(operation.runId, operation.attempt);
      if (!current || current.phase !== "effect_applied") {
        throw new RunTransitionConflictError(
          `convergence operation is not publishable: ${operation.runId}/${operation.attempt}`,
        );
      }
      const expectedOperation = { ...operation, phase: "effect_applied" as const };
      if (jsonStringify(current) !== jsonStringify(expectedOperation)) {
        throw new RunTransitionConflictError(
          `convergence operation changed before publication: ${operation.runId}/${operation.attempt}`,
        );
      }
      if (transition && nextMeta) {
        const result = this.db
          .prepare(
            "UPDATE runs SET meta = ? WHERE run_id = ? AND COALESCE(json_extract(meta, '$.revision'), 0) = ? AND json_extract(meta, '$.status') IN (SELECT value FROM json_each(?))",
          )
          .run(
            jsonStringify(nextMeta),
            transition.runId,
            transition.expectedRevision,
            jsonStringify(transition.expectedStatuses),
          );
        if (result.changes !== 1) {
          throw new RunTransitionConflictError(
            `run ${transition.runId} changed during convergence publication`,
          );
        }
      }
      this.db
        .prepare("INSERT OR REPLACE INTO campaigns(campaign_id, campaign) VALUES (?, ?)")
        .run(campaign.campaignId, jsonStringify(campaign));
      this.db
        .prepare("INSERT INTO events(run_id, event) VALUES (?, ?)")
        .run(operation.runId, jsonStringify(event));
      this.db
        .prepare("INSERT INTO convergence(run_id, entry) VALUES (?, ?)")
        .run(operation.runId, jsonStringify(entry));
      if (publication.nits !== undefined) {
        this.db
          .prepare("INSERT OR REPLACE INTO nits(run_id, markdown) VALUES (?, ?)")
          .run(operation.runId, publication.nits);
      }
      if (admission) {
        this.db
          .prepare("INSERT INTO runs(run_id, meta) VALUES (?, ?)")
          .run(publication.followup!.runId, jsonStringify(admission.meta));
        this.stagePacketProjection(publication.followup!.runId, admission.stamped);
      }
      const operationResult = this.db
        .prepare(
          "UPDATE convergence_operations SET operation = ? WHERE run_id = ? AND attempt = ? AND json_extract(operation, '$.phase') = 'effect_applied'",
        )
        .run(jsonStringify(operation), operation.runId, operation.attempt);
      if (operationResult.changes !== 1) {
        throw new RunTransitionConflictError(
          `convergence operation changed during publication: ${operation.runId}/${operation.attempt}`,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (admission) {
      this.tryPublishPacketProjection(publication.followup!.runId);
    }
    return nextMeta;
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

  syncActiveRunProjection(): void {
    this.syncActiveRunFile();
  }

  addActiveRun(run: ActiveRun): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT OR REPLACE INTO active_run (run_id, run) VALUES (?, ?)")
        .run(run.runId, jsonStringify(run));
      this.bumpActiveRunProjectionRevision();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.syncActiveRunFile();
  }

  removeActiveRun(runId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM active_run WHERE run_id = ?").run(runId);
      this.bumpActiveRunProjectionRevision();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.syncActiveRunFile();
  }

  private syncActiveRunFile(): void {
    // Dual-write: the gate plugin runs inside Baby's opencode subprocess and
    // reads active-run.json synchronously from disk. SQLite is authoritative,
    // but the plugin has no daemon access — this file is the bridge.
    // Must always regenerate the full array after each mutation; never unlink.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const revision = (
        this.db
          .prepare("SELECT revision FROM projection_revisions WHERE name = 'active_run'")
          .get() as { revision: number }
      ).revision;
      const runs = this.listActiveRuns();
      writeTextAtomic(join(this.paths.root, "active-run.json"), jsonStringify(runs));
      this.db
        .prepare("UPDATE projection_revisions SET published_revision = ? WHERE name = 'active_run'")
        .run(revision);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private bumpActiveRunProjectionRevision(): void {
    this.db
      .prepare("UPDATE projection_revisions SET revision = revision + 1 WHERE name = 'active_run'")
      .run();
  }

  private trySyncActiveRunFile(): void {
    try {
      this.syncActiveRunFile();
    } catch (error) {
      // SQLite is authoritative. A projection refresh must not turn a committed
      // lifecycle transition into an apparent rollback.
      console.error("failed to refresh active-run.json projection", error);
    }
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

  admitQueueWithCampaign(
    runId: string,
    raw: string,
    campaign: Campaign,
    decision?: { runId: string; event: JournalEvent },
  ): void {
    const admission = this.prepareQueueAdmission(runId, raw);
    if (!admission) {
      return;
    }
    const stampedCampaign = CampaignSchema.parse({
      ...campaign,
      updatedAt: this.clock.nowIso(),
    });
    const decisionEvent = decision ? JournalEventSchema.parse(decision.event) : undefined;
    if (existsSync(this.paths.packetFile(runId))) {
      throw new Error(`packet already exists without run metadata: ${runId}`);
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId)) {
        throw new Error(`run already exists: ${runId}`);
      }
      this.db
        .prepare("INSERT INTO runs (run_id, meta) VALUES (?, ?)")
        .run(runId, jsonStringify(admission.meta));
      this.stagePacketProjection(runId, admission.stamped);
      this.db
        .prepare("INSERT OR REPLACE INTO campaigns (campaign_id, campaign) VALUES (?, ?)")
        .run(campaign.campaignId, jsonStringify(stampedCampaign));
      if (decision && decisionEvent) {
        this.db
          .prepare("INSERT INTO events (run_id, event) VALUES (?, ?)")
          .run(decision.runId, jsonStringify(decisionEvent));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.tryPublishPacketProjection(runId);
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
        "SELECT run_id, meta FROM runs WHERE json_extract(meta, '$.status') = 'queued' ORDER BY CASE WHEN json_extract(meta, '$.attempt') > 0 THEN 0 ELSE 1 END, run_id",
      )
      .all()
      .map((r) => {
        const meta = RunMetaSchema.parse(JSON.parse(String(r.meta)));
        return { runId: meta.runId, admittedAt: meta.updatedAt };
      });
  }

  claimNextQueuedRun(
    excludedRepos: string[],
    ownerId: string = randomUUID(),
  ): ClaimedQueueEntry | undefined {
    // Build the SELECT with optional repo exclusion.
    let selectSql =
      "SELECT r.run_id, r.meta FROM runs r LEFT JOIN run_startup_operations s ON s.run_id = r.run_id AND s.attempt = json_extract(r.meta, '$.attempt') LEFT JOIN packet_projections p ON p.run_id = r.run_id WHERE COALESCE(p.published, 1) = 1 AND (json_extract(r.meta, '$.status') = 'queued' OR (json_extract(r.meta, '$.status') = 'running' AND json_extract(s.operation, '$.phase') IN ('claimed','state_initialized','sandbox_ready','setup_completed','planner_session_created','executor_session_created'))) AND json_extract(r.meta, '$.repo') NOT IN (SELECT repo FROM repository_leases WHERE expires_at > ?)";
    if (excludedRepos.length > 0) {
      const placeholders = excludedRepos.map(() => "?").join(", ");
      selectSql += ` AND json_extract(r.meta, '$.repo') NOT IN (${placeholders})`;
    }
    selectSql +=
      " ORDER BY CASE WHEN json_extract(r.meta, '$.status') = 'queued' THEN 0 ELSE 1 END, CASE WHEN json_extract(r.meta, '$.attempt') > 0 THEN 0 ELSE 1 END, r.run_id LIMIT 1";

    // BEGIN IMMEDIATE serialises selection, run transition, and repository lease acquisition.
    const now = this.clock.nowIso();
    const bindArgs = excludedRepos.length > 0 ? [now, ...excludedRepos] : [now];
    for (;;) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.refreshRepositoryLeaseLiveness(now);
        const row = this.db.prepare(selectSql).all(...bindArgs) as {
          run_id: string;
          meta: string;
        }[];
        if (row.length === 0) {
          this.db.exec("COMMIT");
          return undefined;
        }

        const runId = row.at(0)!.run_id;
        const meta = RunMetaSchema.parse(jsonParse(row.at(0)!.meta));
        const nowIso = this.clock.nowIso();
        const isQueued = meta.status === "queued";
        const legacyAttempt = !!this.db
          .prepare("SELECT 1 FROM legacy_attempt_claims WHERE run_id = ?")
          .get(runId);
        const result = isQueued
          ? this.db
              .prepare(
                "UPDATE runs SET meta = json_set(meta, '$.status', 'running', '$.attempt', json_extract(meta, '$.attempt') + ?, '$.revision', COALESCE(json_extract(meta, '$.revision'), 0) + 1, '$.updatedAt', ?) WHERE run_id = ? AND json_extract(meta, '$.status') = 'queued'",
              )
              .run(legacyAttempt ? 0 : 1, nowIso, runId)
          : { changes: 1 };

        if (result.changes === 1) {
          if (legacyAttempt) {
            this.db.prepare("DELETE FROM legacy_attempt_claims WHERE run_id = ?").run(runId);
          }
          const lease = this.insertRepositoryLease(meta.repo, ownerId, runId, "execute", nowIso);
          if (isQueued) {
            const attempt = meta.attempt + (legacyAttempt ? 0 : 1);
            const startup = RunStartupOperationSchema.parse({
              runId,
              attempt,
              phase: "claimed",
              updatedAt: nowIso,
            });
            this.db
              .prepare(
                "INSERT INTO run_startup_operations(run_id, attempt, operation) VALUES (?, ?, ?)",
              )
              .run(runId, attempt, jsonStringify(startup));
          }
          this.db.exec("COMMIT");
          return { runId, admittedAt: nowIso, lease };
        }
        this.db.exec("ROLLBACK");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      // changes === 0: another worker claimed it — retry loop.
    }
  }

  acquireRepositoryLease(
    repo: string,
    ownerId: string,
    runId: string,
    purpose: RepositoryLease["purpose"],
  ): RepositoryLease | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const now = this.clock.nowIso();
      this.refreshRepositoryLeaseLiveness(now);
      const active = this.db.prepare("SELECT 1 FROM repository_leases WHERE repo = ?").get(repo);
      if (active) {
        this.db.exec("COMMIT");
        return undefined;
      }
      this.db.prepare("DELETE FROM repository_leases WHERE repo = ?").run(repo);
      const lease = this.insertRepositoryLease(repo, ownerId, runId, purpose, now);
      this.db.exec("COMMIT");
      return lease;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  heartbeatRepositoryLease(lease: RepositoryLease): RepositoryLease | undefined {
    const heartbeatAt = this.clock.nowIso();
    this.refreshRepositoryLeaseLiveness(heartbeatAt);
    const expiresAt = new Date(Date.parse(heartbeatAt) + LEASE_TTL_MS).toISOString();
    const result = this.db
      .prepare(
        "UPDATE repository_leases SET heartbeat_at = ?, expires_at = ? WHERE repo = ? AND owner_id = ? AND epoch = ?",
      )
      .run(heartbeatAt, expiresAt, lease.repo, lease.ownerId, lease.epoch);
    return result.changes === 1 ? { ...lease, heartbeatAt, expiresAt } : undefined;
  }

  releaseRepositoryLease(lease: RepositoryLease): boolean {
    const released =
      this.db
        .prepare("DELETE FROM repository_leases WHERE repo = ? AND owner_id = ? AND epoch = ?")
        .run(lease.repo, lease.ownerId, lease.epoch).changes === 1;
    if (released) {
      this.db
        .prepare(
          "DELETE FROM repository_lease_owners WHERE owner_id = ? AND NOT EXISTS (SELECT 1 FROM repository_leases WHERE owner_id = ?)",
        )
        .run(lease.ownerId, lease.ownerId);
    }
    return released;
  }

  listRepositoryLeases(): RepositoryLease[] {
    const rows = this.db
      .prepare(
        "SELECT repo, owner_id, run_id, purpose, epoch, acquired_at, heartbeat_at, expires_at FROM repository_leases ORDER BY repo",
      )
      .all() as {
      repo: string;
      owner_id: string;
      run_id: string;
      purpose: RepositoryLease["purpose"];
      epoch: number;
      acquired_at: string;
      heartbeat_at: string;
      expires_at: string;
    }[];
    return rows.map((row) => ({
      repo: row.repo,
      ownerId: row.owner_id,
      runId: row.run_id,
      purpose: row.purpose,
      epoch: row.epoch,
      acquiredAt: row.acquired_at,
      heartbeatAt: row.heartbeat_at,
      expiresAt: row.expires_at,
    }));
  }

  private insertRepositoryLease(
    repo: string,
    ownerId: string,
    runId: string,
    purpose: RepositoryLease["purpose"],
    acquiredAt: string,
  ): RepositoryLease {
    this.db
      .prepare(
        "INSERT INTO repository_lease_epochs(repo, epoch) VALUES (?, 1) ON CONFLICT(repo) DO UPDATE SET epoch = epoch + 1",
      )
      .run(repo);
    const { epoch } = this.db
      .prepare("SELECT epoch FROM repository_lease_epochs WHERE repo = ?")
      .get(repo) as { epoch: number };
    const expiresAt = new Date(Date.parse(acquiredAt) + LEASE_TTL_MS).toISOString();
    const lease = {
      repo,
      ownerId,
      runId,
      purpose,
      epoch,
      acquiredAt,
      heartbeatAt: acquiredAt,
      expiresAt,
    };
    this.db
      .prepare(
        "INSERT OR REPLACE INTO repository_lease_owners(owner_id, pid, process_instance_token) VALUES (?, ?, ?)",
      )
      .run(ownerId, process.pid, PROCESS_INSTANCE_TOKEN);
    this.db
      .prepare(
        "INSERT INTO repository_leases(repo, owner_id, run_id, purpose, epoch, acquired_at, heartbeat_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(repo, ownerId, runId, purpose, epoch, acquiredAt, acquiredAt, expiresAt);
    return lease;
  }

  private assertRepositoryLease(lease: RepositoryLease): void {
    this.refreshRepositoryLeaseLiveness(this.clock.nowIso());
    const row = this.db
      .prepare(
        "SELECT 1 FROM repository_leases WHERE repo = ? AND owner_id = ? AND epoch = ? AND run_id = ? AND purpose = ?",
      )
      .get(lease.repo, lease.ownerId, lease.epoch, lease.runId, lease.purpose);
    if (!row) {
      throw new RepositoryLeaseLostError(`repository lease lost for ${lease.repo}`);
    }
  }

  private refreshRepositoryLeaseLiveness(nowIso: string): void {
    const expired = this.db
      .prepare(
        "SELECT l.repo, l.owner_id, o.pid, o.process_instance_token FROM repository_leases l LEFT JOIN repository_lease_owners o ON o.owner_id = l.owner_id WHERE l.expires_at <= ?",
      )
      .all(nowIso) as {
      repo: string;
      owner_id: string;
      pid: number | null;
      process_instance_token: string | null;
    }[];
    for (const lease of expired) {
      const identity =
        lease.pid === null ? { state: "dead" as const } : readProcessIdentity(lease.pid);
      if (identity.state === "live" && identity.token === lease.process_instance_token) {
        const expiresAt = new Date(Date.parse(nowIso) + LEASE_TTL_MS).toISOString();
        this.db
          .prepare(
            "UPDATE repository_leases SET heartbeat_at = ?, expires_at = ? WHERE repo = ? AND owner_id = ?",
          )
          .run(nowIso, expiresAt, lease.repo, lease.owner_id);
      } else if (identity.state !== "unknown") {
        this.db
          .prepare("DELETE FROM repository_leases WHERE repo = ? AND owner_id = ?")
          .run(lease.repo, lease.owner_id);
        this.db
          .prepare("DELETE FROM repository_lease_owners WHERE owner_id = ?")
          .run(lease.owner_id);
      }
    }
  }

  admitQueue(runId: string, raw: string): void {
    const admission = this.prepareQueueAdmission(runId, raw);
    if (!admission) {
      return;
    }
    if (existsSync(this.paths.packetFile(runId))) {
      throw new Error(`packet already exists without run metadata: ${runId}`);
    }

    // Admission is insert-only. SQLite owns the durable packet projection; queue
    // claims cannot observe it until the markdown has been published.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId);
      if (existing) {
        throw new Error(`run already exists: ${runId}`);
      }
      this.db
        .prepare("INSERT INTO runs (run_id, meta) VALUES (?, ?)")
        .run(runId, jsonStringify(admission.meta));
      this.stagePacketProjection(runId, admission.stamped);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.tryPublishPacketProjection(runId);
  }

  private prepareQueueAdmission(
    runId: string,
    raw: string,
  ): { stamped: string; meta: RunMeta } | undefined {
    if (this.readMetaIfExists(runId)) {
      throw new Error(`run already exists: ${runId}`);
    }
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

    // Campaign fields from packet frontmatter (optional campaign_id, pass defaults to 1).
    const campaignId = shape.packet.frontmatter.campaign_id;
    const pass = shape.packet.frontmatter.pass ?? 1;
    const babyModel = shape.packet.frontmatter.baby_model;
    const meta = RunMetaSchema.parse({
      runId,
      status: "queued",
      attempt: 0,
      repo: repoPath,
      base,
      branch: `meridian/${runId}`,
      worktree: join(this.paths.runDir(runId), "worktree"),
      ...(campaignId !== undefined ? { campaignId } : {}),
      pass,
      ...(babyModel !== undefined ? { babyModel } : {}),
      stallRetries: 0,
      crashRetries: 0,
      reorientRetries: 0,
      promoted: shape.packet.frontmatter.promoted,
      updatedAt: this.clock.nowIso(),
    });

    return { stamped, meta };
  }

  archiveQueue(runId: string): void {
    // Mark the run stopped in SQLite. The live packet file stays in the run
    // dir (harmless; the run is terminal).
    const meta = this.readMetaIfExists(runId);
    if (!meta) {
      return;
    }
    this.transitionRun({
      runId,
      expectedRevision: meta.revision ?? 0,
      expectedStatuses: ["queued"],
      meta: { ...meta, status: "stopped", updatedAt: this.clock.nowIso() },
      activeRun: null,
    });
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

  private tryProjectGateState(runId: string, state: GateState): void {
    try {
      writeTextAtomic(join(this.paths.runDir(runId), "gate-state.json"), jsonStringify(state));
    } catch (error) {
      console.error(`failed to refresh gate-state.json projection for ${runId}`, error);
    }
  }

  private stagePacketProjection(runId: string, content: string): void {
    this.db
      .prepare("INSERT INTO packet_projections(run_id, content, published) VALUES (?, ?, 0)")
      .run(runId, content);
  }

  private publishPacketProjection(runId: string): void {
    const row = this.db
      .prepare("SELECT content FROM packet_projections WHERE run_id = ?")
      .get(runId) as { content: string } | undefined;
    if (!row) {
      throw new Error(`packet projection missing for ${runId}`);
    }
    writeTextAtomic(this.paths.packetFile(runId), row.content);
    this.db.prepare("UPDATE packet_projections SET published = 1 WHERE run_id = ?").run(runId);
  }

  private tryPublishPacketProjection(runId: string): void {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.publishPacketProjection(runId);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    // SQLite is authoritative. The pending outbox row keeps the run unclaimable
    // until a later adapter open (or another in-process attempt) publishes it.
    console.error(`packet projection remains pending for ${runId}`, lastError);
  }

  private reconcilePacketProjections(): void {
    const pending = this.db
      .prepare("SELECT run_id FROM packet_projections WHERE published = 0 ORDER BY run_id")
      .all() as { run_id: string }[];
    for (const row of pending) {
      this.tryPublishPacketProjection(row.run_id);
    }
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
  // Plans shelf — pre-queue draft packets

  listPlans(): Plan[] {
    const rows = this.db
      .prepare(
        "SELECT plan_id, title, raw, tags, queued_run_id, created_at, updated_at FROM plans ORDER BY created_at DESC",
      )
      .all() as {
      plan_id: string;
      title: string;
      raw: string;
      tags: string;
      queued_run_id: string | null;
      created_at: string;
      updated_at: string;
    }[];
    return rows.map((r) => ({
      planId: r.plan_id,
      title: r.title,
      raw: r.raw,
      tags: jsonParse(r.tags) as unknown as string[],
      ...(r.queued_run_id ? { queuedRunId: r.queued_run_id } : {}),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  readPlan(planId: string): Plan | undefined {
    const row = this.db
      .prepare(
        "SELECT plan_id, title, raw, tags, queued_run_id, created_at, updated_at FROM plans WHERE plan_id = ?",
      )
      .get(planId) as
      | {
          plan_id: string;
          title: string;
          raw: string;
          tags: string;
          queued_run_id: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;
    if (!row) {
      return undefined;
    }
    return {
      planId: row.plan_id,
      title: row.title,
      raw: row.raw,
      tags: jsonParse(row.tags) as unknown as string[],
      ...(row.queued_run_id ? { queuedRunId: row.queued_run_id } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  writePlan(plan: Plan): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO plans (plan_id, title, raw, tags, queued_run_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        plan.planId,
        plan.title,
        plan.raw,
        jsonStringify(plan.tags),
        plan.queuedRunId ?? null,
        plan.createdAt,
        plan.updatedAt,
      );
  }

  deletePlan(planId: string): void {
    this.db.prepare("DELETE FROM plans WHERE plan_id = ?").run(planId);
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

  readJournalWithSeq(runId: string): { seq: number; event: JournalEvent }[] {
    const rows = this.db
      .prepare("SELECT seq, event FROM events WHERE run_id = ? ORDER BY seq")
      .all(runId) as { seq: number; event: string }[];
    return rows.map((r) => ({
      seq: r.seq,
      event: JournalEventSchema.parse(jsonParse(r.event)),
    }));
  }

  readJournalSinceForRun(runId: string, seq: number): { seq: number; event: JournalEvent }[] {
    const rows = this.db
      .prepare("SELECT seq, event FROM events WHERE run_id = ? AND seq > ? ORDER BY seq")
      .all(runId, seq) as { seq: number; event: string }[];
    return rows.map((r) => ({
      seq: r.seq,
      event: JournalEventSchema.parse(jsonParse(r.event)),
    }));
  }

  readRecentJournal(runId: string, limit: number): JournalEvent[] {
    const rows = this.db
      .prepare("SELECT event FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?")
      .all(runId, Math.max(0, Math.floor(limit))) as { event: string }[];
    return rows.reverse().map((r) => JournalEventSchema.parse(jsonParse(r.event)));
  }

  readRecentJournalWithSeq(runId: string, limit: number): { seq: number; event: JournalEvent }[] {
    const rows = this.db
      .prepare("SELECT seq, event FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?")
      .all(runId, Math.max(0, Math.floor(limit))) as { seq: number; event: string }[];
    return rows.reverse().map((r) => ({
      seq: r.seq,
      event: JournalEventSchema.parse(jsonParse(r.event)),
    }));
  }

  readJournalStats(runId: string): JournalStats {
    const latestTurn = this.db
      .prepare(
        "SELECT event FROM events WHERE run_id = ? AND json_extract(event, '$.turn') IS NOT NULL ORDER BY seq DESC LIMIT 1",
      )
      .get(runId) as { event: string } | undefined;
    const latestContext = this.db
      .prepare(
        "SELECT event FROM events WHERE run_id = ? AND (json_extract(event, '$.event') = 'turn_ended' OR json_extract(event, '$.event') = 'rotation') AND json_extract(event, '$.contextTokens') IS NOT NULL ORDER BY seq DESC LIMIT 1",
      )
      .get(runId) as { event: string } | undefined;
    const rotations = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE run_id = ? AND json_extract(event, '$.event') = 'rotation' AND json_extract(event, '$.phase') = 'session_replaced'",
      )
      .get(runId) as { count: number };

    const turnEvent = latestTurn
      ? JournalEventSchema.parse(jsonParse(latestTurn.event))
      : undefined;
    const contextEvent = latestContext
      ? JournalEventSchema.parse(jsonParse(latestContext.event))
      : undefined;
    const contextTokens =
      contextEvent &&
      "contextTokens" in contextEvent &&
      typeof contextEvent.contextTokens === "number"
        ? contextEvent.contextTokens
        : 0;

    return {
      turn: typeof turnEvent?.turn === "number" ? turnEvent.turn : 0,
      contextTokens,
      rotations: rotations.count,
    };
  }

  latestJournalSeq(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as {
      seq: number;
    };
    return row.seq;
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

    CREATE TABLE IF NOT EXISTS packet_projections(
      run_id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      published INTEGER NOT NULL CHECK(published IN (0, 1)),
      FOREIGN KEY(run_id) REFERENCES runs(run_id) ON DELETE CASCADE
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

    CREATE TABLE IF NOT EXISTS convergence_operations(
      run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      operation TEXT NOT NULL,
      PRIMARY KEY(run_id, attempt)
    );

    CREATE TABLE IF NOT EXISTS run_startup_operations(
      run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      operation TEXT NOT NULL,
      PRIMARY KEY(run_id, attempt)
    );

    CREATE TABLE IF NOT EXISTS acceptance_operations(
      campaign_id TEXT PRIMARY KEY,
      operation TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS projection_revisions(
      name TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      published_revision INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO projection_revisions(name, revision, published_revision) VALUES ('active_run', 0, 0);

    CREATE TABLE IF NOT EXISTS active_convergence(
      run_id TEXT PRIMARY KEY,
      convergence TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repository_leases(
      repo TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('execute', 'accept')),
      epoch INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repository_lease_epochs(
      repo TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS repository_lease_owners(
      owner_id TEXT PRIMARY KEY,
      pid INTEGER NOT NULL,
      process_instance_token TEXT NOT NULL
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

    CREATE TABLE IF NOT EXISTS plans(
      plan_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      raw TEXT NOT NULL,
      tags TEXT NOT NULL,
      queued_run_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS store_metadata(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS legacy_attempt_claims(
      run_id TEXT PRIMARY KEY
    );

    CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_decisions_run_seq ON decisions(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_convergence_run_seq ON convergence(run_id, seq);
  `);
}
