// The bridge: the driver's MCP face (CONTRACT §9). One HTTP endpoint, five
// tools, run identity ambient (M2). Every verdict is persisted before the tool
// result returns (S2 carried); accepted decisions clear the gate synchronously
// because the bridge IS the driver (v1 X2 made impossible).
//
// KEYSTONE (ARCHITECTURE §4): the bridge RECORDS typed BridgeIntent values into
// a per-turn channel (runRef.intents). It does NOT mutate shared context fields
// that the driver loop reads back behind its own back. The driver loop drains
// the intent channel after each send and feeds evaluateTurn.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { execSync } from "child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { resolve } from "path";
import { z } from "zod";
import type { Store } from "../application/ports/store.js";
import type { Paths } from "../config/paths.js";
import type { Config } from "../config/schemas.js";
import { classifyChangedFiles } from "../domain/gate-classification.js";
import {
  OutcomeStatus,
  SubmitReport,
  BlockedReason,
  ACCEPTED_STATUSES,
  clearedGateState,
  type Packet,
  type OutcomeLedger,
  type Checkpoint,
  type BridgeIntent,
} from "../domain/index.js";
import { JournalEvent } from "../domain/journal.js";
import type { QuestionType } from "../domain/review.js";
import { nowIso } from "./fsio.js";
import { readDiffStats } from "./git.js";

// ---------------------------------------------------------------------------
// ActiveRunRef — the per-run context for this bridge session.
//
// Keystone constraint: the bridge RECORDS BridgeIntent values into ref.intents
// (the per-turn channel the driver drains). It does NOT mutate a shared context
// that the driver loop reads as a side-channel. The fields pendingConsult,
// pendingFinalReview, reportRejectionCount, checkpointBounceCount are internal
// state the bridge sets and reads synchronously within the same process — they
// are NOT the TurnFacts scalar fields (those are assembled by evaluateTurn from
// the drained bridgeIntents array).
// ---------------------------------------------------------------------------

export type ActiveRunRef = {
  intents: BridgeIntent[];
  pendingConsult: AskPlannerInput | null;
  pendingFinalReview: SubmitReport | null;
  reportRejectionCount: number;
  checkpointBounceCount: number;
  config: Config;
  paths: Paths;
  worktree: string;
  packet: Packet;
  store: Store;
  turn: number;
};

// RunRef holder — the reference the bridge receives. Matches the reference
// driver's CurrentRunRef = { current: RunContext | undefined } (reference
// src/driver.ts:89). The bridge starts before any run exists; ALL ActiveRunRef
// fields are per-run, not just packet. The holder is { current: undefined }
// at startup, then set/cleared per run by the driver loop.
export type RunRef = {
  current: ActiveRunRef | undefined;
};

// ---------------------------------------------------------------------------
// Journal helper — thin wrapper over store.appendJournal.
// ---------------------------------------------------------------------------

type Without<T, K extends keyof T> = {
  [P in keyof T as P extends K ? never : P]: T[P];
};

const journal = (ctx: ActiveRunRef, event: Without<JournalEvent, "at" | "turn">): void => {
  ctx.store.appendJournal(ctx.packet.runId, {
    ...event,
    at: nowIso(),
    turn: (event as Without<JournalEvent, "at" | "turn"> & { turn?: number }).turn ?? ctx.turn,
  } as JournalEvent);
};

// ---------------------------------------------------------------------------
// Gate clearing — reads and clears the gate state.
// ---------------------------------------------------------------------------

const clearGate = (ctx: ActiveRunRef): void => {
  const gateState = ctx.store.readGateState(ctx.packet.runId);
  const baselineDiffStats = readDiffStats(ctx.worktree);
  const cleared = clearedGateState(gateState, baselineDiffStats, nowIso());
  ctx.store.writeGateState(ctx.packet.runId, cleared);
  journal(ctx, { event: "gate_cleared", decisionAt: nowIso() });
};

// ---------------------------------------------------------------------------
// Verification helpers (ported from reference/src/verification.ts)
// ---------------------------------------------------------------------------

export type VerificationResult = { command: string; exitCode: number; outputTail: string };

