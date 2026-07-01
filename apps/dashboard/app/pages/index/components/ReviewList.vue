<script setup lang="ts">
import { injectLatheActions } from "../ports/lathe-actions";
import { runStatusColor, truncate } from "../logic/formatters";
import { useReviewData } from "../composables/useReviewData";

const { reviewRuns, reviewError, removeRun } = useReviewData();
const actions = injectLatheActions();

const rejectReasons = ref<Record<string, string>>({});

const openReject = (run: { runId: string }): void => {
  rejectReasons.value[run.runId] = "";
};

const cancelReject = (run: { runId: string }): void => {
  delete rejectReasons.value[run.runId];
};

const handleReject = async (run: { runId: string; status: string; outcomes: string; branch: string; repo: string; base: string; blockedQuestion: string | null }): Promise<void> => {
  const reason = rejectReasons.value[run.runId] ?? "rejected";
  try {
    await actions.reject(run.runId, reason);
    removeRun(run.runId);
  } catch {
    // Error surfaced via latheActions.lastError
  }
};

const handleAccept = async (run: { runId: string; status: string; outcomes: string; branch: string; repo: string; base: string; blockedQuestion: string | null }): Promise<void> => {
  try {
    await actions.accept(run.runId);
    removeRun(run.runId);
  } catch {
    // Error surfaced via latheActions.lastError
  }
};
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-base font-semibold">Review</h2>
    </template>

    <UAlert v-if="reviewError" color="error" variant="soft" :title="reviewError" />

    <template v-if="reviewRuns.length">
      <ul class="space-y-3">
        <li
          v-for="run in reviewRuns"
          :key="run.runId"
          class="rounded-lg border border-slate-200 bg-white px-3 py-3"
        >
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2">
              <span class="font-mono text-sm font-medium">{{ run.runId }}</span>
              <UBadge :color="runStatusColor(run.status as 'ready_for_review' | 'blocked')" variant="soft" size="xs">
                {{ run.status }}
              </UBadge>
            </div>
            <div class="flex items-center gap-2">
              <UButton
                size="xs"
                color="success"
                variant="soft"
                :loading="actions.acceptLoading.value"
                :disabled="actions.acceptLoading.value"
                @click="handleAccept(run)"
              >
                Accept
              </UButton>
              <div v-if="!rejectReasons[run.runId]" class="flex items-center gap-2">
                <UButton
                  size="xs"
                  color="error"
                  variant="soft"
                  :loading="actions.rejectLoading.value"
                  :disabled="actions.rejectLoading.value"
                  @click="openReject(run)"
                >
                  Reject
                </UButton>
              </div>
              <div v-else class="flex items-center gap-2">
                <UTextarea
                  v-model="rejectReasons[run.runId]"
                  :rows="1"
                  size="xs"
                  placeholder="Reason..."
                  class="w-40"
                />
                <UButton
                  size="xs"
                  color="error"
                  variant="soft"
                  :loading="actions.rejectLoading.value"
                  :disabled="actions.rejectLoading.value"
                  @click="handleReject(run)"
                >
                  Confirm
                </UButton>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="soft"
                  @click="cancelReject(run)"
                >
                  Cancel
                </UButton>
              </div>
            </div>
          </div>
          <div v-if="run.outcomes" class="mt-1 text-xs text-slate-500">
            {{ truncate(run.outcomes, 100) }}
          </div>
        </li>
      </ul>
    </template>

    <div v-else class="py-6 text-center text-sm text-slate-500">
      Nothing to review
    </div>
  </UCard>
</template>
