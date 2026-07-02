import { client } from "@lathe/contract";
import type { components } from "@lathe/contract";
import { onMounted, ref, watch } from "vue";

import { injectLatheStatus } from "../ports/lathe-status";

type ReviewRun = components["schemas"]["ReviewRunDto"];

export const useReviewData = () => {
  const reviewRuns = ref<ReviewRun[]>([]);
  const reviewError = ref<string | null>(null);
  const status = injectLatheStatus();

  const fetchReview = async (): Promise<void> => {
    reviewError.value = null;
    try {
      const result = await client.GET("/review");
      if (result.data) {
        reviewRuns.value = result.data.runs;
      }
    } catch {
      reviewError.value = "Unable to fetch review data.";
    }
  };

  onMounted(() => {
    void fetchReview();
  });

  watch(status.status, () => {
    void fetchReview();
  });

  const removeRun = (runId: string): void => {
    reviewRuns.value = reviewRuns.value.filter((r) => r.runId !== runId);
  };

  return { reviewRuns, reviewError, fetchReview, removeRun };
};
