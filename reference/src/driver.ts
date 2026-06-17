// The driver: queue loop → run loop → turn loop (CONTRACT §5, §6, §8).
// Procedural on purpose — this file should read top-to-bottom as the lifecycle
// it owns. All semantic judgment lives in Daddy or Max (D1); everything here is
// a mechanical function of durable files, config, and tool results.

import { spawn } from "child_process"
import { existsSync, copyFileSync, mkdirSync, unlinkSync, writeFileSync, watch } from "fs"
import { join } from "path"
import type { Config, Checkpoint, BlockedReason } from "./schemas.js"
import { ActiveRun } from "./schemas.js"
import type { Paths } from "./paths.js"
import { parsePacket } from "./packet.js"
import { listQueue, archivePacket, type QueueEntry } from "./queue.js"
import { promoteStagedChildren } from "./chain.js"
import {
  type RunContext,
  journal,
  readMeta,
  readMetaIfExists,
  writeMeta,
  listRunIds,
  initialLedger,
  readLedger,
  writeLedger,
  initialReviewState,
  readReviewState,
  readDecisions,
  latestCheckpoint,
  appendJournal,
  decideStallRecovery,
  stallAction,
} from "./runtime.js"
import { ReviewState as ReviewStateSchema } from "./schemas.js"
import { writeValidated, nowIso } from "./fsio.js"
import { createRunSandbox, wipCommit, diffStat, readDiffStats, diffDelta, worktreeIsDirty } from "./git.js"
import { initialGateState, readGateState, writeGateState, latchGate, gateTriggerReason, checkpointNudgeDue, rotationGateState, volumeCheckpointReason } from "./gate.js"
import {
  writeOpencodeConfig,
  spawnOpencodeServer,
  warnOnVersionDrift,
  waitForServer,
  createOpencodeClient,
  extractText,
  extractReasoning,
  gateDeniedPart,
  pluginPath,
  type OpencodeClient,
  type TurnResponse,
  type MessagePart,
} from "./opencode.js"
import { renderDaddySeed } from "./planner.js"
import {
  q1InitialSeed,
  q2RotationSeed,
  q3Continue,
  q4CheckpointDemand,
  q5TeardownDemand,
  q6ReportProperly,
  q7ReportRejected,
  q8ReconciliationSeed,
  qReorientSeed,
  ladderNudge,
  softCheckpointNudge,
  qPlannerDecision,
  qPlannerUnavailable,
} from "./prompts.js"
import { renderReportMarkdown } from "./runtime.js"
import { startBridgeServer, listenBridge, runPlannerConsult, runFinalReview, type CurrentRunRef } from "./bridge.js"
import { babyContextBudget } from "./config.js"
import { convergeRun } from "./converge.js"
import { loadRunForReview } from "./super-review.js"
import { campaignIdForRun, readCampaign, alreadyReviewed } from "./campaign.js"

