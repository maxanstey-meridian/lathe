import type { RivetClient, SettingsDto } from "@lathe/contract";
import type { ErrorResponse } from "@lathe/contract";
import type { ComputedRef, Ref } from "vue";
import { client } from "@lathe/contract";
import { computed, ref } from "vue";

export interface LatheSettings {
  readonly loaded: Ref<SettingsDto | null>;
  readonly draft: Ref<SettingsDto | null>;
  readonly loading: Ref<boolean>;
  readonly saving: Ref<boolean>;
  readonly restarting: Ref<boolean>;
  readonly error: Ref<string | null>;
  readonly success: Ref<string | null>;
  readonly reposParseError: Ref<string | null>;
  readonly dirty: ComputedRef<boolean>;
  load(): Promise<void>;
  save(): Promise<boolean>;
  restart(): Promise<boolean>;
  resetDraft(): void;
}

export const useLatheSettings = (c: RivetClient = client): LatheSettings => {
  const loaded = ref<SettingsDto | null>(null);
  const draft = ref<SettingsDto | null>(null);
  const loading = ref(false);
  const saving = ref(false);
  const restarting = ref(false);
  const error = ref<string | null>(null);
  const success = ref<string | null>(null);
  const reposParseError = ref<string | null>(null);

  const dirty = computed(() => {
    if (!loaded.value || !draft.value) return false;
    return JSON.stringify(loaded.value) !== JSON.stringify(draft.value);
  });

  const load = async (): Promise<void> => {
    error.value = null;
    loading.value = true;
    try {
      const result = await c.GET("/settings");
      if (!result.data) {
        throw new Error("settings response was empty");
      }
      loaded.value = result.data;
      draft.value = JSON.parse(JSON.stringify(result.data)) as SettingsDto;
    } catch (err) {
      error.value = mapError(err);
    } finally {
      loading.value = false;
    }
  };

  const save = async (): Promise<boolean> => {
    error.value = null;
    reposParseError.value = null;
    if (!draft.value) return false;
    saving.value = true;
    try {
      const result = await c.PUT("/settings", { body: draft.value as SettingsDto });
      if (!result.response.ok) {
        const body = result.error as ErrorResponse | undefined;
        throw body?.message ?? "save failed";
      }
      if (!result.data) {
        throw "save failed";
      }
      loaded.value = result.data;
      draft.value = JSON.parse(JSON.stringify(result.data)) as SettingsDto;
      success.value = "Settings saved";
      setTimeout(() => { success.value = null; }, 3000);
      return true;
    } catch (err) {
      error.value = mapError(err);
      return false;
    } finally {
      saving.value = false;
    }
  };

  const restart = async (): Promise<boolean> => {
    error.value = null;
    restarting.value = true;
    try {
      const result = await c.POST("/restart");
      if (!result.response.ok) {
        const body = result.error as ErrorResponse | undefined;
        throw body?.message ?? "restart failed";
      }
      if (!result.data) {
        throw "restart failed";
      }
      success.value = "Daemon restarting";
      setTimeout(() => { success.value = null; }, 5000);
      return true;
    } catch (err) {
      error.value = mapError(err);
      return false;
    } finally {
      restarting.value = false;
    }
  };

  const resetDraft = (): void => {
    if (loaded.value) {
      draft.value = JSON.parse(JSON.stringify(loaded.value)) as SettingsDto;
    }
  };

  return {
    loaded,
    draft,
    loading,
    saving,
    restarting,
    error,
    success,
    reposParseError,
    dirty,
    load,
    save,
    restart,
    resetDraft,
  };
};

const mapError = (err: unknown): string => {
  if (typeof err === "string") return err;
  if (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return String(err);
};
