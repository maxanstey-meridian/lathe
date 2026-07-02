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
  green: { border: "border-emerald-500", text: "text-emerald-400", dot: "bg-emerald-500" },
  magenta: { border: "border-fuchsia-500", text: "text-fuchsia-400", dot: "bg-fuchsia-500" },
  blue: { border: "border-sky-500", text: "text-sky-400", dot: "bg-sky-500" },
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
    class="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950 border-t-2"
    :class="isActive ? classes.border : 'border-transparent'"
  >
    <header class="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-3 py-1.5">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full" :class="isActive ? classes.dot : 'bg-slate-700'"></span>
          <h3 class="truncate text-xs font-semibold" :class="isActive ? classes.text : 'text-slate-600'">{{ title }}</h3>
          <span v-if="!isActive" class="text-xs text-slate-700">idle</span>
        </div>
        <p class="mt-0.5 truncate font-mono text-xs text-slate-700">{{ model }}</p>
      </div>
    </header>

    <div ref="scrollContainer" class="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-5">
      <div v-if="lines.length" class="space-y-0.5">
        <p
          v-for="(line, index) in lines"
          :key="`${index}-${line.text}`"
          class="whitespace-pre-wrap break-words"
          :class="{
            'text-slate-600': line.style === 'think',
            'text-cyan-500': line.style === 'tool',
            'text-slate-300': line.style === 'text',
          }"
        >
          {{ line.text }}
        </p>
      </div>
      <div v-else class="flex h-full items-center justify-center font-mono text-xs text-slate-700">—</div>
    </div>
  </section>
</template>
