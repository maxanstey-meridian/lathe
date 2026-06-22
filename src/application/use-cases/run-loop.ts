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
import { decideStallRecovery } from "../../domain/liveness.js";
import type { BridgePort } from "../ports/bridge.js";
import type { Caffeinate } from "../ports/caffeinate.js";
import type { Clock } from "../ports/clock.js";
import type { Repo } from "../ports/repo.js";
import type { Store } from "../ports/store.js";
import { promoteStaged } from "./chain-promotion.js";

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
) => Promise<void>;

export type ConvergeCallback = (runId: string) => Promise<void>;

export type WaitForWorkCallback = (signal: AbortSignal) => Promise<void>;

// ---------------------------------------------------------------------------
// Entry point — the always-on driver loop
// ---------------------------------------------------------------------------

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
): Promise<void> => {
  // R1: bind the bridge port FIRST — the single-driver lock.
  // Must resolve before any call to store.readMetaIfExists, store.listRunIds,
  // store.listQueue, or any other state read/write.
  const ref = await bridge.bind();

  // T3: hold the power assertion for the lifetime of the loop.
  await caffeinate.holdPowerAssertion();

  // Recovery sweeps — behind the lock, before draining.
  recoverOrphanedRuns(store, repo, clock);
  recoverStalledRunsAtStartup(store, config.thresholds.maxStallRetries, clock);

  // Chain promotion at startup.
  promoteStaged(store, repo);

  // --- Main loop ---
  let stopRequested = false;
  let currentAbort: AbortController | undefined;

  const onSigint = () => {
    if (stopRequested) {
      process.exit(130);
    }
    stopRequested = true;
    currentAbort?.abort();
  };
  process.on("SIGINT" as NodeJS.Signals, onSigint);

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
            );
          } catch (err: unknown) {
            // ^C-during-run is NOT a crash. A SIGINT tears down the opencode server,
            // which fails the in-flight turn send with a connection error that lands
            // right here — but the user asked to stop: leave the run RESUMABLE.
            if (stopRequested) {
              if (store.readMetaIfExists(runId)?.worktree) {
                repo.wipCommit(
                  store.readMetaIfExists(runId)!.worktree,
                  `meridian: WIP ${runId} [interrupted]`,
                );
              }
              store.writeMeta({
                ...store.readMeta(runId),
                status: "queued" as const,
                updatedAt: clock.nowIso(),
              });
              break;
            }

            // A real crash: park as blocked/crashed — NOT wedged, so the R10
            // recovery does NOT auto-retry it (a systemic driver fault would
            // hot-loop on the same packet) — and move on.
            const message = err instanceof Error ? err.message : String(err);
            const crashMeta = store.readMeta(runId);
            store.writeMeta({
              ...crashMeta,
              status: "blocked" as const,
              blockedReason: "crashed" as const,
              blockedQuestion: `Driver-level failure: ${message}. See journal and opencode-serve.log.`,
              updatedAt: clock.nowIso(),
            });
            if (crashMeta.worktree) {
              repo.wipCommit(crashMeta.worktree, `meridian: WIP ${runId} [crashed]`);
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
              recoverStalledRun(store, runId, config.thresholds.maxStallRetries, clock);
            }
            // R6: a blocked run parks and driver moves on.
            if (terminalMeta.worktree) {
              repo.wipCommit(terminalMeta.worktree, `meridian: WIP ${runId} [${status}]`);
            }
            continue;
          }

          if (status === "failed") {
            if (terminalMeta.worktree) {
              repo.wipCommit(terminalMeta.worktree, `meridian: WIP ${runId} [${status}]`);
            }
            continue;
          }

          if (status === "ready_for_review" || status === "accepted") {
            // Run completed — continue to convergence.
          } else {
            // Unexpected status — treat as park.
            if (terminalMeta.worktree) {
              repo.wipCommit(terminalMeta.worktree, `meridian: WIP ${runId} [${status}]`);
            }
            continue;
          }

          // Post-run steps: convergence, chain promotion, stall recovery.
          await convergeStep(runId);
          promoteStaged(store, repo);
          recoverStalledRun(store, runId, config.thresholds.maxStallRetries, clock);

          // Clear the bridge context so the next run starts fresh.
          bridge.clearActive(ref);
          continue;
        }
      }

      // Queue empty — wait for new work (fs.watch + poll fallback).
      // SIGINT aborts the in-flight wait via the mutable currentAbort.
      currentAbort = new AbortController();

      try {
        await waitForWork(currentAbort.signal);
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
    process.off("SIGINT" as NodeJS.Signals, onSigint);
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
      repo.wipCommit(meta.worktree, `meridian: WIP ${runId} [interrupted]`);
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
): void => {
  const meta = store.readMetaIfExists(runId);
  if (!meta) {
    return;
  }

  const decision = decideStallRecovery(meta, maxStallRetries);
  if (decision.action === "none") {
    return;
  }

  if (decision.action === "requeue") {
    const { blockedReason: _r, blockedQuestion: _q, ...rest } = meta;
    store.writeMeta({
      ...rest,
      status: "queued" as const,
      stallRetries: decision.stallRetries,
      updatedAt: clock.nowIso(),
    });
    return;
  }

  // Cap reached — escalate to Max.
  store.writeMeta({
    ...meta,
    blockedReason: "human_decision" as const,
    blockedQuestion: `Auto-retried ${decision.stallRetries}× after stalling and stalled again — needs Max. Last stall: ${meta.blockedQuestion ?? "(no detail)"}`,
    updatedAt: clock.nowIso(),
  });
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
): void => {
  const runs = store.listRunIds();

  for (const runId of runs) {
    const meta = store.readMetaIfExists(runId);
    if (meta?.status !== "blocked" || meta.blockedReason !== "wedged") {
      continue;
    }

    const decision = decideStallRecovery(meta, maxStallRetries);
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
    } else if (decision.action === "escalate") {
      store.writeMeta({
        ...meta,
        blockedReason: "human_decision" as const,
        blockedQuestion: `stall retry cap reached (${maxStallRetries}) for run ${runId}`,
        updatedAt: clock.nowIso(),
      });
    }
  }
};
