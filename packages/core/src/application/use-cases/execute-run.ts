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

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { TurnResponse } from "../../domain/agent-response.js";
import { priorReconciliationAccepted, rotationGateState } from "../../domain/gate-decisions.js";
import { initialGateState } from "../../domain/gate.js";
import { parsePacketShape } from "../../domain/packet.js";
import type { Packet } from "../../domain/packet.js";
import {
  q1InitialSeed,
  q2RotationSeed,
  q8ReconciliationSeed,
  q8ResumeSeed,
  renderDaddySeed,
} from "../../domain/prompts.js";
import { renderReportMarkdown } from "../../domain/report.js";
import { decideRunStart } from "../../domain/run.js";
import type { ExecuteRunCallback } from "./run-loop.js";
import {
  journal,
  buildHandoffInject,
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
  endRun: (ref: Ref, runId: string) => void;
};

type RunMetaPaths = { repo: string; worktree: string; base: string; branch: string };

const SETUP_KILL_GRACE_MS = 500;

const abortError = (): Error => {
  const error = new Error("setup command cancelled");
  error.name = "AbortError";
  return error;
};

const runSetupCommand = (
  command: string,
  worktree: string,
  dir: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> =>
  new Promise((resolvePromise, reject) => {
    const root = realpathSync(resolve(worktree));
    const cwd = realpathSync(resolve(root, dir));
    const fromRoot = relative(root, cwd);
    if (
      fromRoot === ".." ||
      fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(fromRoot)
    ) {
      reject(new Error(`setup command cwd escapes sandbox: ${dir}`));
      return;
    }

    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const child = spawn("/bin/zsh", ["-c", command], {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let terminationCause: "timeout" | "cancelled" | undefined;
    let settled = false;
    let exited = false;
    let termination: Promise<void> | undefined;

    const append = (chunk: Buffer): void => {
      output = `${output}${chunk.toString("utf8")}`.slice(-1_000);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const terminate = (cause: "timeout" | "cancelled"): void => {
      if (termination || !child.pid) {
        return;
      }
      if (!exited) {
        terminationCause = cause;
      }
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        return;
      }
      termination = new Promise((resolveTermination) => {
        const killTimer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL");
          } catch {
            // The process group already exited.
          } finally {
            resolveTermination();
          }
        }, SETUP_KILL_GRACE_MS);
        killTimer.unref();
      });
    };
    const onAbort = (): void => terminate("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
    timeout.unref();

    const finish = async (error?: Error): Promise<void> => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      await termination;
      if (terminationCause === "cancelled") {
        reject(abortError());
      } else if (terminationCause === "timeout") {
        reject(new Error(`setup command timed out: ${command}\n${output}`));
      } else if (error) {
        reject(new Error(`setup command failed: ${command}\n${output || error.message}`));
      } else {
        resolvePromise();
      }
    };

    child.once("error", (error) => void finish(error));
    child.once("exit", () => {
      exited = true;
    });
    child.once("close", (code, closeSignal) => {
      void finish(
        code === 0 && !closeSignal
          ? undefined
          : new Error(`exit ${code ?? closeSignal ?? "unknown"}`),
      );
    });
  });

const daddySessionIsStale = async (
  executor: RunPorts["executor"],
  sessionId: string,
): Promise<boolean> => {
  let messages: TurnResponse[];
  try {
    messages = await executor.listMessages(sessionId);
  } catch {
    return true;
  }

  return messages.some((m) => m.info.role === "assistant" && !m.info.error && m.parts.length === 0);
};

const replaceStaleDaddySession = async (
  ports: RunPorts,
  packet: Packet,
  worktree: string,
  staleSessionId: string,
): Promise<string> => {
  const { executor, planner } = ports;
  try {
    await executor.abortSession(staleSessionId);
  } catch {
    /* best effort: a stuck or already-dead session should not block recovery */
  }
  try {
    await executor.deleteSession(staleSessionId);
  } catch {
    /* best effort: stale session cleanup is not required for correctness */
  }

  return planner.handshake(renderDaddySeed(packet.raw), worktree);
};

