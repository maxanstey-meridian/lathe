import type { components } from "@lathe/contract";
import { computed, onMounted, ref, watch } from "vue";

import { injectLatheStatus } from "../ports/lathe-status";
import type { LatheStatus } from "../ports/lathe-status";

import { fetchReviewRuns } from "./fetchReviewRuns";

type ReviewRun = components["schemas"]["ReviewRunDto"];

export const useReviewData = (status?: LatheStatus, loadReviewRuns: typeof fetchReviewRuns = fetchReviewRuns) => {
  const reviewRuns = ref<ReviewRun[]>([]);
  const reviewError = ref<string | null>(null);
  const source = status ?? injectLatheStatus();

  const fetchReview = async (): Promise<void> => {
    reviewError.value = null;
    try {
      const runs = await loadReviewRuns();
      reviewRuns.value = runs;
    } catch {
      reviewError.value = "Unable to fetch review data.";
    }
  };

  onMounted(() => {
    void fetchReview();
  });

  const reviewVersion = computed(() => {
    const current = source.status.value;
    if (!current) {
      return "";
    }
    return `${current.review.readyForReview}:${current.review.failed}`;
  });

  watch(reviewVersion, () => {
    void fetchReview();
  });

  const removeRun = (runId: string): void => {
    reviewRuns.value = reviewRuns.value.filter((r) => r.runId !== runId);
  };

  return { reviewRuns, reviewError, fetchReview, removeRun };
};
