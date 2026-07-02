<script setup lang="ts">
import { computed, ref } from "vue";

import { formatTailDuration, runLabel } from "../logic/tail-state";
import { injectLatheActions } from "../ports/lathe-actions";
import { injectLatheStatus } from "../ports/lathe-status";
import { injectLatheTail } from "../ports/lathe-tail";
import TailPane from "./TailPane.vue";

const tail = injectLatheTail();
const status = injectLatheStatus();
const actions = injectLatheActions();

const showAbortConfirm = ref(false);

const openAbortConfirm = (): void => {
  showAbortConfirm.value = true;
};

const closeAbortConfirm = (): void => {
  showAbortConfirm.value = false;
};

const handleAbort = async (): Promise<void> => {
  const run = status.status.value?.activeRun;
  if (!run) {
    return;
  }
  try {
    await actions.abort(run.runId);
  } catch {
    // Error surfaced via latheActions.lastError
  } finally {
    showAbortConfirm.value = false;
  }
};

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
    return "text-red-400";
  }
  if (contextFraction.value > 0.6) {
    return "text-amber-400";
  }
  return "text-emerald-400";
});
const isTerminal = computed(() => {
  const currentStats = stats.value;
  return currentStats !== null && ["ready_for_review", "blocked", "failed", "accepted"].includes(currentStats.status);
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col bg-slate-950">
    <header class="shrink-0 border-b border-slate-800 px-4 py-2">
      <div class="flex items-center gap-4">
        <div class="flex min-w-0 items-center gap-2">
          <span class="h-2 w-2 shrink-0 rounded-full" :class="tail.isLive.value ? 'bg-emerald-400' : 'bg-red-500'"></span>
          <h2 class="truncate font-mono text-sm text-slate-300">{{ label }}</h2>
        </div>

        <div v-if="snapshot" class="flex items-center gap-3 font-mono text-xs text-slate-600">
          <span>ctx <span :class="contextColorClass">{{ contextBar }}</span> {{ (contextEstimate / 1000).toFixed(1) }}k/{{ (snapshot.budget / 1000).toFixed(0) }}k</span>
          <span v-if="stats && stats.rotations > 0">rot {{ stats.rotations }}</span>
          <span>{{ elapsed }}</span>
          <span v-if="stats">turn {{ stats.turn || 1 }}</span>
          <span v-if="stats">out {{ stats.outcomesDone }}/{{ stats.outcomesTotal }}</span>
          <span v-if="stats?.gateReason" class="text-red-400">gate {{ stats.gateReason }}</span>
          <span v-if="isTerminal" class="text-amber-400">[{{ stats?.status }}]</span>
        </div>

        <div class="ml-auto flex items-center gap-2">
          <UButton
            v-if="status.status.value?.activeRun"
            size="xs"
            color="error"
            variant="ghost"
            :disabled="actions.abortLoading.value"
            @click="openAbortConfirm"
          >
            Abort
          </UButton>
          <UButton
            size="xs"
            color="neutral"
            variant="ghost"
            :loading="tail.isLoading.value"
            class="text-slate-500"
            @click="tail.refresh"
          >
            Tail
          </UButton>
        </div>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col">
      <UAlert v-if="tail.errorMessage.value" class="shrink-0 rounded-none" color="error" variant="soft" :title="tail.errorMessage.value" />

      <template v-if="snapshot && stats">
        <div class="grid min-h-0 flex-1 gap-px bg-slate-800 lg:grid-cols-3">
          <TailPane title="baby" :model="babyModel" :pane="tail.state.value.panes.baby" accent="green" :now="tail.now.value" />
          <TailPane title="daddy" :model="snapshot.models.daddy" :pane="tail.state.value.panes.daddy" accent="magenta" :now="tail.now.value" />
          <TailPane title="super-daddy" :model="snapshot.models.super" :pane="tail.state.value.panes.super" accent="blue" :now="tail.now.value" />
        </div>

        <section class="shrink-0 border-t border-slate-800 bg-slate-900 px-4 py-1.5 font-mono text-xs text-slate-500">
          <div v-if="tail.state.value.driverEvents.length" class="space-y-0.5">
            <p v-for="(event, index) in tail.state.value.driverEvents.slice(-3)" :key="`${index}-${event}`" class="truncate">
              {{ event }}
            </p>
          </div>
          <p v-else class="text-slate-700">no driver events</p>
        </section>
      </template>

      <div v-else class="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 font-mono text-sm text-slate-700">
        <span class="text-slate-600">$ lathe tail</span>
        <span>No active run. Queue a packet to begin.</span>
      </div>
    </div>

    <UModal
      v-if="status.status.value?.activeRun"
      :open="showAbortConfirm"
      title="Abort this run?"
      :persist="false"
      @update:open="(val: boolean) => { if (!val) closeAbortConfirm(); }"
    >
      <template #body>
        <p class="text-sm text-slate-400">
          Abort <code class="font-mono text-xs text-slate-300">{{ status.status.value.activeRun.runId }}</code>?
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="soft" @click="closeAbortConfirm">
            Cancel
          </UButton>
          <UButton
            color="error"
            variant="soft"
            :loading="actions.abortLoading.value"
            :disabled="actions.abortLoading.value"
            @click="handleAbort"
          >
            Abort
          </UButton>
        </div>
      </template>
    </UModal>
  </section>
</template>
