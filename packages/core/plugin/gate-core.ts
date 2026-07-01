// Pure logic for the Lathe gate plugin. Lives in a separate file so the plugin
// file itself exports ONLY the default plugin factory. This file runs inside
// OpenCode's runtime, not under the driver's tsconfig — keep it dependency-free.
//
// The plugin enforces; the driver decides (D1/D3). Everything here reads
// driver-written state and computes cheap synchronous checks. Nothing here
// writes a file.

import { readFileSync, existsSync } from "fs"
import { execSync } from "child_process"
import { join } from "path"
import { homedir } from "os"

export type ActiveRun = {
  runId: string
  runDir: string
  worktree: string
  babySessionId: string
}

export type GatePhaseValue =
  | { phase: "initial" }
  | { phase: "first-edit-latched"; reason: string }
  | { phase: "reconciliation-latched"; reason: string }
  | { phase: "cleared" }
  | { phase: "checkpoint-demand-latched"; reason: string }

export type GateStateFile = {
  runId: string
  phase: GatePhaseValue
  expectedGlobs: string[]
  baselineDiffStats: Record<string, { added: number; removed: number }>
  lastAcceptedDecisionAt?: string
  // Driver-written (§10): how long past the last planner check-in before the
  // ALLOW-path checkpoint reminder starts riding mutation results. Absent on
  // gate-state from before this field existed → falls back to 20 min.
  checkpointNudgeMs?: number
  // Driver-written (§10): volume thresholds for the non-blocking reminder. Tool
  // calls since check-in (any tool), or files/LoC of diff. Absent → no volume
  // reminder (gate-state from before these existed).
  checkpointToolCalls?: number
  checkpointFiles?: number
  checkpointLoc?: number
  mutationCommandPatterns: string[]
}

const STATE_ROOT = join(homedir(), ".meridian", "v3")

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {
    return undefined
  }
}

export const activeRun = (): ActiveRun | undefined =>
  readJson<ActiveRun>(join(STATE_ROOT, "active-run.json"))

export const gateState = (run: ActiveRun): GateStateFile | undefined => {
  return readJson<GateStateFile>(join(run.runDir, "gate-state.json"))
}

// --- tool classification -----------------------------------------------------

export const isBridgeTool = (tool: string): boolean => {
  const t = tool.toLowerCase()
  return (
    t.includes("meridian-bridge") ||
    t.endsWith("ask_planner") ||
    t.endsWith("update_outcomes") ||
    t.endsWith("write_checkpoint") ||
    t.endsWith("submit_report") ||
    t.endsWith("get_decisions")
  )
}

export const isQuestionTool = (tool: string): boolean => tool.toLowerCase().includes("question")

export const isSubagentTool = (tool: string): boolean => {
  const t = tool.toLowerCase()
  return t === "task" || t === "agent" || t.endsWith("_task") || t.includes("subagent")
}

export const isEditTool = (tool: string): boolean => {
  const t = tool.toLowerCase()
  return t.includes("edit") || t.includes("write") || t.includes("patch")
}

export const commandFromArgs = (args: unknown): string => {
  if (!args || typeof args !== "object") return ""
  const command = (args as Record<string, unknown>).command
  return typeof command === "string" ? command : ""
}

// R4: Baby never mutates git state; the driver owns commits and branches.
const FORBIDDEN_GIT = /\bgit\b[^|;&]*\b(commit|push|reset|checkout|rebase|stash|clean|merge|cherry-pick|worktree)\b/

export const isForbiddenGitCommand = (command: string): boolean => FORBIDDEN_GIT.test(command)

export const isMutationCommand = (command: string, patterns: string[]): boolean =>
  patterns.some((p) => {
    try {
      return new RegExp(p, "i").test(command)
    } catch {
      return false
    }
  })

export const isMutation = (tool: string, args: unknown, patterns: string[]): boolean => {
  if (isEditTool(tool)) return true
  const t = tool.toLowerCase()
  if (!t.includes("bash")) return false
  const command = commandFromArgs(args)
  if (!command) return false
  // Redirection/in-place flags are crude but cheap; the diff-based check catches
  // what this misses one tool call later (accepted seam).
  if (isMutationCommand(command, patterns)) return true
  return /(^|\s)(rm|mv|cp|mkdir|touch|tee)\s|>{1,2}|\bsed\b.*-i/.test(command)
}

// --- surface + counters (carried from v1 watchdog-core, proven) --------------

