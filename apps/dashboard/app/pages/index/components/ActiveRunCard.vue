<script setup lang="ts">
import type { StatusActiveRunDto } from "@lathe/contract";
import { timeAgo } from "../logic/formatters";

const props = defineProps<{
  activeRun: StatusActiveRunDto | null;
  isLive: boolean;
}>();
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-4">
        <h2 class="text-base font-semibold">Active Run</h2>
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-full" :class="props.isLive ? 'bg-emerald-500' : 'bg-red-500'"></span>
          <span class="text-xs text-slate-500">{{ props.isLive ? "live" : "offline" }}</span>
        </div>
      </div>
    </template>

    <template v-if="props.activeRun">
      <dl class="grid gap-4 sm:grid-cols-2">
        <div>
          <dt class="text-xs font-medium uppercase text-slate-500">Run ID</dt>
          <dd class="mt-1 font-mono text-sm font-medium">{{ props.activeRun.runId }}</dd>
        </div>
        <div>
          <dt class="text-xs font-medium uppercase text-slate-500">Outcomes</dt>
          <dd class="mt-1 text-sm">{{ props.activeRun.outcomes }}</dd>
        </div>
        <div v-if="props.activeRun.gateLatched" class="sm:col-span-2">
          <dt class="text-xs font-medium uppercase text-slate-500">Gate Latched</dt>
          <dd class="mt-1 text-sm text-amber-600">{{ props.activeRun.gateLatched }}</dd>
        </div>
      </dl>

      <div v-if="props.activeRun.recentEvents.length" class="mt-4">
        <h3 class="mb-2 text-xs font-medium uppercase text-slate-500">Recent Events</h3>
        <ul class="space-y-1">
          <li v-for="event in props.activeRun.recentEvents" :key="event.at" class="flex gap-3 text-sm">
            <span class="w-16 shrink-0 font-mono text-xs text-slate-400">{{ timeAgo(event.at) }}</span>
            <span class="text-slate-700">{{ event.event }}</span>
          </li>
        </ul>
      </div>
    </template>

    <div v-else class="py-6 text-center text-sm text-slate-500">No active run</div>
  </UCard>
</template>
