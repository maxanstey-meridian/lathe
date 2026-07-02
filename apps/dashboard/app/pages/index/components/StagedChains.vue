<script setup lang="ts">
import { injectLatheStatus } from "../ports/lathe-status";

const status = injectLatheStatus();
</script>

<template>
  <section>
    <h2 class="mb-2 text-sm font-semibold text-slate-300">Staged Chains</h2>

    <template v-if="status.status.value?.staged.length">
      <div class="overflow-hidden rounded-lg border border-slate-800">
        <ul class="divide-y divide-slate-800">
          <li
            v-for="entry in status.status.value.staged"
            :key="entry.runId"
            class="flex items-center gap-3 bg-slate-900/50 px-3 py-2"
          >
            <span class="text-slate-600">…</span>
            <span class="font-mono text-xs text-slate-400">{{ entry.runId }}</span>
            <span v-if="entry.parentRunId" class="text-xs text-slate-600">
              ← {{ entry.parentRunId }}
            </span>
            <span v-else class="text-xs text-slate-600">
              (head)
            </span>
          </li>
        </ul>
      </div>
    </template>

    <div v-else class="rounded-lg border border-slate-800 py-6 text-center text-sm text-slate-600">No staged chains</div>
  </section>
</template>
