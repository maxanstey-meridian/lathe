// ---------------------------------------------------------------------------
// `lathe db` — read-only SQLite inspector for debugging.
//
// Does NOT go through the daemon. Opens lathe.db directly in read-only mode
// (WAL = safe concurrent reads). This is deliberate: when the daemon is the
// thing that's broken, you still need to inspect state.
//
// Usage:
//   lathe db run [runId]            hero snapshot: meta + gate + decisions + convergence
//   lathe db events [runId] [-N]    last N journal events (default 20)
//   lathe db gate [runId]           gate state detail
//   lathe db decisions [runId]      full decision history
//   lathe db convergence [runId]    convergence log
//   lathe db campaign [campaignId]  campaign passes + verdicts
//   lathe db queue                  queued runs
//   lathe db active                 active run + convergence pointers
//   lathe db query <sql>            raw SQL escape hatch
//
// <runId> is optional — defaults to the active run when omitted.
// Add --json to any command for raw JSON output.
// ---------------------------------------------------------------------------

import { loadConfig, renderJournalEvent, isLatched, gateReason } from "@lathe/core";
import { DatabaseSync } from "node:sqlite";
import type { CliEnv } from "./commands.js";

type Obj = Record<string, unknown>;

const parseJson = (s: string): Obj => JSON.parse(s) as Obj;

const resolveRunId = (db: DatabaseSync, runId: string | undefined): string | null => {
  if (runId) return runId;
  const row = db.prepare("SELECT run FROM active_run WHERE key = '1'").get() as
    | { run: string }
    | undefined;
  if (!row) return null;
  const active = parseJson(row.run);
  return (active.runId as string) ?? null;
};

const flag = (args: string[], name: string): { present: boolean; rest: string[] } => {
  const without = args.filter((a) => a !== name);
  return { present: without.length !== args.length, rest: without };
};

const openDb = (): DatabaseSync => {
  const { paths } = loadConfig();
  return new DatabaseSync(paths.dbFile, { readOnly: true });
};

const section = (env: CliEnv, title: string): void => {
  const line = "─".repeat(Math.max(0, 52 - title.length));
  env.log(`─── ${title} ${line}`);
};

const kv = (key: string, value: unknown): string => {
  const s = value === undefined || value === null ? "—" : String(value);
  return `${key.padEnd(14)}${s}`;
};

// --- subcommands -----------------------------------------------------------

const dbRun = (env: CliEnv, db: DatabaseSync, args: string[]): number => {
  const runId = resolveRunId(db, args[0]);
  if (!runId) {
    env.err("no active run — specify a runId");
    return 1;
  }

  const metaRow = db.prepare("SELECT meta FROM runs WHERE run_id = ?").get(runId) as
    | { meta: string }
    | undefined;
  if (!metaRow) {
    env.err(`run not found: ${runId}`);
    return 1;
  }
  const meta = parseJson(metaRow.meta);

  section(env, `Run: ${runId}`);
  env.log(kv("status", meta.status));
  env.log(kv("attempt", meta.attempt));
  env.log(kv("base", meta.base));
  env.log(kv("branch", meta.branch));
  env.log(kv("repo", meta.repo));
  if (meta.blockedReason) env.log(kv("blocked", meta.blockedReason));
  if (meta.blockedQuestion) env.log(kv("question", meta.blockedQuestion));
  env.log(kv("reviewer unr.", meta.reviewerUnreachable));
  env.log(kv("promoted", meta.promoted));
  env.log(kv("updated", meta.updatedAt));
  env.log("");

  // Gate state
  const gateRow = db.prepare("SELECT state FROM gate_state WHERE run_id = ?").get(runId) as
    | { state: string }
    | undefined;
  if (gateRow) {
    const gate = parseJson(gateRow.state);
    const phase = gate.phase as Obj;
    section(env, "Gate");
    env.log(kv("phase", phase.phase));
    if (phase.reason) env.log(kv("reason", phase.reason));
    env.log(kv("latched", isLatched(gate as never)));
    env.log(kv("last decision", gate.lastAcceptedDecisionAt));
    env.log(kv("globs", (gate.expectedGlobs as string[])?.join(", ")));
    env.log("");
  }

  // Convergence
  const convRows = db
    .prepare("SELECT entry FROM convergence WHERE run_id = ? ORDER BY seq")
    .all(runId) as { entry: string }[];
  if (convRows.length > 0) {
    section(env, `Convergence (${convRows.length} ${convRows.length === 1 ? "entry" : "entries"})`);
    for (const row of convRows) {
      const e = parseJson(row.entry);
      if (e.kind === "reviewed") {
        const decision = e.decision as Obj;
        const primary = e.primary as Obj;
        env.log(
          `  pass ${e.pass}: ${primary.verdict} → ${decision.action}${e.amendedCommitSha ? ` (amended ${String(e.amendedCommitSha).slice(0, 8)})` : ""}`,
        );
      } else {
        env.log(`  pass ${e.pass}: UNREACHABLE (${e.detail})  [${e.attempt}/${e.budget}]`);
      }
    }
    env.log("");
  }

  // Recent decisions
  const decRows = db
    .prepare("SELECT decision FROM decisions WHERE run_id = ? ORDER BY seq DESC LIMIT 5")
    .all(runId) as { decision: string }[];
  if (decRows.length > 0) {
    section(env, `Recent Decisions (${decRows.length})`);
    for (const row of [...decRows].reverse()) {
      const d = parseJson(row.decision);
      const t = String(d.timestamp ?? "").slice(11, 19);
      const q = String(d.question ?? "").slice(0, 100);
      const a = String(d.answer ?? "").slice(0, 120);
      env.log(`  [${t}] ${d.source} [${d.status}] Q: ${q}`);
      env.log(`    A: ${a}`);
    }
    env.log("");
  }

  // Recent events
  const evRows = db
    .prepare("SELECT event FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT 8")
    .all(runId) as { event: string }[];
  if (evRows.length > 0) {
    section(env, `Recent Events (last ${evRows.length})`);
    for (const row of [...evRows].reverse()) {
      env.log(`  ${renderJournalEvent(parseJson(row.event) as never)}`);
    }
  }

  return 0;
};

