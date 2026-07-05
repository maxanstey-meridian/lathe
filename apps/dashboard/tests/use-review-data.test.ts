import { test, expect } from "vitest";
import { computed, defineComponent, nextTick, ref, type Ref } from "vue";
import { mount } from "@vue/test-utils";

import type { LatheStatus, StatusDto } from "../app/pages/index/ports/lathe-status";
import { useReviewData } from "../app/pages/index/composables/useReviewData";

type ReviewRun = {
  runId: string;
  status: string;
  outcomes: string;
  branch: string;
  repo: string;
  base: string;
  blockedQuestion: string | null;
};

const makeReviewRun = (runId: string, status: string): ReviewRun => ({
  runId,
  status,
  outcomes: `outcomes for ${runId}`,
  branch: `branch-${runId}`,
  repo: "test/repo",
  base: "main",
  blockedQuestion: null,
});

const makeStatus = (): StatusDto => ({
  activeRuns: [],
  queued: [],
  parked: [],
  campaigns: [],
  staged: [],
  review: {
    readyForReview: 0,
    failed: 0,
  },
});

const makeLatheStatus = (status: Ref<StatusDto | null>): LatheStatus => ({
  status,
  isLoading: ref(false),
  errorMessage: ref(null),
  isDaemonReachable: computed(() => true),
  isLive: ref(false),
  refresh: async () => undefined,
});

const flush = async (): Promise<void> => {
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
};

const mountReviewDataHarness = (loadReviewRuns: () => Promise<ReviewRun[]> | ReviewRun[]) => {
  const status = ref<StatusDto | null>(null);
  let api: ReturnType<typeof useReviewData> | undefined;

  const Harness = defineComponent({
    setup() {
      api = useReviewData(makeLatheStatus(status), loadReviewRuns);
      return () => null;
    },
  });

  const wrapper = mount(Harness);

  if (!api) {
    throw new Error("review data composable was not created");
  }

  return { api, wrapper, status };
};

test("useReviewData fetches on mount and refetches when status changes", async () => {
  const firstRun = makeReviewRun("run-1", "ready_for_review");
  const secondRun = makeReviewRun("run-2", "failed");
  let callCount = 0;

  const { api, wrapper, status } = mountReviewDataHarness(async () => {
    callCount += 1;
    return callCount === 1 ? [firstRun] : [secondRun];
  });

  await flush();
  expect(api.reviewRuns.value).toEqual([firstRun]);
  expect(api.reviewError.value).toBeNull();

  status.value = makeStatus();
  await flush();

  expect(api.reviewRuns.value).toEqual([secondRun]);
  expect(api.reviewError.value).toBeNull();

  wrapper.unmount();
});

test("useReviewData surfaces load failures and recovers on a later refresh", async () => {
  const recoveredRun = makeReviewRun("run-3", "ready_for_review");
  let callCount = 0;

  const { api, wrapper, status } = mountReviewDataHarness(async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error("review backend down");
    }
    return [recoveredRun];
  });

  await flush();
  expect(api.reviewRuns.value).toEqual([]);
  expect(api.reviewError.value).toBe("Unable to fetch review data.");

  status.value = makeStatus();
  await flush();

  expect(api.reviewRuns.value).toEqual([recoveredRun]);
  expect(api.reviewError.value).toBeNull();

  wrapper.unmount();
});
