// The Ink face of `meridian tail` (CONTRACT X3, D4): a stateless renderer over
// the run's durable state (through the Store) + the serve instance's live SSE
// feed (through the injected Events subscription). Split panes for Baby and
// Daddy, a driver-event strip, and a status bar with the tokens-until-rotation
// gauge. Writes nothing; identical for a live and a finished run (the finished
// run simply has no live SSE deltas, only the journal).

import { render, Box, Text, useApp, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import type { OpencodeEvent } from "../../application/ports/events.js";
import type { Store } from "../../application/ports/store.js";
import type { JournalEvent } from "../../domain/journal.js";
import { renderJournalEvent, isDriverEvent } from "../../domain/journal.js";

// Durable reads can throw before a run's files exist; in a live tail that is
// "not yet", not an error — swallow to undefined and let the next poll catch up.
const safe = <T,>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

type Subscribe = (
  directory: string,
  onEvent: (event: OpencodeEvent) => void,
) => { close: () => void };

// daddyDirectory: the planner session's directory (paths.root). Daddy's opencode
// session is rooted there, NOT in the worktree, so its events arrive on a separate
// directory-scoped feed (events.ts) — the tail subscribes to both to fill both panes.
export type TailUiDeps = {
  store: Store;
  budget: number;
  subscribe: Subscribe;
  runId: string;
  daddyDirectory: string;
  // No runId was named on the CLI → follow the chain: when the tailed run finishes,
  // hop to the next run the daemon makes active. False when the user named a runId.
  autoAdvance?: boolean;
};

const TERMINAL_STATUSES = ["ready_for_review", "blocked", "failed", "accepted"];

type LineStyle = "think" | "text" | "tool";
type PaneLine = { text: string; style: LineStyle };
type PaneState = { lines: PaneLine[]; current: string; currentStyle: LineStyle; lastAt: number };

const emptyPane = (): PaneState => ({ lines: [], current: "", currentStyle: "text", lastAt: 0 });

const pushDelta = (pane: PaneState, delta: string, style: LineStyle): PaneState => {
  let { lines, current, currentStyle } = pane;
  if (style !== currentStyle && current.trim()) {
    lines = [...lines, { text: current, style: currentStyle }];
    current = "";
  }
  currentStyle = style;
  const segments = (current + delta).split("\n");
  current = segments.pop() ?? "";
  const newLines = segments.filter((s) => s.trim().length > 0).map((text) => ({ text, style }));
  lines = [...lines, ...newLines].slice(-300);
  return { lines, current, currentStyle, lastAt: Date.now() };
};

const pushToolLine = (pane: PaneState, text: string): PaneState => ({
  lines: [
    ...pane.lines,
    ...(pane.current.trim() ? [{ text: pane.current, style: pane.currentStyle }] : []),
    { text, style: "tool" as const },
  ].slice(-300),
  current: "",
  currentStyle: pane.currentStyle,
  lastAt: Date.now(),
});

const fmtDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}m${String(s % 60).padStart(2, "0")}s`;
};

// Status-bar label: the packet summary when set, else the run slug with the
// timestamp prefix stripped. Capped so it never crowds out "q quits".
const runLabel = (runId: string, summary: string | undefined): string => {
  const raw = summary?.trim() || runId.replace(/^\d{8}-\d{6}-/, "").replace(/-/g, " ");
  return raw.length > 50 ? `${raw.slice(0, 49)}…` : raw;
};

const Pane = ({
  title,
  pane,
  height,
  width,
  accent,
}: {
  title: string;
  pane: PaneState;
  height: number;
  width: number;
  accent: string;
}) => {
  // 10s window: tool gaps (installs, typechecks) shouldn't flip "active" to "waiting".
  const active = Date.now() - pane.lastAt < 10_000;
  const visible: PaneLine[] = [
    ...pane.lines,
    ...(pane.current.trim() ? [{ text: pane.current, style: pane.currentStyle }] : []),
  ].slice(-(height - 2));
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      flexBasis={0}
      borderStyle="round"
      borderColor={active ? accent : "gray"}
      height={height}
      width={width}
      overflow="hidden"
      paddingX={1}
    >
      <Text color={active ? accent : "gray"} bold>
        {active ? "●" : "○"} {title}
        {active ? "" : " — waiting…"}
      </Text>
      {visible.map((line, i) => (
        <Text
          key={i}
          dimColor={line.style === "think"}
          color={line.style === "tool" ? "cyan" : undefined}
          wrap="truncate-end"
        >
          {line.text}
        </Text>
      ))}
    </Box>
  );
};

const TailApp = ({ store, budget, subscribe, runId, daddyDirectory }: TailUiDeps) => {
  const { exit } = useApp();
  const [baby, setBaby] = useState<PaneState>(emptyPane());
  const [daddy, setDaddy] = useState<PaneState>(emptyPane());
  const [events, setEvents] = useState<string[]>([]);
  const [now, setNow] = useState(Date.now());
  const [stats, setStats] = useState({
    ctx: 0,
    turn: 0,
    rotations: 0,
    done: 0,
    total: 0,
    gate: "",
    status: "",
  });
  const charsThisTurn = useRef(0);
  const journalIndex = useRef(0);
  const partTypes = useRef(new Map<string, string>());
  const toolSeen = useRef(new Set<string>());
  const meta = store.readMetaIfExists(runId);
  const startedAt = meta?.startedAt ? Date.parse(meta.startedAt) : Date.now();
  const label = runLabel(runId, meta?.summary);

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    }
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Journal: driver events to the strip, turn/rotation/outcome facts to stats.
  useEffect(() => {
    const poll = setInterval(() => {
      const all = safe(() => store.readJournal(runId));
      if (all) {
        const fresh = all.slice(journalIndex.current);
        journalIndex.current = all.length;
        if (fresh.length > 0) {
          const lines = fresh
            .filter(isDriverEvent)
            .map((e: JournalEvent) => renderJournalEvent(e).split("\n")[0] ?? "");
          if (lines.length > 0) {
            setEvents((prev) => [...prev, ...lines].slice(-50));
          }
          for (const e of fresh) {
            if (e.event === "turn_ended") {
              charsThisTurn.current = 0;
              setStats((s) => ({ ...s, ctx: e.contextTokens, turn: e.turn ?? s.turn }));
            }
            if (e.event === "rotation" && e.phase === "session_replaced") {
              charsThisTurn.current = 0;
              setStats((s) => ({ ...s, ctx: 0, rotations: s.rotations + 1 }));
            }
          }
        }
      }
      const ledger = safe(() => store.readLedger(runId));
      const gate = safe(() => store.readGateState(runId));
      const m = store.readMetaIfExists(runId);
      setStats((s) => ({
        ...s,
        done: ledger?.outcomes.filter((o) => o.status === "done").length ?? s.done,
        total: ledger?.outcomes.length ?? s.total,
        gate: gate?.latched ? (gate.latchReason ?? "latched") : "",
        status: m?.status ?? s.status,
      }));
    }, 1000);
    return () => clearInterval(poll);
  }, []);

  // SSE: live deltas and tool lines into the panes.
  useEffect(() => {
    const worktree = store.readMetaIfExists(runId)?.worktree;
    if (!worktree) {
      return;
    }
    const speakerFor = (sessionID: string): "baby" | "daddy" | undefined => {
      const active = store.readActiveRun();
      if (active?.runId === runId && sessionID === active.babySessionId) {
        return "baby";
      }
      const m = store.readMetaIfExists(runId);
      if (m?.daddySessionId === sessionID) {
        return "daddy";
      }
      if (m?.babySessionId === sessionID) {
        return "baby";
      }
      return undefined;
    };
    const apply = (speaker: "baby" | "daddy", fn: (p: PaneState) => PaneState) =>
      speaker === "baby" ? setBaby(fn) : setDaddy(fn);

    const onEvent = (event: OpencodeEvent) => {
      const props = event.properties;
      if (!props) {
        return;
      }
      if (event.type === "message.part.updated") {
        const part = (props.part ?? {}) as Record<string, unknown>;
        const partId = typeof part.id === "string" ? part.id : undefined;
        const type = typeof part.type === "string" ? part.type : "";
        const sessionID = typeof part.sessionID === "string" ? part.sessionID : undefined;
        if (partId) {
          partTypes.current.set(partId, type);
        }
        if (type !== "tool" || !partId || !sessionID) {
          return;
        }
        const state = (part.state ?? {}) as Record<string, unknown>;
        const status = typeof state.status === "string" ? state.status : "";
        if ((status !== "completed" && status !== "error") || toolSeen.current.has(partId)) {
          return;
        }
        toolSeen.current.add(partId);
        const speaker = speakerFor(sessionID);
        if (!speaker) {
          return;
        }
        const inputObj = (state.input ?? {}) as Record<string, unknown>;
        const detail =
          typeof inputObj.command === "string"
            ? inputObj.command.slice(0, 90)
            : typeof inputObj.filePath === "string"
              ? (inputObj.filePath.split("/worktree/").pop() ?? inputObj.filePath)
              : typeof inputObj.question === "string"
                ? `"${inputObj.question.slice(0, 80)}…"`
                : typeof inputObj.status === "string"
                  ? inputObj.status
                  : "";
        const tool = typeof part.tool === "string" ? part.tool : "tool";
        apply(speaker, (p) =>
          pushToolLine(p, `${status === "error" ? "✗" : "·"} ${tool}${detail ? ` ${detail}` : ""}`),
        );
        return;
      }
      if (event.type === "message.part.delta") {
        if (props.field !== "text") {
          return;
        }
        const sessionID = typeof props.sessionID === "string" ? props.sessionID : undefined;
        const partId = typeof props.partID === "string" ? props.partID : undefined;
        const delta = typeof props.delta === "string" ? props.delta : "";
        if (!sessionID || !partId || !delta) {
          return;
        }
        const speaker = speakerFor(sessionID);
        if (!speaker) {
          return;
        }
        if (speaker === "baby") {
          charsThisTurn.current += delta.length;
        }
        const style: LineStyle = partTypes.current.get(partId) === "reasoning" ? "think" : "text";
        apply(speaker, (p) => pushDelta(p, delta, style));
      }
    };

    // opencode's /event feed is directory-scoped by EXACT match: the worktree feed
    // carries only baby's session, the paths.root feed only daddy's planner session.
    // An ancestor directory does NOT see child sessions, so neither feed covers the
    // other — we subscribe to both and let speakerFor route each event by sessionID.
    // The two feeds never overlap, so there is no double-delivery. (An earlier
    // single-feed attempt on the ancestor left baby's pane dead. The "doubling" that
    // prompted it was the full-screen render bug below, not duplicate events.)
    const subBaby = subscribe(worktree, onEvent);
    const subDaddy = subscribe(daddyDirectory, onEvent);
    return () => {
      subBaby.close();
      subDaddy.close();
    };
  }, []);

  const rows = process.stdout.rows ?? 35;
  const columns = process.stdout.columns ?? 80;
  const frameWidth = Math.max(20, columns - 1);
  const leftPaneWidth = Math.floor(frameWidth / 2);
  const rightPaneWidth = frameWidth - leftPaneWidth;
  const paneHeight = Math.max(8, rows - 9);
  const ctxEstimate = stats.ctx + Math.round(charsThisTurn.current / 4);
  const fraction = Math.min(1, budget > 0 ? ctxEstimate / budget : 0);
  const barWidth = 24;
  const filled = Math.round(fraction * barWidth);
  const terminal = TERMINAL_STATUSES.includes(stats.status);

  return (
    <Box flexDirection="column" width={frameWidth} overflow="hidden">
      <Box width={frameWidth} overflow="hidden">
        <Pane title="baby" pane={baby} height={paneHeight} width={leftPaneWidth} accent="green" />
        <Pane title="daddy" pane={daddy} height={paneHeight} width={rightPaneWidth} accent="magenta" />
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="gray"
        height={5}
        width={frameWidth}
        overflow="hidden"
        paddingX={1}
      >
        {events.slice(-3).map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line}
          </Text>
        ))}
        {events.length === 0 && <Text dimColor>no driver events yet</Text>}
      </Box>
      <Box paddingX={1}>
        <Text wrap="truncate-end">
          ctx{" "}
          <Text color={fraction > 0.85 ? "red" : fraction > 0.6 ? "yellow" : "green"}>
            {"▓".repeat(filled)}
            {"░".repeat(barWidth - filled)}
          </Text>{" "}
          {(ctxEstimate / 1000).toFixed(1)}k/{(budget / 1000).toFixed(0)}k
          {stats.rotations > 0 ? ` ♻×${stats.rotations}` : ""}
          {"  "}⏱ {fmtDuration(now - startedAt)} turn {stats.turn || "1"} ✓{stats.done}/
          {stats.total}
          {stats.gate ? <Text color="red"> ⛔ {stats.gate.slice(0, 30)}</Text> : ""}
          {terminal ? <Text color="yellow"> [{stats.status}]</Text> : ""}
          <Text color="cyan"> {label}</Text>
          <Text dimColor> q quits</Text>
        </Text>
      </Box>
    </Box>
  );
};

// Follow the chain, not one run. Holds the tailed runId as state; when autoAdvance
// is set and the current run goes terminal, it switches to the next active run. The
// `key={runId}` forces TailApp to remount so its run-scoped effects (journal poll,
// SSE subscriptions) tear down and rebind to the new run cleanly.
const TailRoot = (deps: TailUiDeps) => {
  const [runId, setRunId] = useState(deps.runId);
  useEffect(() => {
    if (!deps.autoAdvance) {
      return;
    }
    const poll = setInterval(() => {
      const status = safe(() => deps.store.readMetaIfExists(runId)?.status);
      if (status && TERMINAL_STATUSES.includes(status)) {
        const next = safe(() => deps.store.readActiveRun()?.runId);
        if (next && next !== runId) {
          setRunId(next);
        }
      }
    }, 1000);
    return () => clearInterval(poll);
  }, [runId, deps.autoAdvance, deps.store]);
  return <TailApp key={runId} {...deps} runId={runId} />;
};

export const runTailUi = (deps: TailUiDeps): void => {
  if (!process.stdout.isTTY) {
    render(<TailRoot {...deps} />);
    return;
  }

  let restored = false;
  const restore = (): void => {
    if (restored) {
      return;
    }
    restored = true;
    process.stdout.write("\x1b[?1049l");
  };

  process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
  process.once("exit", restore);
  const instance = render(<TailRoot {...deps} />);
  void instance.waitUntilExit().then(restore);
};