const log = (msg: string): void => {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

// ---------------------------------------------------------------------------
// Entry: meridian run

export const runQueue = async (config: Config, paths: Paths): Promise<void> => {
  mkdirSync(paths.queueDir, { recursive: true })
  mkdirSync(paths.runsDir, { recursive: true })

  // Bind the bridge port FIRST: it is the single-driver lock. Recovery must
  // never run while another driver is live (learned live: a second
  // `meridian run` "recovered" a run the first driver was mid-flight on,
  // then died on this very bind — after mutating state).
  const ref: CurrentRunRef = { current: undefined }
  const bridgeServer = startBridgeServer(config, ref)
  await listenBridge(bridgeServer, config)

  // T3: hold a power assertion for the driver's lifetime.
  if (process.platform === "darwin") {
    spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore", detached: true }).unref()
  }

  // R8: crash recovery — safely behind the lock.
  recoverOrphanedRuns(paths)
  // §5 R10: recover wedges stranded by a previous process's exit (bounded).
  recoverStalledRunsAtStartup(config, paths)
  // §19: promote any chained children whose parent converged on a prior night
  // (and admit parent-less chain heads) before the queue is first listed.
  sweepChain(paths)

  // Always-on (SUPER-DADDY §14.3): the driver no longer exits when the queue
  // drains. It waits for new work — a fresh packet, an answered park requeued,
  // or a convergence follow-up it authored itself — until Max stops it with ^C.
  // A first ^C finishes the current step then exits cleanly (teardown in the
  // finally); a second forces out.
  let stopRequested = false
  const onSigint = (): void => {
    if (stopRequested) {
      log("second ^C — forcing exit")
      process.exit(130)
    }
    stopRequested = true
    log("^C received — finishing the current step, then stopping (^C again to force)")
  }
  process.on("SIGINT", onSigint)

  const initial = listQueue(paths)
  log(initial.length > 0 ? `queue: ${initial.length} packet(s) — ${initial.map((q) => q.runId).join(", ")}` : "queue empty — waiting for work (^C to stop)")

  writeOpencodeConfig(config, paths, pluginPath())
  warnOnVersionDrift(config)
  const serverProcess = spawnOpencodeServer(config, paths)

  try {
    await waitForServer(config)
    log(`opencode server up on :${config.opencode.port}, bridge on :${config.opencode.bridgePort}`)
    const client = createOpencodeClient(config)

    while (!stopRequested) {
      // R1: strictly sequential. Re-list after each run so answered parked runs
      // and convergence follow-ups authored mid-loop are picked up (front first, F2).
      let entry: QueueEntry | undefined
      while (!stopRequested && (entry = listQueue(paths)[0]) !== undefined) {
        try {
          await executeRun(config, paths, client, ref, entry)
          // §3/§14.3: convergence is the always-on post-run step. A follow-up it
          // authors lands in the queue and is drained on the next iteration.
          await convergeFinishedRun(config, paths, client, entry.runId)
          // §19: a campaign that just converged may unblock a staged child — promote
          // it (base = this run's converged tip) so it drains on the next iteration.
          sweepChain(paths)
          // §5 R10: a run that parked `wedged` (a harness stall, not a crash and
          // not a judgement park) is auto-requeued up to maxStallRetries, then
          // escalated. The requeue re-enters at the front (F2) on the next list.
          recoverStalledRun(config, paths, entry.runId)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          const meta = readMetaIfExists(paths, entry.runId)

          // ^C-during-run is NOT a crash. A SIGINT tears down the opencode server,
          // which fails the in-flight turn send (and the recovery rotate's
          // createSession) with a connection error that lands right here — looking
          // identical to a driver fault. But the user asked to stop: leave the run
          // RESUMABLE (commit WIP, mark `queued`) so the next `meridian run` picks
          // it straight back up from its latest checkpoint, no manual `answer` dance.
          if (stopRequested) {
            log(`run ${entry.runId} interrupted by ^C — committing WIP and leaving it queued to resume`)
            if (meta) {
              if (existsSync(meta.worktree) && worktreeIsDirty(meta.worktree)) {
                wipCommit(meta.worktree, `meridian: WIP ${entry.runId} [interrupted]`)
              }
              writeMeta(paths, { ...meta, status: "queued", updatedAt: nowIso() })
            }
            if (existsSync(paths.activeRunFile)) unlinkSync(paths.activeRunFile)
            ref.current = undefined
            break
          }

          // One run's hard failure must not kill the night (R6 spirit): park it
          // as `crashed` — NOT `wedged`, so the R10 recovery does NOT auto-retry
          // it (a systemic driver fault would hot-loop on the same packet) — and
          // move on. Max reviews and requeues in the morning.
          log(`run ${entry.runId} CRASHED: ${message} — parking as crashed, continuing with the queue`)
          if (meta) {
            if (existsSync(meta.worktree) && worktreeIsDirty(meta.worktree)) {
              wipCommit(meta.worktree, `meridian: WIP ${entry.runId} [crashed]`)
            }
            writeMeta(paths, {
              ...meta,
              status: "blocked",
              blockedReason: "crashed",
              blockedQuestion: `Driver-level failure: ${message}. See journal and opencode-serve.log.`,
              endedAt: nowIso(),
            })
          }
          if (existsSync(paths.activeRunFile)) unlinkSync(paths.activeRunFile)
        }
        ref.current = undefined
      }
      if (stopRequested) break
      log("queue drained — watching for new work (^C to stop)")
      await waitForWork(paths, () => stopRequested)
    }
    log("stopped")
  } finally {
    process.off("SIGINT", onSigint)
    ref.current = undefined
    if (existsSync(paths.activeRunFile)) unlinkSync(paths.activeRunFile)
    bridgeServer.close()
    serverProcess.kill()
  }
}

// Block until there is something to do or a stop is requested. fs.watch on the
// queue and runs dirs wakes us promptly on a fresh packet; the interval is the
// robust fallback (watch can miss events, and a requeue is a nested meta.json
// write a non-recursive dir watch won't see) and also catches the stop request.
const waitForWork = (paths: Paths, stopped: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearInterval(poll)
      queueWatcher.close()
      runsWatcher?.close()
      resolve()
    }
    const tick = (): void => {
      if (stopped() || listQueue(paths).length > 0) finish()
    }
    const poll = setInterval(tick, 1500)
    const queueWatcher = watch(paths.queueDir, tick)
    const runsWatcher = existsSync(paths.runsDir) ? watch(paths.runsDir, tick) : undefined
  })

// §3/§14.3: the convergence post-run step. Reviews a run that finished
// ready_for_review with super-daddy (reusing the live server),
// then converges / authors a follow-up / parks for Max. It never touches a run
// that did not finish clean, skips a pass already recorded in the campaign ledger
// (§12), and on any convergence failure leaves the run ready_for_review for manual
// review rather than corrupting a finished result.
const convergeFinishedRun = async (config: Config, paths: Paths, client: OpencodeClient, runId: string): Promise<void> => {
  const meta = readMetaIfExists(paths, runId)
  if (meta?.status !== "ready_for_review") return

  let loaded
  try {
    loaded = loadRunForReview(config, paths, runId)
  } catch (err) {
    log(`convergence skipped for ${runId}: ${err instanceof Error ? err.message : String(err)}`)
    return
  }

  const campaignId = campaignIdForRun(loaded.input.packet, runId)
  if (alreadyReviewed(readCampaign(paths, campaignId), runId)) {
    log(`convergence: ${runId} already reviewed in campaign ${campaignId} — skipping`)
    return
  }

  try {
    log(`convergence: reviewing ${runId} (pass ${loaded.input.packet.frontmatter.pass}/${config.thresholds.maxPasses})…`)
    const outcome = await convergeRun(config, paths, client, loaded)
    const tail =
      outcome.result.kind === "author"
        ? ` — authored ${outcome.result.followupRunId}${outcome.result.admitted ? " (queued)" : ` (REJECTED: ${outcome.result.problem ?? "unknown"})`}`
        : outcome.result.kind === "escalate"
          ? " — parked for Max"
          : " — campaign converged"
    log(`convergence: ${runId} → ${outcome.decision.action.toUpperCase()}${tail}`)
  } catch (err) {
    log(`convergence FAILED for ${runId}: ${err instanceof Error ? err.message : String(err)} — leaving ready_for_review for manual review`)
  }
}

// §19: promote staged chained children whose parent campaign has converged. A
// thin log wrapper around the pure promotion sweep — the decision and all I/O
// live in chain.ts; here we only surface what moved. Runs behind the lock, so it
// never races the queue with another driver.
const sweepChain = (paths: Paths): void => {
  const report = promoteStagedChildren(paths)
  for (const runId of report.promoted) log(`chain: promoted ${runId} to the queue (parent converged)`)
  for (const f of report.failed) log(`chain: promotion failed for ${f.runId}: ${f.problem}`)
}

