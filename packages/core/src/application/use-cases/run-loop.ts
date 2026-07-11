// ---------------------------------------------------------------------------
// Run loop (CONTRACT R1/R6/R8/R9/R10, X2)
//
// Composition root: procedural module that owns the driver lifecycle.
// Depends on BridgePort (the lock), domain decisions, and ports + callbacks.
// Reads top-to-bottom as the lifecycle (D1).
//
// Contract invariants enforced here:
//   R1  — bind bridge FIRST, before any state mutation (the single-driver lock)
//   R8  — park orphaned `running` runs at startup
//   R6  — a `blocked` run parks and driver moves on
//   X2  — always-on: waits for work until ^C (first finishes step, second forces)
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { makePaths } from "../../config/paths.js";
import type { Config } from "../../config/schemas.js";
import { RepositoryLeaseLostError } from "../errors/repository-lease-lost.js";
import type { BridgePort } from "../ports/bridge.js";
import type { Caffeinate } from "../ports/caffeinate.js";
import type { Clock } from "../ports/clock.js";
import type { Repo } from "../ports/repo.js";
import type { RepositoryLease, Store } from "../ports/store.js";
import type { ClaimedQueueEntry } from "../ports/store.js";
import { promoteStaged } from "./chain-promotion.js";
import { recoverAcceptedCleanup } from "./recover-acceptance-cleanup.js";

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
  lease?: RepositoryLease,
) => Promise<void>;

export type ConvergeCallback = (
  runId: string,
  signal?: AbortSignal,
  lease?: RepositoryLease,
) => Promise<void>;

export type WaitForWorkCallback = (signal: AbortSignal) => Promise<void>;

// ---------------------------------------------------------------------------
// Entry point — the always-on driver loop
// ---------------------------------------------------------------------------

export type RunLoopSeams = {
  /** If present, wired to waitForWork and used as loop-exit condition. runLoop does NOT register a SIGINT handler. */
  readonly stopSignal?: AbortSignal;
  /** Per-run AbortController map keyed by runId. runLoop creates controllers and populates it; supervisor reads and fires them. */
  readonly abortMap?: Map<string, RunAbort>;
  /** Fired after ownership is acquired and startup recovery is complete. */
  readonly onReady?: () => void;
  /** Deterministic interval seam for lease-loss tests. */
  readonly heartbeatIntervalMs?: number;
};

export type RunTerminationCause = "daemon_shutdown" | "operator_cancel" | "repository_lease_lost";
export type RunAbort = { controller: AbortController; cause?: RunTerminationCause };

const isExplicitConvergenceRetry = (store: Store, runId: string): boolean => {
  const meta = store.readMetaIfExists(runId);
  if (!meta || meta.status !== "ready_for_review") {
    return false;
  }
  const operation = store.readConvergenceOperation(runId, meta.attempt);
  if (!operation || operation.phase === "autofix_started" || operation.phase === "published") {
    return false;
  }
  return store
    .readDecisions(runId)
    .some(
      (decision) =>
        decision.source === "max" &&
        decision.questionType === "convergence_retry" &&
        decision.currentSlice === `attempt:${meta.attempt}`,
    );
};

