// The bridge: the driver's MCP face (CONTRACT §9). One HTTP endpoint, five
// tools, run identity ambient (M2). Every verdict is persisted before the tool
// result returns (S2 carried); accepted decisions clear the gate synchronously
// because the bridge IS the driver (v1 X2 made impossible).

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { z } from "zod"
import {
  QuestionType,
  OutcomeStatus,
  SubmitReport,
  BlockedReason,
  ACCEPTED_STATUSES,
  type Config,
} from "./schemas.js"
import {
  type RunContext,
  journal,
  readLedger,
  writeLedger,
  readReviewState,
  replaceObligations,
  appendDecision,
  readDecisions,
  readMetaIfExists,
  writeMeta,
  checkpointProblems,
  writeCheckpoint,
  nextCheckpointNumber,
} from "./runtime.js"
import { readJsonl } from "./fsio.js"
import { JournalEvent as JournalEventSchema } from "./schemas.js"
import { renderPlannerQuestion, parsePlannerResponse, tryParsePlannerResponse, diagnosePlannerParse, jsonReaskNudge, type DriverFacts } from "./planner.js"
import { renderFinalReview, parseFinalReview } from "./final-review.js"
import { readGateState, clearGate } from "./gate.js"
import { readDiffStats, reviewableDiff } from "./git.js"
import { runVerification, outcomeProblems, classifyChangedFiles, toVerificationClaims } from "./verification.js"
import type { FinalReview, PlannerResponse, AskPlannerInput } from "./schemas.js"
import type { TurnResponse } from "./opencode.js"
import { nowIso } from "./fsio.js"

// V7: cap the inlined diff so a large run can't blow Daddy's context. He has
// read-only repo tools and is told to inspect the real tree past this floor.
const FINAL_REVIEW_DIFF_CAP = 64 * 1024

// V7: the one non-mechanical acceptance check. Reached only after the
// mechanical floor passed (caller guards on problems.length === 0), so this can
// only ever withhold or escalate — never grant. Reuses the run's single Daddy
// session; fails closed to request_changes on an unreachable planner. Run by the
// DRIVER off the MCP request path (submit_report defers via ctx.pendingFinalReview)
// — a multi-minute Daddy call held inside the tool result would be cancelled by
// opencode's MCP client at ~5min, the same failure that crashed ask_planner.
export const runFinalReview = async (ctx: RunContext, report: SubmitReport): Promise<FinalReview> => {
  const ledger = readLedger(ctx.paths, ctx.packet.runId)
  const prompt = renderFinalReview(ctx.packet, reviewableDiff(ctx.worktree, FINAL_REVIEW_DIFF_CAP), ledger, report)
  const daddyModel = { providerId: ctx.config.daddy.providerId, modelId: ctx.config.daddy.modelId, agent: ctx.config.daddy.agent }

  let review: FinalReview
  try {
    const response = await ctx.client.sendMessage(ctx.daddySessionId, prompt, daddyModel, ctx.config.daddy.timeoutMs)
    const raw = response.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n")
    review = parseFinalReview(raw)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    review = {
      verdict: "request_changes",
      findings: [`final review unavailable: ${detail} — retry meridian-bridge_submit_report`],
      notes: "planner unreachable",
      human_decision_needed: null,
    }
  }

  appendDecision(ctx.paths, ctx.packet.runId, {
    timestamp: nowIso(),
    source: "daddy",
    questionType: "final_review",
    question: "final review (V7)",
    evidence: [],
    status: review.verdict,
    answer: review.notes,
    constraints: review.findings,
  })
  journal(ctx, { event: "final_review", verdict: review.verdict, findings: review.findings })
  return review
}

