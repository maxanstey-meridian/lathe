// Lathe gate plugin. Two synchronous responsibilities, no persistence, no prompts,
// no ladder, no file writes — lifecycle belongs to the driver.
//
//   1. DENY (tool.execute.before): block by THROWING — the only
//      hard stops are structural safety / explicit latch (see guard()).
//   2. NOTICE (tool.execute.after): on the ALLOW path, APPEND a non-blocking
//      checkpoint reminder to mutation results once the executor is past its
//      check-in interval. Never throws, never blocks.
//
// This file exports ONLY the default plugin factory. Pure
// logic lives in ./gate-core.ts. Both messages carry the LATHE GATE marker.

import {
  activeRun,
  gateState,
  isBridgeTool,
  isQuestionTool,
  isSubagentTool,
  isMutation,
  isForbiddenGitCommand,
  commandFromArgs,
  mutationDenyReason,
  checkpointNudgeNotice,
  volumeNoticeReason,
  denyMessage,
  QUESTION_MESSAGE,
  SUBAGENT_MESSAGE,
  GIT_MESSAGE,
} from "./gate-core.ts"

type ToolInput = { tool: string; sessionID: string; callID: string }
type ToolAfterInput = ToolInput & { args: unknown }
type PermissionInput = { type: string; sessionID: string; pattern?: unknown; title?: string }

const GatePlugin = async (_input: unknown) => {
  // In-memory latch (G3 tail): a hard-caught question/subagent attempt must
  // reach Daddy before the next mutation, even mid-turn before the driver sees
  // the denial in the journal. Cleared when the driver records a newer accepted
  // decision in gate-state.json. Keyed by sessionID so per-instance state is
  // isolated when the plugin runs in-process across sessions.
  const memoryLatches = new Map<string, { reason: string; at: number }>()

  // Volume reminder tally (§10): tool calls since the last accepted decision.
  // Reset when the driver records a newer accepted decision.
  const toolCallCounters = new Map<string, number>()
  const volumeCountedAgainst = new Map<string, string | undefined>()

  const memoryLatchReason = (sessionID: string, lastAcceptedDecisionAt: string | undefined): string | undefined => {
    const latch = memoryLatches.get(sessionID)
    if (!latch) return undefined
    if (lastAcceptedDecisionAt && Date.parse(lastAcceptedDecisionAt) > latch.at) {
      memoryLatches.delete(sessionID)
      return undefined
    }
    return latch.reason
  }

  const guard = (tool: string, sessionID: string, args: unknown): void => {
    const run = activeRun(sessionID)
    if (!run || run.babySessionId !== sessionID) return

    if (isQuestionTool(tool)) {
      memoryLatches.set(sessionID, { reason: "an interactive question was blocked — carry it into ask_planner", at: Date.now() })
      throw new Error(QUESTION_MESSAGE)
    }
    if (isSubagentTool(tool)) {
      memoryLatches.set(sessionID, { reason: "an exploration subagent was blocked — route the discovery question to ask_planner", at: Date.now() })
      throw new Error(SUBAGENT_MESSAGE)
    }
    if (isBridgeTool(tool)) return // G2: the key is never locked behind its own gate

    const command = commandFromArgs(args)
    if (command && isForbiddenGitCommand(command)) throw new Error(GIT_MESSAGE)

    const state = gateState(run)
    if (!state) return // no gate state → run not armed yet; the driver writes it before the first turn

    if (!isMutation(tool, args, state.mutationCommandPatterns)) return // G1: reads are never blocked

    const reason = mutationDenyReason(tool, args, state, run.worktree, memoryLatchReason(sessionID, state.lastAcceptedDecisionAt))
    if (reason) throw new Error(denyMessage(reason))
  }

  return {
    "tool.execute.before": async (toolInput: ToolInput, output: { args: unknown }) => {
      guard(toolInput.tool, toolInput.sessionID, output.args)
    },

    // Non-blocking checkpoint NOTICE on the allow path (§10): the mutation has
    // already run; we only staple a reminder to its result. Scoped to mutations
    // (where checkpoints matter) and never the bridge tools themselves. Wrapped
    // defensively — a reminder must never break a tool that already succeeded.
    "tool.execute.after": async (toolInput: ToolAfterInput, output: { output: string }) => {
      try {
        const run = activeRun(toolInput.sessionID)
        if (!run || run.babySessionId !== toolInput.sessionID) return
        if (isBridgeTool(toolInput.tool)) return
        const state = gateState(run)
        if (!state) return

        // Reset the volume tally when a newer accepted decision lands.
        const countedAgainst = volumeCountedAgainst.get(toolInput.sessionID)
        if (state.lastAcceptedDecisionAt !== countedAgainst) {
          volumeCountedAgainst.set(toolInput.sessionID, state.lastAcceptedDecisionAt)
          toolCallCounters.set(toolInput.sessionID, 0)
        }
        toolCallCounters.set(toolInput.sessionID, (toolCallCounters.get(toolInput.sessionID) ?? 0) + 1)
        const toolCallsSinceDecision = toolCallCounters.get(toolInput.sessionID) ?? 0

        const mutation = isMutation(toolInput.tool, toolInput.args, state.mutationCommandPatterns)

        // VOLUME reminder: on every tool call (reads included) once over threshold,
        // append the same message a block would show. Never thrown.
        const volume = volumeNoticeReason(state, toolCallsSinceDecision, mutation, run.worktree)
        if (volume) {
          output.output += `\n\n${denyMessage(volume)}`
          return
        }

        // Otherwise the time-based reminder, scoped to mutations as before.
        if (!mutation) return
        const notice = checkpointNudgeNotice(state, Date.now())
        if (notice) output.output += `\n\n${notice}`
      } catch {
        /* a reminder is best-effort; never let it disturb a completed tool */
      }
    },

    // Second net under the same surface for permission-mediated calls (G4 tail).
    // Headless rule: every ask gets an answer. Deny when gated, allow otherwise;
    // an unanswered ask hangs the turn until timeout.
    "permission.ask": async (permissionInput: PermissionInput, output: { status?: string }) => {
      const run = activeRun(permissionInput.sessionID)
      if (!run) return
      if (permissionInput.type === "question") {
        memoryLatches.set(permissionInput.sessionID, { reason: "an interactive question was blocked — carry it into ask_planner", at: Date.now() })
        output.status = "deny"
        return
      }
      try {
        const command = typeof permissionInput.pattern === "string" ? permissionInput.pattern : ""
        guard(`${permissionInput.type}:bash`, permissionInput.sessionID, { command })
        output.status = "allow"
      } catch {
        output.status = "deny"
      }
    },
  }
}

export default GatePlugin
