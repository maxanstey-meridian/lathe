<script setup lang="ts">
import type { StatusReviewSummaryDto } from "@lathe/contract";

const props = defineProps<{
  review: StatusReviewSummaryDto;
}>();
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-base font-semibold">Review</h2>
    </template>

    <div class="flex items-center gap-4">
      <div class="flex items-center gap-2">
        <UBadge v-if="props.review.readyForReview > 0" color="success" variant="soft" size="lg">
          {{ props.review.readyForReview }} ready
        </UBadge>
        <UBadge v-else color="neutral" variant="soft" size="lg">0</UBadge>
      </div>
      <div class="flex items-center gap-2">
        <UBadge v-if="props.review.failed > 0" color="error" variant="soft" size="lg">
          {{ props.review.failed }} failed
        </UBadge>
        <UBadge v-else color="neutral" variant="soft" size="lg">0</UBadge>
      </div>
    </div>

    <div v-if="props.review.readyForReview === 0 && props.review.failed === 0" class="py-6 text-center text-sm text-slate-500">
      Nothing to review
    </div>
  </UCard>
</template>
