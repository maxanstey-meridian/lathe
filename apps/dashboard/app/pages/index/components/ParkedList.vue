<script setup lang="ts">
import type { StatusParkedRunDto } from "@lathe/contract";
import { truncate } from "../logic/formatters";

const props = defineProps<{
  parked: StatusParkedRunDto[];
}>();
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-base font-semibold">Parked Runs</h2>
    </template>

    <template v-if="props.parked.length">
      <ul class="space-y-3">
        <li
          v-for="run in props.parked"
          :key="run.runId"
          class="rounded-lg border border-slate-200 bg-white px-3 py-3"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="font-mono text-sm font-medium">{{ run.runId }}</span>
            <UBadge v-if="run.stallRetries > 0" color="warning" variant="soft" size="xs">
              {{ run.stallRetries }} auto-retr{{ run.stallRetries === 1 ? 'y' : 'ies' }}
            </UBadge>
          </div>

          <div v-if="run.blockedReason" class="mt-1 text-xs text-slate-600">
            {{ run.blockedReason }}
          </div>

          <div v-if="run.blockedQuestion" class="mt-1 text-xs text-slate-500">
            {{ truncate(run.blockedQuestion, 120) }}
          </div>
        </li>
      </ul>
    </template>

    <div v-else class="py-6 text-center text-sm text-slate-500">No parked runs</div>
  </UCard>
</template>
