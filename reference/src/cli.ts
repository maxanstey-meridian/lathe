#!/usr/bin/env node
// meridian CLI (CONTRACT §12): plan / queue / run / status / tail / review /
// answer. Every command except run/plan is a stateless renderer over the run
// dirs (D4). TUI polish (Ink) comes after the core loop is proven; these are
// the plain-text first passes.

import { spawnSync } from "child_process"
import { existsSync, statSync, watchFile, unwatchFile } from "fs"
import { resolve, join } from "path"
import { removeRunSandbox } from "./git.js"
import { loadConfig } from "./config.js"
import { listQueue, addToQueue, dropFromQueue } from "./queue.js"
import { parsePacket } from "./packet.js"
import { runQueue } from "./driver.js"
import {
  listRunIds,
  readMetaIfExists,
  appendDecision,
  latestCheckpoint,
} from "./runtime.js"
import { readValidatedIfExists, readJsonl, nowIso } from "./fsio.js"
import { subscribeEvents } from "./opencode.js"
import { renderJournalEvent } from "./journal-render.js"
import { ActiveRun, JournalEvent, OutcomeLedger, RunMeta } from "./schemas.js"
import { readGateState, clearGate } from "./gate.js"
import { writeMeta } from "./runtime.js"
import { listCampaigns } from "./campaign.js"
import { chainAdd, listStagedStatus } from "./chain.js"

const { config, paths } = loadConfig()

const usage = `meridian — sequential overnight executor of human-written specs

  meridian plan                 open an interactive planning session in the current repo
  meridian queue                list the queue
  meridian queue add <file>     validate a packet and admit it to the queue
  meridian queue drop <runId>   remove a packet from the queue
  meridian chain add <dir>      stage every runId-named packet in <dir> as a chained
                                child; each is promoted to the queue when its parent
                                campaign converges (heads with no parent admit at once)
  meridian run                  drain the queue, then stay up and converge finished runs,
                                waiting for new work until ^C (foreground, journaled)
  meridian status               what is running / queued / parked + campaign convergence
  meridian tail [runId]         live split-pane view of the run (active run by default);
                                --plain for a line stream, --no-follow for replay
  meridian review               morning triage: terminal statuses, outcomes, questions
  meridian answer <runId> <text>  answer a parked run's question and requeue it
  meridian accept <runId> [branch]  merge a ready_for_review run into [branch] (default: its base) and tidy up
  meridian super-review <runId> dry-run the convergence reviewer on a finished run (prints
                                the verdict; no packet authored, no state changed)
  meridian converge <runId>     review a finished run and ACT: converge,
                                author a follow-up pass, or escalate to you
`

const fmtOutcomes = (runId: string): string => {
  const ledger = readValidatedIfExists(paths.outcomesFile(runId), OutcomeLedger)
  if (!ledger) return ""
  const counts = { done: 0, in_progress: 0, not_started: 0, blocked: 0 }
  for (const o of ledger.outcomes) counts[o.status] += 1
  return `${counts.done}/${ledger.outcomes.length} done${counts.in_progress ? `, ${counts.in_progress} in progress` : ""}${counts.blocked ? `, ${counts.blocked} blocked` : ""}`
}

const cmdQueue = (args: string[]): number => {
  const sub = args[0]
  if (sub === "add") {
    const file = args[1]
    if (!file) {
      console.error("usage: meridian queue add <packet.md>")
      return 1
    }
    const result = addToQueue(paths, resolve(file))
    if (!result.ok) {
      console.error("packet REJECTED:")
      for (const p of result.problems) console.error(`  - ${p}`)
      return 1
    }
    console.log(`admitted: ${result.packet.runId}`)
    return 0
  }
  if (sub === "drop") {
    const runId = args[1]
    if (!runId) {
      console.error("usage: meridian queue drop <runId>")
      return 1
    }
    console.log(dropFromQueue(paths, runId) ? `dropped: ${runId}` : `not in queue: ${runId}`)
    return 0
  }
  const entries = listQueue(paths)
  if (entries.length === 0) {
    console.log("queue is empty")
    return 0
  }
  for (const [i, e] of entries.entries()) {
    const check = parsePacket(e.file, e.kind === "requeued" ? e.runId : undefined)
    const validity = check.ok ? "" : `  ⚠ INVALID: ${check.problems[0]}`
    console.log(`${i + 1}. ${e.runId}${e.kind === "requeued" ? "  (requeued)" : ""}${validity}`)
  }
  return 0
}

