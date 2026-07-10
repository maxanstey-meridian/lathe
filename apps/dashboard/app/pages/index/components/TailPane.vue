<script setup lang="ts">
import Prism from "prismjs";
import "prismjs/components/prism-json";
import { computed, nextTick, ref, watch } from "vue";
import { visiblePaneLines, type TailPaneLine, type TailPaneState } from "@lathe/tail-state";

import { classifyLine } from "../logic/tail-json";

type Accent = "green" | "magenta" | "blue" | "amber";

type RenderedLine = {
  readonly key: string;
  readonly text: string;
  readonly style: TailPaneLine["style"];
  readonly classified: ReturnType<typeof classifyLine>;
  readonly attachment?: string;
};

const MAX_JSON_BLOCK_LINES = 80;
const FOLLOW_TAIL_THRESHOLD_PX = 24;
type JsonCandidateStatus = "complete" | "incomplete" | "not-json";

type JsonContainer = {
  readonly close: "]" | "}";
  state: "key" | "key-or-end" | "colon" | "value" | "value-or-end" | "comma-or-end";
};

const jsonCandidateStatus = (text: string): JsonCandidateStatus => {
  const objectStart = text.indexOf("{");
  const arrayStart = text.indexOf("[");
  const starts = [objectStart, arrayStart].filter((start) => start >= 0);
  if (starts.length === 0) {
    return "not-json";
  }

  const start = Math.min(...starts);
  const stack: JsonContainer[] = [{
    close: text[start] === "{" ? "}" : "]",
    state: text[start] === "{" ? "key-or-end" : "value-or-end",
  }];
  let index = start + 1;

  const skipWhitespace = (): void => {
    while (/\s/.test(text[index] ?? "")) {
      index += 1;
    }
  };

  const consumeString = (): JsonCandidateStatus | null => {
    index += 1;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index += 1;
        return null;
      }
      if (char === "\\") {
        index += 1;
        if (index >= text.length) {
          return "incomplete";
        }
        if (!'"\\/bfnrtu'.includes(text[index] ?? "")) {
          return "not-json";
        }
        if (text[index] === "u") {
          const escape = text.slice(index + 1, index + 5);
          if (escape.length < 4) {
            return "incomplete";
          }
          if (!/^[0-9a-fA-F]{4}$/.test(escape)) {
            return "not-json";
          }
          index += 4;
        }
      } else if (char !== undefined && char.charCodeAt(0) < 0x20) {
        return "not-json";
      }
      index += 1;
    }
    return "incomplete";
  };

  const consumeValue = (): JsonCandidateStatus | null => {
    const char = text[index];
    if (char === '"') {
      return consumeString();
    }
    if (char === "{" || char === "[") {
      stack.push({
        close: char === "{" ? "}" : "]",
        state: char === "{" ? "key-or-end" : "value-or-end",
      });
      index += 1;
      return null;
    }

    const tokenStart = index;
    while (index < text.length && !/[\s,}\]]/.test(text[index] ?? "")) {
      index += 1;
    }
    const token = text.slice(tokenStart, index);
    if (index === text.length) {
      return /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token)
        ? null
        : "incomplete";
    }
    return /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(token)
      ? null
      : "not-json";
  };

  while (stack.length > 0) {
    skipWhitespace();
    if (index >= text.length) {
      return "incomplete";
    }

    const container = stack.at(-1);
    if (container === undefined) {
      return "not-json";
    }
    const char = text[index];

    if (container.state === "key" || container.state === "key-or-end") {
      if (container.state === "key-or-end" && char === container.close) {
        stack.pop();
        index += 1;
      } else if (char === '"') {
        const status = consumeString();
        if (status !== null) {
          return status;
        }
        container.state = "colon";
      } else {
        return "not-json";
      }
      continue;
    }

    if (container.state === "colon") {
      if (char !== ":") {
        return "not-json";
      }
      container.state = "value";
      index += 1;
      continue;
    }

    if (container.state === "value" || container.state === "value-or-end") {
      if (container.state === "value-or-end" && char === container.close) {
        stack.pop();
        index += 1;
        continue;
      }
      container.state = "comma-or-end";
      const status = consumeValue();
      if (status !== null) {
        return status;
      }
      continue;
    }

    if (char === ",") {
      container.state = container.close === "}" ? "key" : "value";
      index += 1;
    } else if (char === container.close) {
      stack.pop();
      index += 1;
    } else {
      return "not-json";
    }
  }

  return "complete";
};

