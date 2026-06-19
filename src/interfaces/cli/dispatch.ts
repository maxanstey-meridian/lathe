// ---------------------------------------------------------------------------
// Command surface (CONTRACT X1) — the parse + dispatch layer.
//
// Pure over an injected CliDeps bundle: the read/render commands run against the
// Store + the pure renderers; the three side-effectful commands (run / converge /
// super-review) and `plan` are injected callbacks, so this whole module is
// testable without spawning opencode. Interfaces call APPLICATION (use cases) and
// the pure renderers only — never infrastructure (ARCHITECTURE §1). The
// composition root in index.ts supplies the concrete callbacks.
//
// A command returns its exit code; -1 means "keep the process alive" (tail
// follow). The entry point exits on any code >= 0.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, readdirSync, statSync, watchFile, unwatchFile } from "node:fs"
import { basename, join, resolve } from "node:path"

import type { Config } from "../../config/schemas.js"
import type { Paths } from "../../config/paths.js"
import type { Store } from "../../application/ports/store.js"
import type { Repo } from "../../application/ports/repo.js"
import type { Clock } from "../../application/ports/clock.js"

import { answerRun } from "../../application/use-cases/answer-run.js"
import { acceptRun } from "../../application/use-cases/accept-run.js"
import { promoteStaged } from "../../application/use-cases/chain-promotion.js"
import { parseStaged } from "../../domain/chain.js"
import { renderJournalEvent } from "../../domain/journal.js"

import { renderStatus, renderReview, renderQueue, renderJournalReplay } from "../tui/render.js"

export type CliDeps = {
  config: Config
  paths: Paths
  store: Store
  repo: Repo
  clock: Clock
  openPlanner: () => number
  runDriver: () => Promise<void>
  convergeOnce: (runId: string) => Promise<number>
  superReviewOnce: (runId: string) => Promise<number>
  // Launches the Ink split-pane TTY tail (CONTRACT X3) and returns -1 (Ink owns
  // the terminal until 'q'); injected so dispatch stays free of the renderer + ink.
  openTail: (runId: string) => number
}

const usage = `meridian — sequential overnight executor of human-written specs

  meridian plan                 open an interactive planning session in the current repo
  meridian queue                list the queue
  meridian queue add <file>     validate a packet and admit it to the queue
  meridian queue drop <runId>   remove a packet from the queue
  meridian chain add <dir>      stage every runId-named packet in <dir> as a chained child;
                                each is promoted to the queue when its parent campaign converges
  meridian run                  drain the queue, then stay up and converge finished runs until ^C
  meridian status               what is running / queued / parked + campaign convergence
  meridian tail [runId]         the run's journal as a line stream (active run by default);
                                --no-follow for replay only
  meridian review               morning triage: terminal statuses, outcomes, questions
  meridian answer <runId> <text>   answer a parked run's question and requeue it
  meridian accept <runId> [branch] merge a ready_for_review run into [branch] (default: its base) and tidy up
  meridian super-review <runId>    dry-run the convergence reviewer (prints the verdict; changes nothing)
  meridian converge <runId>     review a finished run and ACT: converge, author a follow-up, or escalate
`

const cmdQueue = (args: string[], deps: CliDeps): number => {
  const sub = args[0]
  if (sub === "add") {
    const file = args[1]
    if (!file) {
      console.error("usage: meridian queue add <packet.md>")
      return 1
    }
    const path = resolve(file)
    if (!existsSync(path)) {
      console.error(`no such file: ${path}`)
      return 1
    }
    const runId = basename(path).replace(/\.md$/, "")
    deps.store.admitQueue(runId, readFileSync(path, "utf-8"))
    // admitQueue archives a rejected packet to the rejected dir and writes the
    // accepted one to the queue dir; the queue file's presence is the verdict.
    if (existsSync(join(deps.paths.queueDir, `${runId}.md`))) {
      console.log(`admitted: ${runId}`)
      return 0
    }
    console.error(`packet REJECTED — see ${deps.paths.rejectedDir}`)
    return 1
  }
  if (sub === "drop") {
    const runId = args[1]
    if (!runId) {
      console.error("usage: meridian queue drop <runId>")
      return 1
    }
    const present = existsSync(join(deps.paths.queueDir, `${runId}.md`))
    deps.store.archiveQueue(runId)
    console.log(present ? `dropped: ${runId}` : `not in queue: ${runId}`)
    return 0
  }
  console.log(renderQueue(deps.store))
  return 0
}

