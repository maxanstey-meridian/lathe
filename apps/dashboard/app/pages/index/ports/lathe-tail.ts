import type { Ref } from "vue";

import { useProvideInject } from "~/composables/useProvideInject";

import type { TailViewState } from "../logic/tail-state";

export interface LatheTail {
  readonly state: Ref<TailViewState>;
  readonly isLoading: Ref<boolean>;
  readonly isLive: Ref<boolean>;
  readonly errorMessage: Ref<string | null>;
  readonly now: Ref<number>;
  readonly selectedRunId: Ref<string | null>;
  readonly refresh: () => Promise<void>;
  readonly selectRun: (runId: string | null) => void;
}

export const [injectLatheTail, provideLatheTail] = useProvideInject<LatheTail>("LatheTail");
