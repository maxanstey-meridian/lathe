<script setup lang="ts">
import type { StatusQueuedRunDto } from "@lathe/contract";

defineProps<{
  queued: StatusQueuedRunDto[];
}>();
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-base font-semibold">Queue</h2>
    </template>

    <template v-if="queued.length">
      <ul class="space-y-2">
        <li
          v-for="(entry, index) in queued"
          :key="entry.runId"
          class="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
        >
          <span class="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
            {{ index + 1 }}
          </span>
          <span class="font-mono text-sm">{{ entry.runId }}</span>
        </li>
      </ul>
    </template>

    <div v-else class="py-6 text-center text-sm text-slate-500">Queue is empty</div>
  </UCard>
</template>
