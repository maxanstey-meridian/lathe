<script setup lang="ts">
import { injectLatheStatus } from "../ports/lathe-status";

const status = injectLatheStatus();

const retrying = ref<string | null>(null);

const retry = async (runId: string): Promise<void> => {
  retrying.value = runId;
  try {
    await status.requeue(runId);
  } finally {
    retrying.value = null;
  }
};
</script>

<template>
  <section>
    <h2 class="mb-2 text-sm font-semibold text-slate-300">Stopped</h2>

    <template v-if="status.status.value?.stopped.length">
      <ul class="space-y-2">
        <li
          v-for="run in status.status.value.stopped"
          :key="run.runId"
          class="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2"
        >
          <span class="font-mono text-sm text-slate-200">{{ run.runId }}</span>
          <UButton
            size="xs"
            color="primary"
            variant="soft"
            :loading="retrying === run.runId"
            @click="retry(run.runId)"
          >
            Retry
          </UButton>
        </li>
      </ul>
    </template>

    <div v-else class="rounded-lg border border-slate-800 py-6 text-center text-sm text-slate-600">No stopped runs</div>
  </section>
</template>
