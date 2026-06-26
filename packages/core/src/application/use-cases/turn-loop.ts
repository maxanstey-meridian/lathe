// ---------------------------------------------------------------------------
// The turn loop (CONTRACT §6 L1, ARCHITECTURE §4 — the keystone, executed)
//
// gather → evaluate → execute. After each send the loop GATHERS the turn's
// facts (drain the bridge intent channel, read gate/tokens/progress, compute
// the deadline + nudge via the Clock), calls the PURE `evaluateTurn`, then
// EXECUTES the returned `TurnDecision` through the ports. Nothing here decides —
// the eleven-branch precedence lives in `evaluateTurn`; the loop body is only
// effects. Reads top-to-bottom as the per-turn lifecycle it owns.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { babyContextBudget } from "../../config/config.js";
import type { Config } from "../../config/schemas.js";
import { extractText, extractReasoning, gateDeniedPart } from "../../domain/agent-response.js";
import type { TurnResponse, MessagePart } from "../../domain/agent-response.js";
import { diffDelta } from "../../domain/gate-classification.js";
import {
  gateTriggerReason,
  volumeCheckpointReason,
  checkpointNudgeDue,
  clearedGateState,
  relatchGate,
  priorReconciliationAccepted,
} from "../../domain/gate-decisions.js";
import { checkReorientBound } from "../../domain/liveness.js";
import type { Packet } from "../../domain/packet.js";
import {
  q2RotationSeed,
  q3Continue,
  q4CheckpointDemand,
  q5TeardownDemand,
  q6ReportProperly,
  q7ReportRejected,
  q8ReconciliationSeed,
  q8ResumeSeed,
  qReorientSeed,
  ladderNudge,
  softCheckpointNudge,
  qPlannerDecision,
  qPlannerUnavailable,
} from "../../domain/prompts.js";
import type { SubmitReport } from "../../domain/report.js";
import { ACCEPTED_STATUSES } from "../../domain/review.js";
import type { FinalReview } from "../../domain/review.js";
import { evaluateTurn } from "../../domain/turn.js";
import type { ModelConfig } from "../ports/executor.js";
import { rotateSession } from "./rotation.js";
import {
  journal,
  buildHandoffInject,
  type RunPorts,
  type RunChannel,
  type RunOutcome,
  type TurnLoopResult,
  type Seed,
} from "./run-runtime.js";

// ---------------------------------------------------------------------------
// Turn facts assembly: message text, reasoning, tool calls, context tokens.
// ---------------------------------------------------------------------------

type TurnObservations = {
  text: string;
  contextTokens: number;
  hadAllowedToolCall: boolean;
  toolCalls: number;
};

// opencode's POST /message returns only the FINAL assistant message's parts, so
// a turn that ends on text hides every earlier-step tool call (the L2 scar).
// Re-fetch the whole session and take every part since the previous turn's final
// message; on a fresh/rotated session lastSeen is absent → findIndex -1 →
// slice(0) → all messages. Fall back to the response parts if the list fails.
const collectTurnParts = async (
  ports: RunPorts,
  sessionId: string,
  lastSeenMessageId: string | undefined,
  response: TurnResponse,
): Promise<MessagePart[]> => {
  try {
    const messages = await ports.executor.listMessages(sessionId);
    const start = lastSeenMessageId
      ? messages.findIndex((m) => m.info.id === lastSeenMessageId) + 1
      : 0;
    const parts = messages.slice(start).flatMap((m) => m.parts);
    return parts.length > 0 ? parts : response.parts;
  } catch {
    return response.parts;
  }
};

