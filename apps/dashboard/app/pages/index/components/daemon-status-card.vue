<script setup lang="ts">
import { computed } from "vue";

import { injectLatheStatus } from "../ports/lathe-status";

const latheStatus = injectLatheStatus();

const activeRunLabel = computed(() => latheStatus.status.value?.activeRun?.runId ?? "no active run");
const queuedCount = computed(() => latheStatus.status.value?.queued.length ?? 0);
const parkedCount = computed(() => latheStatus.status.value?.parked.length ?? 0);
const reviewCount = computed(() => {
  const review = latheStatus.status.value?.review;
  return review ? review.readyForReview + review.failed : 0;
});
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center justify-between gap-4">
        <div>
          <h2 class="text-base font-semibold">Daemon status</h2>
          <p class="text-sm text-slate-500">Seed capability for the dashboard.</p>
        </div>

        <UBadge :color="latheStatus.isDaemonReachable.value ? 'success' : 'error'" variant="soft">
          {{ latheStatus.isDaemonReachable.value ? "reachable" : "offline" }}
        </UBadge>
      </div>
    </template>

    <div class="space-y-4">
      <UAlert
        v-if="latheStatus.errorMessage.value"
        color="error"
        variant="soft"
        :title="latheStatus.errorMessage.value"
      />

      <dl class="grid gap-4 sm:grid-cols-4">
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <dt class="text-xs font-medium uppercase text-slate-500">Active</dt>
          <dd class="mt-2 truncate text-sm font-semibold">{{ activeRunLabel }}</dd>
        </div>
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <dt class="text-xs font-medium uppercase text-slate-500">Queued</dt>
          <dd class="mt-2 text-2xl font-semibold">{{ queuedCount }}</dd>
        </div>
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <dt class="text-xs font-medium uppercase text-slate-500">Parked</dt>
          <dd class="mt-2 text-2xl font-semibold">{{ parkedCount }}</dd>
        </div>
        <div class="rounded-lg border border-slate-200 bg-white p-4">
          <dt class="text-xs font-medium uppercase text-slate-500">Review</dt>
          <dd class="mt-2 text-2xl font-semibold">{{ reviewCount }}</dd>
        </div>
      </dl>
    </div>

    <template #footer>
      <UButton :loading="latheStatus.isLoading.value" color="neutral" variant="soft" @click="latheStatus.refresh">
        Refresh
      </UButton>
    </template>
  </UCard>
</template>