const cmdChain = (args: string[]): number => {
  if (args[0] !== "add" || !args[1]) {
    console.error("usage: meridian chain add <dir>")
    return 1
  }
  const dir = resolve(args[1])
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`not a directory: ${dir}`)
    return 1
  }
  const report = chainAdd(paths, dir)
  for (const runId of report.staged) console.log(`staged: ${runId}`)
  for (const f of report.skipped) console.log(`skipped (not a runId-named packet): ${f}`)
  for (const runId of report.promotion.promoted) console.log(`→ promoted to queue: ${runId}`)
  for (const r of report.rejected) {
    console.error(`REJECTED ${r.runId}:`)
    for (const p of r.problems) console.error(`  - ${p}`)
  }
  for (const f of report.promotion.failed) console.error(`promotion failed ${f.runId}: ${f.problem}`)
  if (report.staged.length === 0 && report.skipped.length === 0) console.log("nothing to stage")
  return report.rejected.length > 0 || report.promotion.failed.length > 0 ? 1 : 0
}

const cmdStatus = (): number => {
  const active = readValidatedIfExists(paths.activeRunFile, ActiveRun)
  if (active) {
    console.log(`ACTIVE: ${active.runId}  (${fmtOutcomes(active.runId)})`)
    const gate = readGateState(paths, active.runId)
    if (gate?.latched) console.log(`  gate latched: ${gate.latchReason ?? "unknown"}`)
    const journal = readJsonl(paths.journalFile(active.runId), JournalEvent)
    for (const e of journal.slice(-5)) console.log(`  ${e.at.slice(11, 19)} ${e.event}`)
  } else {
    console.log("no active run")
  }
  const queued = listQueue(paths)
  if (queued.length > 0) console.log(`queued: ${queued.map((q) => q.runId).join(", ")}`)
  const parked = listRunIds(paths)
    .map((id) => readMetaIfExists(paths, id))
    .filter((m): m is RunMeta => m !== undefined && m.status === "blocked")
  for (const m of parked)
    console.log(`parked: ${m.runId} (${m.blockedReason}${m.stallRetries ? `, ${m.stallRetries} auto-retr${m.stallRetries === 1 ? "y" : "ies"}` : ""}) — ${m.blockedQuestion?.slice(0, 100)}`)

  const campaigns = listCampaigns(paths)
  if (campaigns.length > 0) {
    console.log("campaigns:")
    for (const c of campaigns) {
      const last = c.passes[c.passes.length - 1]
      const mark = c.status === "converged" ? "✅" : c.status === "needs_max" ? "🅿" : "…"
      console.log(`  ${mark} ${c.campaignId}  [${c.status}]  pass ${last?.pass ?? 0}/${c.maxPasses}  — ${c.originalIntent.slice(0, 60)}`)
    }
  }

  const staged = listStagedStatus(paths)
  if (staged.length > 0) {
    console.log("chain (staged):")
    for (const s of staged) {
      const mark = s.state === "promotable" ? "▶" : s.state === "held" ? "🅿" : "…"
      const parent = s.parentRunId ? `← ${s.parentRunId}` : "(no parent)"
      console.log(`  ${mark} ${s.runId}  [${s.state}]  ${parent} — ${s.reason}`)
    }
  }
  return 0
}

// Live mode renders the serve instance's SSE feed — Baby's reasoning and text
// as it streams, tool calls as they complete, Daddy's replies — exactly what
// sitting at the opencode TUI shows. The journal supplies the driver-level
// events (gate, planner verdicts, verification, rotation, parks) and is the
// sole source for finished-run replay.
const DIM = "\x1b[2m"
const CYAN = "\x1b[36m"
const YELLOW = "\x1b[33m"
const RESET = "\x1b[0m"

