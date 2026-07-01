export default defineNuxtConfig({
  modules: ["@nuxt/ui"],
  ssr: false,

  devtools: {
    enabled: true,
  },

  css: ["~/assets/css/main.css"],

  build: {
    transpile: ["@lathe/contract"],
  },

  devServer: {
    port: 3000,
  },

  runtimeConfig: {
    public: {
      apiBaseUrl: process.env.NUXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:4198",
    },
  },

  compatibilityDate: "2026-07-01",
});
