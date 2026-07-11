import { TAIL_PROTOCOL_LIMITS } from "@lathe/contract";
import type {
  TailAgentPanesDto,
  TailDriverCommandDto,
  TailDriverSegmentDto,
  TailEvent,
  TailLineStyle,
  TailPaneLineDto,
  TailRunStatus,
  TailSnapshotDto,
  TailSpeaker,
} from "@lathe/contract";

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
  readonly agentPanes: Record<TailSpeaker, TailPaneState>;
  readonly panes: Record<TailSpeaker | "driver", TailPaneState>;
  readonly driverCommands: TailDriverCommandDto[];
  readonly driverEvents: string[];
  readonly acceptanceReviewLines: string[];
  readonly stats: TailStatsState | null;
  readonly charsThisTurn: number;
};

const MAX_DRIVER_EVENTS = 50;

const boundedAttachment = (attachment: string): string => {
  if (attachment.length <= TAIL_PROTOCOL_LIMITS.lineChars) {
    return attachment;
  }
  return JSON.stringify(
    {
      truncated: true,
      preview: attachment.slice(0, Math.floor(TAIL_PROTOCOL_LIMITS.lineChars / 2)),
    },
    null,
    2,
  );
};

const boundedPaneLine = (line: TailPaneLine): TailPaneLine => ({
  ...line,
  text: line.text.slice(-TAIL_PROTOCOL_LIMITS.lineChars),
  ...(line.attachment !== undefined ? { attachment: boundedAttachment(line.attachment) } : {}),
});

const boundedPaneLines = (lines: TailPaneLine[]): TailPaneLine[] =>
  lines.map(boundedPaneLine).slice(-TAIL_PROTOCOL_LIMITS.paneLines);

const boundedReviewLines = (lines: string[]): string[] =>
  lines
    .map((text) => text.slice(-TAIL_PROTOCOL_LIMITS.lineChars))
    .slice(-TAIL_PROTOCOL_LIMITS.paneLines);

const boundedAgentPanes = (panes: TailAgentPanesDto): TailAgentPanesDto => ({
  baby: boundedPaneLines(panes.baby),
  daddy: boundedPaneLines(panes.daddy),
  super: boundedPaneLines(panes.super),
});

export const emptyTailPane = (): TailPaneState => ({
  lines: [],
  current: "",
  currentStyle: "text",
  lastAt: 0,
});

const paneFromLines = (lines: TailPaneLineDto[], lastAt = 0): TailPaneState => ({
  lines: boundedPaneLines(lines),
  current: "",
  currentStyle: "text",
  lastAt,
});

const agentPanesFromDto = (
  panes: TailAgentPanesDto,
): Pick<TailViewState["panes"], TailSpeaker> => ({
  baby: paneFromLines(panes.baby),
  daddy: paneFromLines(panes.daddy),
  super: paneFromLines(panes.super),
});

const composeAgentPanes = (
  panes: Record<TailSpeaker, TailPaneState>,
  acceptanceReviewLines: string[],
): Record<TailSpeaker, TailPaneState> => ({
  ...panes,
  super: {
    ...panes.super,
    lines: boundedPaneLines([
      ...panes.super.lines,
      ...acceptanceReviewLines.map((text) => ({ text, style: "tool" as const })),
    ]),
  },
});

const boundedDriverSegments = (
  segments: TailDriverSegmentDto[],
  maxChars: number = TAIL_PROTOCOL_LIMITS.driverCharsPerCommand,
): TailDriverSegmentDto[] => {
  const bounded = segments
    .slice(-TAIL_PROTOCOL_LIMITS.driverSegmentsPerCommand)
    .map((segment) => ({ ...segment }));
  let retainedChars = bounded.reduce((total, segment) => total + segment.text.length, 0);
  while (retainedChars > maxChars && bounded.length > 0) {
    const first = bounded[0];
    if (!first) {
      break;
    }
    const excess = retainedChars - maxChars;
    if (first.text.length <= excess) {
      retainedChars -= first.text.length;
      bounded.shift();
    } else {
      first.text = first.text.slice(excess);
      retainedChars = maxChars;
    }
  }
  return bounded;
};

