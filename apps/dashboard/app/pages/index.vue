<script setup lang="ts">
import { onMounted } from "vue";

import ActiveRunCard from "./index/components/ActiveRunCard.vue";
import CampaignLadder from "./index/components/CampaignLadder.vue";
import EventLog from "./index/components/EventLog.vue";
import ParkedList from "./index/components/ParkedList.vue";
import PacketUpload from "./index/components/PacketUpload.vue";
import QueueList from "./index/components/QueueList.vue";
import ReviewList from "./index/components/ReviewList.vue";
import StagedChains from "./index/components/StagedChains.vue";
import { useDaemonEvents } from "./index/composables/useDaemonEvents";
import { useLatheActions } from "./index/composables/useLatheActions";
import { useLatheStatus } from "./index/composables/useLatheStatus";
import { usePacketValidation } from "./index/composables/usePacketValidation";
import { useReviewData } from "./index/composables/useReviewData";
import { provideDaemonEvents } from "./index/ports/daemon-events";
import { provideLatheActions } from "./index/ports/lathe-actions";
import { provideLatheStatus } from "./index/ports/lathe-status";
import { providePacketValidation } from "./index/ports/packet-validation";
import { provideReviewData } from "./index/ports/review-data";

const latheStatus = provideLatheStatus(useLatheStatus());
const latheActions = provideLatheActions(useLatheActions(latheStatus.refresh));
provideDaemonEvents(useDaemonEvents());
providePacketValidation(usePacketValidation());
provideReviewData(useReviewData(latheStatus));

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

    <ActiveRunCard />

    <UAlert
      v-if="latheActions.lastError.value"
      color="error"
      variant="soft"
      :title="latheActions.lastError.value"
    />

    <UAlert
      v-if="latheStatus.errorMessage.value"
      color="error"
      variant="soft"
      :title="latheStatus.errorMessage.value"
    />

    <PacketUpload />

    <QueueList />

    <ParkedList />

    <CampaignLadder />

    <StagedChains />

    <ReviewList />

    <EventLog />

    <div>
      <UButton :loading="latheStatus.isLoading.value" color="neutral" variant="soft" @click="latheStatus.refresh">
        Refresh
      </UButton>
    </div>
  </section>
</template>
