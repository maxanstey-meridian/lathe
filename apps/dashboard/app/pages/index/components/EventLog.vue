<script setup lang="ts">
import type { LatheEvent } from "@lathe/contract";
import { injectDaemonEvents } from "../ports/daemon-events";

const daemonEvents = injectDaemonEvents();

type BadgeColor = "error" | "primary" | "success" | "info" | "warning" | "neutral";

const kindColor = (kind: string, data: LatheEvent): BadgeColor => {
  if (kind === "gate.decision") {
    return data.kind === "gate.decision" && data.decision === "block" ? "error"
      : data.kind === "gate.decision" && data.decision === "allow" ? "success"
      : "warning";
  }
  if (kind === "verdict") {
    return data.kind === "verdict" && data.verdict === "accept" ? "success"
      : data.kind === "verdict" && (data.verdict === "request_changes" || data.verdict === "reject") ? "error"
      : "warning";
  }
  if (kind === "run.state") return "info";
  if (kind === "turn.started") return "primary";
  return "neutral";
};

const summarize = (data: LatheEvent): string => {
  switch (data.kind) {
    case "run.state": return data.status;
    case "turn.started": return `pass ${data.pass} turn ${data.turn}`;
    case "gate.decision": return `${data.decision} — ${data.tool}`;
    case "tokens": return `${data.contextTokens} / ${data.window}`;
    case "verdict": return `${data.reviewer}: ${data.verdict}`;
    case "log": return data.line;
  }
};
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-4">
        <h2 class="text-base font-semibold">Event Log</h2>
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-full" :class="daemonEvents.isLive.value ? 'bg-emerald-500' : 'bg-red-500'"></span>
          <span class="text-xs text-slate-500">{{ daemonEvents.isLive.value ? "live" : "offline" }}</span>
        </div>
      </div>
    </template>

    <template v-if="daemonEvents.events.value.length">
      <ul class="max-h-96 space-y-1 overflow-y-auto font-mono text-xs">
        <li
          v-for="event in daemonEvents.events.value"
          :key="event.seq"
          class="flex items-start gap-3 rounded px-2 py-1 hover:bg-slate-50"
        >
          <span class="w-20 shrink-0 text-slate-400">{{ event.data.at.slice(11, 19) }}</span>
          <UBadge :color="kindColor(event.kind, event.data)" variant="soft" size="xs">{{ event.kind }}</UBadge>
          <span class="shrink-0 text-slate-500">{{ event.data.runId.slice(-12) }}</span>
          <span class="text-slate-700">{{ summarize(event.data) }}</span>
        </li>
      </ul>
    </template>

    <div v-else class="py-6 text-center text-sm text-slate-500">No events yet</div>
  </UCard>
</template>
