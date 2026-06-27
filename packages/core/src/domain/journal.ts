import { z } from "zod";
import { OutcomeStatus } from "./outcomes.js";
import { FinalReviewVerdict } from "./review.js";
import { BlockedReason } from "./run.js";

// ---------------------------------------------------------------------------
// Journal (CONTRACT §13) — discriminated on `event`

const base = { at: z.string(), turn: z.number().int().optional() };

export const JournalEvent = z.discriminatedUnion("event", [
  z.object({
    ...base,
    event: z.literal("run_started"),
    runId: z.string(),
    attempt: z.number().int(),
  }),
  z.object({
    ...base,
    event: z.literal("prompt_sent"),
    promptName: z.string(),
    preview: z.string(),
  }),
  z.object({
    ...base,
    event: z.literal("turn_ended"),
    messageId: z.string(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cacheRead: z.number(),
      cacheWrite: z.number(),
    }),
    contextTokens: z.number(),
    responseError: z.string().optional(),
    responseErrorDetail: z
      .object({
        name: z.string().optional(),
        statusCode: z.number().optional(),
        message: z.string().optional(),
        responseBodyPreview: z.string().optional(),
      })
      .optional(),
    responsePartCount: z.number().int().optional(),
    responsePartTypes: z.array(z.string()).optional(),
    harvestMessageCount: z.number().int().optional(),
    harvestStart: z.number().int().optional(),
    harvestPartCount: z.number().int().optional(),
    text: z.string(),
    reasoning: z.string().optional(),
  }),
  z.object({
    ...base,
    event: z.literal("turn_harvest_failed"),
    messageId: z.string(),
    detail: z.string(),
  }),
  z.object({
    ...base,
    event: z.literal("tool_call"),
    tool: z.string(),
    callId: z.string().optional(),
    command: z.string().optional(),
    target: z.string().optional(),
    status: z.enum(["completed", "error"]),
    exitCode: z.number().optional(),
    outputPreview: z.string().optional(),
    gateDenied: z.boolean().default(false),
  }),
  z.object({ ...base, event: z.literal("gate_latched"), reason: z.string() }),
  z.object({ ...base, event: z.literal("gate_cleared"), decisionAt: z.string() }),
  // The non-blocking volume reminder crossed its threshold this turn; journal it
  // so the tail shows the threshold crossing. §10.
  z.object({
    ...base,
    event: z.literal("checkpoint_volume_nudge"),
    reason: z.string(),
    toolCalls: z.number().int(),
  }),
  z.object({
    ...base,
    event: z.literal("planner_exchange"),
    questionType: z.string(),
    question: z.string(),
    status: z.string(),
    answer: z.string(),
    constraints: z.array(z.string()),
    evidence_used: z.array(z.string()).default([]),
    safe_next_action: z.string().default(""),
    human_decision_needed: z.string().nullable().default(null),
    reconciliation_fingerprint: z.string().optional(),
    reconciliation_reused: z.boolean().optional(),
  }),
  z.object({
    ...base,
    event: z.literal("outcomes_updated"),
    outcomes: z.array(z.object({ id: z.string(), status: OutcomeStatus })),
  }),
  z.object({
    ...base,
    event: z.literal("checkpoint_written"),
    number: z.number().int(),
    valid: z.boolean(),
    problems: z.array(z.string()).default([]),
  }),
  z.object({
    ...base,
    event: z.literal("rotation"),
    phase: z.enum(["teardown_demanded", "session_replaced", "no_progress", "context_overflow"]),
    contextTokens: z.number().optional(),
    newSessionId: z.string().optional(),
  }),
  z.object({
    ...base,
    event: z.literal("verification_run"),
    command: z.string(),
    exitCode: z.number(),
  }),
  z.object({ ...base, event: z.literal("report_submitted"), status: z.string() }),
  z.object({ ...base, event: z.literal("report_rejected"), problems: z.array(z.string()) }),
  z.object({ ...base, event: z.literal("report_accepted"), status: z.string() }),
  z.object({
    ...base,
    event: z.literal("final_review"),
    verdict: FinalReviewVerdict,
    findings: z.array(z.string()),
  }),
  // Super-daddy's convergence verdict for a pass. The convergence log (convergence.jsonl)
  // is not streamed, so without this the reviewer's verdict never reaches the tail. §SUPER-DADDY.
  z.object({
    ...base,
    event: z.literal("super_review"),
    pass: z.number().int(),
    verdict: FinalReviewVerdict,
    findings: z.array(z.string()),
  }),
  z.object({ ...base, event: z.literal("ladder_step"), count: z.number().int() }),
  z.object({
    ...base,
    event: z.literal("parked"),
    reason: BlockedReason,
    question: z.string().optional(),
  }),
  z.object({ ...base, event: z.literal("committed"), sha: z.string(), message: z.string() }),
  z.object({ ...base, event: z.literal("driver_note"), note: z.string() }),
  z.object({
    ...base,
    event: z.literal("stall_recovery"),
    action: z.enum(["requeue", "escalate"]),
    stallRetries: z.number().int(),
  }),
  z.object({ ...base, event: z.literal("reorient"), attempt: z.number().int(), fix: z.string() }),
  z.object({
    ...base,
    event: z.literal("model_promoted"),
    from: z.string(),
    to: z.string(),
  }),
  // Super-daddy authored a follow-up repair packet. Persisted for EVERY attempt
  // (success and failure) so an authoring failure is diagnosable post-hoc — the
  // raw reply is otherwise discarded. `authoredRaw` is the full model reply.
  z.object({
    ...base,
    event: z.literal("authoring_attempt"),
    attempt: z.number().int(),
    ok: z.boolean(),
    problems: z.array(z.string()).default([]),
    authoredRaw: z.string(),
  }),
]);
export type JournalEvent = z.infer<typeof JournalEvent>;