const dbEvents = (env: CliEnv, db: DatabaseSync, args: string[], jsonMode: boolean): number => {
  const runId = resolveRunId(db, args[0]);
  if (!runId) {
    env.err("no active run — specify a runId");
    return 1;
  }

  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 && args[limitIdx + 1] ? Number.parseInt(args[limitIdx + 1]!, 10) : 20;

  const rows = db
    .prepare("SELECT event FROM events WHERE run_id = ? ORDER BY seq DESC LIMIT ?")
    .all(runId, limit) as { event: string }[];

  if (rows.length === 0) {
    env.err(`no events for ${runId}`);
    return 1;
  }

  const events = [...rows].reverse().map((r) => parseJson(r.event));
  if (jsonMode) {
    env.log(JSON.stringify(events, null, 2));
  } else {
    for (const e of events) {
      env.log(renderJournalEvent(e as never));
    }
  }
  return 0;
};

const dbGate = (env: CliEnv, db: DatabaseSync, args: string[], jsonMode: boolean): number => {
  const runId = resolveRunId(db, args[0]);
  if (!runId) {
    env.err("no active run — specify a runId");
    return 1;
  }

  const row = db.prepare("SELECT state FROM gate_state WHERE run_id = ?").get(runId) as
    | { state: string }
    | undefined;
  if (!row) {
    env.err(`no gate state for ${runId}`);
    return 1;
  }

  const gate = parseJson(row.state);
  if (jsonMode) {
    env.log(JSON.stringify(gate, null, 2));
    return 0;
  }

  const phase = gate.phase as Obj;
  env.log(kv("phase", phase.phase));
  if (phase.reason) env.log(kv("reason", phase.reason));
  env.log(kv("latched", isLatched(gate as never)));
  env.log(kv("gate reason", gateReason(gate as never)));
  env.log(kv("last decision", gate.lastAcceptedDecisionAt));
  env.log(kv("checkpoint nudge", gate.checkpointNudgeMs));
  env.log(kv("tool call threshold", gate.checkpointToolCalls));
  env.log(kv("file threshold", gate.checkpointFiles));
  env.log(kv("loc threshold", gate.checkpointLoc));
  env.log(kv("expected globs", (gate.expectedGlobs as string[])?.join(", ")));
  env.log(kv("suspicious globs", (gate.suspiciousGlobs as string[])?.join(", ")));
  env.log(kv("mutation patterns", (gate.mutationCommandPatterns as string[])?.join(", ")));
  env.log(kv("updated", gate.updatedAt));
  return 0;
};

