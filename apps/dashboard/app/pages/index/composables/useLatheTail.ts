import { type TailEvent } from "@lathe/contract";
import { onUnmounted, ref, watch } from "vue";

import { daemonTailEventsUrl, daemonTailRunEventsUrl } from "../logic/daemon-url";
import { applyTailEvent, tailStateFromSnapshot } from "../logic/tail-state";
import type { LatheTail } from "../ports/lathe-tail";

const TAIL_EVENT_KINDS = [
  "tail.journal",
  "tail.stats",
  "tail.pane.delta",
  "tail.pane.tool",
  "tail.panes.replaced",
  "tail.driver.command",
  "tail.driver.delta",
  "tail.super.verdict",
  "tail.run.changed",
  "tail.ping",
] as const;

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

    const url = selectedRunId.value
      ? daemonTailRunEventsUrl(runtimeConfig.public.apiBaseUrl, selectedRunId.value)
      : daemonTailEventsUrl(runtimeConfig.public.apiBaseUrl);

    const source = new EventSource(url);

    source.onopen = () => {
      if (ownGeneration !== generation) return;
      isLive.value = true;
      isLoading.value = false;
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
