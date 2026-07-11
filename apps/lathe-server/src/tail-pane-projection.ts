import type { OpencodeEvent, OpencodeMessage } from "@lathe/core";
import { TAIL_PROTOCOL_LIMITS } from "@lathe/contract";
import type { TailAgentPanesDto, TailDriverCommandDto, TailEvent, TailPaneLineDto, TailSpeaker } from "@lathe/contract";

type ProjectedPart = {
  readonly key: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly partId: string;
  readonly speaker: TailSpeaker;
  readonly kind: "text" | "reasoning" | "tool";
  order: number;
  text: string;
  tool: string;
  status: string;
  detail: string;
  attachment?: string;
};

type DriverSegment = { readonly stream: "stdout" | "stderr"; text: string };
type DriverCommand = {
  order: number;
  phase: Extract<TailEvent, { kind: "tail.driver.command" }>["phase"];
  command: string;
  startedAt: string;
  readonly segments: DriverSegment[];
  terminal?: { readonly status: "completed" | "error"; readonly exitCode: number; readonly timedOut: boolean; readonly finishedAt: string };
};

export type TailPaneProjection = {
  project(runId: string, event: OpencodeEvent): void;
  mergeHistory(runId: string, speaker: TailSpeaker, sessionId: string, messages: OpencodeMessage[]): void;
  panes(runId: string): TailAgentPanesDto;
  acceptanceReviewLines(runId: string): string[];
  driverCommands(runId: string): TailDriverCommandDto[];
  projectDriver(event: Extract<TailEvent, { kind: "tail.driver.command" | "tail.driver.delta" }>): void;
  mergeVerdict(runId: string, lines: string[]): void;
  clearRun(runId: string): void;
};

const MAX_LINES = TAIL_PROTOCOL_LIMITS.paneLines;
const MAX_LINE_LENGTH = TAIL_PROTOCOL_LIMITS.lineChars;
const MAX_IDENTITIES = 2_000;
const MAX_DRIVER_COMMANDS = TAIL_PROTOCOL_LIMITS.driverCommands;
const MAX_DRIVER_SEGMENTS = TAIL_PROTOCOL_LIMITS.driverSegmentsPerCommand;
const MAX_DRIVER_CHARS = TAIL_PROTOCOL_LIMITS.driverCharsPerCommand;
const MAX_RUN_DRIVER_CHARS = TAIL_PROTOCOL_LIMITS.driverCharsPerRun;
const MAX_PART_CHARS = 256_000;
const MAX_RUN_PART_CHARS = 2_000_000;
const MAX_ATTACHMENT_CHARS = 16_000;
const MAX_RUN_ATTACHMENT_CHARS = 256_000;

const emptyPanes = (): TailAgentPanesDto => ({ baby: [], daddy: [], super: [] });

const inputOf = (state: Record<string, unknown>): Record<string, unknown> =>
  (state.input ?? {}) as Record<string, unknown>;

const toolDetail = (state: Record<string, unknown>): string => {
  const input = inputOf(state);
  if (typeof input.command === "string") return input.command.slice(0, 90);
  if (typeof input.filePath === "string") return (input.filePath.split("/worktree/").pop() ?? input.filePath).slice(0, 256);
  if (typeof input.question === "string") return `"${input.question.slice(0, 80)}..."`;
  return typeof input.status === "string" ? input.status : "";
};

const boundedLines = (text: string, style: TailPaneLineDto["style"]): TailPaneLineDto[] =>
  text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ text: line.slice(-MAX_LINE_LENGTH), style }));

const mergeText = (previous: string, next: string): string => {
  if (next === previous) return previous;
  if (next.startsWith(previous)) return next;
  if (previous.startsWith(next)) return previous;
  return next;
};

const boundedPartText = (text: string): string => text.slice(-MAX_PART_CHARS);

