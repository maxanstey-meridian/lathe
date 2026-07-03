<script setup lang="ts">
import { onMounted, ref } from "vue";

import CommandBar from "./index/components/CommandBar.vue";
import PacketUpload from "./index/components/PacketUpload.vue";
import ReviewList from "./index/components/ReviewList.vue";
import TailView from "./index/components/TailView.vue";
import CampaignLadder from "./index/components/CampaignLadder.vue";
import ParkedList from "./index/components/ParkedList.vue";
import QueueList from "./index/components/QueueList.vue";
import StagedChains from "./index/components/StagedChains.vue";
import StoppedList from "./index/components/StoppedList.vue";
import { useLatheActions } from "./index/composables/useLatheActions";
import { useLatheStatus } from "./index/composables/useLatheStatus";
import { useLatheTail } from "./index/composables/useLatheTail";
import { usePacketValidation } from "./index/composables/usePacketValidation";
import { useReviewData } from "./index/composables/useReviewData";
import type { TabId } from "./index/logic/tabs";
import { provideLatheActions } from "./index/ports/lathe-actions";
import { provideLatheStatus } from "./index/ports/lathe-status";
import { provideLatheTail } from "./index/ports/lathe-tail";
import { providePacketValidation } from "./index/ports/packet-validation";
import { provideReviewData } from "./index/ports/review-data";

const latheStatus = provideLatheStatus(useLatheStatus());
const latheActions = provideLatheActions(useLatheActions(latheStatus.refresh));
const latheTail = provideLatheTail(useLatheTail());
providePacketValidation(usePacketValidation());
provideReviewData(useReviewData(latheStatus));

const activeTab = ref<TabId>("console");
const showUpload = ref(false);

onMounted(() => {
  void latheStatus.refresh();
  void latheTail.refresh();
});
</script>

<template>
  <div class="flex h-dvh flex-col">
    <CommandBar
      :active-tab="activeTab"
      @update:active-tab="activeTab = $event"
      @upload="showUpload = true"
    />

    <UAlert
      v-if="latheActions.lastError.value"
      class="shrink-0 rounded-none"
      color="error"
      variant="soft"
      :title="latheActions.lastError.value"
    />

    <UAlert
      v-if="latheStatus.errorMessage.value"
      class="shrink-0 rounded-none"
      color="error"
      variant="soft"
      :title="latheStatus.errorMessage.value"
    />

    <div class="min-h-0 flex-1">
      <TailView v-show="activeTab === 'console'" class="h-full" />

      <div v-if="activeTab === 'runs'" class="h-full overflow-y-auto p-4">
        <div class="mx-auto max-w-5xl space-y-4">
          <QueueList />
          <ParkedList />
          <CampaignLadder />
          <StagedChains />
          <StoppedList />
        </div>
      </div>

      <div v-if="activeTab === 'review'" class="h-full overflow-y-auto p-4">
        <div class="mx-auto max-w-5xl">
          <ReviewList />
        </div>
      </div>
    </div>

    <UModal
      :open="showUpload"
      title="Upload Packet"
      :persist="false"
      @update:open="(val: boolean) => { if (!val) showUpload = false; }"
    >
      <template #body>
        <PacketUpload @queued="showUpload = false" />
      </template>
    </UModal>
  </div>
</template>
