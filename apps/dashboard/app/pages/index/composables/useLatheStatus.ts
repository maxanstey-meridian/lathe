import { client } from "@lathe/contract";
import { computed, onUnmounted, ref } from "vue";

import { connectLatheStatusLiveUpdates } from "./lathe-status-live";
import { daemonEventsUrl } from "../logic/daemon-url";
import type { LatheStatus, StatusDto } from "../ports/lathe-status";

const POLL_INTERVAL_MS = 5_000;

export const useLatheStatus = (): LatheStatus => {
  const runtimeConfig = useRuntimeConfig();
  const status = ref<StatusDto | null>(null);
  const isLoading = ref(false);
  const errorMessage = ref<string | null>(null);
  const isLive = ref(false);

  const isDaemonReachable = computed(() => status.value !== null && errorMessage.value === null);

  const refresh = async (): Promise<void> => {
    isLoading.value = true;
    errorMessage.value = null;

    try {
      const result = await client.GET("/status");

      if (result.data) {
        status.value = result.data;
        return;
      }

      errorMessage.value = `Daemon returned ${result.response.status}.`;
    } catch {
      errorMessage.value = "Unable to reach the Lathe daemon.";
    } finally {
      isLoading.value = false;
    }
  };

  const requeue = async (runId: string): Promise<void> => {
    await client.POST("/runs/{runId}/requeue", { params: { path: { runId } } });
    await refresh();
  };

  const liveConnection = connectLatheStatusLiveUpdates({
    url: daemonEventsUrl(runtimeConfig.public.apiBaseUrl),
    onLiveChange: (live) => {
      isLive.value = live;
    },
    onRefresh: () => {
      void refresh();
    },
  });

  const pollTimer = setInterval(() => {
    void refresh();
  }, POLL_INTERVAL_MS);

  onUnmounted(() => {
    clearInterval(pollTimer);
    liveConnection.close();
  });

  return {
    status,
    isLoading,
    errorMessage,
    isDaemonReachable,
    isLive,
    refresh,
    requeue,
  };
};