export const globToRegExp = (glob: string): RegExp => {
  let pattern = ""
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*"
        i += glob[i + 2] === "/" ? 3 : 2
        continue
      }
      pattern += "[^/]*"
      i += 1
      continue
    }
    pattern += /[a-zA-Z0-9_-]/.test(ch ?? "") ? ch : `\\${ch}`
    i += 1
  }
  return new RegExp(`^${pattern}$`)
}

export const editTargetOutOfSurface = (
  tool: string,
  args: unknown,
  worktree: string,
): string | undefined => {
  if (!isEditTool(tool)) return undefined
  if (!args || typeof args !== "object") return undefined
  const record = args as Record<string, unknown>
  const raw = typeof record.filePath === "string" ? record.filePath : typeof record.path === "string" ? record.path : undefined
  if (!raw) return undefined
  const prefix = worktree.endsWith("/") ? worktree : `${worktree}/`
  const relative = raw.startsWith(prefix) ? raw.slice(prefix.length) : raw
  // An absolute path outside the worktree is invisible to the run's diff —
  // denying here is the ONLY net for it (a wrong-target write into the source
  // repo). Never fail open on it. This guard stays even though the file-surface
  // gate is gone.
  if (relative.startsWith("/")) return raw
  // File-surface gate removed: in-worktree edits are no longer restricted to
  // expectedGlobs. The executor may touch any file the work needs; surface drift is
  // caught after the fact in Daddy's final review, not blocked here.
  return undefined
}

// Deny reason for a mutation attempt, or undefined. Trigger order is CONTRACT G5.
//
// Checkpoint CADENCE removed (work-interval, time-interval): a periodic forced
// checkpoint denied executor edits mid-turn and — post async-consult, where a
// forced ask_planner ENDS the turn — cancelled the turn on every trip, so a
// finished run could never chain verify→submit before the next interval cut it
// off. The gate now denies ONLY what is structurally unsafe (out-of-surface
// absolute writes) or explicitly latched (first-edit approval, reconciliation,
// an in-memory question/subagent latch). No periodic forcing.
export const mutationDenyReason = (
  tool: string,
  args: unknown,
  state: GateStateFile,
  worktree: string,
  memoryLatchReason: string | undefined,
): string | undefined => {
  const surfaceTarget = editTargetOutOfSurface(tool, args, worktree)
  if (surfaceTarget) return `attempted edit outside the handoff's expected change surface: ${surfaceTarget}`

  switch (state.phase.phase) {
    case "initial":
      if (memoryLatchReason) return memoryLatchReason
      return "first edit of the run requires an accepted planner decision"
    case "first-edit-latched":
    case "reconciliation-latched":
    case "checkpoint-demand-latched":
      return state.phase.reason
    case "cleared":
      if (memoryLatchReason) return memoryLatchReason
      return undefined
  }
}

// NON-BLOCKING per-call checkpoint reminder (§10), on the ALLOW path. The mutation runs; this notice is APPENDED to its
// result (never thrown) once the executor has gone `checkpointNudgeMs` past its last
// planner check-in, and rides EVERY subsequent mutation result until it checks
// in (clearGate moves lastAcceptedDecisionAt forward). Deliberately un-throttled.
// Returns the notice when due, else undefined.
export const checkpointNudgeNotice = (state: GateStateFile, nowMs: number): string | undefined => {
  if (state.phase.phase !== "cleared" || !state.lastAcceptedDecisionAt) return undefined
  const intervalMs = state.checkpointNudgeMs ?? 20 * 60 * 1000
  const elapsed = nowMs - Date.parse(state.lastAcceptedDecisionAt)
  if (elapsed < intervalMs) return undefined
  const minutes = Math.round(elapsed / 60_000)
  return `LATHE GATE NOTICE: ~${minutes} min since your last planner check-in. You are NOT blocked — this is a reminder, keep working with full tool access. If stuck, guessing, surprised by code, repeating a failed fix, or your plan changed, call ask_planner now. Prose is not a routed question. Otherwise carry on and call submit_report once the packet is complete.`
}

// Diff snapshot for the volume reminder's files/LoC axis. Only called on mutation
// results; reads can't move the diff, so it never runs git on the hot read path.
type DiffStats = Record<string, { added: number; removed: number }>

