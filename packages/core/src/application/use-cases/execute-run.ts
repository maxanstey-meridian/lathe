// ---------------------------------------------------------------------------
// Execute-run (CONTRACT R2, ARCHITECTURE §3.2)
//
// One run: freeze + init durable state (fresh) or refresh it (resume), create
// the self-rooted sandbox, init/refresh the gate, handshake the ONE Daddy
// session (M6), open a Baby session, choose the seed (fresh Q1 / resume-with-
// checkpoint Q2 / resume-without Q8 with the gate latched, O6), set the watchdog
// deadline, run the turn loop, finalize (WIP commit + report render + status).
//
// Returned as an ExecuteRunCallback the run-loop drains: it is a closure over
// the ports + the bridge binding, so the run-loop stays agnostic of the turn
// loop and the bridge's concrete Ref (the application cannot import the bridge).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { initialGateState } from "../../domain/gate.js";
import { parsePacketShape } from "../../domain/packet.js";
import type { Packet } from "../../domain/packet.js";
import {
  q1InitialSeed,
  q2RotationSeed,
  q8ReconciliationSeed,
  renderDaddySeed,
} from "../../domain/prompts.js";
import { renderReportMarkdown } from "../../domain/report.js";
import type { ExecuteRunCallback } from "./run-loop.js";
import {
  journal,
  type RunPorts,
  type RunChannel,
  type Seed,
  type TurnLoopResult,
} from "./run-runtime.js";
import { turnLoop } from "./turn-loop.js";

// The bridge binding the composition root provides: open the per-run intent
// channel on the bound Ref (the bridge stores it as its active run), and close
// it. The application names only the narrow RunChannel view; the concrete
// infrastructure ActiveRunRef is a structural superset, passed in with no cast.
export type BridgeBinding<Ref> = {
  beginRun: (ref: Ref, packet: Packet, worktree: string) => RunChannel;
  endRun: (ref: Ref) => void;
};

type RunMetaPaths = { repo: string; worktree: string; base: string; branch: string };