const dbDecisions = (env: CliEnv, db: DatabaseSync, args: string[], jsonMode: boolean): number => {
  const runId = resolveRunId(db, args[0]);
  if (!runId) {
    env.err("no active run — specify a runId");
    return 1;
  }

  const rows = db
    .prepare("SELECT decision FROM decisions WHERE run_id = ? ORDER BY seq")
    .all(runId) as { decision: string }[];

  if (rows.length === 0) {
    env.err(`no decisions for ${runId}`);
    return 1;
  }

  const decisions = rows.map((r) => parseJson(r.decision));
  if (jsonMode) {
    env.log(JSON.stringify(decisions, null, 2));
    return 0;
  }

  for (const d of decisions) {
    const t = String(d.timestamp ?? "").slice(11, 19);
    env.log(`[${t}] ${d.source} [${d.status}]`);
    env.log(`  Q: ${String(d.question ?? "").slice(0, 150)}`);
    env.log(`  A: ${String(d.answer ?? "").slice(0, 200)}`);
    const constraints = d.constraints as string[] | undefined;
    if (constraints && constraints.length > 0) {
      env.log(`  constraints: ${constraints.join(" | ")}`);
    }
    if (d.humanDecisionNeeded) {
      env.log(`  ⚠ human decision needed: ${d.humanDecisionNeeded}`);
    }
    env.log("");
  }
  return 0;
};

const dbConvergence = (env: CliEnv, db: DatabaseSync, args: string[], jsonMode: boolean): number => {
  const runId = resolveRunId(db, args[0]);
  if (!runId) {
    env.err("no active run — specify a runId");
    return 1;
  }

  const rows = db
    .prepare("SELECT entry FROM convergence WHERE run_id = ? ORDER BY seq")
    .all(runId) as { entry: string }[];

  if (rows.length === 0) {
    env.err(`no convergence log for ${runId}`);
    return 1;
  }

  const entries = rows.map((r) => parseJson(r.entry));
  if (jsonMode) {
    env.log(JSON.stringify(entries, null, 2));
    return 0;
  }

  for (const e of entries) {
    const at = String(e.at ?? "").slice(11, 19);
    if (e.kind === "reviewed") {
      const decision = e.decision as Obj;
      const primary = e.primary as Obj;
      const findings = (primary.findings as Obj[]) ?? [];
      env.log(`[${at}] pass ${e.pass}: ${primary.verdict} → ${decision.action} (${findings.length} findings)`);
      if (primary.commit_message) {
        env.log(`  commit: ${String(primary.commit_message).slice(0, 100)}`);
      }
    } else {
      env.log(`[${at}] pass ${e.pass}: UNREACHABLE — ${e.detail}  [${e.attempt}/${e.budget}]`);
    }
  }
  return 0;
};

const dbCampaign = (env: CliEnv, db: DatabaseSync, args: string[], jsonMode: boolean): number => {
  const campaignId = args[0];

  if (campaignId) {
    const row = db.prepare("SELECT campaign FROM campaigns WHERE campaign_id = ?").get(campaignId) as
      | { campaign: string }
      | undefined;
    if (!row) {
      env.err(`campaign not found: ${campaignId}`);
      return 1;
    }
    const c = parseJson(row.campaign);
    if (jsonMode) {
      env.log(JSON.stringify(c, null, 2));
      return 0;
    }
    env.log(kv("campaign", c.campaignId));
    env.log(kv("original run", c.originalRunId));
    env.log(kv("intent", String(c.originalIntent ?? "").slice(0, 100)));
    env.log(kv("status", c.status));
    env.log(kv("max passes", c.maxPasses));
    env.log("");
    const passes = (c.passes as Obj[]) ?? [];
    for (const p of passes) {
      env.log(`  pass ${p.pass}: ${p.verdict} (${p.groundedBlockers} blockers) — ${String(p.atIso ?? "").slice(0, 19)}`);
    }
    return 0;
  }

  // List all campaigns
  const rows = db.prepare("SELECT campaign FROM campaigns ORDER BY campaign_id").all() as {
    campaign: string;
  }[];
  if (rows.length === 0) {
    env.err("no campaigns");
    return 1;
  }
  if (jsonMode) {
    env.log(JSON.stringify(rows.map((r) => parseJson(r.campaign)), null, 2));
    return 0;
  }
  for (const row of rows) {
    const c = parseJson(row.campaign);
    const passes = (c.passes as Obj[]) ?? [];
    const lastPass = passes[passes.length - 1];
    env.log(
      `${c.campaignId}  ${String(c.status).padEnd(10)}  ${passes.length}/${c.maxPasses} passes` +
        (lastPass ? `  last: ${lastPass.verdict}` : ""),
    );
  }
  return 0;
};

