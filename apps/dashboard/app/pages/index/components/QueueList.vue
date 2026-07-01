<script setup lang="ts">
import type { components } from "@lathe/contract";
import { injectLatheActions } from "../ports/lathe-actions";
import { injectLatheStatus } from "../ports/lathe-status";

type StatusQueuedRunDto = components["schemas"]["StatusQueuedRunDto"];

const status = injectLatheStatus();
const actions = injectLatheActions();

const showAbortConfirm = ref<string | null>(null);

const closeAbortConfirm = (): void => {
  showAbortConfirm.value = null;
};

const openAbortConfirm = (runId: string): void => {
  showAbortConfirm.value = runId;
};

const handleAbort = async (runId: string): Promise<void> => {
  try {
    await actions.abort(runId);
  } catch {
    // Error surfaced via latheActions.lastError
  } finally {
    showAbortConfirm.value = null;
  }
};
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-base font-semibold">Queue</h2>
    </template>

    <template v-if="status.status.value?.queued.length">
      <ul class="space-y-2">
        <li
          v-for="(entry, index) in status.status.value.queued"
          :key="entry.runId"
          class="flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
        >
          <span class="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-xs font-medium text-slate-600">
            {{ index + 1 }}
          </span>
          <span class="font-mono text-sm">{{ entry.runId }}</span>
          <div class="ml-auto">
            <UModal v-model:open="showAbortConfirm === entry.runId" title="Abort this run?" :persist="false">
              <template #body-content>
                <p class="text-sm text-slate-600">
                  Are you sure you want to abort <code class="font-mono text-xs">{{ entry.runId }}</code>?
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
                    @click="handleAbort(entry.runId)"
                  >
                    Abort
                  </UButton>
                </div>
              </template>
            </UModal>
            <UButton
              size="xs"
              color="error"
              variant="soft"
              :disabled="actions.abortLoading.value"
              @click="openAbortConfirm(entry.runId)"
            >
              Abort
            </UButton>
          </div>
        </li>
      </ul>
    </template>

    <div v-else class="py-6 text-center text-sm text-slate-500">Queue is empty</div>
  </UCard>
</template>
