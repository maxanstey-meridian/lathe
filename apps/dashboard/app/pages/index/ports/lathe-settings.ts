import type { ComputedRef, Ref } from "vue";

import type { SettingsDto } from "@lathe/contract";

import { useProvideInject } from "../../../composables/useProvideInject";

export interface LatheSettingsPort {
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

export const [injectLatheSettings, provideLatheSettings] = useProvideInject<LatheSettingsPort>("LatheSettings");
