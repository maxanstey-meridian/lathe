<script setup lang="ts">
import Prism from "prismjs";
import "prismjs/components/prism-json";
import { computed, nextTick, ref, watch } from "vue";

import { classifyLine } from "../logic/tail-json";
import { visiblePaneLines, type TailPaneLine, type TailPaneState } from "../logic/tail-state";

type Accent = "green" | "magenta" | "blue" | "amber";

type RenderedLine = {
  readonly key: string;
  readonly text: string;
  readonly style: TailPaneLine["style"];
  readonly classified: ReturnType<typeof classifyLine>;
  readonly attachment?: string;
};

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
  amber: { border: "border-amber-500", text: "text-amber-400", dot: "bg-amber-500" },
};

const isActive = computed(() => props.now - props.pane.lastAt < 10_000);
const lines = computed(() => visiblePaneLines(props.pane).slice(-80));
const renderedLines = computed<RenderedLine[]>(() =>
  lines.value.map((line, index) => ({
    key: `${index}-${line.text}`,
    text: line.text,
    style: line.style,
    classified: classifyLine(line.text),
    ...(line.attachment !== undefined ? { attachment: line.attachment } : {}),
  })),
);
const classes = computed(() => accentClasses[props.accent]);
const scrollContainer = ref<HTMLElement | null>(null);

const selectedJson = ref<{ readonly title: string; readonly body: string; readonly html: string } | null>(null);

const escapeHtml = (text: string): string => text
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

const highlightJson = (body: string): string => {
  const jsonGrammar = Prism.languages.json;
  return jsonGrammar ? Prism.highlight(body, jsonGrammar, "json") : escapeHtml(body);
};

const openJson = (title: string, body: string): void => {
  selectedJson.value = {
    title,
    body,
    html: highlightJson(body),
  };
};

const closeJson = (): void => {
  selectedJson.value = null;
};

const copyJson = async (): Promise<void> => {
  const current = selectedJson.value;
  if (current) {
    await navigator.clipboard.writeText(current.body);
  }
};

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
      <div v-if="renderedLines.length" class="space-y-0.5">
        <template v-for="line in renderedLines" :key="line.key">
          <span
            v-if="line.classified.kind === 'json'"
            class="whitespace-pre-wrap break-words"
            :class="{
              'text-slate-600': line.style === 'think',
              'text-cyan-500': line.style === 'tool',
              'text-slate-300': line.style === 'text',
            }"
          >
            <template v-for="(segment, segmentIndex) in line.classified.segments" :key="`${line.key}-segment-${segmentIndex}`">
              <span v-if="segment.kind === 'text'">{{ segment.text }}</span>
              <button
                v-else
                type="button"
                class="inline-block rounded border border-slate-700 px-1.5 py-0.5 transition-colors hover:border-slate-500 hover:bg-slate-800/50"
                :class="{
                  'text-slate-500': line.style === 'think',
                  'text-cyan-600': line.style === 'tool',
                  'text-slate-400': line.style === 'text',
                }"
                @click="openJson(`${title} JSON ${segment.payloadIndex + 1}`, segment.payload.formatted)"
              >
                {{ line.classified.payloads.length === 1 ? segment.payload.label : `${segment.payloadIndex + 1}: ${segment.payload.label}` }}
              </button>
            </template>
          </span>
          <p
            v-else
            class="whitespace-pre-wrap break-words"
            :class="{
              'text-slate-600': line.style === 'think',
              'text-cyan-500': line.style === 'tool',
              'text-slate-300': line.style === 'text',
            }"
          >
            {{ line.text }}<button
              v-if="line.attachment"
              type="button"
              class="ml-1 inline-block rounded border border-slate-700 px-1 text-cyan-600 transition-colors hover:border-slate-500 hover:bg-slate-800/50"
              @click="openJson(`${title} input`, line.attachment)"
            >[args]</button>
          </p>
        </template>
      </div>
      <div v-else class="flex h-full items-center justify-center font-mono text-xs text-slate-700">—</div>
    </div>

    <UModal
      :open="selectedJson !== null"
      :title="selectedJson?.title ?? ''"
      :persist="false"
      @update:open="(val: boolean) => { if (!val) closeJson(); }"
    >
      <template #body>
        <pre class="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-slate-300"><code class="language-json" v-html="selectedJson?.html ?? ''"></code></pre>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="soft" @click="copyJson">
            Copy
          </UButton>
          <UButton color="neutral" variant="soft" @click="closeJson">
            Close
          </UButton>
        </div>
      </template>
    </UModal>
  </section>
</template>

<style scoped>
:deep(.token.property) {
  color: #7dd3fc;
}

:deep(.token.string) {
  color: #86efac;
}

:deep(.token.number) {
  color: #fbbf24;
}

:deep(.token.boolean),
:deep(.token.null) {
  color: #f0abfc;
}

:deep(.token.punctuation) {
  color: #64748b;
}
</style>
