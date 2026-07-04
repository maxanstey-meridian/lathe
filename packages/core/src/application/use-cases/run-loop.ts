// ---------------------------------------------------------------------------
// Run loop (CONTRACT R1/R6/R8/R9/R10, X2)
//
// Composition root: procedural module that owns the driver lifecycle.
// Depends on BridgePort (the lock), domain decisions, and ports + callbacks.
// Reads top-to-bottom as the lifecycle (D1).
//
// Contract invariants enforced here:
//   R1  — bind bridge FIRST, before any state mutation (the single-driver lock)
//   R8  — recover orphaned `running` runs at startup
//   R10 — recover stranded `wedged` runs at startup
//   R6  — a `blocked` run parks and driver moves on
//   X2  — always-on: waits for work until ^C (first finishes step, second forces)
// ---------------------------------------------------------------------------

import type { Config } from "../../config/schemas.js";
import { decideStallRecovery, decideCrashRecovery } from "../../domain/liveness.js";
import type { StallRecoveryDecision } from "../../domain/liveness.js";
import type { BridgePort } from "../ports/bridge.js";
import type { Caffeinate } from "../ports/caffeinate.js";
import type { Clock } from "../ports/clock.js";
import type { Repo } from "../ports/repo.js";
import type { Store } from "../ports/store.js";
import { promoteStaged } from "./chain-promotion.js";
import { journal } from "./run-runtime.js";
import { promotedModelLabel } from "./turn-loop.js";

// ---------------------------------------------------------------------------
// Callback interfaces — owned by the caller (future CLI entry point or
// later packet). The run loop only orchestrates; it doesn't implement the
// turn loop or the executeRun lifecycle.
// ---------------------------------------------------------------------------

export type ExecuteRunCallback<Ref = unknown> = (
  runId: string,
  meta: { repo: string; worktree: string; base: string; branch: string },
  ref: Ref,
  clock: Clock,
  signal?: AbortSignal,
) => Promise<void>;

export type ConvergeCallback = (runId: string) => Promise<void>;

export type WaitForWorkCallback = (signal: AbortSignal) => Promise<void>;

// ---------------------------------------------------------------------------
// Entry point — the always-on driver loop
// ---------------------------------------------------------------------------

export type RunLoopSeams = {
  /** If present, wired to waitForWork and used as loop-exit condition. runLoop does NOT register a SIGINT handler. */
  readonly stopSignal?: AbortSignal;
  /** Per-run AbortController map keyed by runId. runLoop creates controllers and populates it; supervisor reads and fires them. */
  readonly abortMap?: Map<string, AbortController>;
};

