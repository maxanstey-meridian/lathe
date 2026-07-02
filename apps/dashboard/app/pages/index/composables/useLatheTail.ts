import { client, type TailEvent } from "@lathe/contract";
import { onUnmounted, ref } from "vue";

import { daemonTailEventsUrl } from "../logic/daemon-url";
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

  const refresh = async (): Promise<void> => {
    isLoading.value = true;
    errorMessage.value = null;

    try {
      const result = await client.GET("/tail/active");

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

  const eventSource = new EventSource(daemonTailEventsUrl(runtimeConfig.public.apiBaseUrl));

  eventSource.onopen = () => {
    isLive.value = true;
  };

  eventSource.onerror = () => {
    isLive.value = false;
  };

  for (const kind of TAIL_EVENT_KINDS) {
    eventSource.addEventListener(kind, (raw: MessageEvent) => {
      const event = JSON.parse(raw.data) as TailEvent;
      state.value = applyTailEvent(state.value, event, Date.now());
    });
  }

  const timer = setInterval(() => {
    now.value = Date.now();
  }, 1_000);

  onUnmounted(() => {
    clearInterval(timer);
    eventSource.close();
  });

  return {
    state,
    isLoading,
    isLive,
    errorMessage,
    now,
    refresh,
  };
};
