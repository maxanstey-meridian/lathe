<script setup lang="ts">
import { injectLatheActions } from "../ports/lathe-actions";
import { injectLatheStatus } from "../ports/lathe-status";

const status = injectLatheStatus();
const actions = injectLatheActions();

const showStopConfirm = ref<string | null>(null);

const closeStopConfirm = (): void => {
  showStopConfirm.value = null;
};

const openStopConfirm = (runId: string): void => {
  showStopConfirm.value = runId;
};

const handleStop = async (runId: string): Promise<void> => {
  try {
    await actions.stop(runId);
  } catch {
    // Error surfaced via latheActions.lastError
  } finally {
    showStopConfirm.value = null;
  }
};
</script>

<template>
  <section>
    <h2 class="mb-2 text-sm font-semibold text-slate-300">Queue <span class="text-slate-600 font-normal">({{ status.status.value?.queued.length ?? 0 }})</span></h2>

    <template v-if="status.status.value?.queued.length">
      <div class="overflow-hidden rounded-lg border border-slate-800">
        <ul class="divide-y divide-slate-800">
          <li
            v-for="(entry, index) in status.status.value.queued"
            :key="entry.runId"
            class="flex items-center gap-3 bg-slate-900/50 px-3 py-2"
          >
            <span class="flex h-5 w-5 items-center justify-center rounded-full bg-slate-800 text-xs font-medium text-slate-500">
              {{ index + 1 }}
            </span>
            <span class="font-mono text-xs text-slate-400">{{ entry.runId }}</span>
            <div class="ml-auto">
              <UModal :open="showStopConfirm === entry.runId" title="Stop this run?" :persist="false" @update:open="(val: boolean) => { if (!val) showStopConfirm = null; }">
                <template #body>
                  <p class="text-sm text-slate-400">
                    Stop <code class="font-mono text-xs text-slate-300">{{ entry.runId }}</code>?
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
                      @click="handleStop(entry.runId)"
                    >
                      Stop
                    </UButton>
                  </div>
                </template>
              </UModal>
              <UButton
                size="xs"
                color="error"
                variant="ghost"
                :disabled="actions.stopLoading.value"
                @click="openStopConfirm(entry.runId)"
              >
                Stop
              </UButton>
            </div>
          </li>
        </ul>
      </div>
    </template>

    <div v-else class="rounded-lg border border-slate-800 py-6 text-center text-sm text-slate-600">Queue is empty</div>
  </section>
</template>
