import { client } from "@lathe/contract";
import { computed, onUnmounted, ref } from "vue";

import { connectLatheStatusLiveUpdates } from "./lathe-status-live";
import type { LatheStatus, StatusDto } from "../ports/lathe-status";

const SSE_URL = "http://127.0.0.1:4198/events";

export const useLatheStatus = (): LatheStatus => {
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

  const liveConnection = connectLatheStatusLiveUpdates({
    url: SSE_URL,
    onLiveChange: (live) => {
      isLive.value = live;
    },
    onRefresh: () => {
      void refresh();
    },
  });

  onUnmounted(() => {
    liveConnection.close();
  });

  return {
    status,
    isLoading,
    errorMessage,
    isDaemonReachable,
    isLive,
    refresh,
  };
};
