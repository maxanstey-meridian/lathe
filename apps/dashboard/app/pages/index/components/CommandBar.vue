<script setup lang="ts">
import { computed } from "vue";

import type { TabId } from "../logic/tabs";
import { injectLatheStatus } from "../ports/lathe-status";

defineProps<{
  readonly activeTab: TabId;
}>();

defineEmits<{
  "update:activeTab": [TabId];
  upload: [];
}>();

const status = injectLatheStatus();

const activeRun = computed(() => status.status.value?.activeRun ?? null);
const queueCount = computed(() => status.status.value?.queued.length ?? 0);
const parkedCount = computed(() => status.status.value?.parked.length ?? 0);
const reviewCount = computed(() => status.status.value?.review.readyForReview ?? 0);
</script>

<template>
  <header class="flex shrink-0 items-center gap-4 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
    <div class="flex items-center gap-2">
      <span class="flex size-7 items-center justify-center rounded-md bg-slate-100 text-sm font-bold text-slate-950">L</span>
      <span class="text-sm font-semibold text-slate-200">Lathe</span>
    </div>

    <div class="flex items-center gap-1.5">
      <span class="h-2 w-2 rounded-full" :class="status.isLive.value ? 'bg-emerald-400' : 'bg-red-500'"></span>
      <span class="text-xs text-slate-500">{{ status.isLive.value ? "live" : "offline" }}</span>
    </div>

    <div v-if="activeRun" class="hidden items-center gap-2 lg:flex">
      <span class="text-xs text-slate-600">|</span>
      <span class="font-mono text-xs text-slate-400">{{ activeRun.runId }}</span>
    </div>

    <nav class="flex items-center gap-0.5">
      <button
        class="flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm font-medium transition-colors"
        :class="activeTab === 'console'
          ? 'border-cyan-400 text-cyan-300'
          : 'border-transparent text-slate-500 hover:text-slate-300'"
        @click="$emit('update:activeTab', 'console')"
      >
        Console
      </button>
      <button
        class="flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm font-medium transition-colors"
        :class="activeTab === 'runs'
          ? 'border-cyan-400 text-cyan-300'
          : 'border-transparent text-slate-500 hover:text-slate-300'"
        @click="$emit('update:activeTab', 'runs')"
      >
        Runs
        <span
          v-if="queueCount + parkedCount > 0"
          class="flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500/20 px-1 text-xs font-semibold text-amber-400"
        >{{ queueCount + parkedCount }}</span>
      </button>
      <button
        class="flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-sm font-medium transition-colors"
        :class="activeTab === 'review'
          ? 'border-cyan-400 text-cyan-300'
          : 'border-transparent text-slate-500 hover:text-slate-300'"
        @click="$emit('update:activeTab', 'review')"
      >
        Review
        <span
          v-if="reviewCount > 0"
          class="flex h-4 min-w-4 items-center justify-center rounded-full bg-fuchsia-500/20 px-1 text-xs font-semibold text-fuchsia-400"
        >{{ reviewCount }}</span>
      </button>
    </nav>

    <div class="ml-auto flex items-center gap-2">
      <UButton
        size="xs"
        color="neutral"
        variant="ghost"
        :loading="status.isLoading.value"
        class="text-slate-400 hover:text-slate-200"
        @click="status.refresh"
      >
        Refresh
      </UButton>
      <UButton
        size="xs"
        color="primary"
        variant="soft"
        @click="$emit('upload')"
      >
        Upload Packet
      </UButton>
    </div>
  </header>
</template>