const boundedDriverCommands = (commands: TailDriverCommandDto[]): TailDriverCommandDto[] => {
  let remainingChars = TAIL_PROTOCOL_LIMITS.driverCharsPerRun;
  const bounded = commands.slice(-TAIL_PROTOCOL_LIMITS.driverCommands).map((command) => ({
    ...command,
    command: command.command.slice(0, TAIL_PROTOCOL_LIMITS.lineChars),
    segments: boundedDriverSegments(command.segments),
    terminal: command.terminal ? { ...command.terminal } : null,
  }));
  for (const command of bounded.toReversed()) {
    command.segments = boundedDriverSegments(command.segments, remainingChars);
    remainingChars -= command.segments.reduce((total, segment) => total + segment.text.length, 0);
  }
  return bounded;
};

const linesFromText = (text: string, style: TailPaneLineStyle): TailPaneLine[] =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ text: line.slice(-TAIL_PROTOCOL_LIMITS.lineChars), style }));

export const renderDriverCommands = (commands: TailDriverCommandDto[]): TailPaneLine[] => {
  const lines: TailPaneLine[] = [];
  for (const command of commands) {
    for (const segment of command.segments) {
      lines.push(...linesFromText(segment.text, segment.stream === "stderr" ? "think" : "text"));
    }
    if (command.segments.length === 0 && command.terminal === null) {
      lines.push({
        text: `. [${command.phase}] $ ${command.command} (running)`,
        style: "tool",
      });
    } else if (command.terminal) {
      const started = Date.parse(command.startedAt);
      const finished = Date.parse(command.terminal.finishedAt);
      const duration =
        Number.isFinite(started) && Number.isFinite(finished)
          ? ` · ${formatDriverDuration(Math.max(0, finished - started))}`
          : "";
      lines.push({
        text: `${command.terminal.status === "completed" ? "✓" : "x"} [${command.phase}] $ ${command.command} (${command.terminal.timedOut ? "timed out" : `exit ${command.terminal.exitCode}`}${duration})`.slice(
          0,
          TAIL_PROTOCOL_LIMITS.lineChars,
        ),
        style: command.terminal.status === "error" ? "think" : "tool",
      });
    }
  }
  return lines.slice(-TAIL_PROTOCOL_LIMITS.paneLines);
};

const formatDriverDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
};

const driverPane = (
  commands: TailDriverCommandDto[],
  events: string[],
  lastAt = 0,
): TailPaneState =>
  paneFromLines(
    [
      ...renderDriverCommands(commands),
      ...events.map((text) => ({ text, style: "tool" as const })),
    ].slice(-TAIL_PROTOCOL_LIMITS.paneLines),
    lastAt,
  );

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
    .filter((entry) => entry.driver && entry.event !== "verification_run")
    .map((entry) => entry.line.split("\n")[0] ?? "")
    .slice(-MAX_DRIVER_EVENTS);

export const tailStateFromSnapshot = (snapshot: TailSnapshotDto | null): TailViewState => {
  const commands = boundedDriverCommands(snapshot?.driverCommands ?? []);
  const driverEvents = snapshot ? driverEventsFromSnapshot(snapshot) : [];
  const panes = snapshot ? boundedAgentPanes(snapshot.panes) : null;
  const acceptanceReviewLines = boundedReviewLines(snapshot?.acceptanceReviewLines ?? []);
  const agentPanes = panes
    ? agentPanesFromDto(panes)
    : { baby: emptyTailPane(), daddy: emptyTailPane(), super: emptyTailPane() };
  const composedPanes = composeAgentPanes(agentPanes, acceptanceReviewLines);
  return {
    snapshot: snapshot
      ? {
          ...snapshot,
          panes: panes ?? snapshot.panes,
          driverCommands: commands,
          acceptanceReviewLines,
        }
      : null,
    agentPanes,
    panes: {
      ...composedPanes,
      driver: driverPane(commands, driverEvents),
    },
    driverCommands: commands,
    driverEvents,
    acceptanceReviewLines,
    stats: snapshot ? tailStatsFromSnapshot(snapshot) : null,
    charsThisTurn: 0,
  };
};

const pushDelta = (
  pane: TailPaneState,
  delta: string,
  style: TailPaneLineStyle,
  now: number,
): TailPaneState => {
  let lines = pane.lines;
  let current = pane.current;
  let currentStyle = pane.currentStyle;
  if (style !== currentStyle && current.trim()) {
    lines = [...lines, boundedPaneLine({ text: current, style: currentStyle })];
    current = "";
  }
  currentStyle = style;
  const segments = (current + delta).split("\n");
  current = segments.pop() ?? "";
  const newLines = segments
    .filter((segment) => segment.trim().length > 0)
    .map((text) => ({ text: text.slice(-TAIL_PROTOCOL_LIMITS.lineChars), style }));
  return {
    lines: boundedPaneLines([...lines, ...newLines]),
    current: current.slice(-TAIL_PROTOCOL_LIMITS.lineChars),
    currentStyle,
    lastAt: now,
  };
};