// §5 R10: the liveness decision layer. A `wedged` park is a harness-detected
// stall; auto-requeue it up to maxStallRetries (front of the line, resumes from
// checkpoint), then escalate to a `human_decision` park so Max sees a run that
// stalls deterministically. `crashed` and the judgement parks are left for Max.
// The orchestrator writes only the run's lifecycle status here — never its work.
const recoverStalledRun = (config: Config, paths: Paths, runId: string): void => {
  const meta = readMetaIfExists(paths, runId)
  if (!meta) return
  const decision = decideStallRecovery(meta, config.thresholds.maxStallRetries)
  if (decision.action === "none") return

  if (decision.action === "requeue") {
    appendJournal(paths, runId, { event: "stall_recovery", action: "requeue", stallRetries: decision.stallRetries })
    const { blockedReason: _r, blockedQuestion: _q, ...rest } = meta
    writeMeta(paths, { ...rest, status: "queued", stallRetries: decision.stallRetries, updatedAt: nowIso() })
    log(`run ${runId} stalled (wedged) — auto-requeuing (retry ${decision.stallRetries}/${config.thresholds.maxStallRetries})`)
    return
  }

  appendJournal(paths, runId, { event: "stall_recovery", action: "escalate", stallRetries: decision.stallRetries })
  writeMeta(paths, {
    ...meta,
    blockedReason: "human_decision",
    blockedQuestion: `Auto-retried ${decision.stallRetries}× after stalling and stalled again — needs Max. Last stall: ${meta.blockedQuestion ?? "(no detail)"}`,
    updatedAt: nowIso(),
  })
  log(`run ${runId} still wedged after ${decision.stallRetries} auto-retries — escalating to Max (human_decision)`)
}

// §5 R10 (startup): a wedge that outlived its process — the driver was ^C'd or
// died after a run parked `wedged` — is stranded: it is not `queued` (so the
// queue skips it) and not `running` (so R8 orphan-reclaim skips it). Sweep these
// at startup through the same bounded recovery, so an unattended restart resumes
// a stalled run (or escalates it at the cap) instead of leaving it for manual
// requeue. Sibling to recoverOrphanedRuns; runs once behind the lock.
const recoverStalledRunsAtStartup = (config: Config, paths: Paths): void => {
  for (const runId of listRunIds(paths)) {
    const meta = readMetaIfExists(paths, runId)
    if (meta?.status === "blocked" && meta.blockedReason === "wedged") recoverStalledRun(config, paths, runId)
  }
}

// R8: a run whose meta says "running" at startup died with the driver. Commit
// anything dirty, mark interrupted, leave it queued for the front of the line.
const recoverOrphanedRuns = (paths: Paths): void => {
  for (const runId of listRunIds(paths)) {
    const meta = readMetaIfExists(paths, runId)
    if (meta?.status !== "running") continue
    log(`recovering orphaned run ${runId}`)
    if (existsSync(meta.worktree) && worktreeIsDirty(meta.worktree)) {
      wipCommit(meta.worktree, `meridian: WIP ${runId} [interrupted]`)
    }
    writeMeta(paths, { ...meta, status: "queued", updatedAt: nowIso() })
  }
}

// ---------------------------------------------------------------------------
// One run (R2)