export const makeExecuteRun =
  <Ref>(ports: RunPorts, bridge: BridgeBinding<Ref>): ExecuteRunCallback<Ref> =>
  async (runId, runMeta, ref, _clock, signal): Promise<void> => {
    // Snapshot config for this run — configSource is refreshed by PUT /settings,
    // so each run sees the latest repos[*].seed, thresholds, etc.
    const config = ports.configSource.get();
    const { store, repo, executor, planner, clock } = ports;
    const { repo: repoPath, worktree, base, branch } = runMeta as RunMetaPaths;

    const priorMeta = store.readMetaIfExists(runId);
    const queuePacket = store.readQueuePacket(runId);

    // Decide whether this run resumes a prior session or starts fresh.
    const startDecision = decideRunStart(priorMeta);

    // Packet selection: read the current live run packet for this execution.
    const raw = queuePacket ?? "";
    const shape = parsePacketShape(raw, runId);
    if (!shape.ok) {
      if (priorMeta) {
        store.writeMeta({ ...priorMeta, status: "failed", updatedAt: clock.nowIso() });
      }
      return;
    }
    const packet = shape.packet;

    const isResume = startDecision.mode === "resume";
    const attempt = (priorMeta?.attempt ?? 0) + 1;

    if (!isResume) {
      // Fresh: clear stale resume artifacts from a prior session, then seed
      // fresh durable state so a later unchanged-packet pickup cannot resume
      // from pre-fresh checkpoint/decision/review state.
      store.clearResumeArtifacts(runId);
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

      // Seed non-tracked files (gitignored configs, test fixtures, fakes) that
      // the clone won't carry. Per-repo, config-driven — not packet-coupled.
      const seed = config.repos[repoPath]?.seed;
      if (seed) {
        for (const rel of seed.copies) {
          const src = join(repoPath, rel);
          if (existsSync(src)) {
            const dst = join(worktree, rel);
            mkdirSync(dirname(dst), { recursive: true });
            copyFileSync(src, dst);
          }
        }
        for (const [rel, content] of Object.entries(seed.writes)) {
          const dst = join(worktree, rel);
          mkdirSync(dirname(dst), { recursive: true });
          writeFileSync(dst, content);
        }
      }
      const setup = config.repos[repoPath]?.setup;
      if (setup) {
        for (const command of setup.commands) {
          journal(ports, runId, 0, {
            event: "driver_note",
            note: `setup: ${command.command}`,
          });
          await runSetupCommand(
            command.command,
            worktree,
            command.dir,
            config.thresholds.verificationTimeoutMs,
            signal,
          );
        }
      }
    } else {
      // Resume: REFRESH config-derived gate fields (cadence + mutation patterns)
      // from current config; preserve run-state (phase, baseline,
      // lastAcceptedDecisionAt).
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

    if (signal?.aborted) {
      throw abortError();
    }

    // Daddy: ONE session for the run's whole life (M6). The adapter creates a
    // fresh one or resumes the prior session that already holds the packet.
    let daddySessionId: string;
    if (isResume && priorMeta?.daddySessionId) {
      if (await daddySessionIsStale(executor, priorMeta.daddySessionId)) {
        journal(ports, runId, 0, {
          event: "driver_note",
          note: `replacing stale Daddy session ${priorMeta.daddySessionId}`,
        });
        daddySessionId = await replaceStaleDaddySession(
          ports,
          packet,
          worktree,
          priorMeta.daddySessionId,
        );
        journal(ports, runId, 0, {
          event: "driver_note",
          note: `replacement Daddy session ${daddySessionId}`,
        });
      } else {
        daddySessionId = await planner.resumeSession(priorMeta.daddySessionId);
      }
    } else {
      daddySessionId = await planner.handshake(renderDaddySeed(packet.raw), worktree);
    }
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
      campaignId: priorMeta?.campaignId,
      pass: priorMeta?.pass ?? 1,
      stallRetries: priorMeta?.stallRetries ?? 0,
      crashRetries: priorMeta?.crashRetries ?? 0,
      reorientRetries: priorMeta?.reorientRetries ?? 0,
      reviewerUnreachable: priorMeta?.reviewerUnreachable ?? 0,
      // Carry the strong-model promotion across the requeue/resume — turn-loop
      // reads this to start on the promoted model.
      promoted: priorMeta?.promoted ?? false,
      babyModel: priorMeta?.babyModel,
      startedAt: priorMeta?.startedAt ?? clock.nowIso(),
      updatedAt: clock.nowIso(),
    });
    store.addActiveRun({
      runId,
      runDir: dirname(worktree),
      worktree,
      babySessionId,
      startedAt: clock.nowIso(),
    });
    journal(ports, runId, 0, { event: "run_started", runId, attempt });

    // Seed choice: fresh → Q1; resume with a checkpoint → Q2; resume without
    // but prior reconciliation was accepted → Q8b (skip redundant recon);
    // resume without and no prior accepted recon → Q8 with gate latched (O6).
    let seed: Seed;
    if (!isResume) {
      seed = { name: "Q1", text: q1InitialSeed(packet, store.readLedger(runId)) };
    } else {
      const checkpoint = store.latestCheckpoint(runId);
      const decisions = store.readDecisions(runId);
      if (checkpoint) {
        seed = {
          name: "Q2",
          text: q2RotationSeed(
            packet,
            store.readLedger(runId),
            checkpoint,
            store.readReviewState(runId),
            decisions,
          ),
        };
      } else if (priorReconciliationAccepted(decisions)) {
        // Prior reconciliation was accepted — skip redundant reconciliation.
        // Gate re-latches for first-edit only (not reconciliation).
        const { next } = rotationGateState(store.readGateState(runId), false);
        store.writeGateState(runId, next);
        seed = {
          name: "Q8b",
          text: q8ResumeSeed(
            packet,
            store.readLedger(runId),
            store.readReviewState(runId),
            decisions,
          ),
        };
      } else {
        const { next } = rotationGateState(store.readGateState(runId), true);
        store.writeGateState(runId, next);
        seed = {
          name: "Q8",
          text: q8ReconciliationSeed(
            packet,
            store.readLedger(runId),
            store.readReviewState(runId),
            decisions,
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
      injectText = buildHandoffInject(raw);
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
      result = await turnLoop(
        ports,
        packet,
        worktree,
        babySessionId,
        channel,
        seed,
        deadlineMs,
        signal,
      );
    } finally {
      bridge.endRun(ref, packet.runId);
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

  const sha = repo.wipCommit(worktree, `lathe: WIP ${runId} [${outcome.status}]`);
  if (sha) {
    journal(ports, runId, 0, {
      event: "committed",
      sha,
      message: `lathe: WIP ${runId} [${outcome.status}]`,
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

  store.removeActiveRun(runId);
};
