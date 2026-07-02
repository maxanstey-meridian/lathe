<script setup lang="ts">
useHead({
  htmlAttrs: {
    lang: "en",
    class: "dark",
  },
  meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }],
});

useSeoMeta({
  title: "Lathe Dashboard",
  description: "Local dashboard for the Lathe daemon.",
});
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