const executeRun = async (
  config: Config,
  paths: Paths,
  client: OpencodeClient,
  ref: CurrentRunRef,
  entry: QueueEntry,
): Promise<void> => {
  const isResume = entry.kind === "requeued"

  // Re-validate at run start (K3) — fail closed even if the file changed since
  // admission. Requeued entries validate their frozen copy under the run's id.
  const parsed = parsePacket(entry.file, isResume ? entry.runId : undefined)
  if (!parsed.ok) {
    log(`SKIPPING ${entry.runId}: packet failed validation: ${parsed.problems.join("; ")}`)
    if (!isResume) {
      // Move it out of the queue (so the loop does not spin on it forever) into
      // the rejected dir with its problems — recoverable, never destroyed.
      archivePacket(paths, entry.file, parsed.problems)
    } else {
      const meta = readMeta(paths, entry.runId)
      writeMeta(paths, { ...meta, status: "failed", updatedAt: nowIso() })
    }
    return
  }
  const packet = parsed.packet
  const runId = packet.runId

  // Freeze + scaffold on first attempt (R2); reuse durable state on resume.
  const priorMeta = readMetaIfExists(paths, runId)
  const attempt = (priorMeta?.attempt ?? 0) + 1
  const branch = `meridian/${runId}`
  const worktree = join(paths.runDir(runId), "worktree")

  if (!isResume) {
    mkdirSync(paths.runDir(runId), { recursive: true })
    copyFileSync(entry.file, paths.packetFile(runId))
    unlinkSync(entry.file) // consumed from the queue; the frozen copy is authoritative
    writeLedger(paths, initialLedger(packet))
    writeValidated(paths.reviewStateFile(runId), ReviewStateSchema, initialReviewState(runId))
  }

  // Meta exists from the moment the packet is consumed: a crash anywhere after
  // this line (Daddy handshake included) leaves status "queued", so the run
  // re-enters at the front on the next `meridian run` instead of vanishing.
  writeMeta(paths, {
    runId,
    status: "queued",
    attempt,
    repo: packet.frontmatter.repo,
    base: packet.frontmatter.base,
    branch,
    worktree,
    summary: packet.frontmatter.summary,
    // Carried across resumes — the R10 retry budget must survive the rebuild,
    // or every requeue would reset it and the cap would never bite.
    stallRetries: priorMeta?.stallRetries ?? 0,
    reorientRetries: priorMeta?.reorientRetries ?? 0,
    startedAt: priorMeta?.startedAt ?? nowIso(),
    updatedAt: nowIso(),
  })

  // A self-rooted clone (see createRunSandbox): real .git dir so opencode roots on
  // the sandbox, never climbing a worktree linkage back into the source repo.
  createRunSandbox(packet.frontmatter.repo, worktree, branch, packet.frontmatter.base)

  const existingGate = isResume ? readGateState(paths, runId) : undefined
  if (!existingGate) {
    writeGateState(
      paths,
      initialGateState(runId, worktree, packet.frontmatter.expected_surface, packet.frontmatter.suspicious_surface, config),
    )
  } else {
    // Resume: REFRESH the config-derived fields (gate thresholds, mutation patterns)
    // from current config — they are config, not run-state, so a run created before
    // a config/threshold change must pick the new value up. Run-state is preserved
    // (firstEditApproved, baselineDiffStats, lastAcceptedDecisionAt, reconciliation).
    // Without this a resumed run carries pre-feature gate-state forever (found live:
    // a resumed run had no checkpointToolCalls, so the volume shout was silent).
    writeGateState(paths, {
      ...existingGate,
      checkpointNudgeMs: config.thresholds.checkpointNudgeMs,
      checkpointToolCalls: config.thresholds.checkpointToolCalls,
      checkpointFiles: config.thresholds.checkpointFiles,
      checkpointLoc: config.thresholds.checkpointLoc,
      mutationCommandPatterns: config.mutationCommandPatterns,
    })
  }

  log(`run ${runId} attempt ${attempt} starting (branch ${branch})`)

  // Daddy: ONE session for the run's whole life, across attempts and
  // restarts (M6, taken literally — opencode sessions persist on disk, so a
  // resumed attempt re-uses the planner who already holds the packet and
  // every verdict he has given). Fresh only on first attempt or if the old
  // session stopped answering.
  const daddyModel = { providerId: config.daddy.providerId, modelId: config.daddy.modelId, agent: config.daddy.agent }
  let daddySessionId = priorMeta?.daddySessionId
  if (daddySessionId) {
    try {
      const ack = await client.sendMessage(
        daddySessionId,
        `The run is resuming (attempt ${attempt}); the executor session was replaced and will reconstruct from durable state. Your packet and prior verdicts stand. Reply with exactly: PLANNER_OK`,
        daddyModel,
        config.daddy.timeoutMs,
      )
      if (!extractText(ack).includes("PLANNER_OK")) daddySessionId = undefined
    } catch {
      daddySessionId = undefined
    }
    if (!daddySessionId) log(`run ${runId}: prior Daddy session unreachable — creating a fresh one`)
  }
  if (!daddySessionId) {
    daddySessionId = await client.createSession(`daddy:${runId}`, worktree)
    const daddySeed = await client.sendMessage(daddySessionId, renderDaddySeed(packet.raw), daddyModel, config.daddy.timeoutMs)
    if (!extractText(daddySeed).includes("PLANNER_OK")) {
      log(`run ${runId}: planner handshake failed — leaving queued and stopping`)
      throw new Error("Daddy session did not acknowledge the seed with PLANNER_OK")
    }
  }

  const babySessionId = await client.createSession(`baby:${runId}`, worktree)

  const ctx: RunContext = {
    config,
    paths,
    packet,
    worktree,
    client,
    daddySessionId,
    babySessionId,
    turn: 0,
    reportRejectionCount: 0,
    checkpointBounceCount: 0,
    rotationPending: false,
    toolCallsSinceDecision: 0,
  }
  ref.current = ctx

  writeMeta(paths, {
    ...readMeta(paths, runId),
    status: "running",
    babySessionId,
    daddySessionId,
    updatedAt: nowIso(),
  })
  writeValidated(paths.activeRunFile, ActiveRun, {
    runId,
    runDir: paths.runDir(runId),
    worktree,
    babySessionId,
    startedAt: nowIso(),
  })
  journal(ctx, { event: "run_started", runId, attempt })

  // Seed choice: fresh → Q1; resume with a valid checkpoint → Q2; resume
  // without one → Q8 reconciliation with the gate latched (O6).
  let seed: { name: string; text: string }
  if (!isResume) {
    seed = { name: "Q1", text: q1InitialSeed(packet, readLedger(paths, runId)) }
  } else {
    const checkpoint = latestCheckpoint(paths, runId)
    if (checkpoint) {
      seed = {
        name: "Q2",
        text: q2RotationSeed(packet, readLedger(paths, runId), checkpoint, readReviewState(paths, runId), readDecisions(paths, runId), diffStat(worktree, packet.frontmatter.base)),
      }
    } else {
      const gate = readGateState(paths, runId)
      if (gate) writeGateState(paths, { ...gate, latched: true, reconciliationRequired: true, latchReason: "reconciliation required: no valid checkpoint from the previous session" })
      seed = {
        name: "Q8",
        text: q8ReconciliationSeed(packet, readLedger(paths, runId), readReviewState(paths, runId), readDecisions(paths, runId), diffStat(worktree, packet.frontmatter.base)),
      }
    }
  }

  // §5 R10 watchdog: a per-attempt wall-clock backstop. The ladder catches a
  // turn that does nothing; this catches a run that does something every turn
  // yet never converges (a livelock — endless productive-looking rotations). On
  // expiry the attempt parks `wedged`, which the R10 recovery then retries/escalates.
  const deadlineMs = Date.now() + config.thresholds.maxRunMs
  const outcome = await turnLoop(ctx, seed, deadlineMs)
  finalizeRun(ctx, outcome)
}

// ---------------------------------------------------------------------------
// The turn loop (L1)

type RunOutcome =
  | { status: "ready_for_review" }
  | { status: "failed"; note: string }
  | { status: "blocked"; reason: BlockedReason; question: string }

