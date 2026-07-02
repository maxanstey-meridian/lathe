import { configureRivet } from "@lathe/contract";

export default defineNuxtPlugin(() => {
  const runtimeConfig = useRuntimeConfig();

  configureRivet({
    baseUrl: runtimeConfig.public.apiBaseUrl,
  });
});