export const runLoop = async <Ref>(
  config: Config,
  store: Store,
  repo: Repo,
  caffeinate: Caffeinate,
  clock: Clock,
  bridge: BridgePort<Ref>,
  executeRun: ExecuteRunCallback<Ref>,
  convergeStep: ConvergeCallback,
  waitForWork: WaitForWorkCallback,
  seams?: RunLoopSeams,
): Promise<void> => {
  // R1: bind the bridge port FIRST — the single-driver lock.
  // Must resolve before any call to store.readMetaIfExists, store.listRunIds,
  // or any other state read/write.
  const ref = await bridge.bind();

  // T3: hold the power assertion for the lifetime of the loop.
  await caffeinate.holdPowerAssertion();

  // Recovery sweeps — behind the lock, before draining.
  recoverOrphanedRuns(store, repo, clock);
  recoverStalledRunsAtStartup(
    store,
    config.thresholds.maxStallRetries,
    clock,
    config.thresholds.promoteAtCap,
  );

  // Chain promotion at startup.
  promoteStaged(store, repo);

  // --- Main loop ---
  const abortMap = seams?.abortMap ?? new Map<string, AbortController>();

  let stopRequested = false;
  let currentAbort: AbortController | undefined;
  let onSigint: (() => void) | undefined;

  // When an external stopSignal is provided (supervisor-owned), do NOT register
  // our own SIGINT handler — the supervisor owns process-signal handling.
  // Normalise both paths to stopRequested as the single loop-exit flag.
  if (seams?.stopSignal) {
    seams.stopSignal.addEventListener(
      "abort",
      () => {
        stopRequested = true;
      },
      { once: true },
    );
  } else {
    onSigint = () => {
      if (stopRequested) {
        process.exit(130);
      }
      stopRequested = true;
      currentAbort?.abort();
    };
    process.on("SIGINT" as NodeJS.Signals, onSigint);
  }

  try {
    while (!stopRequested) {
      // Drain the front of the queue FIRST (F2: requeued runs listed first).
      const queue = store.listQueue();
      if (queue.length > 0) {
        const first = queue[0];
        if (first) {
          const { runId } = first;

          // Update meta to running. For fresh queue entries (no meta file yet),
          // derive from the queue packet; if the packet vanished, skip.
          const meta = store.readMetaIfExists(runId) ?? store.initMetaFromQueue(runId);
          if (!meta) {
            continue;
          }
          store.writeMeta({ ...meta, status: "running" as const, updatedAt: clock.nowIso() });

          try {
            const runAbort = new AbortController();
            abortMap.set(runId, runAbort);
            await executeRun(
              runId,
              {
                repo: meta.repo,
                worktree: meta.worktree,
                base: meta.base,
                branch: meta.branch,
              },
              ref,
              clock,
              runAbort.signal,
            );
            abortMap.delete(runId);
          } catch (err: unknown) {
            // A crash: clear the active run pointer so it doesn't leak onto the
            // next queued run (X1). ^C-during-run is not a crash.
            if (!stopRequested) {
              store.removeActiveRun(runId);
            }
            // ^C-during-run is NOT a crash. A SIGINT tears down the opencode server,
            // which fails the in-flight turn send with a connection error that lands
            // right here — but the user asked to stop: leave the run RESUMABLE.
            if (stopRequested) {
              if (store.readMetaIfExists(runId)?.worktree) {
                repo.wipCommit(
                  store.readMetaIfExists(runId)!.worktree,
                  `lathe: WIP ${runId} [interrupted]`,
                );
              }
              store.writeMeta({
                ...store.readMeta(runId),
                status: "queued" as const,
                updatedAt: clock.nowIso(),
              });
              break;
            }

            // A real crash: consult the bounded crash-recovery decision.
            // Requeue under the cap (front of the line), escalate at the cap.
            const message = err instanceof Error ? err.message : String(err);
            const crashMeta = store.readMeta(runId);
            const crashedMeta = {
              ...crashMeta,
              status: "blocked" as const,
              blockedReason: "crashed" as const,
              blockedQuestion: `Driver-level failure: ${message}. See journal and opencode-serve.log.`,
              updatedAt: clock.nowIso(),
            };
            store.writeMeta(crashedMeta);
            const crashDecision = decideCrashRecovery(
              crashedMeta,
              config.thresholds.maxCrashRetries,
            );
            if (crashDecision.action === "requeue") {
              if (crashMeta.worktree) {
                repo.wipCommit(crashMeta.worktree, `lathe: WIP ${runId} [crashed]`);
              }
              store.writeMeta({
                ...crashedMeta,
                status: "queued" as const,
                crashRetries: crashDecision.crashRetries,
                blockedReason: undefined,
                blockedQuestion: undefined,
                updatedAt: clock.nowIso(),
              });
              continue;
            }

            // Cap reached (or none — meta no longer crashed, fall through) — escalate to Max.
            const crashCount =
              crashDecision.action === "none"
                ? (crashedMeta.crashRetries ?? 0)
                : crashDecision.crashRetries;
            store.writeMeta({
              ...crashedMeta,
              status: "blocked" as const,
              blockedReason: "crashed" as const,
              blockedQuestion: `Driver-level failure: ${message}. Crash retry cap hit (${crashCount}). See journal and opencode-serve.log.`,
              updatedAt: clock.nowIso(),
            });
            if (crashMeta.worktree) {
              repo.wipCommit(crashMeta.worktree, `lathe: WIP ${runId} [crashed]`);
            }
            continue;
          }

          // Read terminal status from meta (executeRun writes it).
          const terminalMeta = store.readMeta(runId);
          const status = terminalMeta.status;

          // Handle terminal statuses.
          if (status === "blocked") {
            // R10: wedged runs recover immediately.
            if (terminalMeta.blockedReason === "wedged") {
              const stall = recoverStalledRun(
                store,
                runId,
                config.thresholds.maxStallRetries,
                clock,
                config.thresholds.promoteAtCap,
              );
              if (stall.action === "promote") {
                journal({ store, clock }, runId, 0, {
                  event: "model_promoted",
                  from: `${config.baby.providerId}/${config.baby.modelId}`,
                  to: promotedModelLabel(config),
                });
              }
            }
            // R6: a blocked run parks and driver moves on.
            if (terminalMeta.worktree) {
              repo.wipCommit(terminalMeta.worktree, `lathe: WIP ${runId} [${status}]`);
            }
            continue;
          }

          if (status === "failed") {
            if (terminalMeta.worktree) {
              repo.wipCommit(terminalMeta.worktree, `lathe: WIP ${runId} [${status}]`);
            }
            continue;
          }

          if (status === "stopped") {
            if (terminalMeta.worktree) {
              repo.wipCommit(terminalMeta.worktree, `lathe: WIP ${runId} [${status}]`);
            }
            continue;
          }

          if (status === "ready_for_review" || status === "accepted") {
            // Run completed — continue to convergence.
          } else {
            // Unexpected status — treat as park.
            if (terminalMeta.worktree) {
              repo.wipCommit(terminalMeta.worktree, `lathe: WIP ${runId} [${status}]`);
            }
            continue;
          }

          // Post-run steps: convergence, chain promotion, stall recovery.
          await convergeStep(runId);
          promoteStaged(store, repo);
          const stall = recoverStalledRun(
            store,
            runId,
            config.thresholds.maxStallRetries,
            clock,
            config.thresholds.promoteAtCap,
          );
          if (stall.action === "promote") {
            journal({ store, clock }, runId, 0, {
              event: "model_promoted",
              from: `${config.baby.providerId}/${config.baby.modelId}`,
              to: promotedModelLabel(config),
            });
          }

          // Clear the bridge context so the next run starts fresh.
          bridge.clearActive(ref);
          continue;
        }
      }

      // Queue empty — wait for new work (fs.watch + poll fallback).
      // When stopSignal is provided (supervisor-owned), use it; otherwise
      // SIGINT aborts via the mutable currentAbort.
      let waitSignal: AbortSignal;
      if (seams?.stopSignal) {
        waitSignal = seams.stopSignal;
      } else {
        currentAbort = new AbortController();
        waitSignal = currentAbort.signal;
      }

      try {
        await waitForWork(waitSignal);
      } catch (err: unknown) {
        // AbortError from signal.abort() is expected; swallow it.
        if ((err as Error)?.name !== "AbortError") {
          throw err;
        }
      }

      if (stopRequested) {
        break;
      }
    }
  } finally {
    // Cleanup: release the power assertion, close the bridge server.
    if (!seams?.stopSignal) {
      process.off("SIGINT" as NodeJS.Signals, onSigint!);
    }
    // Abort any in-flight per-run controller (e.g. a run still executing
    // when stopSignal fires). The supervisor itself fires per-run controllers
    // via abortMap for the explicit stopRun path.
    for (const [, ac] of abortMap) {
      ac.abort();
    }
    abortMap.clear();
    bridge.close();
  }
};

