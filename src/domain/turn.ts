import { z } from "zod"
import { BlockedReason } from "./run.js"
import { stallAction } from "./liveness.js"

// ---------------------------------------------------------------------------
// Bridge intent (CONTRACT §9, ARCHITECTURE §2.2/§4)
//
// The bridge records typed intents into a per-turn channel.
// The turn loop reads and drains the channel after the send returns.
// These are the ONLY things the bridge can communicate per-turn.
// ---------------------------------------------------------------------------

export const BridgeIntent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("park"), reason: BlockedReason, question: z.string() }),
  z.object({ kind: z.literal("consult-requested") }),
  z.object({ kind: z.literal("final-review-requested") }),
  z.object({ kind: z.literal("report-rejected"), problems: z.array(z.string()) }),
  z.object({ kind: z.literal("checkpoint-written"), checkpoint: z.object({ number: z.number(), reason: z.string(), summary: z.string() }) }),
  z.object({
    kind: z.literal("report-accepted"),
    status: z.enum(["ready_for_review", "failed", "blocked"]),
    blockedReason: BlockedReason.optional(),
    blockedQuestion: z.string().optional(),
    summary: z.string(),
  }),
  z.object({ kind: z.literal("outcomes-updated") }),
])
export type BridgeIntent = z.infer<typeof BridgeIntent>

// ---------------------------------------------------------------------------
// Turn facts (ARCHITECTURE §2.2/§4)
//
// Everything observable at turn end. Bridge signals are derived from
// bridgeIntents — no duplicate scalar fields for acceptedReportStatus,
// pendingConsult, pendingFinalReview, reportRejectionProblems, or
// checkpointWrittenThisTurn.
//
// TurnFacts.ladder is the current (pre-increment) ladder value.
// Ladder-climbing branches compute with (ladder+1) internally.
// ---------------------------------------------------------------------------

export const TurnFacts = z.object({
  // Bridge signal: drained from bridgeIntents scan (see evaluateTurn)
  bridgeIntents: z.array(BridgeIntent),

  // Watchdog (branch 1): past the attempt deadline?
  watchdogPastDeadline: z.boolean(),

  // Context budget (branch 8): measured tokens vs threshold
  contextTokens: z.number(),
  contextBudget: z.number(),

  // Dead-session guard (complementary to branch 7 send-failure path):
  // floor of acceptable context tokens; first-turn exempt.
  contextTokensFloor: z.number(),
  isFirstTurn: z.boolean(),

  // Gate state (branch 9): demands checkpoint (latched OR triggered)
  gateDemandsCheckpoint: z.boolean(),
  gateReason: z.string().optional(),

  // Progress detection (branch 10): allowed tool call AND/OR worktree diff AND/OR checkpoint written
  hadAllowedToolCall: z.boolean(),
  worktreeChanged: z.boolean(),

  // Rotation in-flight (branch 7)
  rotationPending: z.boolean(),
  checkpointBounceCount: z.number(),
  checkpointBounceLimit: z.number(),

  // Send failure count (transport crash path, application-layer handled)
  sendFailureCount: z.number(),

  // Report rejection (branch 4)
  reportRejectionCount: z.number(),
  reportRejectionParkAt: z.number(),

  // Ladder (branch 10)
  ladder: z.number(),
  ladderRotateAt: z.number(),
  ladderParkAt: z.number(),

  // Soft checkpoint nudge (branch 11 — L1 continuation)
  softNudgeDue: z.boolean(),
})

// ---------------------------------------------------------------------------
// Turn decision — 12-arm discriminated union (ARCHITECTURE §2.2/§4)
//
// Mirrors the eleven CONTRACT §6 L1 branches. Each arm carries exactly the
// payload the application layer needs to execute the decision's effect.
// TS collapses same-discriminant variants, so park and rotate each have one
// declaration with the broadest payload type.
// ---------------------------------------------------------------------------