// Journal the turn's tool calls + the turn_ended summary; return the progress
// signal the gather step feeds to evaluateTurn. A non-bridge tool call that was
// allowed and did not error is the primary progress signal (L2/L3).
const journalTurn = (
  ports: RunPorts,
  runId: string,
  turn: number,
  response: TurnResponse,
  turnParts: MessagePart[],
): TurnObservations => {
  const text = extractText(response);
  const reasoning = extractReasoning(response);
  const tokens = response.info.tokens ?? {};
  const contextTokens = (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.output ?? 0);

  let hadAllowedToolCall = false;
  let toolCalls = 0;

  for (const part of turnParts) {
    if (part.type !== "tool") {
      continue;
    }
    const denied = gateDeniedPart(part);
    if (!(part.tool ?? "").toLowerCase().includes("meridian-bridge")) {
      toolCalls += 1;
    }
    const status = part.state?.status === "error" ? ("error" as const) : ("completed" as const);
    const command =
      typeof part.state?.input?.command === "string" ? part.state.input.command : undefined;
    const target =
      typeof part.state?.input?.filePath === "string"
        ? part.state.input.filePath
        : typeof part.state?.input?.path === "string"
          ? part.state.input.path
          : undefined;
    const metadataExit = part.state?.metadata?.exit;
    const exitCode =
      typeof metadataExit === "number" ? metadataExit : status === "completed" ? 0 : 1;

    if (!denied && status !== "error") {
      hadAllowedToolCall = true;
    }

    journal(ports, runId, turn, {
      event: "tool_call",
      tool: part.tool ?? "unknown",
      ...(part.callID !== undefined ? { callId: part.callID } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(target !== undefined ? { target } : {}),
      status,
      exitCode,
      ...(part.state?.output ? { outputPreview: part.state.output.slice(0, 300) } : {}),
      gateDenied: denied,
    });
  }

  journal(ports, runId, turn, {
    event: "turn_ended",
    messageId: response.info.id,
    tokens: {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cacheRead: tokens.cache?.read ?? 0,
      cacheWrite: tokens.cache?.write ?? 0,
    },
    contextTokens,
    text: text.slice(0, 2000),
    ...(reasoning ? { reasoning: reasoning.slice(0, 1000) } : {}),
  });

  return { text, contextTokens, hadAllowedToolCall, toolCalls };
};

// A prose "all done" without submit_report → the report-properly nudge (Q6).
const looksLikeProseFinish = (text: string): boolean =>
  /\b(ready for (human )?review|implementation (is )?complete|all outcomes (are )?done|task (is )?complete)\b/i.test(
    text,
  );

// Pick the rotation/resume seed from durable state: latest checkpoint → Q2
// (gate clears on the new session's first accepted decision); no checkpoint but
// the last decision was an accepted reconciliation → Q8b (skip redundant recon);
// otherwise → Q8 reconciliation (the gate stacks reconciliation). If a handoff
// artifact exists on disk, prepend an inject message to the seed and set awaitingVerification.
// Returns whether reconciliation is needed so the caller can set the matching gate (O5/O6).

const reseedFromCheckpoint = (
  ports: RunPorts,
  packet: Packet,
  worktree: string,
): { seed: Seed; needsReconciliation: boolean; handoffInjected: boolean } => {
  const runId = packet.runId;
  const ledger = ports.store.readLedger(runId);
  const review = ports.store.readReviewState(runId);
  const decisions = ports.store.readDecisions(runId);
  const checkpoint = ports.store.latestCheckpoint(runId);

  const reconAccepted = priorReconciliationAccepted(decisions);
  let seedText: string;
  let seedName: string;
  if (checkpoint) {
    seedName = "Q2";
    seedText = q2RotationSeed(packet, ledger, checkpoint, review, decisions);
  } else if (reconAccepted) {
    seedName = "Q8b";
    seedText = q8ResumeSeed(packet, ledger, review, decisions);
  } else {
    seedName = "Q8";
    seedText = q8ReconciliationSeed(packet, ledger, review, decisions);
  }

  // Handoff inject: if the predecessor wrote handoff.json, prepend a system
  // message so the recycled baby calls verify_handoff first.
  let injectText = "";
  try {
    const runDir = dirname(worktree);
    const handoffPath = join(runDir, "handoff.json");
    const raw = readFileSync(handoffPath, "utf-8");
    injectText = buildHandoffInject(raw);
  } catch {
    /* no handoff — graceful degradation */
  }
  if (injectText) {
    seedName = `${seedName}+handoff`;
    seedText = `${injectText}\n\n${seedText}`;
  }

  return {
    seed: { name: seedName, text: seedText },
    needsReconciliation: !checkpoint && !reconAccepted,
    handoffInjected: injectText.length > 0,
  };
};

// ---------------------------------------------------------------------------
// Model helpers — baby's normal model and the promoteTo fallback.

export const babyModelConfig = (config: Config): ModelConfig => ({
  providerId: config.baby.providerId,
  modelId: config.baby.modelId,
  agent: config.baby.agent,
});

// The promoted (strong) model: baby's promoteTo override if set, else daddy's
// configured model — so promotion can't drift onto a stale/unavailable model
// when daddy is reconfigured. The agent stays "baby"; only inference changes.
export const promotedModelConfig = (config: Config): ModelConfig => ({
  providerId: config.baby.promoteTo?.providerId ?? config.daddy.providerId,
  modelId: config.baby.promoteTo?.modelId ?? config.daddy.modelId,
  agent: config.baby.agent,
});

export const promotedModelLabel = (config: Config): string => {
  const m = promotedModelConfig(config);
  return `${m.providerId}/${m.modelId}`;
};

// ---------------------------------------------------------------------------
// turnLoop — run one attempt to a terminal outcome.
//
// `channel` is the bridge's per-turn intent channel (the keystone seam): the
// bridge records intents into it during a send; the loop drains them after.
// ---------------------------------------------------------------------------

export const turnLoop = async (
  ports: RunPorts,
  packet: Packet,
  worktree: string,
  babySessionId: string,
  channel: RunChannel,
  seed: Seed,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<TurnLoopResult> => {
  const { config, store, repo, executor, planner, clock } = ports;
  const runId = packet.runId;
  // Run Baby's harness on Daddy's model from turn 1 — same task, stronger engine —
  // when this run is already promoted. Two persisted sources: a promoted follow-up
  // packet (the convergence cap escape hatch, in frontmatter) OR a stall-cap/
  // review-reject promotion latched in meta and carried across the requeue.
  // Otherwise we start on Baby's normal model and may still promote mid-loop below.
  let promoted = packet.frontmatter.promoted || (store.readMetaIfExists(runId)?.promoted ?? false);
  let babyModel = promoted ? promotedModelConfig(config) : babyModelConfig(config);
  const contextBudget = babyContextBudget(config);

  let next = seed;
  let sessionId = babySessionId;
  let turn = 0;
  let ladder = 0;
  let sendFailures = 0;
  // Previous turn's measured context — lets the dead-session guard tell a
  // recoverable overflow (real context was in flight) from a dead reseed.
  let priorContextTokens = 0;
  let rotationPending = false;
  let toolCallsSinceDecision = 0;
  let lastSeenMessageId: string | undefined;
  let acceptedReport: SubmitReport | undefined;
  let finalReview: FinalReview | undefined;

  const finish = (outcome: RunOutcome): TurnLoopResult => ({
    outcome,
    ...(acceptedReport ? { acceptedReport } : {}),
    ...(finalReview ? { finalReview } : {}),
  });

  const climb = (): void => {
    ladder += 1;
    journal(ports, runId, turn, { event: "ladder_step", count: ladder });
  };

  // Surface a packet-level promotion the same way the mid-loop promotion is logged,
  // so the tail shows this whole pass running on Daddy's model from the first turn.
  if (promoted) {
    journal(ports, runId, turn, {
      event: "model_promoted",
      from: `${config.baby.providerId}/${config.baby.modelId}`,
      to: promotedModelLabel(config),
    });
  }

  for (;;) {
    turn += 1;
    channel.turn = turn;

    // Snapshot the worktree before the turn (cheap diff fallback for progress
    // when the message-list fetch loses earlier-step tool calls).
    const diffBefore = JSON.stringify(repo.readDiffStats(worktree));
    // Clear the per-turn channel: the bridge fills it during the send.
    channel.intents = [];

    journal(ports, runId, turn, {
      event: "prompt_sent",
      promptName: next.name,
      preview: next.text.slice(0, 200),
    });

    channel.turnComplete = false;

    let response: TurnResponse;
    try {
      response = await executor.sendMessage(
        sessionId,
        next.text,
        babyModel,
        config.baby.timeoutMs,
        signal,
      );
      sendFailures = 0;
    } catch (err) {
      // Signal-aborted by caller (supervisor.abortRun) — terminate the run
      // immediately, NOT as a dead-session failure (the opencode adapter fires
      // req.destroy with a plain Error, not AbortError).
      if (signal?.aborted) {
        return finish({ status: "aborted" });
      }
      // A dead/timed-out turn is the crash path (R10): rotate to a fresh session
      // via reconciliation (O6) once; a second consecutive failure parks wedged.
      sendFailures += 1;
      const detail = err instanceof Error ? err.message : String(err);
      journal(ports, runId, turn, {
        event: "driver_note",
        note: `turn send failed (${sendFailures}): ${detail}`,
      });
      if (sendFailures >= 2) {
        return finish({
          status: "blocked",
          reason: "wedged",
          question:
            "Two consecutive executor turns failed to complete (model/session failure). See journal.",
        });
      }
      const {
        seed: reseed,
        needsReconciliation,
        handoffInjected,
      } = reseedFromCheckpoint(ports, packet, worktree);
      sessionId = await rotateSession(
        ports,
        packet,
        worktree,
        sessionId,
        turn,
        needsReconciliation,
      );
      next = reseed;
      if (handoffInjected) {
        channel.awaitingVerification = true;
      }
      continue;
    }

    // --- gather --------------------------------------------------------------
    const turnParts = await collectTurnParts(ports, sessionId, lastSeenMessageId, response);
    lastSeenMessageId = response.info.id;
    const obs = journalTurn(ports, runId, turn, response, turnParts);
    toolCallsSinceDecision += obs.toolCalls;

    const intents = channel.intents;
    const worktreeChanged = JSON.stringify(repo.readDiffStats(worktree)) !== diffBefore;
    const gate = store.readGateState(runId);
    const delta = diffDelta(gate.baselineDiffStats, repo.readDiffStats(worktree));
    const gateReason = gate.latched
      ? (gate.latchReason ?? "planner checkpoint required")
      : gateTriggerReason(gate, delta);
    const softNudgeDue =
      checkpointNudgeDue(gate, clock.now(), config.thresholds.checkpointNudgeMs) !== undefined;

    const decision = evaluateTurn({
      bridgeIntents: intents,
      watchdogPastDeadline: clock.now() >= deadlineMs,
      contextTokens: obs.contextTokens,
      contextBudget,
      contextTokensFloor: config.thresholds.contextTokensFloor,
      priorContextTokens,
      isFirstTurn: turn === 1,
      gateDemandsCheckpoint: gateReason !== undefined,
      gateReason,
      hadAllowedToolCall: obs.hadAllowedToolCall,
      worktreeChanged,
      rotationPending,
      checkpointBounceCount: channel.checkpointBounceCount,
      checkpointBounceLimit: config.thresholds.checkpointBounceLimit,
      sendFailureCount: sendFailures,
      reportRejectionCount: channel.reportRejectionCount,
      reportRejectionParkAt: config.thresholds.reportRejectionParkAt,
      ladder,
      ladderRotateAt: config.thresholds.ladderRotateAt,
      ladderParkAt: config.thresholds.ladderParkAt,
      softNudgeDue,
    });

    // Carry this turn's context into the next iteration BEFORE any branch
    // continues/returns — the dead-session guard reads it as priorContextTokens.
    priorContextTokens = obs.contextTokens;

    // --- execute -------------------------------------------------------------
    switch (decision.kind) {
      case "watchdog": {
        const minutes = Math.round(config.thresholds.maxRunMs / 60000);
        journal(ports, runId, turn, {
          event: "driver_note",
          note: `run watchdog: attempt exceeded ${minutes}min without finishing — parking wedged`,
        });
        return finish({
          status: "blocked",
          reason: "wedged",
          question: `Attempt ran ${minutes}min without reaching a terminal state (livelock watchdog, §5 R10). See journal.`,
        });
      }

      case "park":
        return finish({ status: "blocked", reason: decision.reason, question: decision.question });

      case "terminal": {
        if (decision.status === "failed") {
          return finish({ status: "failed", note: decision.note ?? "" });
        }
        if (decision.status === "blocked") {
          return finish({
            status: "blocked",
            reason: decision.reason ?? "stop_condition",
            question: decision.question ?? decision.note ?? "",
          });
        }
        // ready_for_review via a report-accepted intent: the bridge routes
        // ready_for_review through the final-review path, so this is unreachable
        // live — resolve it defensively without a render payload.
        return finish({ status: "ready_for_review" });
      }

      case "reject_report":
        next = { name: "Q7", text: q7ReportRejected(decision.problems) };
        continue;

      case "run_consult": {
        const submission = channel.pendingConsult;
        channel.pendingConsult = null;
        if (!submission) {
          next = { name: "Q3", text: q3Continue() };
          continue;
        }

        let plannerResponse;
        try {
          plannerResponse = await planner.consult(submission);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          journal(ports, runId, turn, {
            event: "driver_note",
            note: `ask_planner consult failed: ${detail}`,
          });
          next = { name: "Qp-fail", text: qPlannerUnavailable(detail) };
          continue;
        }

        // Persist BEFORE acting (S2); an answered consult is progress, so the
        // no-progress ladder and the volume tally reset in lockstep.
        store.appendDecision(runId, {
          timestamp: clock.nowIso(),
          source: "daddy",
          questionType: submission.questionType,
          currentSlice: submission.currentSlice,
          question: submission.question,
          approach: submission.approach,
          evidence: submission.evidence,
          status: plannerResponse.status,
          answer: plannerResponse.answer,
          constraints: plannerResponse.constraints,
        });
        journal(ports, runId, turn, {
          event: "planner_exchange",
          questionType: submission.questionType,
          question: submission.question,
          status: plannerResponse.status,
          answer: plannerResponse.answer,
          constraints: plannerResponse.constraints,
          evidence_used: plannerResponse.evidence_used,
          safe_next_action: plannerResponse.safe_next_action,
          human_decision_needed: plannerResponse.human_decision_needed,
        });
        ladder = 0;
        toolCallsSinceDecision = 0;

        if (ACCEPTED_STATUSES.some((s) => s === plannerResponse.status)) {
          store.replaceObligations(runId, plannerResponse.constraints);
          const g = store.readGateState(runId);
          store.writeGateState(
            runId,
            clearedGateState(g, repo.readDiffStats(worktree), clock.nowIso()),
          );
          journal(ports, runId, turn, { event: "gate_cleared", decisionAt: clock.nowIso() });
          const meta = store.readMeta(runId);
          if ((meta.reorientRetries ?? 0) > 0) {
            store.writeMeta({ ...meta, reorientRetries: 0, updatedAt: clock.nowIso() });
          }
          next = { name: "Qp", text: qPlannerDecision(plannerResponse) };
          continue;
        }

        if (plannerResponse.status === "reorient") {
          const meta = store.readMeta(runId);
          const used = meta.reorientRetries ?? 0;
          if (!checkReorientBound(used, config.thresholds.maxReorientRetries).allowed) {
            return finish({
              status: "blocked",
              reason: "human_decision",
              question: `Baby derailed and was reoriented ${used}× but kept drifting — needs Max. Last fix offered: ${plannerResponse.safe_next_action}`,
            });
          }
          store.writeMeta({ ...meta, reorientRetries: used + 1, updatedAt: clock.nowIso() });
          journal(ports, runId, turn, {
            event: "reorient",
            attempt: used + 1,
            fix: plannerResponse.safe_next_action,
          });
          sessionId = await rotateSession(ports, packet, worktree, sessionId, turn, true);
          const ledger = store.readLedger(runId);
          const review = store.readReviewState(runId);
          const decisions = store.readDecisions(runId);
          next = {
            name: "Q9",
            text: qReorientSeed(packet, ledger, review, decisions, plannerResponse),
          };
          continue;
        }

        if (plannerResponse.status === "human_required" || plannerResponse.status === "stop") {
          return finish({
            status: "blocked",
            reason:
              plannerResponse.status === "human_required" ? "human_decision" : "stop_condition",
            question: plannerResponse.human_decision_needed ?? plannerResponse.answer,
          });
        }

        // revise_slice (or any other non-accepted, non-terminal status): hand the
        // verdict back and let Baby revise.
        next = { name: "Qp", text: qPlannerDecision(plannerResponse) };
        continue;
      }

      case "run_final_review": {
        const report = channel.pendingFinalReview;
        channel.pendingFinalReview = null;
        if (!report) {
          next = { name: "Q3", text: q3Continue() };
          continue;
        }
        const ledger = store.readLedger(runId);
        let review: FinalReview;
        try {
          review = await planner.finalReview(packet, ledger, report);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          review = {
            verdict: "request_changes",
            findings: [`final review unavailable: ${detail} — retry meridian-bridge_submit_report`],
            notes: "planner unreachable",
            human_decision_needed: null,
          };
        }
        store.appendDecision(runId, {
          timestamp: clock.nowIso(),
          source: "daddy",
          questionType: "final_review",
          question: "final review (V7)",
          evidence: [],
          status: review.verdict,
          answer: review.notes,
          constraints: review.findings,
        });
        journal(ports, runId, turn, {
          event: "final_review",
          verdict: review.verdict,
          findings: review.findings,
        });

        if (review.verdict === "escalate") {
          return finish({
            status: "blocked",
            reason: "human_decision",
            question:
              review.human_decision_needed ??
              review.notes ??
              "Final review escalated a decision to Max.",
          });
        }
        if (review.verdict === "request_changes") {
          channel.reportRejectionCount += 1;
          const problems = review.findings.map((f) => `final review: ${f}`);
          journal(ports, runId, turn, { event: "report_rejected", problems });
          if (channel.reportRejectionCount >= config.thresholds.reportRejectionParkAt) {
            // Promotion: daddy rejected baby's report reportRejectionParkAt times.
            // Swap to the promoteTo model (a bigger inference engine under baby's
            // harness) and give baby one more set of retries. Ephemeral — the next
            // run starts fresh on baby's normal model. Only fires once per run.
            if (!promoted && config.thresholds.promoteAtCap) {
              promoted = true;
              babyModel = promotedModelConfig(config);
              channel.reportRejectionCount = 0;
              // Latch the promotion in meta so it survives any later requeue and a
              // subsequent stall escalates instead of re-promoting (one per run).
              const pm = store.readMetaIfExists(runId);
              if (pm) {
                store.writeMeta({ ...pm, promoted: true, updatedAt: clock.nowIso() });
              }
              journal(ports, runId, turn, {
                event: "model_promoted",
                from: `${config.baby.providerId}/${config.baby.modelId}`,
                to: promotedModelLabel(config),
              });
              const {
                seed: reseed,
                needsReconciliation,
                handoffInjected,
              } = reseedFromCheckpoint(ports, packet, worktree);
              sessionId = await rotateSession(
                ports,
                packet,
                worktree,
                sessionId,
                turn,
                needsReconciliation,
              );
              next = reseed;
              if (handoffInjected) {
                channel.awaitingVerification = true;
              }
              continue;
            }
            return finish({
              status: "failed",
              note: `report rejected ${channel.reportRejectionCount} times; last problems: ${problems.join("; ")}`,
            });
          }
          next = { name: "Q7", text: q7ReportRejected(problems) };
          continue;
        }
        // accept → terminal ready_for_review (rendered into report.md at finalize).
        acceptedReport = report;
        finalReview = review;
        journal(ports, runId, turn, { event: "report_accepted", status: report.status });
        return finish({ status: "ready_for_review" });
      }

      case "rotate": {
        // checkpoint !== null: the teardown turn produced a valid checkpoint →
        // rotate with it. checkpoint === null: no-progress rotate → the ladder
        // climbed first, NOT reset (a Baby still narrating marches to the park
        // backstop). Both reseed from the latest durable checkpoint (Q2/Q8).
        if (decision.checkpoint !== null) {
          rotationPending = false;
        } else {
          climb();
          journal(ports, runId, turn, {
            event: "rotation",
            phase: "no_progress",
            contextTokens: obs.contextTokens,
          });
        }
        const {
          seed: reseed,
          needsReconciliation,
          handoffInjected,
        } = reseedFromCheckpoint(ports, packet, worktree);
        sessionId = await rotateSession(
          ports,
          packet,
          worktree,
          sessionId,
          turn,
          needsReconciliation,
        );
        next = reseed;
        if (handoffInjected) {
          channel.awaitingVerification = true;
        }
        continue;
      }

      case "recover_overflow": {
        // A working session's request overflowed the server's context window
        // (opencode returns an empty completion on the 4xx). Recover by rotating
        // to a fresh session that reseeds LOW — Q2 from the latest durable
        // checkpoint, else Q8 worktree reconciliation; the worktree (committed +
        // uncommitted work) survives the rotation, so progress is not lost. No
        // ladder climb: the wall was the window, not a stall. If the reseed
        // itself overflows, the next turn lands at 0 with priorContextTokens 0,
        // which falls through to the dead-session park — so this cannot spin.
        journal(ports, runId, turn, {
          event: "rotation",
          phase: "context_overflow",
          contextTokens: priorContextTokens,
        });
        const {
          seed: reseed,
          needsReconciliation,
          handoffInjected,
        } = reseedFromCheckpoint(ports, packet, worktree);
        sessionId = await rotateSession(
          ports,
          packet,
          worktree,
          sessionId,
          turn,
          needsReconciliation,
        );
        next = reseed;
        if (handoffInjected) {
          channel.awaitingVerification = true;
        }
        continue;
      }

      case "re_demand_teardown":
        climb();
        next = { name: "Q5", text: q5TeardownDemand(store.readLedger(runId)) };
        continue;

      case "demand_teardown":
        rotationPending = true;
        journal(ports, runId, turn, {
          event: "rotation",
          phase: "teardown_demanded",
          contextTokens: obs.contextTokens,
        });
        next = { name: "Q5", text: q5TeardownDemand(store.readLedger(runId)) };
        continue;

      case "demand_gate_checkpoint": {
        climb();
        const g = store.readGateState(runId);
        if (!g.latched) {
          store.writeGateState(runId, relatchGate(g, decision.reason));
          journal(ports, runId, turn, { event: "gate_latched", reason: decision.reason });
        }
        next = {
          name: "Q4",
          text: q4CheckpointDemand(decision.reason, store.readReviewState(runId)),
        };
        continue;
      }

      case "nudge":
        climb();
        next = looksLikeProseFinish(obs.text)
          ? { name: "Q6", text: q6ReportProperly() }
          : { name: "ladder", text: ladderNudge(ladder) };
        continue;

      case "continue": {
        ladder = 0;
        // Volume reminder visibility (§10): journal a visible event when work
        // crosses the interval so it appears in the tail.
        const volumeReason = volumeCheckpointReason(
          toolCallsSinceDecision,
          diffDelta(gate.baselineDiffStats, repo.readDiffStats(worktree)),
          config.thresholds,
        );
        if (volumeReason) {
          journal(ports, runId, turn, {
            event: "checkpoint_volume_nudge",
            reason: volumeReason,
            toolCalls: toolCallsSinceDecision,
          });
        }

        const mins = checkpointNudgeDue(gate, clock.now(), config.thresholds.checkpointNudgeMs);
        next =
          mins !== undefined
            ? { name: "Q3", text: softCheckpointNudge(mins) }
            : { name: "Q3", text: q3Continue() };
        continue;
      }
    }
  }
};
