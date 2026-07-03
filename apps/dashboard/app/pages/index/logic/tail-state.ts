import type { TailEvent, TailLineStyle, TailRunStatus, TailSnapshotDto, TailSpeaker } from "@lathe/contract";

export type TailPaneLineStyle = TailLineStyle | "tool";

export type TailPaneLine = {
  readonly text: string;
  readonly style: TailPaneLineStyle;
  readonly attachment?: string;
};

export type TailPaneState = {
  readonly lines: TailPaneLine[];
  readonly current: string;
  readonly currentStyle: TailPaneLineStyle;
  readonly lastAt: number;
};

export type TailStatsState = {
  readonly contextTokens: number;
  readonly turn: number;
  readonly rotations: number;
  readonly outcomesDone: number;
  readonly outcomesTotal: number;
  readonly gateReason: string;
  readonly status: TailRunStatus;
};

export type TailViewState = {
  readonly snapshot: TailSnapshotDto | null;
  readonly panes: Record<TailSpeaker, TailPaneState>;
  readonly driverEvents: string[];
  readonly stats: TailStatsState | null;
  readonly charsThisTurn: number;
};

const MAX_PANE_LINES = 300;
const MAX_DRIVER_EVENTS = 50;

export const emptyTailPane = (): TailPaneState => ({
  lines: [],
  current: "",
  currentStyle: "text",
  lastAt: 0,
});

const tailStatsFromSnapshot = (snapshot: TailSnapshotDto): TailStatsState => ({
  contextTokens: snapshot.contextTokens,
  turn: snapshot.turn,
  rotations: snapshot.rotations,
  outcomesDone: snapshot.outcomesDone,
  outcomesTotal: snapshot.outcomesTotal,
  gateReason: snapshot.gateReason ?? "",
  status: snapshot.status,
});

const driverEventsFromSnapshot = (snapshot: TailSnapshotDto): string[] =>
  snapshot.journal
    .filter((entry) => entry.driver)
    .map((entry) => entry.line.split("\n")[0] ?? "")
    .slice(-MAX_DRIVER_EVENTS);

export const tailStateFromSnapshot = (snapshot: TailSnapshotDto | null): TailViewState => ({
  snapshot,
  panes: {
    baby: emptyTailPane(),
    daddy: emptyTailPane(),
    super: emptyTailPane(),
  },
  driverEvents: snapshot ? driverEventsFromSnapshot(snapshot) : [],
  stats: snapshot ? tailStatsFromSnapshot(snapshot) : null,
  charsThisTurn: 0,
});

const pushDelta = (pane: TailPaneState, delta: string, style: TailPaneLineStyle, now: number): TailPaneState => {
  let lines = pane.lines;
  let current = pane.current;
  let currentStyle = pane.currentStyle;

  if (style !== currentStyle && current.trim()) {
    lines = [...lines, { text: current, style: currentStyle }];
    current = "";
  }

  currentStyle = style;
  const segments = (current + delta).split("\n");
  current = segments.pop() ?? "";
  const newLines = segments
    .filter((segment) => segment.trim().length > 0)
    .map((text) => ({ text, style }));

  return {
    lines: [...lines, ...newLines].slice(-MAX_PANE_LINES),
    current,
    currentStyle,
    lastAt: now,
  };
};

const pushToolLine = (pane: TailPaneState, text: string, now: number, attachment?: string): TailPaneState => ({
  lines: [
    ...pane.lines,
    ...(pane.current.trim() ? [{ text: pane.current, style: pane.currentStyle }] : []),
    { text, style: "tool" as const, ...(attachment !== undefined ? { attachment } : {}) },
  ].slice(-MAX_PANE_LINES),
  current: "",
  currentStyle: pane.currentStyle,
  lastAt: now,
});

const updatePane = (
  state: TailViewState,
  speaker: TailSpeaker,
  update: (pane: TailPaneState) => TailPaneState,
): TailViewState => ({
  ...state,
  panes: {
    ...state.panes,
    [speaker]: update(state.panes[speaker]),
  },
});

const sameRun = (state: TailViewState, event: TailEvent): boolean => {
  if (state.snapshot === null || !("runId" in event)) {
    return true;
  }

  return event.runId === state.snapshot.runId;
};

export const visiblePaneLines = (pane: TailPaneState): TailPaneLine[] => [
  ...pane.lines,
  ...(pane.current.trim() ? [{ text: pane.current, style: pane.currentStyle }] : []),
];

export const runLabel = (runId: string, summary: string | null): string => {
  const raw = summary && summary.trim().length > 0
    ? summary.trim()
    : runId.replace(/^\d{8}-\d{6}-/, "").replace(/-/g, " ");

  return raw.length > 50 ? `${raw.slice(0, 49)}...` : raw;
};

export const formatTailDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return hours > 0
    ? `${hours}h${String(minutes).padStart(2, "0")}m`
    : `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
};

export const applyTailEvent = (state: TailViewState, event: TailEvent, now: number): TailViewState => {
  if (event.kind === "tail.run.changed") {
    return tailStateFromSnapshot(event.snapshot);
  }

  if (!sameRun(state, event)) {
    return state;
  }

  if (event.kind === "tail.journal") {
    if (!event.driver) {
      return state;
    }

    return {
      ...state,
      driverEvents: [...state.driverEvents, event.line.split("\n")[0] ?? ""].slice(-MAX_DRIVER_EVENTS),
    };
  }

  if (event.kind === "tail.stats") {
    return {
      ...state,
      snapshot: state.snapshot ? { ...state.snapshot, promoted: event.promoted, status: event.status } : state.snapshot,
      stats: {
        contextTokens: event.contextTokens,
        turn: event.turn,
        rotations: event.rotations,
        outcomesDone: event.outcomesDone,
        outcomesTotal: event.outcomesTotal,
        gateReason: event.gateReason ?? "",
        status: event.status,
      },
      charsThisTurn: 0,
    };
  }

  if (event.kind === "tail.pane.delta") {
    const next = updatePane(state, event.speaker, (pane) => pushDelta(pane, event.text, event.style, now));

    return {
      ...next,
      charsThisTurn: event.speaker === "baby" ? state.charsThisTurn + event.text.length : state.charsThisTurn,
    };
  }

  if (event.kind === "tail.pane.tool") {
    const marker = event.status === "error" ? "x" : ".";
    const detail = event.detail ? ` ${event.detail}` : "";
    return updatePane(state, event.speaker, (pane) => pushToolLine(pane, `${marker} ${event.tool}${detail}`, now, event.input));
  }

  if (event.kind === "tail.super.verdict") {
    return event.lines.reduce(
      (next, line) => updatePane(next, "super", (pane) => pushToolLine(pane, line, now)),
      state,
    );
  }

  return state;
};
