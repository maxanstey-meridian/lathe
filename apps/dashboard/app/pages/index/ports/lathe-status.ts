import type { components } from "@lathe/contract";
import type { ComputedRef, Ref } from "vue";

import { useProvideInject } from "../../../composables/useProvideInject";

export type LatheStatusSnapshot = components["schemas"]["StatusDto"];

export interface LatheStatus {
  readonly status: Ref<LatheStatusSnapshot | null>;
  readonly isLoading: Ref<boolean>;
  readonly errorMessage: Ref<string | null>;
  readonly isDaemonReachable: ComputedRef<boolean>;
  readonly isLive: Ref<boolean>;
  readonly refresh: () => Promise<void>;
  readonly requeue: (runId: string) => Promise<void>;
}

export const [injectLatheStatus, provideLatheStatus] = useProvideInject<LatheStatus>("LatheStatus");