// The ask_planner consult, run by the DRIVER off the MCP request path (S2, M2).
// ask_planner only SUBMITS (the bridge records ctx.pendingConsult and returns at
// once); the driver calls this at the turn boundary, where the Daddy call is a
// plain opencode request on daddy.timeoutMs with no MCP client to cancel it at
// ~5min. Persists the decision, and on an accepted status clears the gate and
// replaces the obligation list; raises a park on stop / human_required — exactly
// what the inline handler used to do. Returns the verdict, or null when the
// consult could not reach Daddy (transport failure, distinct from a stop verdict).
export const runPlannerConsult = async (
  ctx: RunContext,
  submission: AskPlannerInput,
): Promise<{ planner: PlannerResponse } | { error: string }> => {
  const review = readReviewState(ctx.paths, ctx.packet.runId)
  const meta = readMetaIfExists(ctx.paths, ctx.packet.runId)
  const journalEvents = readJsonl(ctx.paths.journalFile(ctx.packet.runId), JournalEventSchema)
  const ledger = readLedger(ctx.paths, ctx.packet.runId)
  const facts: DriverFacts = {
    attempt: meta?.attempt ?? 1,
    rotations: journalEvents.filter((e) => e.event === "rotation" && e.phase === "session_replaced").length,
    ledgerSummary: ledger.outcomes.map((o) => `${o.id}=${o.status}`).join(", "),
  }
  const prompt = renderPlannerQuestion(
    submission.questionType,
    submission.currentSlice,
    submission.question,
    submission.approach,
    submission.evidence,
    review,
    facts,
  )
  const daddyModel = { providerId: ctx.config.daddy.providerId, modelId: ctx.config.daddy.modelId, agent: ctx.config.daddy.agent }
  const textOf = (r: TurnResponse): string =>
    r.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n")

  let planner: PlannerResponse
  let messageId: string | undefined
  try {
    const response = await ctx.client.sendMessage(ctx.daddySessionId, prompt, daddyModel, ctx.config.daddy.timeoutMs)
    messageId = response.info.id
    const firstText = textOf(response)
    let parsed = tryParsePlannerResponse(firstText)
    // A parse miss is usually a verbose model burying or truncating the JSON —
    // re-ask once with the concrete reason before failing closed to a stop (M4).
    if (parsed === null) {
      const reason = diagnosePlannerParse(firstText)
      journal(ctx, { event: "driver_note", note: `planner reply did not parse (${reason}) — re-asking once for JSON only` })
      const retry = await ctx.client.sendMessage(ctx.daddySessionId, jsonReaskNudge(reason), daddyModel, ctx.config.daddy.timeoutMs)
      messageId = retry.info.id
      parsed = tryParsePlannerResponse(textOf(retry))
    }
    planner = parsed ?? parsePlannerResponse("")
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    journal(ctx, { event: "driver_note", note: `ask_planner consult failed: ${detail}` })
    return { error: detail }
  }

  // Persist BEFORE returning (S2): ledger always; obligations and gate only on
  // accepted statuses (M5, G5).
  appendDecision(ctx.paths, ctx.packet.runId, {
    timestamp: nowIso(),
    source: "daddy",
    questionType: submission.questionType,
    currentSlice: submission.currentSlice,
    question: submission.question,
    approach: submission.approach,
    evidence: submission.evidence,
    status: planner.status,
    answer: planner.answer,
    constraints: planner.constraints,
    messageId,
  })

  if (ACCEPTED_STATUSES.includes(planner.status)) {
    // M4: a proceed supersedes a transient stop (Daddy's stops are usually "I
    // can't answer right now"; once he answers, the earlier stop is moot). A
    // human_decision park is NEVER auto-cleared: only Max can lift that.
    if (ctx.parkRequest?.reason === "stop_condition") {
      journal(ctx, { event: "driver_note", note: "planner proceed supersedes an earlier stop — clearing the pending park" })
      ctx.parkRequest = undefined
    }
    replaceObligations(ctx.paths, ctx.packet.runId, planner.constraints)
    const gate = readGateState(ctx.paths, ctx.packet.runId)
    if (gate) {
      clearGate(ctx.paths, gate, ctx.worktree)
      journal(ctx, { event: "gate_cleared", decisionAt: nowIso() })
    }
    // A reseeded Baby that earns an accepted decision has recovered, so the
    // reorient counter measures CONSECUTIVE derails-without-progress — the
    // misfire tripwire, not a lifetime total. Reset it here.
    const meta = readMetaIfExists(ctx.paths, ctx.packet.runId)
    if (meta && (meta.reorientRetries ?? 0) > 0) {
      writeMeta(ctx.paths, { ...meta, reorientRetries: 0 })
    }
  }

  if (planner.status === "human_required" || planner.status === "stop") {
    ctx.parkRequest = {
      reason: planner.status === "human_required" ? "human_decision" : "stop_condition",
      question: planner.human_decision_needed ?? planner.answer,
    }
  }

  journal(ctx, {
    event: "planner_exchange",
    questionType: submission.questionType,
    question: submission.question,
    status: planner.status,
    answer: planner.answer,
    constraints: planner.constraints,
    evidence_used: planner.evidence_used,
    safe_next_action: planner.safe_next_action,
    human_decision_needed: planner.human_decision_needed,
  })

  return { planner }
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] })
const errorText = (t: string) => ({ content: [{ type: "text" as const, text: t }], isError: true as const })

