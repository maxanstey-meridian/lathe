<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type CSSProperties } from "vue";

import { formatTailDuration, runLabel } from "../logic/tail-state";
import { injectLatheActions } from "../ports/lathe-actions";
import { injectLatheStatus } from "../ports/lathe-status";
import { injectLatheTail } from "../ports/lathe-tail";
import TailPane from "./TailPane.vue";

const tail = injectLatheTail();
const status = injectLatheStatus();
const actions = injectLatheActions();

const showStopConfirm = ref(false);
const tailGrid = ref<HTMLElement | null>(null);
const paneFractions = ref<[number, number, number]>([1, 1, 1]);
const minPaneFraction = 0.45;

let stopDragging: (() => void) | null = null;

const openStopConfirm = (): void => {
  showStopConfirm.value = true;
};

const closeStopConfirm = (): void => {
  showStopConfirm.value = false;
};

const handleStop = async (): Promise<void> => {
  const run = status.status.value?.activeRun;
  if (!run) {
    return;
  }
  try {
    await actions.stop(run.runId);
  } catch {
    // Error surfaced via latheActions.lastError
  } finally {
    showStopConfirm.value = false;
  }
};

const resetPaneWidths = (): void => {
  paneFractions.value = [1, 1, 1];
};

const tailGridStyle = computed<CSSProperties>(() => ({
  "--tail-baby": `${paneFractions.value[0]}fr`,
  "--tail-daddy": `${paneFractions.value[1]}fr`,
  "--tail-super": `${paneFractions.value[2]}fr`,
}));

const startPaneDrag = (dividerIndex: 0 | 1, event: PointerEvent): void => {
  if (event.button !== 0 || tailGrid.value === null) {
    return;
  }

  event.preventDefault();
  stopDragging?.();

  const startX = event.clientX;
  const start = [...paneFractions.value] as [number, number, number];
  const total = start[0] + start[1] + start[2];
  const paneWidth = Math.max(1, tailGrid.value.clientWidth - 12);

  const onPointerMove = (moveEvent: PointerEvent): void => {
    const delta = ((moveEvent.clientX - startX) / paneWidth) * total;
    const next = [...start] as [number, number, number];
    const left = dividerIndex === 0 ? 0 : 1;
    const right = dividerIndex === 0 ? 1 : 2;
    const leftStart = dividerIndex === 0 ? start[0] : start[1];
    const rightStart = dividerIndex === 0 ? start[1] : start[2];
    const maxDelta = rightStart - minPaneFraction;
    const minDelta = minPaneFraction - leftStart;
    const clamped = Math.min(maxDelta, Math.max(minDelta, delta));

    next[left] = leftStart + clamped;
    next[right] = rightStart - clamped;
    paneFractions.value = next;
  };

  const onPointerUp = (): void => {
    stopDragging?.();
  };

  stopDragging = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    stopDragging = null;
  };

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);
};

onBeforeUnmount(() => {
  stopDragging?.();
});

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
            v-if="snapshot"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="resetPaneWidths"
          >
            Reset panes
          </UButton>
          <UButton
            v-if="status.status.value?.activeRun"
            size="xs"
            color="error"
            variant="ghost"
            :disabled="actions.stopLoading.value"
            @click="openStopConfirm"
          >
            Stop
          </UButton>
        </div>
      </div>
    </header>

    <div class="flex min-h-0 flex-1 flex-col">
      <UAlert v-if="tail.errorMessage.value" class="shrink-0 rounded-none" color="error" variant="soft" :title="tail.errorMessage.value" />

      <template v-if="snapshot && stats">
        <div ref="tailGrid" class="tail-grid grid min-h-0 flex-1 gap-px bg-slate-800" :style="tailGridStyle">
          <TailPane title="baby" :model="babyModel" :pane="tail.state.value.panes.baby" accent="green" :now="tail.now.value" />
          <button
            class="tail-grid__splitter hidden cursor-col-resize bg-slate-800 transition-colors hover:bg-cyan-500/70 active:bg-cyan-400 lg:block"
            type="button"
            aria-label="Resize baby and daddy panes"
            title="Drag to resize panes"
            @pointerdown="startPaneDrag(0, $event)"
          />
          <TailPane title="daddy" :model="snapshot.models.daddy" :pane="tail.state.value.panes.daddy" accent="magenta" :now="tail.now.value" />
          <button
            class="tail-grid__splitter hidden cursor-col-resize bg-slate-800 transition-colors hover:bg-cyan-500/70 active:bg-cyan-400 lg:block"
            type="button"
            aria-label="Resize daddy and super-daddy panes"
            title="Drag to resize panes"
            @pointerdown="startPaneDrag(1, $event)"
          />
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
      :open="showStopConfirm"
      title="Stop this run?"
      :persist="false"
      @update:open="(val: boolean) => { if (!val) closeStopConfirm(); }"
    >
      <template #body>
        <p class="text-sm text-slate-400">
          Stop <code class="font-mono text-xs text-slate-300">{{ status.status.value.activeRun.runId }}</code>?
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="soft" @click="closeStopConfirm">
            Cancel
          </UButton>
          <UButton
            color="error"
            variant="soft"
            :loading="actions.stopLoading.value"
            :disabled="actions.stopLoading.value"
            @click="handleStop"
          >
            Stop
          </UButton>
        </div>
      </template>
    </UModal>
  </section>
</template>

<style scoped>
@media (min-width: 1024px) {
  .tail-grid {
    grid-template-columns: var(--tail-baby) 6px var(--tail-daddy) 6px var(--tail-super);
  }

  .tail-grid__splitter {
    touch-action: none;
  }
}
</style>