// Clearing per-turn flags in a helper keeps TS from narrowing the ctx fields
// to undefined for the rest of the loop body (they are mutated behind its back
// by the bridge during sendMessage).
const resetTurnFlags = (ctx: RunContext): void => {
  ctx.checkpointWrittenThisTurn = undefined
  ctx.reportRejectionProblems = undefined
}

const turnLoop = async (ctx: RunContext, seed: { name: string; text: string }, deadlineMs: number): Promise<RunOutcome> => {
  let next = seed
  let ladder = 0
  let sendFailures = 0
  const contextBudget = babyContextBudget(ctx.config)

  for (;;) {
    // §5 R10 watchdog: evaluated at the turn boundary (where the driver owns
    // control); a hung in-flight turn is bounded separately by the transport
    // timeout. Parking `wedged` routes into the bounded R10 recovery.
    if (Date.now() >= deadlineMs) {
      const minutes = Math.round(ctx.config.thresholds.maxRunMs / 60000)
      journal(ctx, { event: "driver_note", note: `run watchdog: attempt exceeded ${minutes}min without finishing — parking wedged` })
      return { status: "blocked", reason: "wedged", question: `Attempt ran ${minutes}min without reaching a terminal state (livelock watchdog, §5 R10). See journal.` }
    }
    ctx.turn += 1
    resetTurnFlags(ctx)

    // Snapshot the worktree before the turn. With collectTurnParts feeding
    // journalTurn the whole turn's tool calls, hadAllowedToolCall is now the
    // primary progress signal; this diff delta stays as a cheap fallback for the
    // case where the message-list fetch fails (collectTurnParts then sees only
    // the final message's parts).
    const diffBefore = JSON.stringify(readDiffStats(ctx.worktree))

    journal(ctx, { event: "prompt_sent", promptName: next.name, preview: next.text.slice(0, 200) })

    let response: TurnResponse
    try {
      response = await ctx.client.sendMessage(
        ctx.babySessionId,
        next.text,
        { providerId: ctx.config.baby.providerId, modelId: ctx.config.baby.modelId, agent: ctx.config.baby.agent },
        ctx.config.baby.timeoutMs,
      )
      sendFailures = 0
    } catch (err) {
      // A dead/timed-out turn is the crash path: rotate to a fresh session via
      // reconciliation (O6) once; a second consecutive failure parks the run.
      sendFailures += 1
      journal(ctx, { event: "driver_note", note: `turn send failed (${sendFailures}): ${err instanceof Error ? err.message : String(err)}` })
      if (sendFailures >= 2) {
        return { status: "blocked", reason: "wedged", question: "Two consecutive executor turns failed to complete (model/session failure). See journal." }
      }
      await rotateSession(ctx, undefined)
      next = {
        name: "Q8",
        text: q8ReconciliationSeed(ctx.packet, readLedger(ctx.paths, ctx.packet.runId), readReviewState(ctx.paths, ctx.packet.runId), readDecisions(ctx.paths, ctx.packet.runId), diffStat(ctx.worktree, ctx.packet.frontmatter.base)),
      }
      continue
    }

    const turnParts = await collectTurnParts(ctx, response)
    ctx.lastSeenMessageId = response.info.id
    const turnFacts = journalTurn(ctx, response, turnParts, contextBudget)
    ctx.toolCallsSinceDecision += turnFacts.toolCalls

    // Evaluation — first match wins (L1).

    // 1. Park requested by the bridge (human_required / stop verdicts, M4).
    if (ctx.parkRequest) {
      return { status: "blocked", reason: ctx.parkRequest.reason, question: ctx.parkRequest.question }
    }

    // 2. Accepted report → terminal (L4).
    if (ctx.acceptedReport) {
      const report = ctx.acceptedReport
      if (report.status === "ready_for_review") return { status: "ready_for_review" }
      if (report.status === "failed") return { status: "failed", note: report.summary }
      return {
        status: "blocked",
        reason: report.blockedReason ?? "stop_condition",
        question: report.blockedQuestion ?? report.summary,
      }
    }

    // 3. Report rejected this turn → bounded retry (V1).
    const rejectionProblems = ctx.reportRejectionProblems
    if (rejectionProblems) {
      if (ctx.reportRejectionCount >= ctx.config.thresholds.reportRejectionParkAt) {
        return { status: "failed", note: `report rejected ${ctx.reportRejectionCount} times; last problems: ${rejectionProblems.join("; ")}` }
      }
      next = { name: "Q7", text: q7ReportRejected(rejectionProblems) }
      continue
    }

    // 3a. ask_planner consult queued this turn → run it OFF the MCP request path
    // (CONTRACT §9). The bridge only submitted the question; the Daddy call
    // happens here, on daddy.timeoutMs, with no MCP client to cancel it at ~5min.
    // runPlannerConsult persists the decision and clears the gate / raises a park;
    // we deliver the verdict to Baby next turn. An answered consult is progress,
    // so the no-progress ladder resets (the old flow counted every ask as a tool
    // call → progress).
    if (ctx.pendingConsult) {
      const submission = ctx.pendingConsult
      ctx.pendingConsult = undefined
      const result = await runPlannerConsult(ctx, submission)
      if ("error" in result) {
        next = { name: "Qp-fail", text: qPlannerUnavailable(result.error) }
        continue
      }
      ladder = 0
      // An accepted decision is the volume reminder's reset point — clearGate moved
      // lastAcceptedDecisionAt forward (which resets the plugin's tally), so the
      // driver's tally must zero in lockstep so the two stay aligned.
      ctx.toolCallsSinceDecision = 0
      const planner = result.planner
      // A reorient verdict: Baby has derailed (hallucination/confabulation) but
      // Daddy can state the fix. Discard Baby's session NOW (rotateSession with
      // no checkpoint — the crash path at the catch above; a derailed Baby's
      // teardown checkpoint would be garbage) and reseed a fresh one handed the
      // fix in safe_next_action. Bounded by maxReorientRetries: a Baby that keeps
      // drifting after K reseeds falls through to a human_decision park (mirrors
      // recoverStalledRun's requeue-then-escalate). Reset to 0 on any accepted
      // consult (bridge.runPlannerConsult), so K counts CONSECUTIVE misfires.
      if (planner.status === "reorient") {
        const meta = readMeta(ctx.paths, ctx.packet.runId)
        const used = meta.reorientRetries ?? 0
        if (used >= ctx.config.thresholds.maxReorientRetries) {
          return {
            status: "blocked",
            reason: "human_decision",
            question: `Baby derailed and was reoriented ${used}× but kept drifting — needs Max. Last fix offered: ${planner.safe_next_action}`,
          }
        }
        writeMeta(ctx.paths, { ...meta, reorientRetries: used + 1 })
        journal(ctx, { event: "reorient", attempt: used + 1, fix: planner.safe_next_action })
        await rotateSession(ctx, undefined)
        next = {
          name: "Q9",
          text: qReorientSeed(ctx.packet, readLedger(ctx.paths, ctx.packet.runId), readReviewState(ctx.paths, ctx.packet.runId), readDecisions(ctx.paths, ctx.packet.runId), diffStat(ctx.worktree, ctx.packet.frontmatter.base), planner),
        }
        continue
      }
      // A stop / human_required verdict is a hard park — park now rather than
      // handing Baby a decision it must not act on (runPlannerConsult already
      // recorded the same park on ctx.parkRequest; we derive it from the verdict
      // to keep TS's flow narrowing of parkRequest intact).
      if (planner.status === "human_required" || planner.status === "stop") {
        return {
          status: "blocked",
          reason: planner.status === "human_required" ? "human_decision" : "stop_condition",
          question: planner.human_decision_needed ?? planner.answer,
        }
      }
      next = { name: "Qp", text: qPlannerDecision(planner) }
      continue
    }

    // 3b. A report cleared the mechanical floor and is awaiting Daddy's final
    // review (V7) → run it OFF the MCP path, same reasoning as the consult. The
    // verdict resolves the run: accept → terminal, escalate → park, request_changes
    // → re-prompt (shares the report-rejection cap with the mechanical floor).
    if (ctx.pendingFinalReview) {
      const report = ctx.pendingFinalReview
      ctx.pendingFinalReview = undefined
      const review = await runFinalReview(ctx, report)
      if (review.verdict === "escalate") {
        return {
          status: "blocked",
          reason: "human_decision",
          question: review.human_decision_needed ?? review.notes ?? "Final review escalated a decision to Max.",
        }
      }
      if (review.verdict === "request_changes") {
        ctx.reportRejectionCount += 1
        const problems = review.findings.map((f) => `final review: ${f}`)
        journal(ctx, { event: "report_rejected", problems })
        if (ctx.reportRejectionCount >= ctx.config.thresholds.reportRejectionParkAt) {
          return { status: "failed", note: `report rejected ${ctx.reportRejectionCount} times; last problems: ${problems.join("; ")}` }
        }
        next = { name: "Q7", text: q7ReportRejected(problems) }
        continue
      }
      // accept → terminal (the verdict renders into report.md via ctx.finalReview).
      ctx.finalReview = review
      ctx.acceptedReport = report
      journal(ctx, { event: "report_accepted", status: report.status })
      return { status: "ready_for_review" }
    }

    // 4. Rotation in flight: the teardown turn must have produced a valid
    // checkpoint (O4); then the session is replaced (O5).
    if (ctx.rotationPending) {
      if (ctx.checkpointWrittenThisTurn) {
        ctx.rotationPending = false
        await rotateSession(ctx, ctx.checkpointWrittenThisTurn)
        next = {
          name: "Q2",
          text: q2RotationSeed(ctx.packet, readLedger(ctx.paths, ctx.packet.runId), ctx.checkpointWrittenThisTurn, readReviewState(ctx.paths, ctx.packet.runId), readDecisions(ctx.paths, ctx.packet.runId), diffStat(ctx.worktree, ctx.packet.frontmatter.base)),
        }
        continue
      }
      if (ctx.checkpointBounceCount > ctx.config.thresholds.checkpointBounceLimit) {
        return { status: "blocked", reason: "wedged", question: "Rotation checkpoint was invalid past the bounce limit. See journal for the validation problems." }
      }
      // A teardown turn that never CALLED write_checkpoint (e.g. emitted the
      // checkpoint as prose — seen live) is non-progress: climb the ladder so
      // a Baby that keeps answering Q5 in text parks instead of looping.
      ladder += 1
      journal(ctx, { event: "ladder_step", count: ladder })
      if (ladder >= ctx.config.thresholds.ladderParkAt) {
        return { status: "blocked", reason: "wedged", question: "Rotation teardown demanded repeatedly but write_checkpoint was never called. See journal." }
      }
      next = { name: "Q5", text: q5TeardownDemand(readLedger(ctx.paths, ctx.packet.runId)) }
      continue
    }

    // 5. Context budget reached → demand teardown (O3).
    if (turnFacts.contextTokens >= contextBudget) {
      ctx.rotationPending = true
      journal(ctx, { event: "rotation", phase: "teardown_demanded", contextTokens: turnFacts.contextTokens })
      next = { name: "Q5", text: q5TeardownDemand(readLedger(ctx.paths, ctx.packet.runId)) }
      continue
    }

    // 6. Gate trigger at turn boundary → latch + demand checkpoint (G5).
    const gate = readGateState(ctx.paths, ctx.packet.runId)
    if (gate) {
      const reason = gate.latched ? (gate.latchReason ?? "planner checkpoint required") : gateTriggerReason(gate, ctx.worktree)
      if (reason) {
        if (!gate.latched) {
          latchGate(ctx.paths, gate, reason)
          journal(ctx, { event: "gate_latched", reason })
        }
        // A latched gate at turn end is non-progress (L2): the executor was told
        // to checkpoint via ask_planner and hasn't reached it. Healthy runs don't
        // accumulate here — branch 3a resets the ladder on every answered consult,
        // so this only climbs when Baby keeps ignoring the checkpoint demand.
        ladder += 1
        journal(ctx, { event: "ladder_step", count: ladder })
        if (ladder >= ctx.config.thresholds.ladderParkAt) {
          return { status: "blocked", reason: "wedged", question: `Gate latched (${reason}) and the executor did not reach ask_planner within ${ladder} turns.` }
        }
        next = { name: "Q4", text: q4CheckpointDemand(reason, readReviewState(ctx.paths, ctx.packet.runId)) }
        continue
      }
    }

    // 7. Progress check (L2/L3). The POST response for a step-capped turn
    // carries only the FINAL message's parts (often text-only), so tool calls
    // from earlier steps are invisible here — a worktree diff delta this turn is
    // therefore equally valid evidence of progress, and the one signal a stalling
    // model can't fake (unlike bookkeeping calls like update_outcomes).
    const worktreeChanged = JSON.stringify(readDiffStats(ctx.worktree)) !== diffBefore
    const madeProgress =
      turnFacts.hadAllowedToolCall || worktreeChanged || ctx.checkpointWrittenThisTurn !== undefined
    if (!madeProgress) {
      ladder += 1
      journal(ctx, { event: "ladder_step", count: ladder })
      const action = stallAction(ladder, ctx.config.thresholds.ladderRotateAt, ctx.config.thresholds.ladderParkAt)
      if (action === "park") {
        return { status: "blocked", reason: "wedged", question: `${ladder} consecutive turns without an allowed tool call. Last text: ${turnFacts.text.slice(0, 300)}` }
      }
      // No-progress ROTATION (L3, §10): every `ladderRotateAt` dead turns, blow the
      // wedged session away and reseed from durable state — a fresh session is the
      // only rescue seen to work on a narration loop (more nudges never were), and
      // the loop keeps context too cheap to trip the budget rotation (branch 5). The
      // ladder is NOT reset, so a Baby still narrating after it marches on to the
      // park backstop (bounded — never a rotation livelock). Seed selection mirrors a
      // resume (O5/O6): latest checkpoint → Q2 (gate stays clear), none → Q8
      // reconciliation (rotateSession latches the gate).
      if (action === "rotate") {
        const checkpoint = latestCheckpoint(ctx.paths, ctx.packet.runId)
        journal(ctx, { event: "rotation", phase: "no_progress", contextTokens: turnFacts.contextTokens })
        await rotateSession(ctx, checkpoint)
        next = checkpoint
          ? { name: "Q2", text: q2RotationSeed(ctx.packet, readLedger(ctx.paths, ctx.packet.runId), checkpoint, readReviewState(ctx.paths, ctx.packet.runId), readDecisions(ctx.paths, ctx.packet.runId), diffStat(ctx.worktree, ctx.packet.frontmatter.base)) }
          : { name: "Q8", text: q8ReconciliationSeed(ctx.packet, readLedger(ctx.paths, ctx.packet.runId), readReviewState(ctx.paths, ctx.packet.runId), readDecisions(ctx.paths, ctx.packet.runId), diffStat(ctx.worktree, ctx.packet.frontmatter.base)) }
        continue
      }
      // nudge: a prose "done" without submit_report gets the report-properly prompt.
      next = looksLikeProseFinish(turnFacts.text)
        ? { name: "Q6", text: q6ReportProperly() }
        : { name: "ladder", text: ladderNudge(ladder) }
      continue
    }

    // 8. Progress, nothing pending. Once past the checkpoint interval, SHOUT
    // (non-blocking) on EVERY turn until Baby checks in — Baby keeps full tool
    // access; this is the work/time cadence reborn as a nudge, never a wall (§10,
    // G5). Deliberately un-throttled: repetition is the feature, not spam — Baby
    // is an easily-distracted child. Else neutral continuation.
    ladder = 0

    // 8a. Volume reminder VISIBILITY (§10): the plugin already shouts the SAME
    // message to Baby per tool call; here we journal a visible event when it crosses
    // (tool calls OR files/LoC since the last check-in) so Max sees it in the tail —
    // the per-call appends to Baby's tool results never surface there.
    if (gate) {
      const volumeReason = volumeCheckpointReason(
        ctx.toolCallsSinceDecision,
        diffDelta(gate.baselineDiffStats, readDiffStats(ctx.worktree)),
        ctx.config.thresholds,
      )
      if (volumeReason) journal(ctx, { event: "checkpoint_volume_nudge", reason: volumeReason, toolCalls: ctx.toolCallsSinceDecision })
    }

    const nudgeMins = gate ? checkpointNudgeDue(gate, Date.now(), ctx.config.thresholds.checkpointNudgeMs) : undefined
    next = nudgeMins !== undefined
      ? { name: "Q3", text: softCheckpointNudge(nudgeMins) }
      : { name: "Q3", text: q3Continue() }
  }
}

