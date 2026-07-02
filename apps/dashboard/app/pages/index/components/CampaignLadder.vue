<script setup lang="ts">
import { injectLatheStatus } from "../ports/lathe-status";
import { campaignStatusIcon, truncate } from "../logic/formatters";

const status = injectLatheStatus();
</script>

<template>
  <section>
    <h2 class="mb-2 text-sm font-semibold text-slate-300">Campaigns</h2>

    <template v-if="status.status.value?.campaigns.length">
      <div class="overflow-hidden rounded-lg border border-slate-800">
        <ul class="divide-y divide-slate-800">
          <li
            v-for="campaign in status.status.value.campaigns"
            :key="campaign.campaignId"
            class="flex items-center gap-3 bg-slate-900/50 px-3 py-2"
          >
            <span class="text-sm">{{ campaignStatusIcon(campaign.status) }}</span>
            <span class="font-mono text-xs text-slate-400">{{ campaign.campaignId }}</span>
            <UBadge variant="soft" size="xs">{{ campaign.status }}</UBadge>
            <div v-if="campaign.originalIntent" class="ml-auto max-w-md truncate text-xs text-slate-600">
              {{ truncate(campaign.originalIntent, 80) }}
            </div>
            <div class="flex items-center gap-1.5">
              <span class="text-xs text-slate-600">pass</span>
              <span class="text-xs font-medium text-slate-400">{{ campaign.pass }}/{{ campaign.maxPasses }}</span>
            </div>
          </li>
        </ul>
      </div>
    </template>

    <div v-else class="rounded-lg border border-slate-800 py-6 text-center text-sm text-slate-600">No campaigns</div>
  </section>
</template>