const cmdTail = async (args: string[]): Promise<number> => {
  const follow = !args.includes("--no-follow")
  let runId = args.find((a) => !a.startsWith("--"))

  if (!runId) {
    const active = readValidatedIfExists(paths.activeRunFile, ActiveRun)
    if (active) {
      runId = active.runId
    } else {
      console.log("no active run — waiting for one to start (^C to give up)…")
      runId = await new Promise<string>((resolve) => {
        const timer = setInterval(() => {
          const a = readValidatedIfExists(paths.activeRunFile, ActiveRun)
          if (a) {
            clearInterval(timer)
            resolve(a.runId)
          }
        }, 1000)
      })
    }
  }

  const file = paths.journalFile(runId)
  if (!existsSync(file) && !follow) {
    console.error(`no journal for ${runId}`)
    return 1
  }
  if (!existsSync(file)) {
    console.log(`run ${runId} has not started — waiting for its journal…`)
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (existsSync(file)) {
          clearInterval(timer)
          resolve()
        }
      }, 1000)
    })
  }

  // On a real terminal the Ink UI takes over (split panes, gauges); the plain
  // stream remains for pipes, --plain, and --no-follow replay.
  if (follow && process.stdout.isTTY && !args.includes("--plain")) {
    const { runTailUi } = await import("./tail-ui.js")
    runTailUi({ config, paths, runId })
    return -1
  }

  // Live SSE stream. Printing comes from message.part.delta (assistant-only
  // streaming of text/thinking); message.part.updated supplies part TYPES
  // (delta events don't carry them) and tool-call state transitions. The
  // user-prompt echo arrives as a part.updated text snapshot and is never
  // printed — only deltas print prose.
  let liveStreaming = false
  const partTypes = new Map<string, string>()
  const toolPrinted = new Set<string>()
  let lastSpeaker = ""

  const speakerFor = (sessionID: string): string | undefined => {
    const active = readValidatedIfExists(paths.activeRunFile, ActiveRun)
    if (active?.runId !== runId) return undefined
    if (sessionID === active.babySessionId) return "baby"
    const meta = readMetaIfExists(paths, runId)
    if (meta?.daddySessionId === sessionID) return "daddy"
    return undefined
  }

  const renderPartUpdated = (props: Record<string, unknown>): void => {
    const part = (props.part ?? {}) as Record<string, unknown>
    const sessionID = typeof part.sessionID === "string" ? part.sessionID : undefined
    const partId = typeof part.id === "string" ? part.id : undefined
    const type = typeof part.type === "string" ? part.type : ""
    if (!sessionID || !partId) return
    partTypes.set(partId, type)
    if (type !== "tool") return
    const speaker = speakerFor(sessionID)
    if (!speaker) return

    const state = (part.state ?? {}) as Record<string, unknown>
    const status = typeof state.status === "string" ? state.status : ""
    if (status !== "completed" && status !== "error") return
    if (toolPrinted.has(partId)) return
    toolPrinted.add(partId)
    const input = (state.input ?? {}) as Record<string, unknown>
    const detail =
      typeof input.command === "string"
        ? input.command.slice(0, 100)
        : typeof input.filePath === "string"
          ? input.filePath
          : typeof input.path === "string"
            ? input.path
            : typeof input.question === "string" // ask_planner
              ? `"${input.question.slice(0, 90)}…"`
              : typeof input.status === "string" // submit_report
                ? input.status
                : typeof input.reason === "string" // write_checkpoint
                  ? input.reason
                  : ""
    const tool = typeof part.tool === "string" ? part.tool : "tool"
    const mark = status === "error" ? "✗" : "·"
    lastSpeaker = ""
    process.stdout.write(`\n${CYAN}${mark} [${speaker}] ${tool}${detail ? ` ${detail}` : ""}${RESET}\n`)
    liveStreaming = true
  }

  const renderPartDelta = (props: Record<string, unknown>): void => {
    if (props.field !== "text") return
    const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined
    const partId = typeof props.partID === "string" ? props.partID : undefined
    const delta = typeof props.delta === "string" ? props.delta : ""
    if (!sessionID || !partId || !delta) return
    const speaker = speakerFor(sessionID)
    if (!speaker) return

    const type = partTypes.get(partId) ?? "text"
    const label = `${speaker}${type === "reasoning" ? " thinking" : ""}`
    if (lastSpeaker !== label) {
      process.stdout.write(`\n${YELLOW}── ${label} ──${RESET}\n`)
      lastSpeaker = label
    }
    const dim = type === "reasoning"
    process.stdout.write(dim ? `${DIM}${delta}${RESET}` : delta)
    liveStreaming = true
  }

  let printed = 0
  const renderJournal = () => {
    const events = readJsonl(file, JournalEvent)
    for (const e of events.slice(printed)) {
      // While the live stream covers text and tool calls, the journal renders
      // only driver-level events to avoid printing everything twice.
      if (liveStreaming && (e.event === "tool_call" || e.event === "turn_ended")) continue
      lastSpeaker = ""
      console.log(renderJournalEvent(e))
    }
    printed = events.length
  }

  renderJournal()
  if (!follow) return 0

  watchFile(file, { interval: 1000 }, renderJournal)
  const worktree = readMetaIfExists(paths, runId)?.worktree ?? paths.runDir(runId) + "/worktree"
  const subscription = subscribeEvents(config, worktree, (event) => {
    const props = event.properties
    if (!props) return
    if (event.type === "message.part.updated") renderPartUpdated(props)
    else if (event.type === "message.part.delta") renderPartDelta(props)
  })
  process.on("SIGINT", () => {
    unwatchFile(file)
    subscription.close()
    process.exit(0)
  })
  return -1 // keep the process alive
}

