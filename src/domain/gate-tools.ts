// Pure tool classification predicates (CONTRACT §10 G3/G5).
// No fs, no child_process, no Date. These are importable by
// both the driver and the gate plugin.

import { normalize } from "node:path/posix"

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
export const FORBIDDEN_GIT = /\bgit\b[^|;&]*\b(commit|push|reset|checkout|rebase|stash|clean|merge|cherry-pick|worktree|switch|restore|add|branch|tag)\b/

export const isForbiddenGitCommand = (command: string): boolean => FORBIDDEN_GIT.test(command)

export const isMutationCommand = (command: string, patterns: string[]): boolean =>
  patterns.some((p) => {
    try {
      return new RegExp(p, "i").test(command)
    } catch {
      return false
    }
  })

// Categorise whether a tool call mutates the worktree.
// Edit tools (edit/write/patch) always mutate.
// Bash tools matching mutation patterns or shell mutation verbs / redirection / sed -i mutate.
export const isMutation = (tool: string, _args: unknown, patterns: string[]): boolean => {
  if (isEditTool(tool)) return true
  const t = tool.toLowerCase()
  if (!t.includes("bash")) return false
  const command = commandFromArgs(_args)
  if (!command) return false
  if (isMutationCommand(command, patterns)) return true
  return /(^|\s)(rm|mv|cp|mkdir|touch|tee)\s|>{1,2}|\bsed\b.*-i/.test(command)
}

// G5 (revised): block absolute-path-outside-worktree ONLY.
// The in-worktree file-surface gate is GONE.
// editTargetOutOfSurface returns the raw target string when the
// edit target is an absolute path outside the worktree (the
// only net for a wrong-target write onto real disk). Returns
// undefined for in-worktree paths.
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
  if (raw.startsWith(prefix)) {
    const afterPrefix = raw.slice(prefix.length)
    const normalized = normalize(afterPrefix)
    // An absolute path whose remainder climbs out of the worktree is invisible
    // to the run's diff — denying here is the ONLY net for it. Never fail open.
    if (normalized === ".." || normalized.startsWith("../")) return raw
    // Empty string (path resolves to worktree root itself) is allowed.
    return undefined
  }
  // An absolute path outside the worktree is invisible to the run's diff —
  // denying here is the ONLY net for it. Never fail open.
  if (raw.startsWith("/")) return raw
  // Relative path: normalize and check for parent-dir escapes.
  const normalized = normalize(raw)
  if (normalized === ".." || normalized.startsWith("../")) return raw
  return undefined
}
