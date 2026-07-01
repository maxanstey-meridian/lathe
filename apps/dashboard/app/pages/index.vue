<script setup lang="ts">
import { onMounted } from "vue";

import DaemonStatusCard from "./index/components/daemon-status-card.vue";
import { useLatheStatus } from "./index/composables/useLatheStatus";
import { provideLatheStatus } from "./index/ports/lathe-status";

const latheStatus = provideLatheStatus(useLatheStatus());

onMounted(() => {
  void latheStatus.refresh();
});
</script>

<template>
  <section class="space-y-6">
    <div>
      <p class="text-sm font-medium uppercase tracking-wide text-slate-500">Local dashboard</p>
      <h1 class="mt-2 text-3xl font-semibold tracking-tight">Lathe daemon</h1>
      <p class="mt-2 max-w-2xl text-slate-600">
        Basic Nuxt scaffold with Rivet configured and one real capability for Baby to extend.
      </p>
    </div>

    <DaemonStatusCard />
  </section>
</template>
