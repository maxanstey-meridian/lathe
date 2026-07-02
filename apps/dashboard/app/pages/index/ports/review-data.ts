import type { Ref } from "vue";

import type { ReviewRunDto } from "@lathe/contract";

import { useProvideInject } from "~/composables/useProvideInject";

export interface ReviewData {
  readonly reviewRuns: Ref<ReviewRunDto[]>;
  readonly reviewError: Ref<string | null>;
  removeRun(runId: string): void;
}

export const [injectReviewData, provideReviewData] = useProvideInject<ReviewData>("ReviewData");
