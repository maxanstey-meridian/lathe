<script setup lang="ts">
import { computed } from "vue";

import { formatTailDuration, runLabel } from "../logic/tail-state";
import { injectLatheTail } from "../ports/lathe-tail";
import TailPane from "./TailPane.vue";

const tail = injectLatheTail();

const snapshot = computed(() => tail.state.value.snapshot);
const stats = computed(() => tail.state.value.stats);
const babyModel = computed(() => {
  const current = snapshot.value;
  if (current === null) {
    return "baby";
  }

  return current.promoted ? `promoted ${current.models.promoted}` : current.models.baby;
});
const label = computed(() => {
  const current = snapshot.value;
  return current === null ? "No active run" : runLabel(current.runId, current.summary);
});
const elapsed = computed(() => {
  const current = snapshot.value;
  if (current === null || current.startedAt === null) {
    return "0m00s";
  }

  return formatTailDuration(tail.now.value - Date.parse(current.startedAt));
});
const contextEstimate = computed(() => {
  const currentStats = stats.value;
  if (currentStats === null) {
    return 0;
  }

  return currentStats.contextTokens + Math.round(tail.state.value.charsThisTurn / 4);
});
const contextFraction = computed(() => {
  const current = snapshot.value;
  if (current === null || current.budget <= 0) {
    return 0;
  }

  return Math.min(1, contextEstimate.value / current.budget);
});
const contextBar = computed(() => {
  const width = 24;
  const filled = Math.round(contextFraction.value * width);

  return `${"#".repeat(filled)}${"-".repeat(width - filled)}`;
});
const contextColorClass = computed(() => {
  if (contextFraction.value > 0.85) {
    return "text-red-600";
  }
  if (contextFraction.value > 0.6) {
    return "text-amber-600";
  }

  return "text-emerald-600";
});
const isTerminal = computed(() => {
  const currentStats = stats.value;
  return currentStats !== null && ["ready_for_review", "blocked", "failed", "accepted"].includes(currentStats.status);
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
    <header class="shrink-0 border-b border-slate-100 px-4 py-3">
      <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 class="text-base font-semibold">Run Tail</h2>
          <p class="mt-1 text-sm text-slate-500">{{ label }}</p>
        </div>
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-2">
            <span class="h-2 w-2 rounded-full" :class="tail.isLive.value ? 'bg-emerald-500' : 'bg-red-500'"></span>
            <span class="text-xs text-slate-500">{{ tail.isLive.value ? "live" : "offline" }}</span>
          </div>
          <UButton size="xs" color="neutral" variant="soft" :loading="tail.isLoading.value" @click="tail.refresh">
            Refresh tail
          </UButton>
        </div>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <UAlert v-if="tail.errorMessage.value" class="shrink-0" color="error" variant="soft" :title="tail.errorMessage.value" />

      <div v-if="snapshot && stats" class="flex min-h-0 flex-1 flex-col gap-3">
        <div class="grid min-h-0 flex-1 gap-3 lg:grid-cols-3">
          <TailPane title="baby" :model="babyModel" :pane="tail.state.value.panes.baby" accent="green" :now="tail.now.value" />
          <TailPane title="daddy" :model="snapshot.models.daddy" :pane="tail.state.value.panes.daddy" accent="magenta" :now="tail.now.value" />
          <TailPane title="super-daddy" :model="snapshot.models.super" :pane="tail.state.value.panes.super" accent="blue" :now="tail.now.value" />
        </div>

        <section class="shrink-0 rounded-xl border border-slate-200 bg-slate-950 p-3 font-mono text-xs text-slate-100">
          <div v-if="tail.state.value.driverEvents.length" class="space-y-1">
            <p v-for="(event, index) in tail.state.value.driverEvents.slice(-3)" :key="`${index}-${event}`" class="truncate">
              {{ event }}
            </p>
          </div>
          <p v-else class="text-slate-400">no driver events yet</p>
        </section>

        <div class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">
          <span>ctx <span :class="contextColorClass">{{ contextBar }}</span> {{ (contextEstimate / 1000).toFixed(1) }}k/{{ (snapshot.budget / 1000).toFixed(0) }}k</span>
          <span v-if="stats.rotations > 0">rotations {{ stats.rotations }}</span>
          <span>elapsed {{ elapsed }}</span>
          <span>turn {{ stats.turn || 1 }}</span>
          <span>outcomes {{ stats.outcomesDone }}/{{ stats.outcomesTotal }}</span>
          <span v-if="stats.gateReason" class="text-red-600">gate {{ stats.gateReason }}</span>
          <span v-if="isTerminal" class="text-amber-600">[{{ stats.status }}]</span>
        </div>
      </div>

      <div v-else class="flex min-h-0 flex-1 items-center justify-center text-sm text-slate-500">
        No active run tail available.
      </div>
    </div>
  </section>
</template>
