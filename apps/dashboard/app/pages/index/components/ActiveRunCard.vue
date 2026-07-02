<script setup lang="ts">
import type { StatusActiveRunDto } from "@lathe/contract";
import { timeAgo } from "../logic/formatters";
import { injectLatheActions } from "../ports/lathe-actions";
import { injectLatheStatus } from "../ports/lathe-status";

const status = injectLatheStatus();
const actions = injectLatheActions();

const showAbortConfirm = ref(false);

const closeAbortConfirm = (): void => {
  showAbortConfirm.value = false;
};

const handleAbort = async (runId: string): Promise<void> => {
  try {
    await actions.abort(runId);
  } catch {
    // Error surfaced via latheActions.lastError
  } finally {
    showAbortConfirm.value = false;
  }
};
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-4">
        <h2 class="text-base font-semibold">Active Run</h2>
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-full" :class="status.isLive.value ? 'bg-emerald-500' : 'bg-red-500'"></span>
          <span class="text-xs text-slate-500">{{ status.isLive.value ? "live" : "offline" }}</span>
          <UModal v-if="status.status.value?.activeRun" v-model:open="showAbortConfirm" title="Abort this run?" :persist="false">
            <template #body-content>
              <p class="text-sm text-slate-600">
                Are you sure you want to abort <code class="font-mono text-xs">{{ status.status.value.activeRun.runId }}</code>?
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
                  @click="handleAbort(status.status.value!.activeRun.runId)"
                >
                  Abort
                </UButton>
              </div>
            </template>
          </UModal>
        </div>
      </div>
    </template>

    <template v-if="status.status.value?.activeRun">
      <dl class="grid gap-4 sm:grid-cols-2">
        <div>
          <dt class="text-xs font-medium uppercase text-slate-500">Run ID</dt>
          <dd class="mt-1 font-mono text-sm font-medium">{{ status.status.value.activeRun.runId }}</dd>
        </div>
        <div>
          <dt class="text-xs font-medium uppercase text-slate-500">Outcomes</dt>
          <dd class="mt-1 text-sm">{{ status.status.value.activeRun.outcomes }}</dd>
        </div>
        <div v-if="status.status.value.activeRun.gateLatched" class="sm:col-span-2">
          <dt class="text-xs font-medium uppercase text-slate-500">Gate Latched</dt>
          <dd class="mt-1 text-sm text-amber-600">{{ status.status.value.activeRun.gateLatched }}</dd>
        </div>
      </dl>

      <div v-if="status.status.value.activeRun.recentEvents.length" class="mt-4">
        <h3 class="mb-2 text-xs font-medium uppercase text-slate-500">Recent Events</h3>
        <ul class="space-y-1">
          <li v-for="event in status.status.value.activeRun.recentEvents" :key="event.at" class="flex gap-3 text-sm">
            <span class="w-16 shrink-0 font-mono text-xs text-slate-400">{{ timeAgo(event.at) }}</span>
            <span class="text-slate-700">{{ event.event }}</span>
          </li>
        </ul>
      </div>
    </template>

    <div v-else class="py-6 text-center text-sm text-slate-500">No active run</div>
  </UCard>
</template>