const cmdReview = (): number => {
  const runs = listRunIds(paths)
    .map((id) => readMetaIfExists(paths, id))
    .filter((m): m is RunMeta => m !== undefined && m.status !== "running" && m.status !== "queued")
  if (runs.length === 0) {
    console.log("nothing to review")
    return 0
  }
  for (const m of runs) {
    const icon =
      m.status === "ready_for_review" ? "✅" : m.status === "accepted" ? "☑" : m.status === "blocked" ? "🅿" : m.status === "failed" ? "❌" : "⏸"
    console.log(`${icon} ${m.runId}  [${m.status}]  ${fmtOutcomes(m.runId)}  branch ${m.branch}`)
    if (m.status === "blocked") {
      console.log(`   needs: ${m.blockedQuestion ?? "(no question recorded)"}`)
      console.log(`   answer with: meridian answer ${m.runId} "<your decision>"`)
    }
    if (existsSync(paths.reportFile(m.runId))) console.log(`   report: ${paths.reportFile(m.runId)}`)
    if (existsSync(paths.nitsFile(m.runId))) console.log(`   nits:   ${paths.nitsFile(m.runId)}`)
    if (m.status === "ready_for_review") {
      console.log(`   diff:   git -C ${m.repo} diff ${m.base}...${m.branch}`)
      console.log(`   accept: meridian accept ${m.runId} [branch]   (merges into [branch], default ${m.base}; tidies the worktree)`)
    }
  }
  return 0
}

// The morning "yes": merge the run's branch into base and tidy up. Refuses to
// guess — the repo checkout must be on base and clean, or it prints the manual
// commands instead of improvising.
const cmdAccept = (args: string[]): number => {
  const runId = args[0]
  if (!runId) {
    console.error("usage: meridian accept <runId> [targetBranch]")
    return 1
  }
  const meta = readMetaIfExists(paths, runId)
  if (!meta || meta.status !== "ready_for_review") {
    console.error(`run ${runId} is not ready_for_review (status: ${meta?.status ?? "unknown"})`)
    return 1
  }
  // Merge into an explicit branch when given, else the run's recorded base. The
  // base is often NOT where you integrate — a follow-up run is branched off the
  // prior run, so meta.base can be a throwaway meridian branch. Pass the real
  // integration branch (e.g. `meridian accept <runId> main`) to land it there.
  const target = args[1] ?? meta.base
  // Array args, never a string split on spaces: paths/refs pass verbatim with no
  // shell and no word-splitting surprises.
  const git = (...a: string[]) =>
    spawnSync("git", ["-C", meta.repo, ...a], { encoding: "utf-8" })

  const head = git("rev-parse", "--abbrev-ref", "HEAD").stdout.trim()
  const dirty = git("status", "--porcelain").stdout.trim().length > 0
  if (head !== target || dirty) {
    console.error(`repo is ${dirty ? "dirty" : `on ${head}, not ${target}`} — switch to ${target} (clean) then re-run, or merge manually:`)
    console.error(`  git -C ${meta.repo} checkout ${target} && git -C ${meta.repo} merge ${meta.branch}`)
    return 1
  }

  // A self-rooted clone (current model) keeps the run branch in its OWN refs, so
  // its commits must be fetched into the source repo before the merge can resolve.
  // A legacy `git worktree` run already shares the source's ref namespace — no
  // fetch needed, and a different teardown. Discriminate on the .git shape.
  const dotGit = join(meta.worktree, ".git")
  const isClone = existsSync(dotGit) && statSync(dotGit).isDirectory()
  if (isClone) {
    const fetch = git("fetch", meta.worktree, `${meta.branch}:${meta.branch}`)
    if (fetch.status !== 0) {
      console.error(`fetch from sandbox failed:\n${fetch.stderr || fetch.stdout}`)
      return 1
    }
  }

  const merge = git("merge", meta.branch)
  if (merge.status !== 0) {
    console.error(`merge failed:\n${merge.stderr || merge.stdout}`)
    return 1
  }
  if (isClone) {
    removeRunSandbox(meta.worktree, paths.runsDir) // guarded rm -rf — refuses anything but the run's own sandbox
  } else {
    git("worktree", "remove", meta.worktree) // legacy worktree run
  }
  git("branch", "-d", meta.branch)
  writeMeta(paths, { ...meta, status: "accepted", updatedAt: nowIso() })
  console.log(`accepted ${runId} — merged ${meta.branch} into ${target}, worktree tidied`)
  console.log(`run records kept at ${paths.runDir(runId)}`)
  return 0
}

