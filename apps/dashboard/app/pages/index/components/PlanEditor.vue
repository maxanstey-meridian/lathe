<script setup lang="ts">
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { markdown } from "@codemirror/lang-markdown";
import { yaml } from "@codemirror/lang-yaml";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { onMounted, onUnmounted, ref, watch } from "vue";

import { injectLathePlans } from "../ports/lathe-plans";

const plans = injectLathePlans();

const editorContainer = ref<HTMLElement | null>(null);
let editorView: EditorView | null = null;

const buildExtensions = () => [
  lineNumbers(),
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  markdown(),
  yaml(),
  oneDark,
  EditorView.lineWrapping,
  EditorView.theme({
    "&": { height: "100%", fontSize: "13px" },
    ".cm-content": { fontFamily: "monospace" },
    ".cm-gutters": { backgroundColor: "#0f172a", border: "none" },
  }),
  EditorView.updateListener.of((update) => {
    if (update.docChanged) {
      plans.editedContent.value = update.state.doc.toString();
      plans.markDirty();
    }
  }),
];

onMounted(() => {
  if (!editorContainer.value) {
    return;
  }

  editorView = new EditorView({
    parent: editorContainer.value,
    state: EditorState.create({
      doc: plans.editedContent.value,
      extensions: buildExtensions(),
    }),
  });
});

onUnmounted(() => {
  editorView?.destroy();
  editorView = null;
});

watch(
  () => plans.selectedPlanId.value,
  (_newId, oldId) => {
    if (!editorView || _newId === oldId) {
      return;
    }
    editorView.setState(
      EditorState.create({
        doc: plans.editedContent.value,
        extensions: buildExtensions(),
      }),
    );
  },
);
</script>

<template>
  <div class="flex h-full flex-col gap-3">
    <div ref="editorContainer" class="min-h-0 flex-1 overflow-hidden rounded-lg border border-slate-800" />

    <div class="shrink-0">
      <dt class="mb-1 text-xs font-medium uppercase text-slate-500">Tags</dt>
      <div class="flex flex-wrap items-center gap-2">
        <span
          v-for="tag in plans.editedTags.value"
          :key="tag"
          class="flex items-center gap-1 rounded-full bg-cyan-500/20 px-2 py-0.5 text-xs text-cyan-300"
        >
          {{ tag }}
          <button class="text-cyan-500 hover:text-cyan-200" @click="plans.removeTag(tag)">×</button>
        </span>
        <div class="flex items-center gap-1">
          <input
            v-model="plans.tagInput.value"
            type="text"
            placeholder="add tag..."
            class="w-28 rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-xs text-slate-300 outline-none focus:border-cyan-500"
            @keydown.enter="plans.addTag()"
          />
          <button
            v-if="plans.tagInput.value.trim()"
            class="text-xs text-cyan-400 hover:text-cyan-200"
            @click="plans.addTag()"
          >
            Add
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
