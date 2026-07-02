import type { components } from "@lathe/contract";
import type { ComputedRef, Ref } from "vue";

import { useProvideInject } from "../../../composables/useProvideInject";

export type StatusDto = components["schemas"]["StatusDto"];

export interface LatheStatus {
  readonly status: Ref<StatusDto | null>;
  readonly isLoading: Ref<boolean>;
  readonly errorMessage: Ref<string | null>;
  readonly isDaemonReachable: ComputedRef<boolean>;
  readonly isLive: Ref<boolean>;
  readonly refresh: () => Promise<void>;
}

export const [injectLatheStatus, provideLatheStatus] = useProvideInject<LatheStatus>("LatheStatus");
