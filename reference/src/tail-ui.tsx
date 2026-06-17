// The Ink face of `meridian tail` (CONTRACT X3, D4): a stateless renderer over
// the run dir + the serve instance's SSE feed. Split panes for Baby and Daddy,
// a driver-event strip, and a status bar with the tokens-until-rotation gauge.

import { useEffect, useRef, useState } from "react"
import { render, Box, Text, useApp, useInput } from "ink"
import { existsSync } from "fs"
import { subscribeEvents } from "./opencode.js"
import { readValidatedIfExists, readJsonl } from "./fsio.js"
import { ActiveRun, JournalEvent, OutcomeLedger, RunMeta, GateState, type Config } from "./schemas.js"
import { renderJournalEvent, isDriverEvent } from "./journal-render.js"
import { babyContextBudget } from "./config.js"
import type { Paths } from "./paths.js"

type LineStyle = "think" | "text" | "tool"
type PaneLine = { text: string; style: LineStyle }
type PaneState = { lines: PaneLine[]; current: string; currentStyle: LineStyle; lastAt: number }

const emptyPane = (): PaneState => ({ lines: [], current: "", currentStyle: "text", lastAt: 0 })

const pushDelta = (pane: PaneState, delta: string, style: LineStyle): PaneState => {
  let { lines, current, currentStyle } = pane
  if (style !== currentStyle && current.trim()) {
    lines = [...lines, { text: current, style: currentStyle }]
    current = ""
  }
  currentStyle = style
  const segments = (current + delta).split("\n")
  current = segments.pop() ?? ""
  const newLines = segments.filter((s) => s.trim().length > 0).map((text) => ({ text, style }))
  lines = [...lines, ...newLines].slice(-300)
  return { lines, current, currentStyle, lastAt: Date.now() }
}

const pushToolLine = (pane: PaneState, text: string): PaneState => ({
  lines: [
    ...pane.lines,
    ...(pane.current.trim() ? [{ text: pane.current, style: pane.currentStyle }] : []),
    { text, style: "tool" as const },
  ].slice(-300),
  current: "",
  currentStyle: pane.currentStyle,
  lastAt: Date.now(),
})

const fmtDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s % 60).padStart(2, "0")}s`
}

// Status-bar label for the run: the packet's summary when it set one, else the
// run slug with the timestamp prefix stripped and dashes spaced. Capped so it
// never crowds out "q quits" on a normal-width terminal.
const runLabel = (runId: string, summary: string | undefined): string => {
  const raw = summary?.trim() || runId.replace(/^\d{8}-\d{6}-/, "").replace(/-/g, " ")
  return raw.length > 50 ? `${raw.slice(0, 49)}…` : raw
}

const Pane = ({ title, pane, height, accent }: { title: string; pane: PaneState; height: number; accent: string }) => {
  // 10s window: tool execution gaps (installs, typechecks) shouldn't flip the
  // floor-holder to "waiting".
  const active = Date.now() - pane.lastAt < 10_000
  const visible: PaneLine[] = [
    ...pane.lines,
    ...(pane.current.trim() ? [{ text: pane.current, style: pane.currentStyle }] : []),
  ].slice(-(height - 2))
  return (
    <Box flexDirection="column" flexGrow={1} flexBasis={0} borderStyle="round" borderColor={active ? accent : "gray"} height={height} overflow="hidden" paddingX={1}>
      <Text color={active ? accent : "gray"} bold>
        {active ? "●" : "○"} {title}
        {active ? "" : " — waiting…"}
      </Text>
      {visible.map((line, i) => (
        <Text key={i} dimColor={line.style === "think"} color={line.style === "tool" ? "cyan" : undefined} wrap="truncate-end">
          {line.text}
        </Text>
      ))}
    </Box>
  )
}

type TailDeps = { config: Config; paths: Paths; runId: string }

const TailApp = ({ config, paths, runId }: TailDeps) => {
  const { exit } = useApp()
  const [baby, setBaby] = useState<PaneState>(emptyPane())
  const [daddy, setDaddy] = useState<PaneState>(emptyPane())
  const [events, setEvents] = useState<string[]>([])
  const [now, setNow] = useState(Date.now())
  const [stats, setStats] = useState({ ctx: 0, turn: 0, rotations: 0, done: 0, total: 0, gate: "", status: "" })
  const charsThisTurn = useRef(0)
  const journalIndex = useRef(0)
  const partTypes = useRef(new Map<string, string>())
  const toolSeen = useRef(new Set<string>())
  const budget = babyContextBudget(config)
  const meta = readValidatedIfExists(paths.metaFile(runId), RunMeta)
  const startedAt = meta?.startedAt ? Date.parse(meta.startedAt) : Date.now()
  const label = runLabel(runId, meta?.summary)

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) exit()
  })

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Journal: driver events to the strip, turn/rotation/outcome facts to stats.
  useEffect(() => {
    const poll = setInterval(() => {
      const file = paths.journalFile(runId)
      if (!existsSync(file)) return
      const all = readJsonl(file, JournalEvent)
      const fresh = all.slice(journalIndex.current)
      journalIndex.current = all.length
      if (fresh.length > 0) {
        const lines = fresh.filter(isDriverEvent).map((e) => renderJournalEvent(e).split("\n")[0] ?? "")
        if (lines.length > 0) setEvents((prev) => [...prev, ...lines].slice(-50))
        for (const e of fresh) {
          if (e.event === "turn_ended") {
            charsThisTurn.current = 0
            setStats((s) => ({ ...s, ctx: e.contextTokens, turn: e.turn ?? s.turn }))
          }
          if (e.event === "rotation" && e.phase === "session_replaced") {
            charsThisTurn.current = 0
            setStats((s) => ({ ...s, ctx: 0, rotations: s.rotations + 1 }))
          }
        }
      }
      const ledger = readValidatedIfExists(paths.outcomesFile(runId), OutcomeLedger)
      const gate = readValidatedIfExists(paths.gateStateFile(runId), GateState)
      const m = readValidatedIfExists(paths.metaFile(runId), RunMeta)
      setStats((s) => ({
        ...s,
        done: ledger?.outcomes.filter((o) => o.status === "done").length ?? s.done,
        total: ledger?.outcomes.length ?? s.total,
        gate: gate?.latched ? (gate.latchReason ?? "latched") : "",
        status: m?.status ?? s.status,
      }))
    }, 1000)
    return () => clearInterval(poll)
  }, [])

  // SSE: live deltas and tool lines into the panes.
  useEffect(() => {
    const worktree = meta?.worktree ?? `${paths.runDir(runId)}/worktree`
    const speakerFor = (sessionID: string): "baby" | "daddy" | undefined => {
      const active = readValidatedIfExists(paths.activeRunFile, ActiveRun)
      if (active?.runId === runId && sessionID === active.babySessionId) return "baby"
      const m = readValidatedIfExists(paths.metaFile(runId), RunMeta)
      if (m?.daddySessionId === sessionID) return "daddy"
      if (m?.babySessionId === sessionID) return "baby"
      return undefined
    }
    const apply = (speaker: "baby" | "daddy", fn: (p: PaneState) => PaneState) =>
      speaker === "baby" ? setBaby(fn) : setDaddy(fn)

    const sub = subscribeEvents(config, worktree, (event) => {
      const props = event.properties
      if (!props) return
      if (event.type === "message.part.updated") {
        const part = (props.part ?? {}) as Record<string, unknown>
        const partId = typeof part.id === "string" ? part.id : undefined
        const type = typeof part.type === "string" ? part.type : ""
        const sessionID = typeof part.sessionID === "string" ? part.sessionID : undefined
        if (partId) partTypes.current.set(partId, type)
        if (type !== "tool" || !partId || !sessionID) return
        const state = (part.state ?? {}) as Record<string, unknown>
        const status = typeof state.status === "string" ? state.status : ""
        if ((status !== "completed" && status !== "error") || toolSeen.current.has(partId)) return
        toolSeen.current.add(partId)
        const speaker = speakerFor(sessionID)
        if (!speaker) return
        const input = (state.input ?? {}) as Record<string, unknown>
        const detail =
          typeof input.command === "string"
            ? input.command.slice(0, 90)
            : typeof input.filePath === "string"
              ? input.filePath.split("/worktree/").pop() ?? input.filePath
              : typeof input.question === "string"
                ? `"${input.question.slice(0, 80)}…"`
                : typeof input.status === "string"
                  ? input.status
                  : ""
        const tool = typeof part.tool === "string" ? part.tool : "tool"
        apply(speaker, (p) => pushToolLine(p, `${status === "error" ? "✗" : "·"} ${tool}${detail ? ` ${detail}` : ""}`))
        return
      }
      if (event.type === "message.part.delta") {
        if (props.field !== "text") return
        const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined
        const partId = typeof props.partID === "string" ? props.partID : undefined
        const delta = typeof props.delta === "string" ? props.delta : ""
        if (!sessionID || !partId || !delta) return
        const speaker = speakerFor(sessionID)
        if (!speaker) return
        if (speaker === "baby") charsThisTurn.current += delta.length
        const style: LineStyle = partTypes.current.get(partId) === "reasoning" ? "think" : "text"
        apply(speaker, (p) => pushDelta(p, delta, style))
      }
    })
    return () => sub.close()
  }, [])

  const rows = process.stdout.rows ?? 35
  const paneHeight = Math.max(8, rows - 9)
  const ctxEstimate = stats.ctx + Math.round(charsThisTurn.current / 4)
  const fraction = Math.min(1, ctxEstimate / budget)
  const barWidth = 24
  const filled = Math.round(fraction * barWidth)
  const terminal = ["ready_for_review", "blocked", "failed", "accepted"].includes(stats.status)

  return (
    <Box flexDirection="column">
      <Box>
        <Pane title="baby" pane={baby} height={paneHeight} accent="green" />
        <Pane title="daddy" pane={daddy} height={paneHeight} accent="magenta" />
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor="gray" height={5} overflow="hidden" paddingX={1}>
        {events.slice(-3).map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line}
          </Text>
        ))}
        {events.length === 0 && <Text dimColor>no driver events yet</Text>}
      </Box>
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          ctx <Text color={fraction > 0.85 ? "red" : fraction > 0.6 ? "yellow" : "green"}>{"▓".repeat(filled)}{"░".repeat(barWidth - filled)}</Text>{" "}
          {(ctxEstimate / 1000).toFixed(1)}k/{(budget / 1000).toFixed(0)}k
          {stats.rotations > 0 ? ` ♻×${stats.rotations}` : ""}
          {"  "}⏱ {fmtDuration(now - startedAt)}  turn {stats.turn || "1"}  ✓{stats.done}/{stats.total}
          {stats.gate ? <Text color="red">  ⛔ {stats.gate.slice(0, 30)}</Text> : ""}
          {terminal ? <Text color="yellow">  [{stats.status}]</Text> : ""}
          <Text color="cyan">  {label}</Text>
          <Text dimColor>  q quits</Text>
        </Text>
      </Box>
    </Box>
  )
}

export const runTailUi = (deps: TailDeps): void => {
  render(<TailApp {...deps} />)
}