const needsStartupConvergenceRecovery = (store: Store, runId: string): boolean => {
  const meta = store.readMetaIfExists(runId);
  if (!meta || meta.status !== "ready_for_review") {
    return false;
  }
  const operation = store.readConvergenceOperation(runId, meta.attempt);
  return (
    !operation ||
    operation.phase === "decided" ||
    operation.phase === "amend_started" ||
    operation.phase === "effect_applied" ||
    isExplicitConvergenceRetry(store, runId)
  );
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

  try {
    await runBoundLoop();
  } finally {
    bridge.close();
  }

  async function runBoundLoop(): Promise<void> {
    // T3: hold the power assertion for the lifetime of the loop.
    await caffeinate.holdPowerAssertion();

    // Ownership cleanup is behind the single-driver lock. Interrupted work is
    // parked for explicit operator action; startup never retries it implicitly.
    parkOrphanedRuns(store, repo, clock);
    recoverStaleActiveRuns(store);
    recoverStaleActiveConvergences(store);
    recoverAcceptedCleanup({
      store,
      repo,
      clock,
      runsDir: makePaths(config.stateRoot).runsDir,
    });
    // The gate plugin consumes this projection out-of-process. Readiness is not
    // safe until authoritative active state has been projected successfully.
    store.syncActiveRunProjection();

    // --- Main loop ---
    const abortMap = seams?.abortMap ?? new Map<string, RunAbort>();

    let stopRequested = false;
    let onSigint: (() => void) | undefined;
    const waitController = new AbortController();

    const requestShutdown = (): void => {
      stopRequested = true;
      waitController.abort();
      for (const [, abort] of abortMap) {
        abort.cause ??= "daemon_shutdown";
        abort.controller.abort();
      }
    };

    // When an external stopSignal is provided (supervisor-owned), do NOT register
    // our own SIGINT handler — the supervisor owns process-signal handling.
    // Normalise both paths to stopRequested as the single loop-exit flag.
    if (seams?.stopSignal) {
      seams.stopSignal.addEventListener("abort", requestShutdown, { once: true });
      if (seams.stopSignal.aborted) {
        requestShutdown();
      }
    } else {
      onSigint = () => {
        if (stopRequested) {
          process.exit(130);
        }
        requestShutdown();
      };
      process.on("SIGINT" as NodeJS.Signals, onSigint);
    }

    // Shared wait controller for non-supervisor path — created once so all workers
    // share the same signal. SIGINT aborts it to wake all waiting workers.
    // Convergence mutex: serialise convergeStep calls so only one runs at a time
    // across all workers.
    let convergenceChain: Promise<void> = Promise.resolve();
    const serializeConvergence = (
      runId: string,
      signal?: AbortSignal,
      lease?: RepositoryLease,
    ): Promise<void> => {
      const next = convergenceChain.then(() => {
        if (signal?.aborted) {
          return;
        }
        return convergeStep(runId, signal, lease);
      });
      convergenceChain = next.catch(() => {});
      return next;
    };

    const parkConvergenceFailure = (
      runId: string,
      error: unknown,
      lease: RepositoryLease,
    ): void => {
      if (error instanceof RepositoryLeaseLostError) {
        return;
      }
      const failedMeta = store.readMeta(runId);
      const message = error instanceof Error ? error.message : String(error);
      if (failedMeta.status === "blocked") {
        store.appendJournal(runId, {
          at: clock.nowIso(),
          turn: 0,
          event: "driver_note",
          note: `Convergence failed after the run was blocked: ${message}. The existing blocked state was preserved; retry convergence after resolving the failure.`,
        });
        return;
      }
      const question = `Convergence failure: ${message}. Inspect the journal and preserved sandbox, then retry convergence.`;
      store.transitionRun({
        runId,
        expectedRevision: failedMeta.revision ?? 0,
        expectedStatuses: [failedMeta.status],
        meta: {
          ...failedMeta,
          status: "blocked",
          blockedReason: "crashed",
          blockedQuestion: question,
          updatedAt: clock.nowIso(),
        },
        activeRun: null,
        lease,
        event: { at: clock.nowIso(), turn: 0, event: "parked", reason: "crashed", question },
      });
    };

    // Resume completed runs interrupted before convergence began, plus work
    // explicitly retried by the Human Operator. Partial operations remain parked.
    for (const runId of store.listRunIds()) {
      const meta = store.readMetaIfExists(runId);
      if (!meta || !needsStartupConvergenceRecovery(store, runId)) {
        continue;
      }
      const lease = store.acquireRepositoryLease(
        meta.repo,
        `recovery:${randomUUID()}`,
        runId,
        "execute",
      );
      if (!lease) {
        continue;
      }
      const abort: RunAbort = { controller: new AbortController() };
      abortMap.set(runId, abort);
      if (stopRequested) {
        abort.cause = "daemon_shutdown";
        abort.controller.abort();
      }
      try {
        await serializeConvergence(runId, abort.controller.signal, lease);
      } catch (error: unknown) {
        if (!abort.controller.signal.aborted) {
          parkConvergenceFailure(runId, error, lease);
        }
      } finally {
        abortMap.delete(runId);
        store.releaseRepositoryLease(lease);
      }
    }

    // Chain promotion observes all convergence publications recovered above.
    promoteStaged(store, repo);
    seams?.onReady?.();

    const maxWorkers = config.concurrency.maxWorkers;
    const workers = Array.from({ length: maxWorkers }, () => workerLoop());

    try {
      try {
        await Promise.all(workers);
      } catch (error: unknown) {
        requestShutdown();
        await Promise.allSettled(workers);
        throw error;
      }
    } finally {
      // Cleanup: release the power assertion, close the bridge server.
      if (!seams?.stopSignal) {
        process.off("SIGINT" as NodeJS.Signals, onSigint!);
      }
      // Abort any in-flight per-run controller (e.g. a run still executing
      // when stopSignal fires). The supervisor itself fires per-run controllers
      // via abortMap for the explicit stopRun path.
      for (const [, abort] of abortMap) {
        abort.cause = "daemon_shutdown";
        abort.controller.abort();
      }
      abortMap.clear();
    }

    // ---------------------------------------------------------------------------
    // Worker loop — each worker independently claims, executes, and converges runs.
    // ---------------------------------------------------------------------------

    async function workerLoop(): Promise<void> {
      const ownerId = `worker:${randomUUID()}`;
      while (!stopRequested) {
        const retryRunId = store
          .listRunIds()
          .find((runId) => isExplicitConvergenceRetry(store, runId));
        if (retryRunId) {
          const retryMeta = store.readMeta(retryRunId);
          const retryLease = store.acquireRepositoryLease(
            retryMeta.repo,
            ownerId,
            retryRunId,
            "execute",
          );
          if (retryLease) {
            const abort: RunAbort = { controller: new AbortController() };
            abortMap.set(retryRunId, abort);
            let completed = false;
            try {
              await serializeConvergence(retryRunId, abort.controller.signal, retryLease);
              completed = !abort.controller.signal.aborted;
              if (completed) {
                promoteStaged(store, repo, retryLease);
                bridge.clearActive(ref, retryRunId);
              }
            } catch (error: unknown) {
              if (!abort.controller.signal.aborted) {
                parkConvergenceFailure(retryRunId, error, retryLease);
              }
            } finally {
              abortMap.delete(retryRunId);
              store.releaseRepositoryLease(retryLease);
            }
            continue;
          }
        }

        // Drain the queue using atomic claim with repo affinity (F2: requeued runs claimed first).
        const claimed = store.claimNextQueuedRun([], ownerId);
        if (!claimed) {
          // No eligible run — wait for new work (fs.watch + poll fallback).
          // When stopSignal is provided (supervisor-owned), use it; otherwise
          // SIGINT aborts via the shared waitController.
          const waitSignal = waitController.signal;

          try {
            await waitForWork(waitSignal);
          } catch (err: unknown) {
            // AbortError from signal.abort() is expected; swallow it.
            if ((err as Error)?.name !== "AbortError") {
              throw err;
            }
          }
          continue;
        }

        const heartbeat = setInterval(() => {
          if (!store.heartbeatRepositoryLease(claimed.lease)) {
            const abort = abortMap.get(claimed.runId);
            if (abort && !abort.controller.signal.aborted) {
              abort.cause = "repository_lease_lost";
              abort.controller.abort(
                new RepositoryLeaseLostError(`repository lease lost for ${claimed.lease.repo}`),
              );
            }
          }
        }, seams?.heartbeatIntervalMs ?? 10_000);
        try {
          await processClaimedRun(claimed);
        } finally {
          clearInterval(heartbeat);
          store.releaseRepositoryLease(claimed.lease);
        }
      }
    }

    // ---------------------------------------------------------------------------
    // processClaimedRun — single-run claim lifecycle extracted from the old while
    // loop body. Returns when done; the worker loop continues naturally.
    // ---------------------------------------------------------------------------

    async function processClaimedRun(claimed: ClaimedQueueEntry): Promise<void> {
      const { runId } = claimed;
      const lease = claimed.lease;

      const meta = store.readMeta(runId);

      try {
        const runAbort = new AbortController();
        const abort: RunAbort = { controller: runAbort };
        abortMap.set(runId, abort);
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
          lease,
        );
        abort.controller = new AbortController();
        if (abort.cause === "operator_cancel" || seams?.stopSignal?.aborted) {
          abort.cause ??= "daemon_shutdown";
          abort.controller.abort();
        }
      } catch (err: unknown) {
        const terminationCause = abortMap.get(runId)?.cause;
        abortMap.delete(runId);
        if (
          terminationCause === "repository_lease_lost" ||
          err instanceof RepositoryLeaseLostError
        ) {
          return;
        }
        if (
          stopRequested ||
          terminationCause === "daemon_shutdown" ||
          terminationCause === "operator_cancel"
        ) {
          const cancelledMeta = store.readMeta(runId);
          const startup = store.readRunStartup(runId, cancelledMeta.attempt);
          if (startup?.phase === "setup_started") {
            const question =
              "Setup cancellation occurred after an arbitrary setup command started. Its effects are ambiguous, so setup will not be replayed. Inspect the preserved sandbox before requeueing.";
            store.transitionRun({
              runId,
              expectedRevision: cancelledMeta.revision ?? 0,
              expectedStatuses: ["running"],
              meta: {
                ...cancelledMeta,
                status: "blocked",
                blockedReason: "crashed",
                blockedQuestion: question,
                updatedAt: clock.nowIso(),
              },
              activeRun: null,
              lease,
              event: { at: clock.nowIso(), turn: 0, event: "parked", reason: "crashed", question },
            });
            return;
          }
        }
        // ^C-during-run is NOT a crash. A SIGINT tears down the opencode server,
        // which fails the in-flight turn send with a connection error that lands
        // right here — but the user asked to stop: leave the run RESUMABLE.
        if (stopRequested || terminationCause === "daemon_shutdown") {
          if (store.readMetaIfExists(runId)?.worktree) {
            try {
              repo.wipCommit(
                store.readMetaIfExists(runId)!.worktree,
                `lathe: WIP ${runId} [stopped]`,
              );
            } catch {}
          }
          const stoppedMeta = store.readMeta(runId);
          store.transitionRun({
            runId,
            expectedRevision: stoppedMeta.revision ?? 0,
            expectedStatuses: ["running"],
            meta: { ...stoppedMeta, status: "stopped", updatedAt: clock.nowIso() },
            activeRun: null,
            lease,
          });
          return;
        }

        if (terminationCause === "operator_cancel") {
          const cancelledMeta = store.readMeta(runId);
          if (cancelledMeta.worktree) {
            try {
              repo.wipCommit(cancelledMeta.worktree, `lathe: WIP ${runId} [stopped]`);
            } catch {}
          }
          store.transitionRun({
            runId,
            expectedRevision: cancelledMeta.revision ?? 0,
            expectedStatuses: ["running"],
            meta: { ...cancelledMeta, status: "stopped", updatedAt: clock.nowIso() },
            activeRun: null,
            lease,
          });
          return;
        }

        // A real crash is parked for explicit operator action. Never infer that
        // external effects are safe to replay and never destroy resume evidence.
        const message = err instanceof Error ? err.message : String(err);
        const crashMeta = store.readMeta(runId);
        if (crashMeta.worktree) {
          try {
            repo.wipCommit(crashMeta.worktree, `lathe: WIP ${runId} [crashed]`);
          } catch {}
        }
        const question = `Driver-level failure: ${message}. See journal and opencode-serve.log.`;
        store.transitionRun({
          runId,
          expectedRevision: crashMeta.revision ?? 0,
          expectedStatuses: ["running"],
          meta: {
            ...crashMeta,
            status: "blocked",
            blockedReason: "crashed",
            blockedQuestion: question,
            updatedAt: clock.nowIso(),
          },
          activeRun: null,
          lease,
          event: {
            at: clock.nowIso(),
            turn: 0,
            event: "parked",
            reason: "crashed",
            question,
          },
        });
        return;
      }

      // Read terminal status from meta (executeRun writes it).
      const terminalMeta = store.readMeta(runId);
      const status = terminalMeta.status;

      // Handle terminal statuses.
      if (status === "blocked") {
        abortMap.delete(runId);
        // R6: a blocked run parks and driver moves on.
        if (terminalMeta.worktree) {
          repo.wipCommit(terminalMeta.worktree, `lathe: WIP ${runId} [${status}]`);
        }
        return;
      }

      if (status === "failed") {
        abortMap.delete(runId);
        if (terminalMeta.worktree) {
          repo.wipCommit(terminalMeta.worktree, `lathe: WIP ${runId} [${status}]`);
        }
        return;
      }

      if (status === "stopped") {
        abortMap.delete(runId);
        if (terminalMeta.worktree) {
          repo.wipCommit(terminalMeta.worktree, `lathe: WIP ${runId} [${status}]`);
        }
        return;
      }

      if (status === "ready_for_review" || status === "accepted") {
        // Run completed — continue to convergence.
      } else {
        abortMap.delete(runId);
        // Unexpected status — treat as park.
        if (terminalMeta.worktree) {
          repo.wipCommit(terminalMeta.worktree, `lathe: WIP ${runId} [${status}]`);
        }
        return;
      }

      // Post-run steps: convergence and chain promotion.
      const convergence = abortMap.get(runId)!;
      if (abortMap.get(runId)?.cause === "operator_cancel") {
        const cancelledMeta = store.readMeta(runId);
        if (cancelledMeta.worktree) {
          repo.wipCommit(cancelledMeta.worktree, `lathe: WIP ${runId} [stopped]`);
        }
        store.transitionRun({
          runId,
          expectedRevision: cancelledMeta.revision ?? 0,
          expectedStatuses: [cancelledMeta.status],
          meta: { ...cancelledMeta, status: "stopped", updatedAt: clock.nowIso() },
          activeRun: null,
          lease,
        });
        abortMap.delete(runId);
        return;
      }
      try {
        await serializeConvergence(runId, convergence.controller.signal, lease);
      } catch (err: unknown) {
        if (err instanceof RepositoryLeaseLostError) {
          return;
        }
        parkConvergenceFailure(runId, err, lease);
        return;
      } finally {
        abortMap.delete(runId);
      }
      const convergenceCause = (convergence as RunAbort).cause;
      if (convergenceCause === "operator_cancel") {
        const cancelledMeta = store.readMeta(runId);
        if (
          cancelledMeta.status === "accepted" ||
          (cancelledMeta.status === "blocked" && cancelledMeta.blockedReason === "human_decision")
        ) {
          return;
        }
        if (cancelledMeta.worktree) {
          repo.wipCommit(cancelledMeta.worktree, `lathe: WIP ${runId} [stopped]`);
        }
        store.transitionRun({
          runId,
          expectedRevision: cancelledMeta.revision ?? 0,
          expectedStatuses: [cancelledMeta.status],
          meta: { ...cancelledMeta, status: "stopped", updatedAt: clock.nowIso() },
          activeRun: null,
          lease,
        });
        return;
      }
      if (convergenceCause === "daemon_shutdown" || stopRequested) {
        return;
      }
      if (convergenceCause === "repository_lease_lost") {
        return;
      }
      promoteStaged(store, repo, lease);

      // Clear the bridge context so the next run starts fresh.
      bridge.clearActive(ref, runId);
    }
  }
};