const looksLikeProseFinish = (text: string): boolean =>
  /\b(ready for (human )?review|implementation (is )?complete|all outcomes (are )?done|task (is )?complete)\b/i.test(text)

// ---------------------------------------------------------------------------
// Turn journaling: message text, reasoning, tool calls, verification runs.

type TurnFacts = { text: string; contextTokens: number; hadAllowedToolCall: boolean; toolCalls: number }

// opencode's POST /message returns only the FINAL assistant message's parts, so
// a turn that ends on a text/reasoning message hides every earlier-step tool
// call — reads, greps, edits, bridge calls. Progress detection that trusts only
// the final message false-wedges a hard-working investigation turn. Re-fetch the
// whole session and take every part produced since the previous turn's final
// message; on a fresh/rotated session lastSeenMessageId is absent or unfound, so
// findIndex → -1 → slice(0) → all messages (correct). Fall back to the final
// message's parts if the list call fails or yields nothing.
const collectTurnParts = async (ctx: RunContext, response: TurnResponse): Promise<MessagePart[]> => {
  try {
    const messages = await ctx.client.listMessages(ctx.babySessionId)
    const start = ctx.lastSeenMessageId
      ? messages.findIndex((m) => m.info.id === ctx.lastSeenMessageId) + 1
      : 0
    const parts = messages.slice(start).flatMap((m) => m.parts)
    return parts.length > 0 ? parts : response.parts
  } catch {
    return response.parts
  }
}