export const makeExecuteRun =
  <Ref>(ports: RunPorts, bridge: BridgeBinding<Ref>): ExecuteRunCallback<Ref> =>
  async (runId, runMeta, ref): Promise<void> => {
    const { store, repo, executor, planner, config, clock } = ports;
    const { repo: repoPath, worktree, base, branch } = runMeta as RunMetaPaths;

    // K3: re-validate at run start, fail closed even if the file changed.
    // Fresh queue entries have no frozen packet — fall back to the queue dir.
    const raw = store.readFrozenPacket(runId) || store.readQueuePacket(runId) || "";
    const shape = parsePacketShape(raw, runId);
    if (!shape.ok) {
      const prior = store.readMetaIfExists(runId);
      if (prior) {
        store.writeMeta({ ...prior, status: "failed", updatedAt: clock.nowIso() });
      }
      return;
    }
    const packet = shape.packet;

    const priorMeta = store.readMetaIfExists(runId);
    const isResume = priorMeta?.babySessionId !== undefined;
    const attempt = (priorMeta?.attempt ?? 0) + 1;

    if (!isResume) {
      // Fresh: freeze the validated packet + seed durable state (R2).
      store.freezePacket(runId, packet.raw);
      store.writeLedger(store.initialLedger(packet));
      store.replaceObligations(runId, []);
      store.writeGateState(
        runId,
        initialGateState(
          runId,
          packet.frontmatter.expected_surface,
          packet.frontmatter.suspicious_surface,
          {
            checkpointNudgeMs: config.thresholds.checkpointNudgeMs,
            checkpointToolCalls: config.thresholds.checkpointToolCalls,
            checkpointFiles: config.thresholds.checkpointFiles,
            checkpointLoc: config.thresholds.checkpointLoc,
            mutationCommandPatterns: config.mutationCommandPatterns,
          },
          clock.nowIso(),
        ),
      );
      // A self-rooted clone: opencode roots on the sandbox, never climbing a
      // worktree linkage back into the source repo. Resume reuses the sandbox.
      repo.createSandbox(repoPath, worktree, branch, base);
    } else {
      // Resume: REFRESH config-derived gate fields (cadence + mutation patterns)
      // from current config; preserve run-state (firstEditApproved, baseline,
      // lastAcceptedDecisionAt, reconciliation).
      const gate = store.readGateState(runId);
      store.writeGateState(runId, {
        ...gate,
        checkpointNudgeMs: config.thresholds.checkpointNudgeMs,
        checkpointToolCalls: config.thresholds.checkpointToolCalls,
        checkpointFiles: config.thresholds.checkpointFiles,
        checkpointLoc: config.thresholds.checkpointLoc,
        mutationCommandPatterns: config.mutationCommandPatterns,
      });
    }

    // Daddy: ONE session for the run's whole life (M6). The adapter creates a
    // fresh one or resumes the prior session that already holds the packet.
    const daddySessionId =
      isResume && priorMeta?.daddySessionId
        ? await planner.resumeSession(priorMeta.daddySessionId)
        : await planner.handshake(renderDaddySeed(packet.raw));
    const babySessionId = await executor.createSession(`baby:${runId}`, worktree);

    store.writeMeta({
      runId,
      status: "running",
      attempt,
      repo: repoPath,
      base,
      branch,
      worktree,
      summary: packet.frontmatter.summary,
      babySessionId,
      daddySessionId,
      stallRetries: priorMeta?.stallRetries ?? 0,
      reorientRetries: priorMeta?.reorientRetries ?? 0,
      reviewerUnreachable: priorMeta?.reviewerUnreachable ?? 0,
      startedAt: priorMeta?.startedAt ?? clock.nowIso(),
      updatedAt: clock.nowIso(),
    });
    store.writeActiveRun({
      runId,
      runDir: dirname(worktree),
      worktree,
      babySessionId,
      startedAt: clock.nowIso(),
    });
    journal(ports, runId, 0, { event: "run_started", runId, attempt });

    // Seed choice: fresh → Q1; resume with a checkpoint → Q2; resume without →
    // Q8 reconciliation, with the gate latched (O6).
    let seed: Seed;
    if (!isResume) {
      seed = { name: "Q1", text: q1InitialSeed(packet, store.readLedger(runId)) };
    } else {
      const checkpoint = store.latestCheckpoint(runId);
      if (checkpoint) {
        seed = {
          name: "Q2",
          text: q2RotationSeed(
            packet,
            store.readLedger(runId),
            checkpoint,
            store.readReviewState(runId),
            store.readDecisions(runId),
            repo.diffStat(worktree, base),
          ),
        };
      } else {
        const gate = store.readGateState(runId);
        store.writeGateState(runId, {
          ...gate,
          latched: true,
          reconciliationRequired: true,
          latchReason: "reconciliation required: no valid checkpoint from the previous session",
        });
        seed = {
          name: "Q8",
          text: q8ReconciliationSeed(
            packet,
            store.readLedger(runId),
            store.readReviewState(runId),
            store.readDecisions(runId),
            repo.diffStat(worktree, base),
          ),
        };
      }
    }

    // §5 R10 watchdog: a per-attempt wall-clock backstop for a livelock that
    // does something every turn yet never converges (the ladder catches a turn
    // that does nothing). On expiry the attempt parks wedged.
    const deadlineMs = clock.now() + config.thresholds.maxRunMs;

    // Handoff inject: if the predecessor wrote handoff.json, prepend a system
    // message so new baby reads it and calls verify_handoff first.
    const runDir = dirname(worktree);
    const handoffPath = join(runDir, "handoff.json");
    let injectText = "";
    try {
      const raw = readFileSync(handoffPath, "utf-8");
      const injected = `Predecessor handoff available: ${raw.slice(0, 2000)}. Call verify_handoff once you have read the packet and the handoff, before starting new work.`;
      injectText = injected;
    } catch {
      /* no handoff — graceful degradation, baby re-derives trust the old way */
    }
    if (injectText) {
      seed = { name: `${seed.name}+handoff`, text: `${injectText}\n\n${seed.text}` };
    }

    const channel = bridge.beginRun(ref, packet, worktree);
    if (injectText) {
      channel.awaitingVerification = true;
    }
    let result: TurnLoopResult;
    try {
      result = await turnLoop(ports, packet, worktree, babySessionId, channel, seed, deadlineMs);
    } finally {
      bridge.endRun(ref);
    }

    finalizeRun(ports, runId, worktree, result);
  };

// ---------------------------------------------------------------------------
// Finalize (R3/R5/R6): commit WIP, render the report on accept, write the
// terminal status. The run-loop reads the status back from meta.
// ---------------------------------------------------------------------------

const finalizeRun = (
  ports: RunPorts,
  runId: string,
  worktree: string,
  result: TurnLoopResult,
): void => {
  const { store, repo, clock } = ports;
  const { outcome } = result;

  const sha = repo.wipCommit(worktree, `meridian: WIP ${runId} [${outcome.status}]`);
  if (sha) {
    journal(ports, runId, 0, {
      event: "committed",
      sha,
      message: `meridian: WIP ${runId} [${outcome.status}]`,
    });
  }

  if (outcome.status === "ready_for_review" && result.acceptedReport) {
    const markdown = renderReportMarkdown(result.acceptedReport, runId, result.finalReview);
    store.writeReport(runId, result.acceptedReport, markdown);
  }

  const meta = store.readMeta(runId);
  if (outcome.status === "blocked") {
    journal(ports, runId, 0, {
      event: "parked",
      reason: outcome.reason,
      question: outcome.question,
    });
    store.writeMeta({
      ...meta,
      status: "blocked",
      blockedReason: outcome.reason,
      blockedQuestion: outcome.question,
      endedAt: clock.nowIso(),
      updatedAt: clock.nowIso(),
    });
  } else {
    if (outcome.status === "failed") {
      journal(ports, runId, 0, { event: "driver_note", note: outcome.note });
    }
    store.writeMeta({
      ...meta,
      status: outcome.status,
      endedAt: clock.nowIso(),
      updatedAt: clock.nowIso(),
    });
  }

  store.clearActiveRun();
};