// R7: Max's answer becomes a durable decision, clears the block, requeues at
// the front. The resumed attempt seeds from the latest checkpoint (Q2) or
// reconciliation (Q8) — the driver decides at pickup.
const cmdAnswer = (args: string[]): number => {
  const [runId, ...answerParts] = args
  const answer = answerParts.join(" ").trim()
  if (!runId || !answer) {
    console.error('usage: meridian answer <runId> "<decision>"')
    return 1
  }
  const meta = readMetaIfExists(paths, runId)
  if (!meta || meta.status !== "blocked") {
    console.error(`run ${runId} is not parked (status: ${meta?.status ?? "unknown"})`)
    return 1
  }

  appendDecision(paths, runId, {
    timestamp: nowIso(),
    source: "max",
    questionType: "stop_condition",
    question: meta.blockedQuestion ?? "(parked without a recorded question)",
    evidence: [],
    status: "proceed",
    answer,
    constraints: [],
  })

  const gate = readGateState(paths, runId)
  if (gate && existsSync(meta.worktree)) clearGate(paths, gate, meta.worktree)

  // A human answered — reset the R10 auto-retry budget; this is a fresh start,
  // not another harness stall.
  const requeued: RunMeta = { ...meta, status: "queued", stallRetries: 0, updatedAt: nowIso() }
  delete requeued.blockedReason
  delete requeued.blockedQuestion
  writeMeta(paths, requeued)
  console.log(`answered and requeued ${runId} — it resumes at the front of the queue on the next 'meridian run'`)
  const checkpoint = latestCheckpoint(paths, runId)
  console.log(checkpoint ? `(will resume from checkpoint ${checkpoint.number})` : "(no checkpoint — will resume via reconciliation)")
  return 0
}

// K4: no hand-rolled chat. plan opens OpenCode in the target repo; the global
// /packet skill authors the packet into the queue dir; admission validates.
const cmdPlan = (): number => {
  console.log(`Opening OpenCode. Plan with your model of choice, then invoke /packet to author the handoff into:`)
  console.log(`  ${paths.queueDir}/YYYYMMDD-HHMMSS-<slug>.md`)
  console.log(`Then admit it with: meridian queue add <that file>\n`)
  const result = spawnSync("opencode", [], { stdio: "inherit", cwd: process.cwd() })
  return result.status ?? 0
}

const main = async (): Promise<void> => {
  const [cmd, ...args] = process.argv.slice(2)
  let code: number
  switch (cmd) {
    case "plan":
      code = cmdPlan()
      break
    case "queue":
      code = cmdQueue(args)
      break
    case "chain":
      code = cmdChain(args)
      break
    case "run":
      await runQueue(config, paths)
      code = 0
      break
    case "status":
      code = cmdStatus()
      break
    case "tail":
      code = await cmdTail(args)
      break
    case "review":
      code = cmdReview()
      break
    case "answer":
      code = cmdAnswer(args)
      break
    case "accept":
      code = cmdAccept(args)
      break
    case "super-review": {
      const runId = args[0]
      if (!runId) {
        console.error("usage: meridian super-review <runId>")
        code = 1
      } else {
        const { superReviewCommand } = await import("./super-review.js")
        code = await superReviewCommand(runId, args[1])
      }
      break
    }
    case "converge": {
      const runId = args[0]
      if (!runId) {
        console.error("usage: meridian converge <runId>")
        code = 1
      } else {
        const { convergeCommand } = await import("./converge.js")
        code = await convergeCommand(runId, args[1])
      }
      break
    }
    default:
      console.log(usage)
      code = cmd ? 1 : 0
  }
  if (code >= 0) process.exit(code)
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