export type TurnDecision =
  // 1. Watchdog past attempt deadline → park wedged
  | { kind: "watchdog" }

  // 2/7b/10c. Park requested by bridge (planner human_required/stop),
  // rotation bounce at limit, or no-progress parked via ladder.
  | { kind: "park"; reason: z.infer<typeof BlockedReason>; question: string }

  // 3. Accepted report → terminal (READY_FOR_REVIEW, FAILED, BLOCKED)
  // Branch 4-at-cap also emits this arm.
  | {
      kind: "terminal"
      status: "ready_for_review" | "failed" | "blocked"
      reason?: z.infer<typeof BlockedReason>
      question?: string
      note?: string
    }

  // 4. Report rejected (`problems` in facts); app layer sends Q7
  | { kind: "reject_report"; problems: string[] }

  // 5. Pending consult → application runs off-MCP Daddy consult
  | { kind: "run_consult" }

  // 6. Pending final review → application runs off-MCP Daddy review
  | { kind: "run_final_review" }

  // 7a. Rotation in-flight with checkpoint written → rotate with checkpoint (Q2 seed)
  // 10a/7c. No-progress rotate / rotation in-flight without checkpoint →
  //         rotate without checkpoint (seeds Q2 if checkpoint available, Q8 if not)
  | { kind: "rotate"; checkpoint: { number: number } | null }

  // 7c. Rotation in-flight with no checkpoint written, under bound →
  //     re-demand teardown Q5, ladder climbs
  | { kind: "re_demand_teardown" }

  // 8. Context budget reached → teardown Q5
  | { kind: "demand_teardown" }

  // 9. Gate latched/triggers → checkpoint Q4
  | { kind: "demand_gate_checkpoint"; reason: string }

  // 10c. Nudge on no progress (stallAction returned nudge)
  | { kind: "nudge" }

  // 11. Otherwise → continue; softNudgeDue prefixes Q3 with the soft reminder
  | { kind: "continue"; softNudgeDue: boolean }

// ---------------------------------------------------------------------------
// evaluateTurn (ARCHITECTURE §2.2/§4 — the keystone)
//
// PURE function: facts in, decision out. No I/O, no clock call.
// Encodes exactly the eleven CONTRACT §6 L1 branches in first-match-wins
// order. The tests ARE the encoded branch order.
// ---------------------------------------------------------------------------

type Dec = TurnDecision