// The current run, set by the driver before each run starts. Runs are strictly
// sequential (R1), so a single mutable ref is the whole registry.
export type CurrentRunRef = { current: RunContext | undefined }

const buildMcpServer = (ref: CurrentRunRef): McpServer => {
  const server = new McpServer({ name: "meridian-bridge", version: "2.0.0" })

  const requireRun = (): RunContext => {
    const ctx = ref.current
    if (!ctx) throw new Error("No active run. The bridge only serves the run the driver is currently executing.")
    return ctx
  }

  server.tool(
    "ask_planner",
    "Ask the planner (Daddy) a scoped question tied to the current slice. Returns a structured decision. human_required and stop are hard stops.",
    {
      questionType: QuestionType.describe("Category of the question."),
      currentSlice: z.string().min(1).describe("The implementation unit you are working on."),
      question: z.string().min(1).describe("The narrow, scoped question."),
      approach: z
        .string()
        .min(1)
        .describe(
          "Your implementation approach for this slice: every design decision you have already made or are about to make (representations, strategies, structure), plus your intended next steps. The planner reviews this, not just the question — withholding a decision here means implementing it unreviewed.",
        ),
      evidence: z.array(z.string()).min(1).describe("Concrete evidence: file paths, snippets, error text."),
    },
    async (input) => {
      const ctx = requireRun()
      // M2: argument failures must be visible. The SDK validates shapes before
      // this handler, but content-level emptiness slips through — and an
      // invisible rejection reads as "planner unreachable" to the executor.
      const argProblems: string[] = []
      if (!input.question.trim()) argProblems.push("question is empty")
      if (!input.currentSlice.trim()) argProblems.push("currentSlice is empty")
      if (!input.approach.trim()) argProblems.push("approach is empty — state your design decisions and intended next steps")
      if (input.evidence.every((e) => !e.trim())) argProblems.push("evidence is empty")
      if (argProblems.length > 0) {
        journal(ctx, { event: "driver_note", note: `ask_planner rejected: ${argProblems.join("; ")}` })
        return errorText(JSON.stringify({ error: "invalid meridian-bridge_ask_planner call", problems: argProblems }))
      }

      // Async (CONTRACT §9): the consult takes minutes, but opencode's MCP client
      // cancels a tool-call held open that long (~5min) — which surfaced as a
      // spurious "planner unavailable" and crashed runs mid-think. So the bridge
      // does NOT run the consult here: it records the submission and returns at
      // once. The driver runs the Daddy call off the MCP request path (its own 1h
      // budget) at the next turn boundary and delivers the verdict in Baby's next
      // prompt (runPlannerConsult → qPlannerDecision). A second ask while one is
      // already queued is a no-op hold, not a stall.
      if (ctx.pendingConsult) {
        return text(
          JSON.stringify({
            status: "already_submitted",
            instruction:
              "Your planner question is already queued. STOP and end your turn — Daddy's decision arrives in your next prompt. Do not ask again.",
          }),
        )
      }
      ctx.pendingConsult = {
        questionType: input.questionType,
        currentSlice: input.currentSlice,
        question: input.question,
        approach: input.approach,
        evidence: input.evidence,
      }
      journal(ctx, { event: "driver_note", note: `ask_planner submitted (${input.questionType}) — consult deferred to the driver` })
      return text(
        JSON.stringify({
          status: "submitted",
          instruction:
            "Planner consult submitted. STOP now and end your turn — do not call more tools and do not improvise an answer. Daddy's decision will arrive in your next prompt.",
        }),
      )
    },
  )

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
    async (input) => {
      const ctx = requireRun()
      const ledger = readLedger(ctx.paths, ctx.packet.runId)
      const problems: string[] = []

      for (const update of input.outcomes) {
        const entry = ledger.outcomes.find((o) => o.id === update.id)
        if (!entry) {
          problems.push(`unknown outcome id: ${update.id}`)
          continue
        }
        if (update.status === "done" && (!update.evidence || update.evidence.length === 0) && entry.evidence.length === 0) {
          problems.push(`outcome ${update.id} cannot be done without evidence (O2)`)
          continue
        }
        entry.status = update.status
        if (update.evidence) entry.evidence = update.evidence
        if (update.state !== undefined) entry.state = update.state
        if (update.nextAction !== undefined) entry.nextAction = update.nextAction
        entry.updatedAt = nowIso()
      }

      if (problems.length > 0) return errorText(JSON.stringify({ ok: false, problems }))

      writeLedger(ctx.paths, ledger)
      journal(ctx, {
        event: "outcomes_updated",
        outcomes: ledger.outcomes.map((o) => ({ id: o.id, status: o.status })),
      })
      return text(JSON.stringify({ ok: true, outcomes: ledger.outcomes.map((o) => ({ id: o.id, status: o.status })) }))
    },
  )

  server.tool(
    "write_checkpoint",
    "Write the rotation checkpoint for your successor. Supply only your subjective state — a prose summary of where the work stands and what comes next, plus any uncertainties a successor must not assume. The driver records WHICH outcomes are at what status (from the ledger) and WHICH files changed (from the diff); you don't restate them. Keep the ledger current via meridian-bridge_update_outcomes BEFORE you checkpoint so the snapshot is accurate.",
    {
      summary: z
        .string()
        .min(1)
        .describe("Plain prose a successor can act on: what is done, what is half-done and how, what the precise next action is, and why you made the decisions you made."),
      uncertainties: z.array(z.string()).optional().describe("Things a successor must NOT assume — open questions, fragile spots, decisions you are unsure about."),
    },
    async (input) => {
      const ctx = requireRun()
      const ledger = readLedger(ctx.paths, ctx.packet.runId)
      // Assembled from durable state — the executor supplies only prose. The
      // outcome block IS the ledger; the file list IS the diff. A structure
      // built from its own source of truth cannot diverge from it.
      const checkpoint = {
        number: nextCheckpointNumber(ctx.paths, ctx.packet.runId),
        reason: "rotation",
        summary: input.summary,
        outcomes: ledger.outcomes.map((o) => ({
          id: o.id,
          status: o.status,
          evidence: o.evidence,
          ...(o.state !== undefined ? { state: o.state } : {}),
          ...(o.nextAction !== undefined ? { nextAction: o.nextAction } : {}),
        })),
        // Untracked-aware (same source as the report's table and the gate):
        // worktree files are uncommitted until finalize, so a tracked-only
        // `git diff HEAD` would report none. The successor must see what exists.
        filesChanged: Object.keys(readDiffStats(ctx.worktree)).sort().map((path) => ({ path })),
        filesInspected: [],
        uncertainties: input.uncertainties ?? [],
        writtenAt: nowIso(),
      }

      const problems = checkpointProblems(checkpoint, ctx.packet, ledger)
      journal(ctx, { event: "checkpoint_written", number: checkpoint.number, valid: problems.length === 0, problems })

      if (problems.length > 0) {
        ctx.checkpointBounceCount += 1
        return errorText(
          JSON.stringify({
            ok: false,
            problems,
            note:
              ctx.checkpointBounceCount > ctx.config.thresholds.checkpointBounceLimit
                ? "bounce limit exceeded — the run will park if the next checkpoint is also invalid"
                : "fix these and call meridian-bridge_write_checkpoint again",
          }),
        )
      }

      writeCheckpoint(ctx.paths, ctx.packet.runId, checkpoint)
      ctx.checkpointWrittenThisTurn = checkpoint
      ctx.checkpointBounceCount = 0
      return text(JSON.stringify({ ok: true, number: checkpoint.number }))
    },
  )

  server.tool(
    "submit_report",
    "Submit the final report — the ONLY way a run reaches a terminal status. Supply your terminal DECISION (status) and your subjective account in prose; the driver records the objective facts itself — which files changed (from the diff), which outcomes are done (from the ledger), and the verification results (the driver runs the commands). Do not restate those. ready_for_review is accepted only if the driver's own verification is green and every outcome is done; if not, submit blocked or failed and say why.",
    {
      status: z.enum(["ready_for_review", "blocked", "failed"]),
      blockedReason: BlockedReason.optional(),
      blockedQuestion: z.string().optional().describe("For blocked: the exact decision only Max can make."),
      summary: z.string().min(1).describe("Your account of what you did and why — the narrative of the work, in prose."),
      behaviourChanged: z.array(z.string()).optional().describe("How system behaviour changed, in your words — interpretation a diff cannot show."),
      sourceOfTruthFollowed: z.array(z.string()).optional().describe("The guidance/spec/decisions you followed."),
      escalations: z.array(z.string()).optional().describe("Anything you escalated or think Max should know."),
      remainingUncertainty: z.array(z.string()).optional().describe("What you remain unsure about."),
    },
    async (input) => {
      const ctx = requireRun()
      // A re-submit while the deferred final review is still running is a no-op
      // hold (the driver is mid-review off the MCP path) — do not re-run it.
      if (ctx.pendingFinalReview) {
        return text(
          JSON.stringify({
            status: "review_pending",
            instruction:
              "Your report's final review is already running. STOP and end your turn — the result arrives in your next prompt.",
          }),
        )
      }
      const ledger = readLedger(ctx.paths, ctx.packet.runId)

      // V1: the driver runs verification ITSELF, up front for ready_for_review —
      // one run feeds BOTH the acceptance gate and the report's verification
      // block. The executor never supplies verification outcomes (its claims are
      // worth nothing structurally); these are real exit codes from the worktree,
      // after all mutations by construction.
      const verificationResults =
        input.status === "ready_for_review"
          ? runVerification(ctx.packet.frontmatter, ctx.worktree, ctx.config.thresholds.verificationTimeoutMs)
          : []
      for (const r of verificationResults) {
        journal(ctx, { event: "verification_run", command: r.command, exitCode: r.exitCode })
      }

      // Assembled from durable state + the executor's belief-prose. The objective
      // blocks — files changed, outcome claims, verification — are the driver's
      // own observation of the tree, ledger, and command runs, NOT the executor's
      // word. The executor owns only its account (summary, behaviour, uncertainty)
      // and the terminal decision (status).
      const report = SubmitReport.parse({
        status: input.status,
        ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason } : {}),
        ...(input.blockedQuestion !== undefined ? { blockedQuestion: input.blockedQuestion } : {}),
        summary: input.summary,
        filesChanged: classifyChangedFiles(
          ctx.worktree,
          ctx.packet.frontmatter.expected_surface,
          ctx.packet.frontmatter.suspicious_surface,
        ),
        behaviourChanged: input.behaviourChanged ?? [],
        sourceOfTruthFollowed: input.sourceOfTruthFollowed ?? [],
        outcomeClaims: ledger.outcomes.map((o) => ({ id: o.id, status: o.status })),
        verificationClaims: toVerificationClaims(verificationResults),
        escalations: input.escalations ?? [],
        remainingUncertainty: input.remainingUncertainty ?? [],
      })

      journal(ctx, { event: "report_submitted", status: report.status })

      const problems: string[] = []
      if (report.status === "blocked" && (!report.blockedReason || !report.blockedQuestion)) {
        problems.push("blocked reports must carry blockedReason and blockedQuestion — Max needs the exact decision")
      }
      problems.push(...outcomeProblems(report, ledger))
      // A latched gate means an unresolved planner obligation (reconciliation,
      // checkpoint, out-of-surface): terminal SUCCESS requires a clear gate.
      // blocked/failed stay submittable — parking must always be possible.
      const gate = readGateState(ctx.paths, ctx.packet.runId)
      if (report.status === "ready_for_review" && gate?.latched) {
        problems.push(
          `the gate is latched (${gate.latchReason ?? "planner checkpoint required"}) — ready_for_review requires a clear gate: call meridian-bridge_ask_planner and continue only on proceed`,
        )
      }
      // The files-changed table is built from the diff above (V6 completeness is
      // structural — it cannot omit a changed file). Verification failures from
      // the driver's own run are the acceptance gate (V1).
      for (const r of verificationResults) {
        if (r.exitCode !== 0) {
          problems.push(`verification failed (exit ${r.exitCode}): ${r.command}\n  output: ${r.outputTail.slice(-200)}`)
        }
      }

      // The mechanical floor (V1/V6): the driver's own verification + outcome +
      // gate checks. A failure here rejects synchronously — no planner needed.
      if (problems.length > 0) {
        ctx.reportRejectionCount += 1
        ctx.reportRejectionProblems = problems
        journal(ctx, { event: "report_rejected", problems })
        return errorText(JSON.stringify({ ok: false, problems }))
      }

      // V7: the mechanical floor passed. ready_for_review now needs Daddy's final
      // review — the one non-mechanical acceptance check. Like ask_planner it is a
      // multi-minute Daddy call, so it must NOT run in this handler (opencode's MCP
      // client would cancel the held-open tool-call at ~5min). Defer it: record the
      // report and return; the driver runs the review off the MCP path and resolves
      // the run (accept → finalize, request_changes → re-prompt, escalate → park).
      if (report.status === "ready_for_review") {
        ctx.pendingFinalReview = report
        return text(
          JSON.stringify({
            status: "review_pending",
            instruction:
              "Report received and the mechanical floor is green. Daddy's final review runs now — STOP and end your turn; the result (accept, requested changes, or escalation) arrives in your next prompt.",
          }),
        )
      }

      // blocked / failed with a clean floor: terminal immediately, no review.
      ctx.acceptedReport = report
      journal(ctx, { event: "report_accepted", status: report.status })
      return text(JSON.stringify({ ok: true, status: report.status, note: "Report accepted. The driver will finalize the run." }))
    },
  )

  server.tool(
    "get_decisions",
    "Read prior planner and Max decisions for this run.",
    { limit: z.number().int().min(1).max(100).optional() },
    async (input) => {
      const ctx = requireRun()
      const decisions = readDecisions(ctx.paths, ctx.packet.runId)
      return text(JSON.stringify({ decisions: decisions.slice(-(input.limit ?? 20)) }, null, 2))
    },
  )

  return server
}

// Stateless StreamableHTTP: a fresh transport per POST avoids request-id
// collisions and session bookkeeping; the MCP client (opencode) re-initializes
// cheaply.
export const startBridgeServer = (config: Config, ref: CurrentRunRef): Server => {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end()
      return
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }),
      )
      return
    }
    try {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf-8")) : undefined

      const server = buildMcpServer(ref)
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
      res.on("close", () => {
        void transport.close()
        void server.close()
      })
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
            id: null,
          }),
        )
      }
    }
  })
  // ask_planner holds a request open for as long as Daddy thinks; node's
  // default requestTimeout (300s) would kill it mid-verdict.
  httpServer.requestTimeout = 0
  httpServer.timeout = 0
  return httpServer
}

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
      )
    })
    httpServer.listen(config.opencode.bridgePort, "127.0.0.1", () => resolve())
  })
