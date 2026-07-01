<script setup lang="ts">
import { injectLatheStatus } from "../ports/lathe-status";

const status = injectLatheStatus();
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-base font-semibold">Staged Chains</h2>
    </template>

    <template v-if="status.status.value?.staged.length">
      <ul class="space-y-2">
        <li
          v-for="entry in status.status.value.staged"
          :key="entry.runId"
          class="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
        >
          <span class="text-slate-500">…</span>
          <span class="font-mono text-sm">{{ entry.runId }}</span>
          <span v-if="entry.parentRunId" class="text-xs text-slate-400">
            ← {{ entry.parentRunId }}
          </span>
          <span v-else class="text-xs text-slate-400">
            (head)
          </span>
        </li>
      </ul>
    </template>

    <div v-else class="py-6 text-center text-sm text-slate-500">No staged chains</div>
  </UCard>
</template>
