<script setup lang="ts">
import { onMounted } from "vue";

import ActiveRunCard from "./index/components/ActiveRunCard.vue";
import CampaignLadder from "./index/components/CampaignLadder.vue";
import ParkedList from "./index/components/ParkedList.vue";
import QueueList from "./index/components/QueueList.vue";
import ReviewBadge from "./index/components/ReviewBadge.vue";
import StagedChains from "./index/components/StagedChains.vue";
import { useLatheStatus } from "./index/composables/useLatheStatus";
import { provideLatheStatus } from "./index/ports/lathe-status";

const latheStatus = provideLatheStatus(useLatheStatus());

onMounted(() => {
  void latheStatus.refresh();
});
</script>

<template>
  <section class="space-y-6">
    <div>
      <p class="text-sm font-medium uppercase tracking-wide text-slate-500">Local dashboard</p>
      <h1 class="mt-2 text-3xl font-semibold tracking-tight">Lathe daemon</h1>
      <p class="mt-2 max-w-2xl text-slate-600">
        Live overview of runs, queues, campaigns, and review status.
      </p>
    </div>

    <ActiveRunCard :active-run="latheStatus.status.value?.activeRun ?? null" :is-live="latheStatus.isLive.value" />

    <UAlert
      v-if="latheStatus.errorMessage.value"
      color="error"
      variant="soft"
      :title="latheStatus.errorMessage.value"
    />

    <QueueList :queued="latheStatus.status.value?.queued ?? []" />

    <ParkedList :parked="latheStatus.status.value?.parked ?? []" />

    <CampaignLadder :campaigns="latheStatus.status.value?.campaigns ?? []" />

    <StagedChains :staged="latheStatus.status.value?.staged ?? []" />

    <ReviewBadge :review="latheStatus.status.value?.review ?? { readyForReview: 0, failed: 0 }" />

    <div>
      <UButton :loading="latheStatus.isLoading.value" color="neutral" variant="soft" @click="latheStatus.refresh">
        Refresh
      </UButton>
    </div>
  </section>
</template>
