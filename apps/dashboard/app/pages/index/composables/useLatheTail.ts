import { TAIL_EVENT_KINDS, type TailEvent } from "@lathe/contract";
import { applyTailEvent, tailStateFromSnapshot } from "@lathe/tail-state";
import { onUnmounted, ref, watch } from "vue";

import { daemonTailEventsUrl, daemonTailRunEventsUrl } from "../logic/daemon-url";
import type { LatheTail } from "../ports/lathe-tail";

export const useLatheTail = (): LatheTail => {
  const runtimeConfig = useRuntimeConfig();
  const state = ref(tailStateFromSnapshot(null));
  const isLoading = ref(false);
  const isLive = ref(false);
  const errorMessage = ref<string | null>(null);
  const now = ref(Date.now());
  const selectedRunId = ref<string | null>(null);

  let reconnect = (): void => {};
  const refresh = async (): Promise<void> => {
    isLoading.value = true;
    errorMessage.value = null;
    reconnect();
  };

  let eventSource: EventSource | null = null;
  let generation = 0;

  const connectEventSource = (): void => {
    generation += 1;
    const ownGeneration = generation;
    eventSource?.close();
    state.value = tailStateFromSnapshot(null);
    isLoading.value = true;
    isLive.value = false;
    errorMessage.value = null;

    const url = selectedRunId.value
      ? daemonTailRunEventsUrl(runtimeConfig.public.apiBaseUrl, selectedRunId.value)
      : daemonTailEventsUrl(runtimeConfig.public.apiBaseUrl);

    const source = new EventSource(url);

    source.onopen = () => {
      if (ownGeneration !== generation) return;
      isLive.value = true;
    };

    source.onerror = () => {
      if (ownGeneration !== generation) return;
      isLive.value = false;
      isLoading.value = false;
      errorMessage.value = "Unable to reach the Lathe tail endpoint.";
    };

    for (const kind of TAIL_EVENT_KINDS) {
      source.addEventListener(kind, (raw: MessageEvent) => {
        if (ownGeneration !== generation) return;
        const event = JSON.parse(raw.data) as TailEvent;
        errorMessage.value = null;
        state.value = applyTailEvent(state.value, event, Date.now());
        if (event.kind === "tail.run.changed") {
          isLoading.value = false;
        }
      });
    }

    eventSource = source;
  };
  reconnect = connectEventSource;

  watch(selectedRunId, () => {
    connectEventSource();
  });

  connectEventSource();

  const timer = setInterval(() => {
    now.value = Date.now();
  }, 1_000);

  onUnmounted(() => {
    clearInterval(timer);
    eventSource?.close();
  });

  return {
    state,
    isLoading,
    isLive,
    errorMessage,
    now,
    selectedRunId,
    refresh,
    selectRun: (runId: string | null): void => {
      selectedRunId.value = runId;
    },
  };
};
