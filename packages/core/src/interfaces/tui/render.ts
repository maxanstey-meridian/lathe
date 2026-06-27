// ---------------------------------------------------------------------------
// Stateless TUI renderers (CONTRACT D4, ARCHITECTURE §1)
//
// Pure functions over the Store: each takes durable run state and returns the
// text to print. They NEVER write run state, and produce identical output for a
// live and a finished run (the journal is the same file in both cases). The CLI
// reads through the Store port only — no infrastructure, no filesystem here.
//
// These are the plain-text renderers (status, review, queue, journal replay/--plain).
// The live Ink split-pane TTY face — Baby/Daddy panes, the context gauge, the
// status strip, fed by the journal + the live SSE feed — lives in tail-ui.tsx and
// is launched by `tail` on a TTY (CONTRACT X3). Both read-only over the same
// durable state; the journal is the authoritative event log and the sole source
// for finished-run replay.
// ---------------------------------------------------------------------------

import type { Store } from "../../application/ports/store.js";
import { isLatched, gateReason } from "../../domain/gate.js";
import { renderJournalEvent } from "../../domain/journal.js";

// Outcome roll-up: "2/3 done, 1 in progress". Empty string when no ledger yet.
export const fmtOutcomes = (store: Store, runId: string): string => {
  const ledger = (() => {
    try {
      return store.readLedger(runId);
    } catch {
      return undefined;
    }
  })();
  if (!ledger) {
    return "";
  }
  const counts = { done: 0, in_progress: 0, not_started: 0, blocked: 0 };
  for (const o of ledger.outcomes) {
    counts[o.status] += 1;
  }
  const extra = `${counts.in_progress ? `, ${counts.in_progress} in progress` : ""}${counts.blocked ? `, ${counts.blocked} blocked` : ""}`;
  return `${counts.done}/${ledger.outcomes.length} done${extra}`;
};

// `meridian status`: what is running / queued / parked + campaign convergence +
// the held chain.
export const renderStatus = (store: Store): string => {
  const lines: string[] = [];

  const active = store.readActiveRun();
  if (active) {
    lines.push(`ACTIVE: ${active.runId}  (${fmtOutcomes(store, active.runId)})`);
    let latched: string | undefined;
    try {
      const gate = store.readGateState(active.runId);
      if (isLatched(gate)) {
        latched = gateReason(gate) ?? "unknown";
      }
    } catch {
      /* no gate yet */
    }
    if (latched) {
      lines.push(`  gate latched: ${latched}`);
    }
    for (const e of store.readJournal(active.runId).slice(-5)) {
      lines.push(`  ${e.at.slice(11, 19)} ${e.event}`);
    }
  } else {
    lines.push("no active run");
  }

  const queued = store.listQueue();
  if (queued.length > 0) {
    lines.push(`queued: ${queued.map((q) => q.runId).join(", ")}`);
  }

  const parked = store
    .listRunIds()
    .map((id) => store.readMetaIfExists(id))
    .filter((m) => m !== undefined && m.status === "blocked");
  for (const m of parked) {
    if (!m) {
      continue;
    }
    const retries = m.stallRetries
      ? `, ${m.stallRetries} auto-retr${m.stallRetries === 1 ? "y" : "ies"}`
      : "";
    lines.push(
      `parked: ${m.runId} (${m.blockedReason ?? "?"}${retries}) — ${(m.blockedQuestion ?? "").slice(0, 100)}`,
    );
  }

  const campaigns = store.listCampaigns();
  if (campaigns.length > 0) {
    lines.push("campaigns:");
    for (const c of campaigns) {
      const last = c.passes[c.passes.length - 1];
      const mark = c.status === "converged" ? "✅" : c.status === "needs_max" ? "🅿" : "…";
      lines.push(
        `  ${mark} ${c.campaignId}  [${c.status}]  pass ${last?.pass ?? 0}/${c.maxPasses}  — ${c.originalIntent.slice(0, 60)}`,
      );
    }
  }

  const staged = store.listStaged();
  if (staged.length > 0) {
    lines.push("chain (staged):");
    for (const s of staged) {
      const parent = s.parentRunId ? `← ${s.parentRunId}` : "(no parent — head)";
      lines.push(`  … ${s.runId}  ${parent}`);
    }
  }

  return lines.join("\n");
};

// `meridian review`: morning triage — every terminal-status run, its outcomes,
// and the exact next command (answer / accept).
export const renderReview = (store: Store): string => {
  const runs = store
    .listRunIds()
    .map((id) => store.readMetaIfExists(id))
    .filter((m) => m !== undefined && m.status !== "running" && m.status !== "queued");

  if (runs.length === 0) {
    return "nothing to review";
  }

  const lines: string[] = [];
  for (const m of runs) {
    if (!m) {
      continue;
    }
    const icon =
      m.status === "ready_for_review"
        ? "✅"
        : m.status === "accepted"
          ? "☑"
          : m.status === "blocked"
            ? "🅿"
            : m.status === "failed"
              ? "❌"
              : "⏸";
    lines.push(
      `${icon} ${m.runId}  [${m.status}]  ${fmtOutcomes(store, m.runId)}  branch ${m.branch}`,
    );
    if (m.status === "blocked") {
      lines.push(`   needs: ${m.blockedQuestion ?? "(no question recorded)"}`);
      lines.push(`   answer with: meridian answer ${m.runId} "<your decision>"`);
    }
    if (m.status === "ready_for_review") {
      lines.push(`   diff:   git -C ${m.repo} diff ${m.base}...${m.branch}`);
      lines.push(
        `   accept: meridian accept ${m.runId} [branch]   (merges into [branch], default ${m.base}; tidies the worktree)`,
      );
    }
  }
  return lines.join("\n");
};

// `meridian queue`: the queue, marking any packet that fails re-validation.
export const renderQueue = (store: Store): string => {
  const entries = store.listQueue();
  if (entries.length === 0) {
    return "queue is empty";
  }
  return entries.map((e, i) => `${i + 1}. ${e.runId}`).join("\n");
};

// `meridian tail --no-follow` / replay: the journal as a line stream. The same
// renderer feeds live follow (one slice per file change) — D4: identical output
// live and finished.
export const renderJournalReplay = (store: Store, runId: string): string =>
  store.readJournal(runId).map(renderJournalEvent).join("\n");
