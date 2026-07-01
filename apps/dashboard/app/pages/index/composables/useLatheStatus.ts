import { client } from "@lathe/contract";
import { computed, ref } from "vue";

import type { LatheStatus, StatusDto } from "../ports/lathe-status";

export const useLatheStatus = (): LatheStatus => {
  const status = ref<StatusDto | null>(null);
  const isLoading = ref(false);
  const errorMessage = ref<string | null>(null);

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

  return {
    status,
    isLoading,
    errorMessage,
    isDaemonReachable,
    refresh,
  };
};
