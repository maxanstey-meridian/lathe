import { client, type TailEvent } from "@lathe/contract";
import { onUnmounted, ref, watch } from "vue";

import { daemonTailEventsUrl, daemonTailRunEventsUrl } from "../logic/daemon-url";
import { applyTailEvent, tailStateFromSnapshot } from "../logic/tail-state";
import type { LatheTail } from "../ports/lathe-tail";

const TAIL_EVENT_KINDS = [
  "tail.journal",
  "tail.stats",
  "tail.pane.delta",
  "tail.pane.tool",
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

  const refresh = async (): Promise<void> => {
    isLoading.value = true;
    errorMessage.value = null;

    try {
      const result = selectedRunId.value
        ? await client.GET("/tail/{runId}", { params: { path: { runId: selectedRunId.value } } })
        : await client.GET("/tail/active");

      if (result.response.ok) {
        state.value = tailStateFromSnapshot(result.data ?? null);
        return;
      }

      errorMessage.value = `Tail endpoint returned ${result.response.status}.`;
    } catch {
      errorMessage.value = "Unable to reach the Lathe tail endpoint.";
    } finally {
      isLoading.value = false;
    }
  };

  let eventSource: EventSource | null = null;

  const connectEventSource = (): void => {
    eventSource?.close();

    const url = selectedRunId.value
      ? daemonTailRunEventsUrl(runtimeConfig.public.apiBaseUrl, selectedRunId.value)
      : daemonTailEventsUrl(runtimeConfig.public.apiBaseUrl);

    const source = new EventSource(url);

    source.onopen = () => {
      isLive.value = true;
    };

    source.onerror = () => {
      isLive.value = false;
    };

    for (const kind of TAIL_EVENT_KINDS) {
      source.addEventListener(kind, (raw: MessageEvent) => {
        const event = JSON.parse(raw.data) as TailEvent;
        state.value = applyTailEvent(state.value, event, Date.now());
      });
    }

    eventSource = source;
  };

  watch(selectedRunId, () => {
    connectEventSource();
    void refresh();
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