const cmdChain = (args: string[], deps: CliDeps): number => {
  if (args[0] !== "add" || !args[1]) {
    console.error("usage: meridian chain add <dir>")
    return 1
  }
  const dir = resolve(args[1])
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`not a directory: ${dir}`)
    return 1
  }

  const staged: string[] = []
  const skipped: string[] = []
  const rejected: Array<{ file: string; problems: string[] }> = []

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".md")) {
      skipped.push(file)
      continue
    }
    const raw = readFileSync(join(dir, file), "utf-8")
    const parsed = parseStaged(raw, file)
    if (parsed.ok) {
      deps.store.writeStaged(parsed.info.runId, raw)
      staged.push(parsed.info.runId)
    } else {
      rejected.push({ file, problems: parsed.problems })
    }
  }

  // Heads with no parent (and children whose parent already converged) promote
  // straight away; the rest wait in the staged registry.
  promoteStaged(deps.store, deps.repo)

  for (const runId of staged) console.log(`staged: ${runId}`)
  for (const f of skipped) console.log(`skipped (not a .md packet): ${f}`)
  for (const r of rejected) {
    console.error(`REJECTED ${r.file}:`)
    for (const p of r.problems) console.error(`  - ${p}`)
  }
  if (staged.length === 0 && rejected.length === 0) console.log("nothing to stage")
  return rejected.length > 0 ? 1 : 0
}

const cmdAnswer = (args: string[], deps: CliDeps): number => {
  const [runId, ...answerParts] = args
  const answer = answerParts.join(" ").trim()
  if (!runId || !answer) {
    console.error('usage: meridian answer <runId> "<decision>"')
    return 1
  }
  const meta = deps.store.readMetaIfExists(runId)
  const result = answerRun(deps.store, deps.repo, runId, answer, meta?.worktree ?? "", deps.clock)
  if (!result.ok) {
    console.error(result.reason)
    return 1
  }
  console.log(`answered and requeued ${runId} — it resumes at the front of the queue on the next 'meridian run'`)
  console.log(
    result.checkpoint !== undefined
      ? `(will resume from checkpoint ${result.checkpoint})`
      : "(no checkpoint — will resume via reconciliation)",
  )
  return 0
}

const cmdTail = (args: string[], deps: CliDeps): number => {
  const follow = !args.includes("--no-follow")
  const plain = args.includes("--plain")
  const runId = args.find((a) => !a.startsWith("--")) ?? deps.store.readActiveRun()?.runId
  if (!runId) {
    console.log("no active run")
    return follow ? 0 : 1
  }
  // On a real terminal the Ink split-pane UI takes over (Baby/Daddy panes, the
  // context gauge, the status strip); the plain stream remains for pipes,
  // --plain, and --no-follow replay (CONTRACT X3, D4).
  if (follow && !plain && process.stdout.isTTY) {
    return deps.openTail(runId)
  }
  const file = deps.paths.journalFile(runId)
  if (!existsSync(file)) {
    if (!follow) {
      console.error(`no journal for ${runId}`)
      return 1
    }
    console.log(`run ${runId} has not started — waiting for its journal…`)
  } else {
    console.log(renderJournalReplay(deps.store, runId))
  }
  if (!follow) return 0

  // Live follow: re-read the journal on each change and print only new events.
  // The same renderer serves replay and live (D4 — identical output).
  let printed = existsSync(file) ? deps.store.readJournal(runId).length : 0
  const flush = (): void => {
    if (!existsSync(file)) return
    const events = deps.store.readJournal(runId)
    for (const e of events.slice(printed)) console.log(renderJournalEvent(e))
    printed = events.length
  }
  watchFile(file, { interval: 1000 }, flush)
  process.on("SIGINT", () => {
    unwatchFile(file)
    process.exit(0)
  })
  return -1
}

export const dispatch = async (argv: string[], deps: CliDeps): Promise<number> => {
  const [cmd, ...args] = argv
  switch (cmd) {
    case "plan":
      return deps.openPlanner()
    case "queue":
      return cmdQueue(args, deps)
    case "chain":
      return cmdChain(args, deps)
    case "run":
      await deps.runDriver()
      return 0
    case "status":
      console.log(renderStatus(deps.store))
      return 0
    case "tail":
      return cmdTail(args, deps)
    case "review":
      console.log(renderReview(deps.store))
      return 0
    case "answer":
      return cmdAnswer(args, deps)
    case "accept": {
      const runId = args[0]
      if (!runId) {
        console.error("usage: meridian accept <runId> [targetBranch]")
        return 1
      }
      return acceptRun(runId, args[1], { store: deps.store, repo: deps.repo, clock: deps.clock, runsDir: deps.paths.runsDir })
    }
    case "super-review": {
      const runId = args[0]
      if (!runId) {
        console.error("usage: meridian super-review <runId>")
        return 1
      }
      return deps.superReviewOnce(runId)
    }
    case "converge": {
      const runId = args[0]
      if (!runId) {
        console.error("usage: meridian converge <runId>")
        return 1
      }
      return deps.convergeOnce(runId)
    }
    default:
      console.log(usage)
      return cmd ? 1 : 0
  }
}
