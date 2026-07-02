<script setup lang="ts">
import type { components } from "@lathe/contract";
import { injectLatheActions } from "../ports/lathe-actions";
import { injectLatheStatus } from "../ports/lathe-status";
import { runStatusColor, truncate } from "../logic/formatters";
import { client } from "@lathe/contract";
import { onMounted, ref, watch } from "vue";

type ReviewRun = components["schemas"]["ReviewRunDto"];

const status = injectLatheStatus();
const actions = injectLatheActions();

const reviewRuns = ref<ReviewRun[]>([]);
const reviewError = ref<string | null>(null);

const fetchReview = async (): Promise<void> => {
  reviewError.value = null;
  try {
    const result = await client.GET("/review");
    if (result.data) {
      reviewRuns.value = result.data.runs;
    }
  } catch {
    reviewError.value = "Unable to fetch review data.";
  }
};

onMounted(() => {
  void fetchReview();
});

watch(status.status, () => {
  void fetchReview();
});

const rejectReasons = ref<Record<string, string>>({});

const openReject = (run: ReviewRun): void => {
  rejectReasons.value[run.runId] = "";
};

const cancelReject = (run: ReviewRun): void => {
  delete rejectReasons.value[run.runId];
};

const handleReject = async (run: ReviewRun): Promise<void> => {
  const reason = rejectReasons.value[run.runId] ?? "rejected";
  try {
    await actions.reject(run.runId, reason);
    reviewRuns.value = reviewRuns.value.filter((r) => r.runId !== run.runId);
  } catch {
    // Error surfaced via latheActions.lastError
  }
};

const handleAccept = async (run: ReviewRun): Promise<void> => {
  try {
    await actions.accept(run.runId);
    reviewRuns.value = reviewRuns.value.filter((r) => r.runId !== run.runId);
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
