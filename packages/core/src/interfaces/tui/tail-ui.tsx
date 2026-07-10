// The Ink face of `lathe tail` (CONTRACT X3, D4): a stateless renderer over the
// daemon-owned tail snapshot plus daemon tail events. Split panes for Baby,
// Daddy, and Super-daddy, a driver-event strip, and a status bar with the
// tokens-until-rotation gauge. Writes nothing.

import type { TailEvent, TailSnapshotDto } from "@lathe/contract";
import {
  applyTailEvent,
  isTerminalTailStatus,
  tailStateFromSnapshot,
  visiblePaneLines,
} from "@lathe/tail-state";
import type { TailPaneLine as PaneLine, TailPaneState as PaneState } from "@lathe/tail-state";
import { render, Box, Text, useApp, useInput } from "ink";
import React from "react";
import { useEffect, useState } from "react";

export type TailUiDeps = {
  snapshot: TailSnapshotDto;
  subscribe: (onEvent: (event: TailEvent) => void) => { close: () => void };
};

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
  const visible: PaneLine[] = visiblePaneLines(pane).slice(-(height - 3));
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
  const [tail, setTail] = useState(() => tailStateFromSnapshot(initialSnapshot));
  const [now, setNow] = useState(Date.now());
  const snapshot = tail.snapshot;
  const stats = tail.stats;
  const baby = tail.panes.baby;
  const daddy = tail.panes.daddy;
  const superPane = tail.panes.super;
  const driver = tail.panes.driver;
  const events = tail.driverEvents;
  const startedAt = snapshot?.startedAt ? Date.parse(snapshot.startedAt) : Date.now();
  const label = snapshot
    ? runLabel(snapshot.runId, snapshot.summary ?? undefined)
    : "no active run";
  const babyModel = snapshot
    ? snapshot.promoted
      ? `⬆ ${snapshot.models.promoted}`
      : snapshot.models.baby
    : "";

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
    const sub = subscribe((event) => {
      setTail((current) => applyTailEvent(current, event, Date.now()));
    });
    return () => {
      sub.close();
    };
  }, [subscribe]);

  if (!snapshot) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="gray">No active run. Queue a packet to begin.</Text>
      </Box>
    );
  }
  if (!stats) {
    return null;
  }

  const rows = process.stdout.rows ?? 35;
  const columns = process.stdout.columns ?? 80;
  const frameWidth = Math.max(20, columns - 1);
  // Three panes (baby | daddy | super). Even thirds with the remainder widening
  // the last; on a narrow terminal each is still usable for tool/command lines.
  const babyWidth = Math.floor(frameWidth / 3);
  const daddyWidth = Math.floor((frameWidth - babyWidth) / 2);
  const superWidth = frameWidth - babyWidth - daddyWidth;
  const paneHeight = Math.max(8, rows - 9);
  const ctxEstimate = stats.contextTokens + Math.round(tail.charsThisTurn / 4);
  const fraction = Math.min(1, snapshot.budget > 0 ? ctxEstimate / snapshot.budget : 0);
  const barWidth = 24;
  const filled = Math.round(fraction * barWidth);
  const terminal = isTerminalTailStatus(stats.status);

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
        {visiblePaneLines(driver)
          .slice(-3)
          .map((line, i) => (
            <Text
              key={`driver-${i}`}
              dimColor={line.style === "think"}
              color={line.style === "tool" ? "yellow" : undefined}
              wrap="truncate-end"
            >
              {line.text}
            </Text>
          ))}
        {driver.lines.length === 0 &&
          !driver.current.trim() &&
          events.slice(-3).map((line, i) => (
            <Text key={i} wrap="truncate-end">
              {line}
            </Text>
          ))}
        {driver.lines.length === 0 && !driver.current.trim() && events.length === 0 && (
          <Text dimColor>no driver events yet</Text>
        )}
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
          {"  "}⏱ {fmtDuration(now - startedAt)} turn {stats.turn || "1"} ✓{stats.outcomesDone}/
          {stats.outcomesTotal}
          {stats.gateReason ? <Text color="red"> ⛔ {stats.gateReason.slice(0, 30)}</Text> : ""}
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
