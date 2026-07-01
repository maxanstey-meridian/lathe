// The Ink face of `lathe tail` (CONTRACT X3, D4): a stateless renderer over the
// daemon-owned tail snapshot plus daemon tail events. Split panes for Baby,
// Daddy, and Super-daddy, a driver-event strip, and a status bar with the
// tokens-until-rotation gauge. Writes nothing.

import type { TailEvent, TailLineStyle, TailSnapshotDto, TailSpeaker } from "@lathe/contract";
import { render, Box, Text, useApp, useInput } from "ink";
import React from "react";
import { useEffect, useRef, useState } from "react";

export type TailUiDeps = {
  snapshot: TailSnapshotDto;
  subscribe: (onEvent: (event: TailEvent) => void) => { close: () => void };
};

const TERMINAL_STATUSES = ["ready_for_review", "blocked", "failed", "accepted"];

type LineStyle = TailLineStyle | "tool";
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
  model,
  pane,
  height,
  width,
  accent,
}: {
  title: string;
  model: string;
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
  ].slice(-(height - 3));
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
      <Text wrap="truncate-end">
        <Text color={active ? accent : "gray"} bold>
          {active ? "●" : "○"} {title}
        </Text>
        <Text color={active ? accent : "gray"} dimColor>
          {" · "}
          {model}
        </Text>
        {!active && <Text color="gray">{" — waiting…"}</Text>}
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

const TailApp = ({ snapshot: initialSnapshot, subscribe }: TailUiDeps) => {
  const { exit } = useApp();
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [baby, setBaby] = useState<PaneState>(emptyPane());
  const [daddy, setDaddy] = useState<PaneState>(emptyPane());
  const [superPane, setSuperPane] = useState<PaneState>(emptyPane());
  const [events, setEvents] = useState<string[]>(
    initialSnapshot.journal
      .filter((entry) => entry.driver)
      .map((entry) => entry.line.split("\n")[0] ?? "")
      .slice(-50),
  );
  const [now, setNow] = useState(Date.now());
  const [stats, setStats] = useState({
    ctx: initialSnapshot.contextTokens,
    turn: initialSnapshot.turn,
    rotations: initialSnapshot.rotations,
    done: initialSnapshot.outcomesDone,
    total: initialSnapshot.outcomesTotal,
    gate: initialSnapshot.gateReason ?? "",
    status: initialSnapshot.status,
  });
  const charsThisTurn = useRef(0);
  const startedAt = snapshot.startedAt ? Date.parse(snapshot.startedAt) : Date.now();
  const label = runLabel(snapshot.runId, snapshot.summary ?? undefined);
  const babyModel = snapshot.promoted ? `⬆ ${snapshot.models.promoted}` : snapshot.models.baby;

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
    }
  });

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const apply = (speaker: TailSpeaker, fn: (p: PaneState) => PaneState) => {
      if (speaker === "baby") {
        setBaby(fn);
      } else if (speaker === "daddy") {
        setDaddy(fn);
      } else {
        setSuperPane(fn);
      }
    };

    const sub = subscribe((event) => {
      if (event.kind === "tail.run.changed") {
        if (event.snapshot) {
          setSnapshot(event.snapshot);
          setEvents(
            event.snapshot.journal
              .filter((entry) => entry.driver)
              .map((entry) => entry.line.split("\n")[0] ?? "")
              .slice(-50),
          );
          setStats({
            ctx: event.snapshot.contextTokens,
            turn: event.snapshot.turn,
            rotations: event.snapshot.rotations,
            done: event.snapshot.outcomesDone,
            total: event.snapshot.outcomesTotal,
            gate: event.snapshot.gateReason ?? "",
            status: event.snapshot.status,
          });
          setBaby(emptyPane());
          setDaddy(emptyPane());
          setSuperPane(emptyPane());
          charsThisTurn.current = 0;
        }
        return;
      }

      if ("runId" in event && event.runId !== snapshot.runId) {
        return;
      }
      if (event.kind === "tail.journal") {
        if (event.driver) {
          setEvents((prev) => [...prev, event.line.split("\n")[0] ?? ""].slice(-50));
        }
        return;
      }
      if (event.kind === "tail.stats") {
        charsThisTurn.current = 0;
        setSnapshot((prev) => ({ ...prev, promoted: event.promoted, status: event.status }));
        setStats({
          ctx: event.contextTokens,
          turn: event.turn,
          rotations: event.rotations,
          done: event.outcomesDone,
          total: event.outcomesTotal,
          gate: event.gateReason ?? "",
          status: event.status,
        });
        return;
      }
      if (event.kind === "tail.pane.delta") {
        if (event.speaker === "baby") {
          charsThisTurn.current += event.text.length;
        }
        apply(event.speaker, (p) => pushDelta(p, event.text, event.style));
        return;
      }
      if (event.kind === "tail.pane.tool") {
        apply(event.speaker, (p) =>
          pushToolLine(
            p,
            `${event.status === "error" ? "✗" : "·"} ${event.tool}${event.detail ? ` ${event.detail}` : ""}`,
          ),
        );
        return;
      }
      if (event.kind === "tail.super.verdict") {
        for (const line of event.lines) {
          setSuperPane((p) => pushToolLine(p, line));
        }
      }
    });
    return () => {
      sub.close();
    };
  }, [snapshot.runId, subscribe]);

  const rows = process.stdout.rows ?? 35;
  const columns = process.stdout.columns ?? 80;
  const frameWidth = Math.max(20, columns - 1);
  // Three panes (baby | daddy | super). Even thirds with the remainder widening
  // the last; on a narrow terminal each is still usable for tool/command lines.
  const babyWidth = Math.floor(frameWidth / 3);
  const daddyWidth = Math.floor((frameWidth - babyWidth) / 2);
  const superWidth = frameWidth - babyWidth - daddyWidth;
  const paneHeight = Math.max(8, rows - 9);
  const ctxEstimate = stats.ctx + Math.round(charsThisTurn.current / 4);
  const fraction = Math.min(1, snapshot.budget > 0 ? ctxEstimate / snapshot.budget : 0);
  const barWidth = 24;
  const filled = Math.round(fraction * barWidth);
  const terminal = TERMINAL_STATUSES.includes(stats.status);

  return (
    <Box flexDirection="column" width={frameWidth} overflow="hidden">
      <Box width={frameWidth} overflow="hidden">
        <Pane
          title="baby"
          model={babyModel}
          pane={baby}
          height={paneHeight}
          width={babyWidth}
          accent="green"
        />
        <Pane
          title="daddy"
          model={snapshot.models.daddy}
          pane={daddy}
          height={paneHeight}
          width={daddyWidth}
          accent="magenta"
        />
        <Pane
          title="super-daddy"
          model={snapshot.models.super}
          pane={superPane}
          height={paneHeight}
          width={superWidth}
          accent="blue"
        />
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
          {(ctxEstimate / 1000).toFixed(1)}k/{(snapshot.budget / 1000).toFixed(0)}k
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

export const runTailUi = (deps: TailUiDeps): void => {
  if (!process.stdout.isTTY) {
    render(<TailApp {...deps} />);
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
  const instance = render(<TailApp {...deps} />);
  void instance.waitUntilExit().then(() => {
    restore();
    process.exit(0);
  });
};