export const evaluateTurn = (facts: z.infer<typeof TurnFacts>): Dec => {
  const {
    bridgeIntents,
    watchdogPastDeadline,
    contextTokens,
    contextBudget,
    contextTokensFloor,
    isFirstTurn,
    gateDemandsCheckpoint,
    gateReason,
    hadAllowedToolCall,
    worktreeChanged,
    rotationPending,
    checkpointBounceCount,
    checkpointBounceLimit,
    reportRejectionCount,
    reportRejectionParkAt,
    ladder,
    ladderRotateAt,
    ladderParkAt,
    sendFailureCount,
    softNudgeDue,
  } = facts

  // Derive bridge signals from bridgeIntents scan
  let parkRequest: { reason: z.infer<typeof BlockedReason>; question: string } | null = null
  let pendingConsult = false
  let pendingFinalReview = false
  let reportRejectedProblems: string[] | null = null
  // checkpointWritten is the extracted checkpoint data (not the full intent).
  // null when no checkpoint-written intent was delivered this turn.
  let checkpointWritten: { number: number; reason: string; summary: string } | null = null
  let acceptedReport: { status: "ready_for_review" | "failed" | "blocked"; reason?: z.infer<typeof BlockedReason>; question?: string; summary: string } | null = null

  for (const intent of bridgeIntents) {
    switch (intent.kind) {
      case "park":
        parkRequest = { reason: intent.reason, question: intent.question }
        break
      case "consult-requested":
        pendingConsult = true
        break
      case "final-review-requested":
        pendingFinalReview = true
        break
      case "report-rejected":
        reportRejectedProblems = intent.problems
        break
      case "checkpoint-written":
        checkpointWritten = intent.checkpoint
        break
      case "report-accepted":
        acceptedReport = {
          status: intent.status,
          reason: intent.blockedReason,
          question: intent.blockedQuestion,
          summary: intent.summary,
        }
        break
      // outcomes-updated: no turn-level signal; ignored in evaluateTurn
    }
  }

  // ---- Branch 1: Watchdog ----
  if (watchdogPastDeadline) {
    return { kind: "watchdog" }
  }

  // ---- Branch 2: Park requested by bridge ----
  if (parkRequest) {
    return { kind: "park", reason: parkRequest.reason, question: parkRequest.question }
  }

  // ---- Branch 3: Accepted report → terminal ----
  if (acceptedReport) {
    if (acceptedReport.status === "failed") {
      return { kind: "terminal", status: "failed", note: acceptedReport.summary }
    }
    if (acceptedReport.status === "blocked") {
      return {
        kind: "terminal",
        status: "blocked",
        reason: acceptedReport.reason ?? "stop_condition",
        question: acceptedReport.question ?? acceptedReport.summary,
      }
    }
    return { kind: "terminal", status: "ready_for_review", reason: acceptedReport.reason, question: acceptedReport.question }
  }

  // ---- Branch 4: Report rejected ----
  if (reportRejectedProblems) {
    if (reportRejectionCount >= reportRejectionParkAt) {
      // At cap → terminal failure (evaluateTurn checks internally)
      return {
        kind: "terminal",
        status: "failed",
        note: `report rejected ${reportRejectionCount} times; last problems: ${reportRejectedProblems.join("; ")}`,
      }
    }
    return { kind: "reject_report", problems: reportRejectedProblems }
  }

  // ---- Branch 5: Pending consult ----
  if (pendingConsult) {
    return { kind: "run_consult" }
  }

  // ---- Branch 6: Pending final review ----
  if (pendingFinalReview) {
    return { kind: "run_final_review" }
  }

  // ---- Branch 7: Rotation in flight ----
  if (rotationPending) {
    if (checkpointWritten !== null) {
      return { kind: "rotate", checkpoint: { number: checkpointWritten.number } }
    }
    if (checkpointBounceCount > checkpointBounceLimit) {
      return { kind: "park", reason: "wedged", question: "Rotation checkpoint bounced past the limit" }
    }
    // No checkpoint written, under bound — check ladder bound first
    const nextLadder = ladder + 1
    if (nextLadder >= ladderParkAt) {
      return { kind: "park", reason: "wedged", question: "Rotation teardown demanded repeatedly but write_checkpoint was never called" }
    }
    return { kind: "re_demand_teardown" }
  }

  // ---- Branch 8: Context budget reached ----
  if (contextTokens >= contextBudget) {
    return { kind: "demand_teardown" }
  }

  // ---- Branch 9: Gate latched/triggers ----
  if (gateDemandsCheckpoint) {
    const nextLadder = ladder + 1
    if (nextLadder >= ladderParkAt) {
      return { kind: "park", reason: "wedged", question: `Gate latched (${gateReason ?? "checkpoint required"}) and the executor did not reach ask_planner within ${nextLadder} turns` }
    }
    return { kind: "demand_gate_checkpoint", reason: gateReason ?? "checkpoint required" }
  }

  // ---- Dead-session guard (complementary to branch 7 send-failure path) ----
  // A send that returns but with an empty/near-zero prompt landing — the v2
  // reseed-dead-session scar. First-turn exempt (a fresh session always starts
  // with the full seed). Fires BEFORE the no-progress ladder so a dead landing
  // parks deliberately instead of spiralling up the ladder.
  if (!isFirstTurn && contextTokens < contextTokensFloor) {
    return { kind: "park", reason: "wedged", question: `Model received only ${contextTokens} context tokens (floor: ${contextTokensFloor}) — possible dead session` }
  }

  // ---- Branch 10: No progress → ladder action ----
  const hadProgress = hadAllowedToolCall || worktreeChanged || checkpointWritten !== null
  if (!hadProgress) {
    const nextLadder = ladder + 1
    const action = stallAction(nextLadder, ladderRotateAt, ladderParkAt)
    if (action === "park") {
      return { kind: "park", reason: "wedged", question: `${nextLadder} consecutive turns without an allowed tool call` }
    }
    if (action === "rotate") {
      return { kind: "rotate", checkpoint: null }
    }
    return { kind: "nudge" }
  }

  // ---- Branch 11: Continue (neutral) ----
  return { kind: "continue", softNudgeDue }
}