const journalTurn = (ctx: RunContext, response: TurnResponse, turnParts: MessagePart[], _contextBudget: number): TurnFacts => {
  const text = extractText(response)
  const reasoning = extractReasoning(response)
  const tokens = response.info.tokens ?? {}
  const contextTokens = (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.output ?? 0)

  let hadAllowedToolCall = false
  let toolCalls = 0

  for (const part of turnParts) {
    if (part.type !== "tool") continue
    const denied = gateDeniedPart(part)
    // Count non-bridge tool calls toward the volume reminder — the same set the
    // plugin tallies (bookkeeping bridge calls like write_checkpoint don't count).
    if (!(part.tool ?? "").toLowerCase().includes("meridian-bridge")) toolCalls += 1
    const status = part.state?.status === "error" ? "error" : "completed"
    const command = typeof part.state?.input?.command === "string" ? part.state.input.command : undefined
    const target =
      typeof part.state?.input?.filePath === "string"
        ? part.state.input.filePath
        : typeof part.state?.input?.path === "string"
          ? part.state.input.path
          : undefined
    const metadataExit = part.state?.metadata?.exit
    const exitCode = typeof metadataExit === "number" ? metadataExit : status === "completed" ? 0 : 1

    if (!denied && status !== "error") hadAllowedToolCall = true

    journal(ctx, {
      event: "tool_call",
      tool: part.tool ?? "unknown",
      ...(part.callID !== undefined ? { callId: part.callID } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(target !== undefined ? { target } : {}),
      status,
      exitCode,
      ...(part.state?.output ? { outputPreview: part.state.output.slice(0, 300) } : {}),
      gateDenied: denied,
    })
  }

  journal(ctx, {
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
  })

  return { text, contextTokens, hadAllowedToolCall, toolCalls }
}

// ---------------------------------------------------------------------------
// Rotation (O5): discard the session, fresh one seeded from durable state.

const rotateSession = async (ctx: RunContext, checkpoint: Checkpoint | undefined): Promise<void> => {
  await ctx.client.deleteSession(ctx.babySessionId)
  ctx.babySessionId = await ctx.client.createSession(`baby:${ctx.packet.runId}:r${ctx.turn}`, ctx.worktree)
  journal(ctx, { event: "rotation", phase: "session_replaced", newSessionId: ctx.babySessionId })

  const meta = readMeta(ctx.paths, ctx.packet.runId)
  writeMeta(ctx.paths, { ...meta, babySessionId: ctx.babySessionId })
  writeValidated(ctx.paths.activeRunFile, ActiveRun, {
    runId: ctx.packet.runId,
    runDir: ctx.paths.runDir(ctx.packet.runId),
    worktree: ctx.worktree,
    babySessionId: ctx.babySessionId,
    startedAt: nowIso(),
  })

  // Every replaced session re-latches first-edit so the new context clears its
  // plan before editing (O5); the crash path stacks reconciliation. See gate.ts.
  const gate = readGateState(ctx.paths, ctx.packet.runId)
  if (gate) {
    const { next, reason } = rotationGateState(gate, checkpoint !== undefined)
    writeGateState(ctx.paths, next)
    journal(ctx, { event: "gate_latched", reason })
  }
}

// ---------------------------------------------------------------------------
// Finalize (R3, R5, R6)

const finalizeRun = (ctx: RunContext, outcome: RunOutcome): void => {
  const { paths, packet } = ctx
  const runId = packet.runId

  const sha = wipCommit(ctx.worktree, `meridian: WIP ${runId} [${outcome.status}]`)
  if (sha) journal(ctx, { event: "committed", sha, message: `meridian: WIP ${runId} [${outcome.status}]` })

  if (ctx.acceptedReport) {
    const markdown = renderReportMarkdown(ctx.acceptedReport, runId, ctx.finalReview)
    writeReportFile(paths, runId, markdown)
  }

  const meta = readMeta(paths, runId)
  if (outcome.status === "blocked") {
    journal(ctx, { event: "parked", reason: outcome.reason, question: outcome.question })
    writeMeta(paths, {
      ...meta,
      status: "blocked",
      blockedReason: outcome.reason,
      blockedQuestion: outcome.question,
      endedAt: nowIso(),
    })
    log(`run ${runId} PARKED (${outcome.reason}): ${outcome.question.slice(0, 120)}`)
  } else {
    writeMeta(paths, { ...meta, status: outcome.status, endedAt: nowIso() })
    log(`run ${runId} finished: ${outcome.status}`)
  }

  if (existsSync(paths.activeRunFile)) unlinkSync(paths.activeRunFile)
}

const writeReportFile = (paths: Paths, runId: string, markdown: string): void => {
  mkdirSync(paths.runDir(runId), { recursive: true })
  // report.md is a render of validated structure, not itself re-read — plain write.
  writeFileSync(paths.reportFile(runId), markdown, "utf-8")
}
