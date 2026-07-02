<script setup lang="ts">
import { onMounted } from "vue";

import ActiveRunCard from "./index/components/ActiveRunCard.vue";
import CampaignLadder from "./index/components/CampaignLadder.vue";
import ParkedList from "./index/components/ParkedList.vue";
import PacketUpload from "./index/components/PacketUpload.vue";
import QueueList from "./index/components/QueueList.vue";
import ReviewList from "./index/components/ReviewList.vue";
import StagedChains from "./index/components/StagedChains.vue";
import TailView from "./index/components/TailView.vue";
import { useLatheActions } from "./index/composables/useLatheActions";
import { useLatheStatus } from "./index/composables/useLatheStatus";
import { useLatheTail } from "./index/composables/useLatheTail";
import { provideLatheActions } from "./index/ports/lathe-actions";
import { provideLatheStatus } from "./index/ports/lathe-status";
import { provideLatheTail } from "./index/ports/lathe-tail";

const latheStatus = provideLatheStatus(useLatheStatus());
const latheActions = provideLatheActions(useLatheActions(latheStatus.refresh));
const latheTail = provideLatheTail(useLatheTail());

onMounted(() => {
  void latheStatus.refresh();
  void latheTail.refresh();
});
</script>

<template>
  <section class="flex h-full min-h-0 flex-col gap-4">
    <header class="flex shrink-0 flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <p class="text-xs font-medium uppercase tracking-wide text-slate-500">Local dashboard</p>
        <h1 class="mt-1 text-2xl font-semibold tracking-tight">Lathe daemon</h1>
      </div>
      <div class="flex items-center gap-3">
        <div class="flex items-center gap-2 text-xs text-slate-500">
          <span class="h-2 w-2 rounded-full" :class="latheStatus.isLive.value ? 'bg-emerald-500' : 'bg-red-500'"></span>
          <span>{{ latheStatus.isLive.value ? "status live" : "status offline" }}</span>
        </div>
        <UButton :loading="latheStatus.isLoading.value" color="neutral" variant="soft" size="sm" @click="latheStatus.refresh">
          Refresh status
        </UButton>
      </div>
    </header>

    <UAlert
      v-if="latheActions.lastError.value"
      class="shrink-0"
      color="error"
      variant="soft"
      :title="latheActions.lastError.value"
    />

    <UAlert
      v-if="latheStatus.errorMessage.value"
      class="shrink-0"
      color="error"
      variant="soft"
      :title="latheStatus.errorMessage.value"
    />

    <div class="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <TailView class="h-[80dvh] min-h-[30rem] xl:h-full xl:min-h-0" />

      <aside class="min-h-0 space-y-4 xl:overflow-y-auto xl:pr-1">
        <PacketUpload />

        <ActiveRunCard />

        <QueueList />

        <ParkedList />

        <CampaignLadder />

        <StagedChains />

        <ReviewList />
      </aside>
    </div>
  </section>
</template>