const pushToolLine = (
  pane: TailPaneState,
  text: string,
  now: number,
  attachment?: string,
): TailPaneState => ({
  lines: boundedPaneLines([
    ...pane.lines,
    ...(pane.current.trim()
      ? [boundedPaneLine({ text: pane.current, style: pane.currentStyle })]
      : []),
    { text, style: "tool" as const, ...(attachment !== undefined ? { attachment } : {}) },
  ]),
  current: "",
  currentStyle: pane.currentStyle,
  lastAt: now,
});

const updatePane = (
  state: TailViewState,
  speaker: TailSpeaker,
  update: (pane: TailPaneState) => TailPaneState,
): TailViewState => {
  const agentPanes = { ...state.agentPanes, [speaker]: update(state.agentPanes[speaker]) };
  return {
    ...state,
    agentPanes,
    panes: { ...state.panes, ...composeAgentPanes(agentPanes, state.acceptanceReviewLines) },
  };
};

const flushCurrent = (pane: TailPaneState): TailPaneState =>
  pane.current.trim()
    ? {
        ...pane,
        lines: boundedPaneLines([...pane.lines, { text: pane.current, style: pane.currentStyle }]),
        current: "",
      }
    : pane;

const replaceSuperReviewState = (
  state: TailViewState,
  lines: string[],
  now: number,
): TailViewState => {
  const boundedLines = boundedReviewLines(lines);
  const transcriptSuper = { ...flushCurrent(state.agentPanes.super), lastAt: now };
  const agentPanes = { ...state.agentPanes, super: transcriptSuper };
  const composedPanes = composeAgentPanes(agentPanes, boundedLines);
  return {
    ...state,
    agentPanes,
    acceptanceReviewLines: boundedLines,
    snapshot: state.snapshot
      ? {
          ...state.snapshot,
          acceptanceReviewLines: boundedLines,
          panes: { ...state.snapshot.panes, super: transcriptSuper.lines },
        }
      : state.snapshot,
    panes: { ...state.panes, ...composedPanes },
  };
};

const sameRun = (state: TailViewState, runId: string): boolean =>
  state.snapshot === null || runId === state.snapshot.runId;

const appendDriverSegment = (
  command: TailDriverCommandDto,
  stream: TailDriverSegmentDto["stream"],
  text: string,
): TailDriverCommandDto => {
  const segments = command.segments.map((segment) => ({ ...segment }));
  const last = segments.at(-1);
  if (last?.stream === stream) {
    last.text += text;
  } else {
    segments.push({ stream, text });
  }
  return { ...command, segments: boundedDriverSegments(segments) };
};

const applyDriverEvent = (
  commands: TailDriverCommandDto[],
  event: Extract<TailEvent, { kind: "tail.driver.command" | "tail.driver.delta" }>,
): TailDriverCommandDto[] => {
  const index = commands.findIndex((command) => command.commandId === event.commandId);
  const existing = index >= 0 ? commands[index] : undefined;
  let command: TailDriverCommandDto;
  if (event.kind === "tail.driver.delta") {
    command = appendDriverSegment(
      existing ?? {
        commandId: event.commandId,
        phase: event.phase,
        command: event.commandId,
        startedAt: event.at,
        segments: [],
        terminal: null,
      },
      event.stream,
      event.text,
    );
  } else if (event.status === "running") {
    command = {
      commandId: event.commandId,
      phase: event.phase,
      command: event.command,
      startedAt: existing?.startedAt ?? event.at,
      segments: existing?.segments ?? [],
      terminal: existing?.terminal ?? null,
    };
  } else {
    command = {
      commandId: event.commandId,
      phase: event.phase,
      command: event.command,
      startedAt: existing?.startedAt ?? event.at,
      segments: existing?.segments ?? [],
      terminal: {
        status: event.status,
        exitCode: event.exitCode,
        timedOut: event.timedOut,
        finishedAt: event.at,
      },
    };
  }
  const next = [...commands];
  if (index >= 0) {
    next[index] = command;
  } else {
    next.push(command);
  }
  return boundedDriverCommands(next);
};