export const readDiffStats = (worktree: string): DiffStats => {
  const stats: DiffStats = {}
  try {
    const output = execSync("git diff --numstat HEAD", { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
    for (const line of output.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [a, r, ...pathParts] = trimmed.split(/\s+/)
      const path = pathParts.join(" ")
      if (!path) continue
      stats[path] = { added: Number.parseInt(a ?? "0", 10) || 0, removed: Number.parseInt(r ?? "0", 10) || 0 }
    }
    const untracked = execSync("git ls-files --others --exclude-standard", { cwd: worktree, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
    for (const file of untracked.split("\n").map((l) => l.trim()).filter(Boolean)) {
      if (file.startsWith("node_modules/") || file.includes("/node_modules/")) continue
      if (stats[file]) continue
      const full = join(worktree, file)
      if (!existsSync(full)) continue
      try {
        const content = readFileSync(full)
        if (content.length > 1024 * 1024 || content.includes(0)) continue
        stats[file] = { added: content.toString("utf-8").split("\n").length, removed: 0 }
      } catch {
        /* binary/unreadable untracked files do not count */
      }
    }
  } catch {
    /* unreadable diff → no delta visible to counters */
  }
  return stats
}

const diffSince = (baseline: DiffStats, current: DiffStats): { files: number; loc: number } => {
  let files = 0
  let loc = 0
  for (const file of new Set([...Object.keys(baseline), ...Object.keys(current)])) {
    const before = baseline[file] ?? { added: 0, removed: 0 }
    const after = current[file] ?? { added: 0, removed: 0 }
    const delta = Math.abs(after.added - before.added) + Math.abs(after.removed - before.removed)
    if (delta === 0) continue
    files += 1
    loc += delta
  }
  return { files, loc }
}

// NON-BLOCKING VOLUME reminder (§10) on a count axis. Returns the reason string
// (wrapped by denyMessage and APPENDED, never thrown) once the executor has done too much work since its last planner check-in:
// `checkpointToolCalls` tool calls (any tool), or `checkpointFiles`/`checkpointLoc`
// of diff. The tool-call axis is
// the in-memory tally the plugin keeps; files/LoC are only checked on a mutation
// (a read can't move the diff), keeping git off the read hot path. The reminder
// rides EVERY subsequent tool result until the executor checks in (the plugin resets the
// tally when the driver records a newer accepted decision). Returns undefined when
// not due. Same wording as `volumeCheckpointReason` so the executor and journal agree.
export const volumeNoticeReason = (
  state: GateStateFile,
  toolCallCount: number,
  isMutationCall: boolean,
  worktree: string,
): string | undefined => {
  if (typeof state.checkpointToolCalls === "number" && toolCallCount >= state.checkpointToolCalls)
    return `work checkpoint interval reached (${toolCallCount} tool calls since your last planner check-in)`
  if (!isMutationCall) return undefined
  const fileLimit = state.checkpointFiles
  const locLimit = state.checkpointLoc
  if (typeof fileLimit !== "number" && typeof locLimit !== "number") return undefined
  const delta = diffSince(state.baselineDiffStats, readDiffStats(worktree))
  if ((typeof fileLimit === "number" && delta.files >= fileLimit) || (typeof locLimit === "number" && delta.loc >= locLimit))
    return `work checkpoint interval reached (${delta.files} files, ${delta.loc} changed LoC since your last planner check-in)`
  return undefined
}

// --- messages (all carry the LATHE GATE marker the driver journals on) ----

export const denyMessage = (reason: string): string => {
  if (reason.startsWith("reconciliation required:")) {
    return `LATHE GATE BLOCKED: ${reason}. The first mutation after a no-checkpoint resume is blocked. Do not inspect, compare, reconstruct, or prove the run state. Your next tool call must be ask_planner with questionType "reconciliation"; Baby is only triggering Daddy-owned reconciliation. The driver will supply durable state and git evidence. Continue only on proceed or proceed_with_constraints.`
  }
  return `LATHE GATE BLOCKED: ${reason}. Your next tool call must be ask_planner — and it must state exactly what you were about to change (file and intended edit), WHY, and where the work stands overall. The planner can correct your direction even while approving, but only if you show it the real intent, not a summary that flatters it. Continue only on proceed or proceed_with_constraints. Reads stay available for gathering evidence.`
}

export const QUESTION_MESSAGE = `LATHE GATE BLOCKED: interactive questions are disabled — Max is not present during a run. Route it: implementation/architecture/procedure/scope questions go to ask_planner; decisions only Max can make go into submit_report with status "blocked" and the exact question.`

export const SUBAGENT_MESSAGE = `LATHE GATE BLOCKED: exploration subagents are disabled during a run. Broad discovery routes to ask_planner; bounded inspection of files the packet names stays available in this session.`

export const GIT_MESSAGE = `LATHE GATE BLOCKED: git mutations are not yours — the driver owns commits, branches, and worktrees. Work in the files; the driver commits at the end of the run.`