const props = defineProps<{
  readonly title: string;
  readonly model: string;
  readonly pane: TailPaneState;
  readonly accent: Accent;
  readonly now: number;
  readonly activity?: readonly string[];
}>();

const accentClasses: Record<Accent, { readonly border: string; readonly text: string; readonly dot: string }> = {
  green: { border: "border-emerald-500", text: "text-emerald-400", dot: "bg-emerald-500" },
  magenta: { border: "border-fuchsia-500", text: "text-fuchsia-400", dot: "bg-fuchsia-500" },
  blue: { border: "border-sky-500", text: "text-sky-400", dot: "bg-sky-500" },
  amber: { border: "border-amber-500", text: "text-amber-400", dot: "bg-amber-500" },
};

const hasActivity = computed(() => (props.activity?.length ?? 0) > 0);
const isActive = computed(() => hasActivity.value || props.now - props.pane.lastAt < 10_000);
const lines = computed(() => visiblePaneLines(props.pane).slice(-80));
const hasJsonStart = (text: string): boolean => text.includes("{") || text.includes("[");
const renderedLines = computed<RenderedLine[]>(() => {
  const result: RenderedLine[] = [];
  let index = 0;

  while (index < lines.value.length) {
    const line = lines.value[index];
    if (line === undefined) {
      break;
    }

    if (line.attachment !== undefined || !hasJsonStart(line.text)) {
      result.push({
        key: `${index}-${line.text}`,
        text: line.text,
        style: line.style,
        classified: classifyLine(line.text),
        ...(line.attachment !== undefined ? { attachment: line.attachment } : {}),
      });
      index += 1;
      continue;
    }

    const block = [line.text];
    let blockEnd = index;
    let classified = classifyLine(line.text);
    let candidateStatus = jsonCandidateStatus(line.text);
    while (candidateStatus === "incomplete" && block.length < MAX_JSON_BLOCK_LINES) {
      const next = lines.value[blockEnd + 1];
      if (next === undefined || next.attachment !== undefined || next.style !== line.style) {
        break;
      }
      block.push(next.text);
      blockEnd += 1;
      const text = block.join("\n");
      classified = classifyLine(text);
      candidateStatus = jsonCandidateStatus(text);
    }

    if (classified.kind === "json") {
      const text = block.join("\n");
      result.push({
        key: `${index}-${blockEnd}-${text}`,
        text,
        style: line.style,
        classified,
      });
      index = blockEnd + 1;
      continue;
    }

    // The block may be a still-streaming outer JSON value. Preserve every
    // accumulated line as text and skip them together; otherwise nested arrays
    // are revisited independently and buttonified before the outer value closes.
    block.forEach((text, blockIndex) => {
      result.push({
        key: `${index + blockIndex}-${text}`,
        text,
        style: line.style,
        classified: { kind: "text" },
      });
    });
    index = blockEnd + 1;
  }

  return result;
});
const classes = computed(() => accentClasses[props.accent]);
const scrollContainer = ref<HTMLElement | null>(null);
const followsTail = ref(true);

const updateFollowsTail = (): void => {
  const container = scrollContainer.value;
  if (container) {
    followsTail.value =
      container.scrollHeight - container.scrollTop - container.clientHeight <= FOLLOW_TAIL_THRESHOLD_PX;
  }
};

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
  if (container && followsTail.value) {
    container.scrollTop = container.scrollHeight;
  }
}, { flush: "post" });
</script>

<template>
  <section
    class="flex min-h-0 flex-col overflow-hidden bg-slate-950 border-t-2"
    :class="isActive ? classes.border : 'border-transparent'"
  >
    <header class="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-3 py-1.5">
      <div class="min-w-0">
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full" :class="isActive ? classes.dot : 'bg-slate-700'"></span>
          <h3 class="truncate text-xs font-semibold" :class="isActive ? classes.text : 'text-slate-600'">{{ title }}</h3>
          <span v-if="hasActivity" class="text-xs text-amber-500">running</span>
          <span v-else-if="!isActive" class="text-xs text-slate-700">idle</span>
        </div>
        <p class="mt-0.5 truncate font-mono text-xs text-slate-700">
          {{ hasActivity ? activity?.join(" | ") : model }}
        </p>
      </div>
    </header>

    <div
      ref="scrollContainer"
      data-testid="tail-scroll"
      class="min-h-0 flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-5"
      @scroll="updateFollowsTail"
    >
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