const attachmentOf = (input: Record<string, unknown>): string | undefined =>
  Object.keys(input).length === 0
    ? undefined
    : (() => {
        const serialized = JSON.stringify(input, null, 2);
        return serialized.length <= MAX_ATTACHMENT_CHARS
          ? serialized
          : JSON.stringify({ truncated: true, preview: serialized.slice(0, Math.floor(MAX_ATTACHMENT_CHARS / 2)) }, null, 2);
      })();

export const createTailPaneProjection = (
  speakerFor: (runId: string, sessionId: string) => TailSpeaker | undefined,
  publish: (event: TailEvent) => void,
): TailPaneProjection => {
  const parts = new Map<string, ProjectedPart>();
  const driverCommands = new Map<string, Map<string, DriverCommand>>();
  const verdictLines = new Map<string, TailPaneLineDto[]>();
  const seenEvents = new Set<string>();
  const removedParts = new Set<string>();
  let nextOrder = 0;

  const keyOf = (runId: string, sessionId: string, messageId: string, partId: string): string =>
    `${runId}:${sessionId}:${messageId}:${partId}`;

  const trimRun = (runId: string): void => {
    const runParts = [...parts.values()]
      .filter((part) => part.key.startsWith(`${runId}:`))
      .sort((a, b) => a.order - b.order);
    for (const part of runParts.slice(0, -MAX_IDENTITIES)) {
      parts.delete(part.key);
    }
    let retainedPartChars = 0;
    let retainedAttachmentChars = 0;
    for (const part of runParts.slice(-MAX_IDENTITIES).toReversed()) {
      const remaining = MAX_RUN_PART_CHARS - retainedPartChars;
      if (remaining <= 0) {
        parts.delete(part.key);
        continue;
      }
      if (part.text.length > remaining) {
        part.text = part.text.slice(-remaining);
      }
      retainedPartChars += part.text.length;
      if (part.attachment) {
        if (retainedAttachmentChars + part.attachment.length > MAX_RUN_ATTACHMENT_CHARS) {
          delete part.attachment;
        } else {
          retainedAttachmentChars += part.attachment.length;
        }
      }
    }
    const commands = driverCommands.get(runId);
    if (commands && commands.size > MAX_DRIVER_COMMANDS) {
      const oldest = [...commands.entries()]
        .sort(([, a], [, b]) => a.order - b.order)
        .slice(0, commands.size - MAX_DRIVER_COMMANDS);
      for (const [commandId] of oldest) {
        commands.delete(commandId);
      }
    }
    if (commands) {
      let remainingChars = MAX_RUN_DRIVER_CHARS;
      for (const command of [...commands.values()].sort((a, b) => b.order - a.order)) {
        let commandChars = command.segments.reduce((total, segment) => total + segment.text.length, 0);
        while (commandChars > remainingChars && command.segments.length > 0) {
          const first = command.segments[0];
          if (!first) break;
          const excess = commandChars - remainingChars;
          if (first.text.length <= excess) {
            commandChars -= first.text.length;
            command.segments.shift();
          } else {
            first.text = first.text.slice(excess);
            commandChars = remainingChars;
          }
        }
        remainingChars -= commandChars;
      }
    }
    if (seenEvents.size > MAX_IDENTITIES * 4) {
      const oldest = [...seenEvents].slice(0, seenEvents.size - MAX_IDENTITIES * 4);
      for (const eventId of oldest) seenEvents.delete(eventId);
    }
    if (removedParts.size > MAX_IDENTITIES * 2) {
      const oldest = [...removedParts].slice(0, removedParts.size - MAX_IDENTITIES * 2);
      for (const key of oldest) removedParts.delete(key);
    }
  };

  const render = (runId: string): TailAgentPanesDto => {
    const panes = emptyPanes();
    const ordered = [...parts.values()]
      .filter((part) => part.key.startsWith(`${runId}:`))
      .sort((a, b) => a.order - b.order);
    for (const part of ordered) {
      const lines = panes[part.speaker];
      if (part.kind === "tool") {
        const marker = part.status === "error" ? "x" : ".";
        lines.push({
          text: `${marker} ${part.tool}${part.detail ? ` ${part.detail}` : ""}`.slice(0, MAX_LINE_LENGTH),
          style: "tool",
          ...(part.attachment ? { attachment: part.attachment } : {}),
        });
      } else {
        lines.push(...boundedLines(part.text, part.kind === "reasoning" ? "think" : "text"));
      }
    }
    panes.baby = panes.baby.slice(-MAX_LINES);
    panes.daddy = panes.daddy.slice(-MAX_LINES);
    panes.super = panes.super.slice(-MAX_LINES);
    return panes;
  };

  const acceptanceReviewLines = (runId: string): string[] =>
    (verdictLines.get(runId) ?? []).map((line) => line.text).slice(-MAX_LINES);

  const renderDriverCommands = (runId: string): TailDriverCommandDto[] =>
    [...(driverCommands.get(runId)?.entries() ?? [])]
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([commandId, command]) => ({
        commandId,
        phase: command.phase,
        command: command.command,
        startedAt: command.startedAt,
        segments: command.segments.map((segment) => ({ ...segment })),
        terminal: command.terminal ? { ...command.terminal } : null,
      }));

  const replace = (runId: string): void => {
    publish({
      kind: "tail.agent.panes.replaced",
      runId,
      panes: render(runId),
      acceptanceReviewLines: acceptanceReviewLines(runId),
    });
  };

  const projectDriver = (event: Extract<TailEvent, { kind: "tail.driver.command" | "tail.driver.delta" }>): void => {
    const commands = driverCommands.get(event.runId) ?? new Map<string, DriverCommand>();
    const existing = commands.get(event.commandId);
    if (event.kind === "tail.driver.command" && event.status === "running") {
      if (existing) {
        existing.phase = event.phase;
        existing.command = event.command.slice(0, MAX_LINE_LENGTH);
      } else {
        commands.set(event.commandId, {
          order: nextOrder++,
          phase: event.phase,
          command: event.command.slice(0, MAX_LINE_LENGTH),
          startedAt: event.at,
          segments: [],
        });
      }
    } else if (event.kind === "tail.driver.delta") {
      const command = existing ?? {
        order: nextOrder++,
        phase: event.phase,
        command: event.commandId.slice(0, MAX_LINE_LENGTH),
        startedAt: event.at,
        segments: [],
      };
      const last = command.segments.at(-1);
      if (last?.stream === event.stream) {
        last.text += event.text;
      } else {
        command.segments.push({ stream: event.stream, text: event.text });
      }
      while (command.segments.length > MAX_DRIVER_SEGMENTS) {
        command.segments.shift();
      }
      let retainedChars = command.segments.reduce((total, segment) => total + segment.text.length, 0);
      while (retainedChars > MAX_DRIVER_CHARS && command.segments.length > 0) {
        const first = command.segments[0]!;
        const excess = retainedChars - MAX_DRIVER_CHARS;
        if (first.text.length <= excess) {
          retainedChars -= first.text.length;
          command.segments.shift();
        } else {
          first.text = first.text.slice(excess);
          retainedChars = MAX_DRIVER_CHARS;
        }
      }
      commands.set(event.commandId, command);
    } else {
      const command = existing ?? {
        order: nextOrder++,
        phase: event.phase,
        command: event.command.slice(0, MAX_LINE_LENGTH),
        startedAt: event.at,
        segments: [],
      };
      command.terminal = {
        status: event.status,
        exitCode: event.exitCode,
        timedOut: event.timedOut,
        finishedAt: event.at,
      };
      commands.set(event.commandId, command);
    }
    driverCommands.set(event.runId, commands);
    trimRun(event.runId);
    publish(event);
  };

  const mergeVerdict = (runId: string, lines: string[]): void => {
    verdictLines.set(runId, lines.map((text) => ({ text: text.slice(-MAX_LINE_LENGTH), style: "tool" })));
  };

  const project = (runId: string, event: OpencodeEvent): void => {
    const eventKey = event.id ? `${runId}:${event.id}` : undefined;
    if (eventKey && seenEvents.has(eventKey)) return;
    if (eventKey) seenEvents.add(eventKey);
    const props = event.properties;
    if (!props) return;

    if (event.type === "message.part.removed") {
      const sessionId = typeof props.sessionID === "string" ? props.sessionID : "";
      const messageId = typeof props.messageID === "string" ? props.messageID : "";
      const partId = typeof props.partID === "string" ? props.partID : "";
      if (sessionId && messageId && partId) {
        const key = keyOf(runId, sessionId, messageId, partId);
        const removed = parts.delete(key);
        removedParts.add(key);
        if (removed) replace(runId);
      }
      trimRun(runId);
      return;
    }

    if (event.type === "message.part.updated") {
      const raw = (props.part ?? {}) as Record<string, unknown>;
      const sessionId = typeof raw.sessionID === "string" ? raw.sessionID : "";
      const messageId = typeof raw.messageID === "string" ? raw.messageID : "";
      const partId = typeof raw.id === "string" ? raw.id : "";
      const type = raw.type === "reasoning" || raw.type === "tool" ? raw.type : raw.type === "text" ? "text" : undefined;
      const speaker = sessionId ? speakerFor(runId, sessionId) : undefined;
      if (!speaker || !messageId || !partId || !type) return;
      const key = keyOf(runId, sessionId, messageId, partId);
      removedParts.delete(key);
      const previous = parts.get(key);
      if (type === "tool") {
        const state = (raw.state ?? {}) as Record<string, unknown>;
        const input = inputOf(state);
        const incomingStatus = typeof state.status === "string" ? state.status : "pending";
        const previousTerminal = previous?.status === "completed" || previous?.status === "error";
        const status = previousTerminal && incomingStatus !== "completed" && incomingStatus !== "error"
          ? previous.status
          : incomingStatus;
        const attachment = attachmentOf(input);
        const next: ProjectedPart = {
          key, sessionId, messageId, partId, speaker, kind: "tool",
          order: previous?.order ?? nextOrder++,
          text: "",
          tool: typeof raw.tool === "string" ? raw.tool : "tool",
          status,
          detail: toolDetail(state),
          ...(attachment ? { attachment } : {}),
        };
        parts.set(key, next);
        const statusChanged = previous !== undefined && previous.status !== status;
        if (!previous) {
          publish({ kind: "tail.pane.tool", runId, speaker, status: status === "error" ? "error" : status === "completed" ? "completed" : "running", tool: next.tool, detail: next.detail, ...(attachment ? { input: attachment } : {}) });
        }
        const visibleChanged = previous !== undefined && (
          (previous.status === "error") !== (status === "error") ||
          previous.tool !== next.tool ||
          previous.detail !== next.detail ||
          previous.attachment !== next.attachment
        );
        if (visibleChanged || statusChanged) {
          replace(runId);
        }
        trimRun(runId);
        return;
      }
      const text = typeof raw.text === "string" ? raw.text : "";
      const merged = boundedPartText(mergeText(previous?.text ?? "", text));
      parts.set(key, { key, sessionId, messageId, partId, speaker, kind: type, order: previous?.order ?? nextOrder++, text: merged, tool: "", status: "", detail: "" });
      const appendOnly = merged.startsWith(previous?.text ?? "");
      const delta = appendOnly ? merged.slice((previous?.text ?? "").length) : "";
      if (!appendOnly) {
        replace(runId);
      } else if (delta) {
          publish({ kind: "tail.pane.delta", runId, speaker, style: type === "reasoning" ? "think" : "text", text: delta.slice(-MAX_PART_CHARS) });
      }
      trimRun(runId);
      return;
    }

    if (event.type === "message.part.delta" && props.field === "text") {
      const sessionId = typeof props.sessionID === "string" ? props.sessionID : "";
      const messageId = typeof props.messageID === "string" ? props.messageID : "";
      const partId = typeof props.partID === "string" ? props.partID : "";
      const delta = typeof props.delta === "string" ? props.delta : "";
      const speaker = sessionId ? speakerFor(runId, sessionId) : undefined;
      if (!speaker || !messageId || !partId || !delta) return;
      const key = keyOf(runId, sessionId, messageId, partId);
      removedParts.delete(key);
      const previous = parts.get(key);
      const kind = previous?.kind === "reasoning" ? "reasoning" : "text";
      parts.set(key, { key, sessionId, messageId, partId, speaker, kind, order: previous?.order ?? nextOrder++, text: boundedPartText(`${previous?.text ?? ""}${delta}`), tool: "", status: "", detail: "" });
      publish({ kind: "tail.pane.delta", runId, speaker, style: kind === "reasoning" ? "think" : "text", text: delta.slice(-MAX_PART_CHARS) });
      trimRun(runId);
    }
  };

  const mergeHistory = (runId: string, speaker: TailSpeaker, sessionId: string, messages: OpencodeMessage[]): void => {
    const historyKeys: string[] = [];
    for (const message of messages) {
      if (message.info?.role !== "assistant") continue;
      const messageId = message.info.id ?? "";
      if (!messageId) continue;
      for (const raw of message.parts ?? []) {
        const type = raw.type === "reasoning" || raw.type === "tool" ? raw.type : raw.type === "text" ? "text" : undefined;
        const partId = raw.id ?? "";
        if (!type || !partId) continue;
        const key = keyOf(runId, sessionId, messageId, partId);
        if (removedParts.has(key)) continue;
        historyKeys.push(key);
        const previous = parts.get(key);
        if (type === "tool") {
          const state = (raw.state ?? {}) as Record<string, unknown>;
          const input = inputOf(state);
          const attachment = attachmentOf(input);
          const historyStatus = typeof state.status === "string" ? state.status : "completed";
          const status = historyStatus === "completed" || historyStatus === "error" ? historyStatus : previous?.status ?? historyStatus;
          parts.set(key, { key, sessionId, messageId, partId, speaker, kind: "tool", order: previous?.order ?? nextOrder++, text: "", tool: raw.tool ?? previous?.tool ?? "tool", status, detail: toolDetail(state) || previous?.detail || "", ...(attachment ? { attachment } : previous?.attachment ? { attachment: previous.attachment } : {}) });
        } else {
          const historyText = raw.text ?? "";
          const text = previous
            ? historyText.startsWith(previous.text)
              ? historyText
              : previous.text
            : historyText;
          const bounded = boundedPartText(text);
          parts.set(key, { key, sessionId, messageId, partId, speaker, kind: type, order: previous?.order ?? nextOrder++, text: bounded, tool: "", status: "", detail: "" });
        }
      }
    }
    const sessionParts = [...parts.values()]
      .filter((part) => part.key.startsWith(`${runId}:${sessionId}:`))
      .sort((a, b) => a.order - b.order);
    if (sessionParts.length > 0) {
      const base = Math.min(...sessionParts.map((part) => part.order));
      const ranked = [
        ...historyKeys.map((key) => parts.get(key)).filter((part): part is ProjectedPart => part !== undefined),
        ...sessionParts.filter((part) => !historyKeys.includes(part.key)),
      ];
      ranked.forEach((part, index) => { part.order = base + index; });
      nextOrder = Math.max(nextOrder, base + ranked.length);
    }
    trimRun(runId);
  };

  const clearRun = (runId: string): void => {
    for (const key of parts.keys()) if (key.startsWith(`${runId}:`)) parts.delete(key);
    for (const key of removedParts) if (key.startsWith(`${runId}:`)) removedParts.delete(key);
    for (const key of seenEvents) if (key.startsWith(`${runId}:`)) seenEvents.delete(key);
    driverCommands.delete(runId);
    verdictLines.delete(runId);
  };

  return { project, mergeHistory, panes: render, acceptanceReviewLines, driverCommands: renderDriverCommands, projectDriver, mergeVerdict, clearRun };
};