const dbQueue = (env: CliEnv, db: DatabaseSync, _args: string[], jsonMode: boolean): number => {
  const rows = db
    .prepare(
      "SELECT run_id, meta FROM runs WHERE json_extract(meta, '$.status') = 'queued' ORDER BY run_id",
    )
    .all() as { run_id: string; meta: string }[];

  if (rows.length === 0) {
    env.log("queue is empty");
    return 0;
  }

  if (jsonMode) {
    env.log(JSON.stringify(rows.map((r) => ({ runId: r.run_id, ...parseJson(r.meta) })), null, 2));
    return 0;
  }

  for (const row of rows) {
    const meta = parseJson(row.meta);
    env.log(`${row.run_id}  base=${meta.base ?? "?"}  updated=${String(meta.updatedAt ?? "").slice(0, 19)}`);
  }
  return 0;
};

const dbActive = (env: CliEnv, db: DatabaseSync, _args: string[], jsonMode: boolean): number => {
  const runRow = db.prepare("SELECT run FROM active_run WHERE key = '1'").get() as
    | { run: string }
    | undefined;
  const convRow = db.prepare("SELECT convergence FROM active_convergence WHERE key = '1'").get() as
    | { convergence: string }
    | undefined;

  if (!runRow && !convRow) {
    env.log("no active run or convergence");
    return 0;
  }

  const active: Obj = {};
  if (runRow) active.activeRun = parseJson(runRow.run);
  if (convRow) active.activeConvergence = parseJson(convRow.convergence);

  if (jsonMode) {
    env.log(JSON.stringify(active, null, 2));
    return 0;
  }

  if (active.activeRun) {
    const r = active.activeRun as Obj;
    env.log(kv("active run", r.runId));
    env.log(kv("session", r.babySessionId));
    env.log(kv("worktree", r.worktree));
  }
  if (active.activeConvergence) {
    const c = active.activeConvergence as Obj;
    env.log(kv("converging", c.runId));
  }
  return 0;
};

const dbQuery = (env: CliEnv, db: DatabaseSync, args: string[]): number => {
  const sql = args.join(" ");
  if (!sql) {
    env.err("usage: lathe db query <sql>");
    return 1;
  }

  let rows: unknown[];
  try {
    rows = db.prepare(sql).all() as unknown[];
  } catch (err) {
    env.err(`query failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  env.log(JSON.stringify(rows, null, 2));
  return 0;
};

// --- entry point -----------------------------------------------------------

export const cmdDb = (env: CliEnv, args: string[]): number => {
  const { present: jsonMode, rest } = flag(args, "--json");
  const subcommand = rest[0] ?? "";
  const subArgs = rest.slice(1);

  let db: DatabaseSync;
  try {
    db = openDb();
  } catch (err) {
    env.err(`cannot open lathe.db: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  try {
    switch (subcommand) {
      case "run":
        return dbRun(env, db, subArgs);
      case "events":
        return dbEvents(env, db, subArgs, jsonMode);
      case "gate":
        return dbGate(env, db, subArgs, jsonMode);
      case "decisions":
        return dbDecisions(env, db, subArgs, jsonMode);
      case "convergence":
        return dbConvergence(env, db, subArgs, jsonMode);
      case "campaign":
        return dbCampaign(env, db, subArgs, jsonMode);
      case "queue":
        return dbQueue(env, db, subArgs, jsonMode);
      case "active":
        return dbActive(env, db, subArgs, jsonMode);
      case "query":
        return dbQuery(env, db, subArgs);
      default:
        env.log(`usage: lathe db <command> [args] [--json]

commands:
  run [runId]            hero snapshot: meta + gate + decisions + convergence
  events [runId] [-N]    last N journal events (default 20)
  gate [runId]           gate state detail
  decisions [runId]      full decision history
  convergence [runId]    convergence log
  campaign [campaignId]  campaign passes + verdicts
  queue                  queued runs
  active                 active run + convergence pointers
  query <sql>            raw SQL escape hatch

<runId> defaults to the active run when omitted.
add --json to any command for raw JSON output`);
        return subcommand ? 1 : 0;
    }
  } finally {
    db.close();
  }
};
