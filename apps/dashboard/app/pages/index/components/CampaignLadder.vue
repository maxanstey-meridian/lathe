<script setup lang="ts">
import type { StatusCampaignDto } from "@lathe/contract";
import { campaignStatusIcon, truncate } from "../logic/formatters";

const props = defineProps<{
  campaigns: StatusCampaignDto[];
}>();
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-base font-semibold">Campaigns</h2>
    </template>

    <template v-if="props.campaigns.length">
      <ul class="space-y-2">
        <li
          v-for="campaign in props.campaigns"
          :key="campaign.campaignId"
          class="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2"
        >
          <div class="flex items-center gap-2">
            <span class="text-sm">{{ campaignStatusIcon(campaign.status) }}</span>
            <span class="font-mono text-sm">{{ campaign.campaignId }}</span>
            <UBadge variant="soft" size="xs">{{ campaign.status }}</UBadge>
          </div>
          <div v-if="campaign.originalIntent" class="text-xs text-slate-500">
            {{ truncate(campaign.originalIntent, 80) }}
          </div>
          <div class="flex items-center gap-2">
            <span class="text-xs text-slate-500">pass</span>
            <span class="text-sm font-medium">{{ campaign.pass }}/{{ campaign.maxPasses }}</span>
          </div>
        </li>
      </ul>
    </template>

    <div v-else class="py-6 text-center text-sm text-slate-500">No campaigns</div>
  </UCard>
</template>