const withDriverCommands = (
  state: TailViewState,
  commands: TailDriverCommandDto[],
  now: number,
): TailViewState => ({
  ...state,
  snapshot: state.snapshot ? { ...state.snapshot, driverCommands: commands } : state.snapshot,
  driverCommands: commands,
  panes: { ...state.panes, driver: driverPane(commands, state.driverEvents, now) },
});

const assertNever = (value: never): never => {
  throw new Error(`Unhandled tail event: ${JSON.stringify(value)}`);
};

export const applyTailEvent = (
  state: TailViewState,
  event: TailEvent,
  now: number,
): TailViewState => {
  if (event.kind === "tail.run.changed") {
    return tailStateFromSnapshot(event.snapshot);
  }
  if (event.kind === "tail.ping") {
    return state;
  }
  if (!sameRun(state, event.runId)) {
    return state;
  }

  switch (event.kind) {
    case "tail.agent.panes.replaced": {
      const panes = boundedAgentPanes(event.panes);
      const acceptanceReviewLines = boundedReviewLines(event.acceptanceReviewLines);
      const agentPanes = agentPanesFromDto(panes);
      return {
        ...state,
        agentPanes,
        acceptanceReviewLines,
        snapshot: state.snapshot
          ? { ...state.snapshot, panes, acceptanceReviewLines }
          : state.snapshot,
        panes: { ...state.panes, ...composeAgentPanes(agentPanes, acceptanceReviewLines) },
      };
    }
    case "tail.journal": {
      if (!event.driver || event.event === "verification_run") {
        return state;
      }
      const driverEvents = [...state.driverEvents, event.line.split("\n")[0] ?? ""].slice(
        -MAX_DRIVER_EVENTS,
      );
      return {
        ...state,
        driverEvents,
        panes: { ...state.panes, driver: driverPane(state.driverCommands, driverEvents, now) },
      };
    }
    case "tail.stats": {
      return {
        ...state,
        snapshot: state.snapshot
          ? {
              ...state.snapshot,
              contextTokens: event.contextTokens,
              turn: event.turn,
              rotations: event.rotations,
              outcomesDone: event.outcomesDone,
              outcomesTotal: event.outcomesTotal,
              gateReason: event.gateReason,
              promoted: event.promoted,
              status: event.status,
            }
          : state.snapshot,
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
    case "tail.pane.delta": {
      const next = updatePane(state, event.speaker, (pane) =>
        pushDelta(pane, event.text, event.style, now),
      );
      return {
        ...next,
        charsThisTurn:
          event.speaker === "baby" ? state.charsThisTurn + event.text.length : state.charsThisTurn,
      };
    }
    case "tail.pane.tool": {
      const marker = event.status === "error" ? "x" : ".";
      const detail = event.detail ? ` ${event.detail}` : "";
      return updatePane(state, event.speaker, (pane) =>
        pushToolLine(pane, `${marker} ${event.tool}${detail}`, now, event.input),
      );
    }
    case "tail.driver.delta":
    case "tail.driver.command":
      return withDriverCommands(state, applyDriverEvent(state.driverCommands, event), now);
    case "tail.super.status":
    case "tail.super.verdict":
      return replaceSuperReviewState(state, event.lines, now);
    default:
      return assertNever(event);
  }
};

const stripHtmlComments = (lines: TailPaneLine[]): TailPaneLine[] => {
  let inComment = false;
  return lines.map((line) => {
    let text = line.text;
    let visible = "";
    while (text.length > 0) {
      if (inComment) {
        const end = text.indexOf("-->");
        if (end < 0) {
          text = "";
        } else {
          text = text.slice(end + 3);
          inComment = false;
        }
      } else {
        const start = text.indexOf("<!--");
        if (start < 0) {
          visible += text;
          text = "";
        } else {
          visible += text.slice(0, start);
          text = text.slice(start + 4);
          inComment = true;
        }
      }
    }
    return { ...line, text: visible };
  });
};

export const visiblePaneLines = (pane: TailPaneState): TailPaneLine[] =>
  stripHtmlComments([
    ...pane.lines,
    ...(pane.current.trim() ? [{ text: pane.current, style: pane.currentStyle }] : []),
  ]);

export const isTerminalTailStatus = (status: TailRunStatus): boolean =>
  status === "ready_for_review" ||
  status === "blocked" ||
  status === "failed" ||
  status === "accepted" ||
  status === "stopped";
