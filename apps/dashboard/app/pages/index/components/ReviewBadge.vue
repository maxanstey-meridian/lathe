<script setup lang="ts">
import { injectLatheStatus } from "../ports/lathe-status";

const status = injectLatheStatus();
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-base font-semibold">Review</h2>
    </template>

    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2">
        <UBadge v-if="(status.status.value?.review.readyForReview ?? 0) > 0" color="success" variant="soft" size="lg">
          {{ status.status.value?.review.readyForReview ?? 0 }} ready
        </UBadge>
        <UBadge v-else color="neutral" variant="soft" size="lg">0</UBadge>
      </div>
      <div class="flex items-center gap-2">
        <UBadge v-if="(status.status.value?.review.failed ?? 0) > 0" color="error" variant="soft" size="lg">
          {{ status.status.value?.review.failed ?? 0 }} failed
        </UBadge>
        <UBadge v-else color="neutral" variant="soft" size="lg">0</UBadge>
      </div>
    </div>

    <div v-if="(status.status.value?.review.readyForReview ?? 0) === 0 && (status.status.value?.review.failed ?? 0) === 0" class="py-6 text-center text-sm text-slate-500">
      Nothing to review
    </div>
  </UCard>
</template>
