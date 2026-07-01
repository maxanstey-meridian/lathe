import type { LatheEvent } from "@lathe/contract";
import { onUnmounted, ref } from "vue";

import { daemonEventsUrl } from "../logic/daemon-url";
import type { DaemonEvent } from "../ports/daemon-events";

const MAX_EVENTS = 100;

const EVENT_KINDS = ["run.state", "turn.started", "gate.decision", "tokens", "verdict", "log"] as const;

export const useDaemonEvents = () => {
  const runtimeConfig = useRuntimeConfig();
  const events = ref<DaemonEvent[]>([]);
  const isLive = ref(false);

  const eventSource = new EventSource(daemonEventsUrl(runtimeConfig.public.apiBaseUrl));

  eventSource.onopen = () => {
    isLive.value = true;
  };

  eventSource.onerror = () => {
    isLive.value = false;
  };

  for (const kind of EVENT_KINDS) {
    eventSource.addEventListener(kind, (raw: MessageEvent) => {
      const data = JSON.parse(raw.data) as LatheEvent;
      const seq = Number(raw.lastEventId);
      events.value = [{ seq, kind, data }, ...events.value].slice(0, MAX_EVENTS);
    });
  }

  onUnmounted(() => {
    eventSource.close();
  });

  return { events, isLive };
};
