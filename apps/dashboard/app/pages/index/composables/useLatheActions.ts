import type { LatheActions } from "../ports/lathe-actions";
import type { RivetClient } from "@lathe/contract";
import { computed, ref } from "vue";

import { client } from "@lathe/contract";

type MutationResult<T> = { data?: T; error?: unknown; response: Response };

export const mapError = (err: unknown): string => {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
};

const performMutation = async <T>(
  c: RivetClient,
  fn: (client: RivetClient) => Promise<MutationResult<T>>,
  loading: { value: boolean },
  refresh: () => Promise<void>,
): Promise<T | undefined> => {
  loading.value = true;
  try {
    const result = await fn(c);
    if (!result.response.ok || result.data === undefined) {
      throw result.error;
    }
    void refresh();
    return result.data;
  } catch (err) {
    throw err;
  } finally {
    loading.value = false;
  }
};

export const useLatheActions = (refresh: () => Promise<void>, c: RivetClient = client): LatheActions => {
  const abortLoading = ref(false);
  const answerLoading = ref(false);
  const acceptLoading = ref(false);
  const rejectLoading = ref(false);
  const enqueueContentLoading = ref(false);
  const lastError = ref<string | null>(null);

  const isLoading = computed(
    () =>
      abortLoading.value ||
      answerLoading.value ||
      acceptLoading.value ||
      rejectLoading.value ||
      enqueueContentLoading.value,
  );

  const abort = async (runId: string): Promise<boolean> => {
    lastError.value = null;
    try {
      await performMutation(c, (client) => client.POST("/runs/{runId}/abort", { params: { path: { runId } } }), abortLoading, refresh);
      return true;
    } catch (err) {
      lastError.value = mapError(err);
      return false;
    }
  };

  const answer = async (runId: string, answer: string): Promise<boolean> => {
    lastError.value = null;
    try {
      await performMutation(c, (client) =>
        client.POST("/runs/{runId}/answer", {
          params: { path: { runId } },
          body: { answer },
        }),
        answerLoading,
        refresh,
      );
      return true;
    } catch (err) {
      lastError.value = mapError(err);
      return false;
    }
  };

  const accept = async (runId: string): Promise<boolean> => {
    lastError.value = null;
    try {
      await performMutation(c, (client) => client.POST("/runs/{runId}/accept", { params: { path: { runId } } }), acceptLoading, refresh);
      return true;
    } catch (err) {
      lastError.value = mapError(err);
      return false;
    }
  };

  const reject = async (runId: string, reason?: string): Promise<boolean> => {
    lastError.value = null;
    try {
      await performMutation(c, (client) =>
        client.POST("/runs/{runId}/reject", {
          params: { path: { runId } },
          body: { reason: reason ?? "rejected" },
        }),
        rejectLoading,
        refresh,
      );
      return true;
    } catch (err) {
      lastError.value = mapError(err);
      return false;
    }
  };

  const enqueueContent = async (filename: string, content: string): Promise<boolean> => {
    lastError.value = null;
    try {
      await performMutation(c, (client) =>
        client.POST("/runs/content", {
          body: { content, filename },
        }),
        enqueueContentLoading,
        refresh,
      );
      return true;
    } catch (err) {
      lastError.value = mapError(err);
      return false;
    }
  };

  return {
    abort,
    answer,
    accept,
    reject,
    enqueueContent,
    lastError,
    isLoading,
    abortLoading,
    answerLoading,
    acceptLoading,
    rejectLoading,
    enqueueContentLoading,
  };
};
