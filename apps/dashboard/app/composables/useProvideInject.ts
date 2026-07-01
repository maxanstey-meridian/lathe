import { injectLocal, provideLocal } from "@vueuse/core";
import type { InjectionKey } from "vue";

export const useProvideInject = <T>(name: string) => {
  const key: InjectionKey<T> = Symbol(name);

  const useProvide = (value: T): T => {
    provideLocal(key, value);
    return value;
  };

  const useInject = (): T => {
    const value = injectLocal(key);

    if (value === undefined) {
      throw new Error(`[Context:${name}] inject() called outside provider`);
    }

    return value;
  };

  return [useInject, useProvide] as const;
};
