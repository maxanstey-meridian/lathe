<script setup lang="ts">
import { ref } from "vue";

import { injectLatheActions } from "../ports/lathe-actions";
import { runStatusColor, runStatusLabel, truncate } from "../logic/formatters";
import { injectReviewData } from "../ports/review-data";
import { removeReviewRunAfterSuccess } from "../logic/action-results";

const { reviewRuns, reviewError, removeRun } = injectReviewData();
const actions = injectLatheActions();

const rejectReasons = ref<Record<string, string>>({});

const openReject = (run: { runId: string }): void => {
  rejectReasons.value[run.runId] = "";
};

const cancelReject = (runId: string): void => {
  delete rejectReasons.value[runId];
};

const handleReject = async (run: { runId: string }): Promise<void> => {
  const reason = rejectReasons.value[run.runId]?.trim() ?? "";
  if (!reason) {
    return;
  }
  await removeReviewRunAfterSuccess(
    run.runId,
    (runId) => actions.reject(runId, reason),
    removeRun,
  );
  delete rejectReasons.value[run.runId];
};

const handleAccept = async (run: { runId: string }): Promise<void> => {
  await removeReviewRunAfterSuccess(run.runId, actions.accept, removeRun);
};
</script>

<template>
  <div>
    <h2 class="mb-3 text-sm font-semibold text-slate-300">Review Queue</h2>

    <UAlert v-if="reviewError" color="error" variant="soft" :title="reviewError" class="mb-3" />

    <template v-if="reviewRuns.length">
      <div class="overflow-hidden rounded-lg border border-slate-800">
        <table class="w-full text-sm">
          <thead class="border-b border-slate-800 bg-slate-900 text-xs uppercase text-slate-500">
            <tr>
              <th class="px-3 py-2 text-left font-medium">Run</th>
              <th class="px-3 py-2 text-left font-medium">Next Step</th>
              <th class="px-3 py-2 text-left font-medium">Reported Outcomes</th>
              <th class="px-3 py-2 text-right font-medium">Decision</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-800">
            <template v-for="run in reviewRuns" :key="run.runId">
              <tr class="text-slate-300">
                <td class="px-3 py-2.5 font-mono text-xs">{{ run.runId }}</td>
                <td class="px-3 py-2.5">
                  <UBadge :color="runStatusColor(run.status as 'ready_for_review' | 'blocked')" variant="soft" size="xs">
                    {{ runStatusLabel(run.status) }}
                  </UBadge>
                </td>
                <td class="max-w-md px-3 py-2.5 text-xs text-slate-500">{{ truncate(run.outcomes, 120) }}</td>
                <td class="px-3 py-2.5">
                  <div class="flex items-center justify-end gap-2">
                    <UButton
                      v-if="run.status === 'ready_for_review'"
                      size="xs"
                      color="success"
                      variant="soft"
                      :loading="actions.acceptLoading.value"
                      :disabled="actions.acceptLoading.value"
                      @click="handleAccept(run)"
                    >
                      Prepare for Merge
                    </UButton>
                    <UButton
                      v-if="run.status === 'ready_for_review' && rejectReasons[run.runId] === undefined"
                      size="xs"
                      color="error"
                      variant="soft"
                      :loading="actions.rejectLoading.value"
                      :disabled="actions.rejectLoading.value"
                      @click="openReject(run)"
                    >
                      Request Changes
                    </UButton>
                  </div>
                </td>
              </tr>
              <tr v-if="rejectReasons[run.runId] !== undefined" class="bg-slate-900/50">
                <td colspan="4" class="px-3 py-2">
                  <div class="flex items-center gap-2">
                    <UTextarea
                      v-model="rejectReasons[run.runId]"
                      :rows="1"
                      size="xs"
                      placeholder="Required changes..."
                      class="flex-1"
                    />
                    <UButton
                      size="xs"
                      color="error"
                      variant="soft"
                      :loading="actions.rejectLoading.value"
                      :disabled="actions.rejectLoading.value || !rejectReasons[run.runId]?.trim()"
                      @click="handleReject(run)"
                    >
                      Submit Changes
                    </UButton>
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="ghost"
                      @click="cancelReject(run.runId)"
                    >
                      Cancel
                    </UButton>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>

    <div v-else class="rounded-lg border border-slate-800 py-12 text-center text-sm text-slate-600">
      Nothing to review
    </div>
  </div>
</template>