// ---------------------------------------------------------------------------
// Recovery helpers — called at startup and after stall recovery
// ---------------------------------------------------------------------------

// R8: a run whose meta says "running" at startup died with the driver.
// Commit anything dirty, mark interrupted, leave it queued for the front.
export const recoverOrphanedRuns = (store: Store, repo: Repo, clock: Clock): void => {
  const runs = store.listRunIds();
  for (const runId of runs) {
    const meta = store.readMetaIfExists(runId);
    if (meta?.status !== "running") {
      continue;
    }
    if (meta.worktree) {
      repo.wipCommit(meta.worktree, `lathe: WIP ${runId} [interrupted]`);
    }
    store.writeMeta({
      ...meta,
      status: "queued" as const,
      updatedAt: clock.nowIso(),
    });
  }
};

// R10: post-run stall recovery (singular). Processes ONLY the run that just
// finished. A `wedged` park is a harness-detected stall; auto-requeue it up to
// maxStallRetries (front of the line, resumes from checkpoint), then escalate
// to a `human_decision` park so Max sees a run that stalls deterministically.
// `crashed` and the judgement parks are left for Max.
export const recoverStalledRun = (
  store: Store,
  runId: string,
  maxStallRetries: number,
  clock: Clock,
  promoteAtCap = true,
): StallRecoveryDecision => {
  const meta = store.readMetaIfExists(runId);
  if (!meta) {
    return { action: "none" };
  }

  const decision = decideStallRecovery(meta, maxStallRetries, promoteAtCap);
  if (decision.action === "none") {
    return decision;
  }

  if (decision.action === "requeue") {
    const { blockedReason: _r, blockedQuestion: _q, ...rest } = meta;
    store.writeMeta({
      ...rest,
      status: "queued" as const,
      stallRetries: decision.stallRetries,
      updatedAt: clock.nowIso(),
    });
    return decision;
  }

  if (decision.action === "promote") {
    // Cap reached on baby's normal model: requeue with the strong model latched
    // (promoted) and a fresh retry budget. The requeued attempt resumes from the
    // latest checkpoint — same task, bigger inference.
    const { blockedReason: _r, blockedQuestion: _q, ...rest } = meta;
    store.writeMeta({
      ...rest,
      status: "queued" as const,
      stallRetries: decision.stallRetries,
      promoted: true,
      updatedAt: clock.nowIso(),
    });
    return decision;
  }

  // Cap reached — escalate to Max. After a promotion the strong model also
  // stalled out, so say so.
  store.writeMeta({
    ...meta,
    blockedReason: "human_decision" as const,
    blockedQuestion: meta.promoted
      ? `Stalled to the retry cap even after promoting baby to the strong model — needs Max. Last stall: ${meta.blockedQuestion ?? "(no detail)"}`
      : `Auto-retried ${decision.stallRetries}× after stalling and stalled again — needs Max. Last stall: ${meta.blockedQuestion ?? "(no detail)"}`,
    updatedAt: clock.nowIso(),
  });
  return decision;
};

