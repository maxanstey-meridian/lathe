import type { LatheActions } from "../ports/lathe-actions";
import { client } from "@lathe/contract";
import { computed, ref } from "vue";

export const useLatheActions = (refresh: () => Promise<void>): LatheActions => {
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

  const mapError = (err: unknown): string => {
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
      return (err as { message: string }).message;
    }
    return String(err);
  };

  const handleMutation = async <T>(
    fn: () => Promise<T>,
    loading: typeof abortLoading,
  ): Promise<T> => {
    lastError.value = null;
    loading.value = true;
    try {
      const result = await fn();
      void refresh();
      return result;
    } catch (err) {
      const msg = mapError(err);
      lastError.value = msg;
      throw err;
    } finally {
      loading.value = false;
    }
  };

  const abort = async (runId: string): Promise<boolean> => {
    try {
      await handleMutation(
        () => client.POST("/runs/{runId}/abort", { params: { path: { runId } } }),
        abortLoading,
      );
      return true;
    } catch {
      return false;
    }
  };

  const answer = async (runId: string, answer: string): Promise<boolean> => {
    try {
      await handleMutation(
        () =>
          client.POST("/runs/{runId}/answer", {
            params: { path: { runId } },
            body: { answer },
          }),
        answerLoading,
      );
      return true;
    } catch {
      return false;
    }
  };

  const accept = async (runId: string): Promise<boolean> => {
    try {
      await handleMutation(
        () => client.POST("/runs/{runId}/accept", { params: { path: { runId } } }),
        acceptLoading,
      );
      return true;
    } catch {
      return false;
    }
  };

  const reject = async (runId: string, reason?: string): Promise<boolean> => {
    try {
      await handleMutation(
        () =>
          client.POST("/runs/{runId}/reject", {
            params: { path: { runId } },
            body: { reason: reason ?? "rejected" },
          }),
        rejectLoading,
      );
      return true;
    } catch {
      return false;
    }
  };

  const enqueueContent = async (filename: string, content: string): Promise<boolean> => {
    try {
      await handleMutation(
        () =>
          client.POST("/runs/content", {
            body: { content, filename },
          }),
        enqueueContentLoading,
      );
      return true;
    } catch {
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