export const runVerification = (
  frontmatter: Packet["frontmatter"],
  worktree: string,
  timeoutMs: number,
): VerificationResult[] => {
  const wt = resolve(worktree);
  return frontmatter.verification.map((v) => {
    try {
      const output = execSync(v.command, {
        cwd: wt,
        encoding: "utf-8",
        stdio: ["ignore" as const, "pipe" as const, "pipe" as const],
        timeout: timeoutMs,
        shell: "/bin/zsh",
      });
      return { command: v.command, exitCode: 0, outputTail: output.slice(-400) };
    } catch (err) {
      const e = err as {
        status?: number | null;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      return {
        command: v.command,
        exitCode: typeof e.status === "number" ? e.status : 1,
        outputTail: `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-400) || (e.message ?? "failed"),
      };
    }
  });
};

export const toVerificationClaims = (
  results: VerificationResult[],
): SubmitReport["verificationClaims"] =>
  results.map((r) => ({
    command: r.command,
    result: r.exitCode === 0 ? ("passed" as const) : ("failed" as const),
    ...(r.outputTail ? { notes: r.outputTail.slice(-200) } : {}),
  }));

export const outcomeProblems = (report: SubmitReport, ledger: OutcomeLedger): string[] => {
  const problems: string[] = [];
  const byId = new Map(ledger.outcomes.map((o) => [o.id, o]));

  for (const claim of report.outcomeClaims) {
    const entry = byId.get(claim.id);
    if (!entry) {
      problems.push(`report claims unknown outcome id: ${claim.id}`);
      continue;
    }
    if (entry.status !== claim.status) {
      problems.push(
        `report claims outcome ${claim.id} is ${claim.status} but the ledger says ${entry.status} — update the ledger via update_outcomes (with evidence) or correct the claim`,
      );
    }
  }

  for (const entry of ledger.outcomes) {
    if (!report.outcomeClaims.some((c) => c.id === entry.id)) {
      problems.push(`report omits outcome ${entry.id} — every outcome must be claimed`);
    }
  }

  if (report.status === "ready_for_review") {
    for (const entry of ledger.outcomes) {
      if (entry.status !== "done") {
        problems.push(
          `ready_for_review requires every outcome done; ${entry.id} is ${entry.status} — finish it, or submit as blocked/failed`,
        );
      }
    }
  }

  return problems;
};

// ---------------------------------------------------------------------------
// Checkpoint problems — defensive check on the driver-ASSEMBLED checkpoint
// before teardown. The driver builds the outcome block from the ledger and
// the file list from the diff (the executor supplies only prose: summary +
// uncertainties), so the per-outcome state/next-action and ledger-equality
// checks are now vacuous. What remains is pure defence: every packet outcome
// present, no phantom ids, done implies evidence.
// ---------------------------------------------------------------------------

const checkpointProblems = (
  checkpoint: Checkpoint,
  packet: Packet,
  ledger: OutcomeLedger,
): string[] => {
  const problems: string[] = [];
  const packetIds = new Set(packet.frontmatter.outcomes.map((o) => o.id));
  const checkpointIds = new Set(checkpoint.outcomes.map((o) => o.id));

  for (const id of packetIds) {
    if (!checkpointIds.has(id))
      problems.push(`checkpoint omits outcome ${id} — every outcome must be accounted for`);
  }
  for (const o of checkpoint.outcomes) {
    if (!packetIds.has(o.id)) problems.push(`checkpoint names unknown outcome ${o.id}`);
    if (o.status === "done" && o.evidence.length === 0)
      problems.push(`done outcome ${o.id} has no evidence`);
  }
  return problems;
};

// ---------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  isError: false as const,
});
const errorText = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  isError: true as const,
});

// ---------------------------------------------------------------------------
// Exported tool handler bodies (extracted for testability — see bridge test)
// ---------------------------------------------------------------------------

// questionType is the domain QuestionType enum, NOT a bare string: this makes
// ActiveRunRef a genuine structural superset of the application's RunChannel
// (whose pendingConsult is the domain AskPlannerInput), so the composition root
// hands the bound ref to the run channel with no cast. The MCP tool's zod enum
// parses to exactly these members, so the handler input still satisfies it.
export type AskPlannerInput = {
  questionType: QuestionType;
  currentSlice: string;
  question: string;
  approach: string;
  evidence: string[];
};

// Re-export the domain AskPlannerInput for tests.
export type { AskPlannerInput as DomainAskPlannerInput, QuestionType } from "../domain/review.js";

export type UpdateOutcomesInput = {
  outcomes: Array<{
    id: string;
    status: string;
    evidence?: string[];
    state?: string;
    nextAction?: string;
  }>;
};

export type WriteCheckpointInput = {
  summary: string;
  uncertainties?: string[];
};

export type SubmitReportInput = {
  status: "ready_for_review" | "blocked" | "failed";
  blockedReason?: string;
  blockedQuestion?: string;
  summary: string;
  behaviourChanged?: string[];
  sourceOfTruthFollowed?: string[];
  escalations?: string[];
  remainingUncertainty?: string[];
};

export type GetDecisionsInput = {
  limit?: number;
};

export const handleAskPlanner = async (ref: RunRef, input: AskPlannerInput) => {
  const ctx = ref.current;
  if (!ctx) return errorText(JSON.stringify({ error: "no active run" }));

  // M2: argument failures must be visible. The SDK validates shapes before
  // this handler, but content-level emptiness slips through — and an
  // invisible rejection reads as "planner unreachable" to the executor.
  const argProblems: string[] = [];
  if (!input.question.trim()) argProblems.push("question is empty");
  if (!input.currentSlice.trim()) argProblems.push("currentSlice is empty");
  if (!input.approach.trim())
    argProblems.push("approach is empty — state your design decisions and intended next steps");
  if (input.evidence.every((e) => !e.trim())) argProblems.push("evidence is empty");
  if (argProblems.length > 0) {
    journal(ctx, { event: "driver_note", note: `ask_planner rejected: ${argProblems.join("; ")}` });
    return errorText(
      JSON.stringify({ error: "invalid meridian-bridge_ask_planner call", problems: argProblems }),
    );
  }

  // Async (CONTRACT §9 M3): the consult takes minutes, but opencode's MCP client
  // cancels a tool-call held open that long (~5min). So the bridge does NOT run
  // the consult here: it records the submission and returns at once.
  if (ctx.pendingConsult) {
    ctx.intents.push({ kind: "consult-requested" });
    return text(
      JSON.stringify({
        status: "already_submitted",
        instruction:
          "Your planner question is already queued. STOP and end your turn — Daddy's decision arrives in your next prompt. Do not ask again.",
      }),
    );
  }

  // Record the submission internally; the driver drains this on the next turn.
  ctx.pendingConsult = {
    questionType: input.questionType,
    currentSlice: input.currentSlice,
    question: input.question,
    approach: input.approach,
    evidence: input.evidence,
  };

  // Record the intent for the turn loop to evaluate.
  ctx.intents.push({ kind: "consult-requested" });
  journal(ctx, {
    event: "driver_note",
    note: `ask_planner submitted (${input.questionType}) — consult deferred to the driver`,
  });

  return text(
    JSON.stringify({
      status: "submitted",
      instruction:
        "Planner consult submitted. STOP now and end your turn — do not call more tools and do not improvise an answer. Daddy's decision will arrive in your next prompt.",
    }),
  );
};

export const handleUpdateOutcomes = async (ref: RunRef, input: UpdateOutcomesInput) => {
  const ctx = ref.current;
  if (!ctx) return errorText(JSON.stringify({ error: "no active run" }));

  const ledger = ctx.store.readLedger(ctx.packet.runId);
  const problems: string[] = [];

  for (const update of input.outcomes) {
    const entry = ledger.outcomes.find((o) => o.id === update.id);
    if (!entry) {
      problems.push(`unknown outcome id: ${update.id}`);
      continue;
    }
    const evidenceIsBlank =
      !update.evidence || update.evidence.length === 0 || update.evidence.every((e) => !e.trim());
    if (update.status === "done" && evidenceIsBlank && entry.evidence.length === 0) {
      problems.push(`outcome ${update.id} cannot be done without evidence (O2)`);
      continue;
    }
    entry.status = update.status as typeof entry.status;
    if (update.evidence && !evidenceIsBlank) entry.evidence = update.evidence;
    if (update.state !== undefined) entry.state = update.state;
    if (update.nextAction !== undefined) entry.nextAction = update.nextAction;
    entry.updatedAt = nowIso();
  }

  if (problems.length > 0) return errorText(JSON.stringify({ ok: false, problems }));

  ctx.store.writeLedger(ledger);
  journal(ctx, {
    event: "outcomes_updated",
    outcomes: ledger.outcomes.map((o) => ({ id: o.id, status: o.status })),
  });
  ctx.intents.push({ kind: "outcomes-updated" });
  return text(
    JSON.stringify({
      ok: true,
      outcomes: ledger.outcomes.map((o) => ({ id: o.id, status: o.status })),
    }),
  );
};

export const handleWriteCheckpoint = async (ref: RunRef, input: WriteCheckpointInput) => {
  const ctx = ref.current;
  if (!ctx) return errorText(JSON.stringify({ error: "no active run" }));

  const ledger = ctx.store.readLedger(ctx.packet.runId);
  const checkpoint = {
    number: ctx.store.nextCheckpointNumber(ctx.packet.runId),
    reason: "rotation",
    summary: input.summary,
    outcomes: ledger.outcomes.map((o) => ({
      id: o.id,
      status: o.status,
      evidence: o.evidence,
      ...(o.state !== undefined ? { state: o.state } : {}),
      ...(o.nextAction !== undefined ? { nextAction: o.nextAction } : {}),
    })),
    // Untracked-aware: worktree files are uncommitted until finalize, so a
    // tracked-only `git diff HEAD` would report none. The successor must see
    // what exists.
    filesChanged: Object.keys(readDiffStats(ctx.worktree))
      .sort()
      .map((path) => ({ path })),
    filesInspected: [],
    uncertainties: input.uncertainties ?? [],
    writtenAt: nowIso(),
  } as Checkpoint;

  const problems = checkpointProblems(checkpoint, ctx.packet, ledger);
  journal(ctx, {
    event: "checkpoint_written",
    number: checkpoint.number,
    valid: problems.length === 0,
    problems,
  });

  if (problems.length > 0) {
    ctx.checkpointBounceCount += 1;
    return errorText(
      JSON.stringify({
        ok: false,
        problems,
        note:
          ctx.checkpointBounceCount > ctx.config.thresholds.checkpointBounceLimit
            ? "bounce limit exceeded — the run will park if the next checkpoint is also invalid"
            : "fix these and call meridian-bridge_write_checkpoint again",
      }),
    );
  }

  ctx.store.writeCheckpoint(ctx.packet.runId, checkpoint);
  ctx.checkpointBounceCount = 0;
  ctx.intents.push({
    kind: "checkpoint-written",
    checkpoint: { number: checkpoint.number, reason: "rotation", summary: input.summary },
  });
  return text(JSON.stringify({ ok: true, number: checkpoint.number }));
};

export const handleSubmitReport = async (ref: RunRef, input: SubmitReportInput) => {
  const ctx = ref.current;
  if (!ctx) return errorText(JSON.stringify({ error: "no active run" }));

  // A re-submit while the deferred final review is still running is a no-op
  // hold (the driver is mid-review off the MCP path).
  if (ctx.pendingFinalReview) {
    return text(
      JSON.stringify({
        status: "review_pending",
        instruction:
          "Your report's final review is already running. STOP and end your turn — the result arrives in your next prompt.",
      }),
    );
  }
  const ledger = ctx.store.readLedger(ctx.packet.runId);

  // V1: the driver runs verification ITSELF, up front for ready_for_review.
  const verificationResults =
    input.status === "ready_for_review"
      ? runVerification(
          ctx.packet.frontmatter,
          ctx.worktree,
          ctx.config.thresholds.verificationTimeoutMs,
        )
      : [];
  for (const r of verificationResults) {
    journal(ctx, { event: "verification_run", command: r.command, exitCode: r.exitCode });
  }

  // Assembled from durable state + the executor's belief-prose.
  const report = SubmitReport.parse({
    status: input.status,
    ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason } : {}),
    ...(input.blockedQuestion !== undefined ? { blockedQuestion: input.blockedQuestion } : {}),
    summary: input.summary,
    filesChanged: classifyChangedFiles(
      Object.keys(readDiffStats(ctx.worktree)),
      ctx.packet.frontmatter.expected_surface,
      ctx.packet.frontmatter.suspicious_surface,
    ),
    behaviourChanged: input.behaviourChanged ?? [],
    sourceOfTruthFollowed: input.sourceOfTruthFollowed ?? [],
    outcomeClaims: ledger.outcomes.map((o) => ({ id: o.id, status: o.status })),
    verificationClaims: toVerificationClaims(verificationResults),
    escalations: input.escalations ?? [],
    remainingUncertainty: input.remainingUncertainty ?? [],
  });

  journal(ctx, { event: "report_submitted", status: report.status });

  const problems: string[] = [];
  if (report.status === "blocked" && (!report.blockedReason || !report.blockedQuestion)) {
    problems.push(
      "blocked reports must carry blockedReason and blockedQuestion — Max needs the exact decision",
    );
  }
  problems.push(...outcomeProblems(report, ledger));

  // V5: a latched gate means an unresolved planner obligation.
  const gateState = ctx.store.readGateState(ctx.packet.runId);
  if (report.status === "ready_for_review" && gateState.latched) {
    problems.push(
      `the gate is latched (${gateState.latchReason ?? "planner checkpoint required"}) — ready_for_review requires a clear gate: call meridian-bridge_ask_planner and continue only on proceed`,
    );
  }

  // Verification failures from the driver's own run.
  for (const r of verificationResults) {
    if (r.exitCode !== 0) {
      problems.push(
        `verification failed (exit ${r.exitCode}): ${r.command}\n  output: ${r.outputTail.slice(-200)}`,
      );
    }
  }

  // Mechanical floor (V1/V6): synchronous rejection — no planner needed.
  if (problems.length > 0) {
    ctx.reportRejectionCount += 1;
    journal(ctx, { event: "report_rejected", problems });
    ctx.intents.push({ kind: "report-rejected", problems });
    return errorText(JSON.stringify({ ok: false, problems }));
  }

  // V7: mechanical floor passed. ready_for_review needs Daddy's final review.
  // Like ask_planner it is a multi-minute Daddy call, so it must NOT run in
  // this handler. Defer it: record the report and return; the driver runs the
  // review off the MCP path.
  if (report.status === "ready_for_review") {
    ctx.pendingFinalReview = report;
    // No journal here — the actual final_review event is written by the
    // driver-side runner when the review completes. The report_submitted
    // event above is already sufficient tracking.
    ctx.intents.push({ kind: "final-review-requested" });
    return text(
      JSON.stringify({
        status: "review_pending",
        instruction:
          "Report received and the mechanical floor is green. Daddy's final review runs now — STOP and end your turn; the result (accept, requested changes, or escalation) arrives in your next prompt.",
      }),
    );
  }

  // blocked / failed with a clean floor: terminal immediately, no review.
  journal(ctx, { event: "report_accepted", status: report.status });
  ctx.intents.push({
    kind: "report-accepted",
    status: report.status,
    blockedReason: report.blockedReason,
    blockedQuestion: report.blockedQuestion,
    summary: report.summary,
  });
  return text(
    JSON.stringify({
      ok: true,
      status: report.status,
      note: "Report accepted. The driver will finalize the run.",
    }),
  );
};

export const handleGetDecisions = async (ref: RunRef, input: GetDecisionsInput) => {
  const ctx = ref.current;
  if (!ctx) return errorText(JSON.stringify({ error: "no active run" }));

  const decisions = ctx.store.readDecisions(ctx.packet.runId);
  const gateState = ctx.store.readGateState(ctx.packet.runId);
  const accepted = decisions
    .slice(-(input.limit ?? 20))
    .find(
      (d) =>
        ACCEPTED_STATUSES.some((s) => s === d.status) &&
        (gateState.lastAcceptedDecisionAt ?? "") < d.timestamp,
    );
  if (accepted) clearGate(ctx);
  return text(JSON.stringify({ decisions: decisions.slice(-(input.limit ?? 20)) }, null, 2));
};

// ---------------------------------------------------------------------------
// Build the MCP server
// ---------------------------------------------------------------------------

export const buildMcpServer = (ref: RunRef): McpServer => {
  const server = new McpServer({ name: "meridian-bridge", version: "2.0.0" });

  // --- ask_planner (CONTRACT §9 M1–M3) ---

  server.tool(
    "ask_planner",
    "Ask the planner (Daddy) a scoped question tied to the current slice. Returns a structured decision. human_required and stop are hard stops.",
    {
      questionType: z
        .enum([
          "repo_procedure",
          "architecture_discoverable",
          "handoff_interpretation",
          "stop_condition",
          "diff_audit",
          "reconciliation",
          "other",
        ])
        .describe("Category of the question."),
      currentSlice: z.string().min(1).describe("The implementation unit you are working on."),
      question: z.string().min(1).describe("The narrow, scoped question."),
      approach: z
        .string()
        .min(1)
        .describe(
          "Your implementation approach for this slice: every design decision you have already made or are about to make (representations, strategies, structure), plus your intended next steps. The planner reviews this, not just the question — withholding a decision here means implementing it unreviewed.",
        ),
      evidence: z
        .array(z.string())
        .min(1)
        .describe("Concrete evidence: file paths, snippets, error text."),
    },
    async (input) => handleAskPlanner(ref, input),
  );

  // --- update_outcomes (CONTRACT §8 O2) ---

  server.tool(
    "update_outcomes",
    "Update the outcome ledger. Marking an outcome done requires evidence. in_progress entries should carry exact state and next action.",
    {
      outcomes: z
        .array(
          z.object({
            id: z.string(),
            status: OutcomeStatus,
            evidence: z.array(z.string()).optional(),
            state: z.string().optional(),
            nextAction: z.string().optional(),
          }),
        )
        .min(1),
    },
    async (input) => handleUpdateOutcomes(ref, input),
  );

  // --- write_checkpoint (CONTRACT §8 O4) ---

  server.tool(
    "write_checkpoint",
    "Write the rotation checkpoint for your successor. Supply only your subjective state — a prose summary of where the work stands and what comes next, plus any uncertainties a successor must not assume. The driver records WHICH outcomes are at what status (from the ledger) and WHICH files changed (from the diff); you don't restate them. Keep the ledger current via meridian-bridge_update_outcomes BEFORE you checkpoint so the snapshot is accurate.",
    {
      summary: z
        .string()
        .min(1)
        .describe(
          "Plain prose a successor can act on: what is done, what is half-done and how, what the precise next action is, and why you made the decisions you made.",
        ),
      uncertainties: z
        .array(z.string())
        .optional()
        .describe(
          "Things a successor must NOT assume — open questions, fragile spots, decisions you are unsure about.",
        ),
    },
    async (input) => handleWriteCheckpoint(ref, input),
  );

  // --- submit_report (CONTRACT §11 V1/V4/V5) ---

  server.tool(
    "submit_report",
    "Submit the final report — the ONLY way a run reaches a terminal status. Supply your terminal DECISION (status) and your subjective account in prose; the driver records the objective facts itself — which files changed (from the diff), which outcomes are done (from the ledger), and the verification results (the driver runs the commands). Do not restate those. ready_for_review is accepted only if the driver's own verification is green and every outcome is done; if not, submit blocked or failed and say why.",
    {
      status: z.enum(["ready_for_review", "blocked", "failed"]),
      blockedReason: BlockedReason.optional(),
      blockedQuestion: z
        .string()
        .optional()
        .describe("For blocked: the exact decision only Max can make."),
      summary: z
        .string()
        .min(1)
        .describe("Your account of what you did and why — the narrative of the work, in prose."),
      behaviourChanged: z
        .array(z.string())
        .optional()
        .describe(
          "How system behaviour changed, in your words — interpretation a diff cannot show.",
        ),
      sourceOfTruthFollowed: z
        .array(z.string())
        .optional()
        .describe("The guidance/spec/decisions you followed."),
      escalations: z
        .array(z.string())
        .optional()
        .describe("Anything you escalated or think Max should know."),
      remainingUncertainty: z
        .array(z.string())
        .optional()
        .describe("What you remain unsure about."),
    },
    async (input) => handleSubmitReport(ref, input),
  );

  // --- get_decisions (CONTRACT §9) ---

  server.tool(
    "get_decisions",
    "Read prior planner and Max decisions for this run.",
    { limit: z.number().int().min(1).max(100).optional() },
    async (input) => handleGetDecisions(ref, input),
  );

  return server;
};

// ---------------------------------------------------------------------------
// MCP server lifecycle
// ---------------------------------------------------------------------------

// Stateless StreamableHTTP: a fresh transport per POST avoids request-id
// collisions and session bookkeeping; the MCP client (opencode) re-initializes
// cheaply.
export const startBridgeServer = (config: Config, ref: RunRef): Server => {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }),
      );
      return;
    }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body =
        chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined;

      const server = buildMcpServer(ref);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
            id: null,
          }),
        );
      }
    }
  });
  // ask_planner holds a request open for as long as Daddy thinks; node's
  // default requestTimeout (300s) would kill it mid-verdict.
  httpServer.requestTimeout = 0;
  httpServer.timeout = 0;
  return httpServer;
};

// Binding the bridge port doubles as the single-driver lock: it MUST happen
// before anything touches run state (R1 — exactly one driver, ever). The bind
// is atomic and self-releasing on crash, which a lockfile is not.
export const listenBridge = (httpServer: Server, config: Config): Promise<void> =>
  new Promise((resolve, reject) => {
    httpServer.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `port ${config.opencode.bridgePort} is in use — another 'meridian run' is already active. One driver at a time.`,
            )
          : err,
      );
    });
    httpServer.listen(config.opencode.bridgePort, "127.0.0.1", () => resolve());
  });
