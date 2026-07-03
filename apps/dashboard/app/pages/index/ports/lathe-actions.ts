import type { ComputedRef, Ref } from "vue";

import { useProvideInject } from "~/composables/useProvideInject";

export type ActionState = {
  loading: boolean;
  error: string | null;
};

export interface LatheActions {
  readonly stopLoading: Ref<boolean>;
  readonly answerLoading: Ref<boolean>;
  readonly acceptLoading: Ref<boolean>;
  readonly rejectLoading: Ref<boolean>;
  readonly enqueueContentLoading: Ref<boolean>;
  readonly lastError: Ref<string | null>;
  readonly isLoading: ComputedRef<boolean>;
  stop(runId: string): Promise<boolean>;
  answer(runId: string, answer: string): Promise<boolean>;
  accept(runId: string): Promise<boolean>;
  reject(runId: string, reason?: string): Promise<boolean>;
  enqueueContent(filename: string, content: string): Promise<boolean>;
}

export const [injectLatheActions, provideLatheActions] = useProvideInject<LatheActions>("LatheActions");