// ---------------------------------------------------------------------------
// Journal event one-line renderings (CONTRACT §13)

export const renderJournalEvent = (e: JournalEvent): string => {
  const t = e.at.slice(11, 19);
  switch (e.event) {
    case "run_started":
      return `${t} ▶ run started (attempt ${e.attempt})`;
    case "prompt_sent":
      return `${t} → ${e.promptName}`;
    case "turn_ended":
      return `${t} ◀ turn ${e.turn ?? "?"} (${e.contextTokens} ctx tokens)${e.responseError ? ` ERROR: ${e.responseError.slice(0, 120)}` : ""}${e.text ? `\n   ${e.text.slice(0, 200).replace(/\n/g, "\n   ")}` : ""}`;
    case "turn_harvest_failed":
      return `${t} ✗ turn harvest failed: ${e.detail.slice(0, 160)}`;
    case "tool_call":
      return `${t}   ${e.gateDenied ? "⛔" : "·"} ${e.tool}${e.command ? ` ${e.command.slice(0, 80)}` : ""}${e.target ? ` ${e.target}` : ""}${e.status === "error" && !e.gateDenied ? " ✗" : ""}`;
    case "gate_latched":
      return `${t} ⛔ gate latched: ${e.reason}`;
    case "gate_cleared":
      return `${t} ✓ gate cleared`;
    case "checkpoint_volume_nudge":
      return `${t} 📣 checkpoint reminder: ${e.reason}`;
    case "planner_exchange":
      return `${t} ☎ [${e.status}] Q: ${e.question.slice(0, 120)}\n   A: ${e.answer.slice(0, 160)}${e.constraints.length ? `\n   constraints: ${e.constraints.join(" | ")}` : ""}`;
    case "outcomes_updated":
      return `${t} ☑ outcomes: ${e.outcomes.map((o) => `${o.id}=${o.status}`).join(", ")}`;
    case "checkpoint_written":
      return `${t} ⛳ checkpoint ${e.number} ${e.valid ? "valid" : `INVALID: ${e.problems.join("; ")}`}`;
    case "rotation":
      return `${t} ♻ rotation: ${e.phase}${e.contextTokens ? ` at ${e.contextTokens} tokens` : ""}`;
    case "verification_run":
      return `${t} ${e.exitCode === 0 ? "✅" : "❌"} verification: ${e.command} (exit ${e.exitCode})`;
    case "report_submitted":
      return `${t} 📋 report submitted: ${e.status}`;
    case "report_rejected":
      return `${t} 📋 report REJECTED: ${e.problems.join("; ")}`;
    case "report_accepted":
      return `${t} 📋 report accepted: ${e.status}`;
    case "final_review":
      return `${t} 🔍 final review [${e.verdict}]${e.findings.length ? `\n   ${e.findings.join("\n   ")}` : ""}`;
    case "super_review":
      return `${t} 🛡 super-daddy review pass ${e.pass} [${e.verdict}]${e.findings.length ? `\n   ${e.findings.join("\n   ")}` : ""}`;
    case "ladder_step":
      return `${t} ⚠ no-progress ladder: ${e.count}`;
    case "parked":
      return `${t} 🅿 parked (${e.reason})${e.question ? `: ${e.question.slice(0, 120)}` : ""}`;
    case "committed":
      return `${t} ⎇ committed ${e.sha.slice(0, 8)}`;
    case "driver_note":
      return `${t} ✎ ${e.note}`;
    case "stall_recovery":
      return `${t} ${e.action === "requeue" ? "↻" : "🅿"} stall ${e.action} (auto-retry ${e.stallRetries})`;
    case "reorient":
      return `${t} 🧭 reorient #${e.attempt} (Baby derailed) → fix: ${e.fix.slice(0, 120)}`;
    case "model_promoted":
      return `${t} ⬆ model promoted: ${e.from} → ${e.to}`;
    case "authoring_attempt":
      return `${t} ${e.ok ? "✍︎" : "✗"} follow-up authoring attempt ${e.attempt}${e.ok ? " admitted" : `: ${e.problems.join("; ")}`}`;
  }
};

export const isDriverEvent = (e: JournalEvent): boolean =>
  e.event !== "tool_call" && e.event !== "turn_ended" && e.event !== "prompt_sent";