// Startup sweep for stalled runs (R10): a wedge that outlived its process —
// the driver was ^C'd or died after a run parked `wedged` — is stranded: it
// is not `queued` (so the queue skips it) and not `running` (so R8
// orphan-reclaim skips it). Sweep these at startup through the same bounded
// recovery, so an unattended restart resumes a stalled run (or escalates it at
// the cap) instead of leaving it for manual requeue.
export const recoverStalledRunsAtStartup = (
  store: Store,
  maxStallRetries: number,
  clock: Clock,
  promoteAtCap = true,
): void => {
  const runs = store.listRunIds();

  for (const runId of runs) {
    const meta = store.readMetaIfExists(runId);
    if (meta?.status !== "blocked" || meta.blockedReason !== "wedged") {
      continue;
    }

    const decision = decideStallRecovery(meta, maxStallRetries, promoteAtCap);
    if (decision.action === "none") {
      continue;
    }

    if (decision.action === "requeue") {
      store.writeMeta({
        ...meta,
        status: "queued" as const,
        stallRetries: decision.stallRetries,
        blockedReason: undefined,
        blockedQuestion: undefined,
        updatedAt: clock.nowIso(),
      });
    } else if (decision.action === "promote") {
      store.writeMeta({
        ...meta,
        status: "queued" as const,
        stallRetries: decision.stallRetries,
        promoted: true,
        blockedReason: undefined,
        blockedQuestion: undefined,
        updatedAt: clock.nowIso(),
      });
    } else if (decision.action === "escalate") {
      store.writeMeta({
        ...meta,
        blockedReason: "human_decision" as const,
        blockedQuestion: meta.promoted
          ? `stall retry cap reached on the promoted (strong) model for run ${runId}`
          : `stall retry cap reached (${maxStallRetries}) for run ${runId}`,
        updatedAt: clock.nowIso(),
      });
    }
  }
};