// ---------------------------------------------------------------------------
// Startup ownership cleanup
// ---------------------------------------------------------------------------

// A run whose meta says "running" at startup died with the driver. Preserve its
// sandbox and session evidence, then park it for explicit operator action.
export const parkOrphanedRuns = (store: Store, repo: Repo, clock: Clock): void => {
  const runs = store.listRunIds();
  for (const runId of runs) {
    const meta = store.readMetaIfExists(runId);
    if (meta?.status !== "running") {
      continue;
    }
    const startup = store.readRunStartup(runId, meta.attempt);
    const ambiguousPhase =
      startup?.phase === "setup_started" ||
      startup?.phase === "planner_session_started" ||
      startup?.phase === "executor_session_started";
    if (startup && startup.phase !== "active" && !ambiguousPhase) {
      continue;
    }
    if (meta.worktree) {
      try {
        repo.wipCommit(meta.worktree, `lathe: WIP ${runId} [crashed]`);
      } catch {}
    }
    const question =
      startup?.phase === "setup_started"
        ? "Driver exited during an arbitrary setup command. Its effects are ambiguous, so setup will not be replayed. Inspect the preserved sandbox before requeueing."
        : startup?.phase === "planner_session_started" ||
            startup?.phase === "executor_session_started"
          ? "Driver exited during session creation. The external result is ambiguous, so session creation will not be replayed. Inspect and reconcile the external session before requeueing."
          : "Driver exited while this run was active. Inspect the preserved sandbox before requeueing.";
    store.transitionRun({
      runId,
      expectedRevision: meta.revision ?? 0,
      expectedStatuses: ["running"],
      meta: {
        ...meta,
        status: "blocked",
        blockedReason: "crashed",
        blockedQuestion: question,
        updatedAt: clock.nowIso(),
      },
      activeRun: null,
      event: { at: clock.nowIso(), turn: 0, event: "parked", reason: "crashed", question },
    });
  }
};

// Clear stale active_run pointers on boot. An active_run row whose meta is
// not "running" (or whose run row is gone) is stale.
export const recoverStaleActiveRuns = (store: Store): void => {
  for (const active of store.listActiveRuns()) {
    const meta = store.readMetaIfExists(active.runId);
    if (!meta || meta.status !== "running") {
      store.removeActiveRun(active.runId);
    }
  }
};

// Clear ALL active_convergence pointers on boot. No convergence can be running
// at startup because the daemon has just acquired ownership.
export const recoverStaleActiveConvergences = (store: Store): void => {
  for (const conv of store.listActiveConvergences()) {
    store.removeActiveConvergence(conv.runId);
  }
};
