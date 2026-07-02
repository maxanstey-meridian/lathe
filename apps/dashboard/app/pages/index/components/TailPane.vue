<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";

import { visiblePaneLines, type TailPaneState } from "../logic/tail-state";

type Accent = "green" | "magenta" | "blue";

const props = defineProps<{
  readonly title: string;
  readonly model: string;
  readonly pane: TailPaneState;
  readonly accent: Accent;
  readonly now: number;
}>();

const accentClasses: Record<Accent, { readonly border: string; readonly text: string; readonly dot: string }> = {
  green: { border: "border-emerald-500", text: "text-emerald-600", dot: "bg-emerald-500" },
  magenta: { border: "border-fuchsia-500", text: "text-fuchsia-600", dot: "bg-fuchsia-500" },
  blue: { border: "border-sky-500", text: "text-sky-600", dot: "bg-sky-500" },
};

const isActive = computed(() => props.now - props.pane.lastAt < 10_000);
const lines = computed(() => visiblePaneLines(props.pane).slice(-80));
const classes = computed(() => accentClasses[props.accent]);
const scrollContainer = ref<HTMLElement | null>(null);

watch(lines, async () => {
  await nextTick();

  const container = scrollContainer.value;
  if (container) {
    container.scrollTop = container.scrollHeight;
  }
}, { flush: "post" });
</script>

<template>
  <section
    class="flex min-h-[22rem] flex-1 flex-col overflow-hidden rounded-xl border bg-white shadow-sm lg:min-h-0"
    :class="isActive ? classes.border : 'border-slate-200'"
  >
    <header class="flex items-center justify-between gap-3 border-b border-slate-100 px-3 py-2">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-full" :class="isActive ? classes.dot : 'bg-slate-300'"></span>
          <h3 class="truncate text-sm font-semibold" :class="isActive ? classes.text : 'text-slate-500'">{{ title }}</h3>
          <span v-if="!isActive" class="text-xs text-slate-400">waiting</span>
        </div>
        <p class="mt-0.5 truncate text-xs text-slate-400">{{ model }}</p>
      </div>
    </header>

    <div ref="scrollContainer" class="min-h-0 flex-1 overflow-y-auto p-3 font-mono text-xs leading-5">
      <div v-if="lines.length" class="space-y-1">
        <p
          v-for="(line, index) in lines"
          :key="`${index}-${line.text}`"
          class="whitespace-pre-wrap break-words"
          :class="{
            'text-slate-400': line.style === 'think',
            'text-cyan-700': line.style === 'tool',
            'text-slate-800': line.style === 'text',
          }"
        >
          {{ line.text }}
        </p>
      </div>
      <div v-else class="flex h-full items-center justify-center text-sm text-slate-400">No output yet</div>
    </div>
  </section>
</template>
