<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { SettingsRepoDto } from "@lathe/contract";

import { sectionNames, settingsFields, excludedFieldNames } from "../logic/settings-fields";
import { injectLatheSettings } from "../ports/lathe-settings";

const settings = injectLatheSettings();

onMounted(async () => {
  await settings.load();
  hydrateReposText();
});

// ── Mutation Command Patterns (editable list) ──
const mutationPatterns = computed({
  get: () => settings.draft.value?.mutationCommandPatterns ?? [],
  set: (val: string[]) => {
    if (settings.draft.value) {
      settings.draft.value.mutationCommandPatterns = val;
    }
  },
});

// ── Promote To toggle ──
const promoteEnabled = computed({
  get: () => !!settings.draft.value?.baby.promoteTo,
  set: (val: boolean) => {
    if (!settings.draft.value) return;
    if (val && !settings.draft.value.baby.promoteTo) {
      settings.draft.value.baby.promoteTo = { providerId: "", modelId: "" };
    } else if (!val) {
      delete settings.draft.value.baby.promoteTo;
    }
  },
});

// ── Group fields by section ──
const fieldsBySection = computed(() => {
  const groups: Record<string, typeof settingsFields> = {};
  for (const field of settingsFields) {
    if (!groups[field.section]) groups[field.section] = [];
    groups[field.section]!.push(field);
  }
  return groups;
});

// ── Get/set a dotted path on draft ──
const getNested = (obj: unknown, path: string): unknown => {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
};

const setNested = (obj: unknown, path: string, value: unknown): void => {
  const parts = path.split(".");
  const lastPart = parts.at(-1);
  if (parts.length === 1 && lastPart) {
    if (obj && typeof obj === "object") {
      (obj as Record<string, unknown>)[lastPart] = value;
    }
    return;
  }
  if (!lastPart) return;
  const remainder = parts.slice(0, -1);
  let current: Record<string, unknown> = obj as Record<string, unknown>;
  for (const part of remainder) {
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[lastPart] = value;
};

// ── Event helpers for template ──
const onNumberInput = (fieldPath: string, event: Event): void => {
  const value = (event.target as HTMLInputElement).value;
  handleFieldInput(fieldPath, parseNumber(value));
};

const onSelectChange = (fieldPath: string, event: Event): void => {
  const value = (event.target as HTMLSelectElement).value;
  handleFieldInput(fieldPath, value);
};

const onCheckboxChange = (fieldPath: string, event: Event): void => {
  const checked = (event.target as HTMLInputElement).checked;
  handleFieldInput(fieldPath, checked);
};

const onTextInput = (fieldPath: string, event: Event): void => {
  const value = (event.target as HTMLInputElement).value;
  handleFieldInput(fieldPath, value);
};

const onTextareaInput = (fieldPath: string, event: Event): void => {
  const value = (event.target as HTMLTextAreaElement).value;
  handleFieldInput(fieldPath, value);
};

const onReposInput = (event: Event): void => {
  updateRepos((event.target as HTMLTextAreaElement).value);
};

const onPatternInput = (index: number, event: Event): void => {
  const val = (event.target as HTMLInputElement).value;
  const patterns = mutationPatterns.value;
  patterns[index] = val;
  mutationPatterns.value = [...patterns];
};

const handleFieldInput = (fieldPath: string, value: unknown): void => {
  if (!settings.draft.value) return;
  setNested(settings.draft.value, fieldPath, value);
};

// ── Number input: convert DOM string to number ──
const parseNumber = (val: string | number | null | undefined): number | null => {
  if (val === null || val === undefined || val === "") return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
};

const parseRepos = (val: string): Record<string, SettingsRepoDto> | null => {
  try {
    const parsed = JSON.parse(val);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, SettingsRepoDto>;
  } catch {
    return null;
  }
};

// ── Repos JSON textarea ──
const reposText = ref("{}");

const hydrateReposText = (): void => {
  if (!settings.draft.value) {
    reposText.value = "{}";
    return;
  }
  try {
    reposText.value = JSON.stringify(settings.draft.value.repos, null, 2);
    settings.reposParseError.value = null;
  } catch {
    reposText.value = "{}";
  }
};

const updateRepos = (val: string): void => {
  reposText.value = val;
  if (!settings.draft.value) return;
  const parsed = parseRepos(val);
  if (parsed) {
    settings.draft.value.repos = parsed;
    settings.reposParseError.value = null;
  } else {
    settings.reposParseError.value = "Invalid JSON";
  }
};

// ── Actions ──
const showRestartConfirm = ref(false);

const handleSave = async (): Promise<void> => {
  if (settings.reposParseError.value) {
    return;
  }
  await settings.save();
  hydrateReposText();
};

const handleRestart = async (): Promise<void> => {
  await settings.restart();
};

const handlePatternsAdd = (): void => {
  if (settings.draft.value) {
    settings.draft.value.mutationCommandPatterns = [...settings.draft.value.mutationCommandPatterns, ""];
  }
};

const handlePatternsRemove = (index: number): void => {
  if (!settings.draft.value) return;
  settings.draft.value.mutationCommandPatterns = settings.draft.value.mutationCommandPatterns.filter((_, i) => i !== index);
};

const openRestartConfirm = (): void => {
  showRestartConfirm.value = true;
};

const closeRestartConfirm = (): void => {
  showRestartConfirm.value = false;
};

const handlePromoteToggle = (event: Event): void => {
  promoteEnabled.value = (event.target as HTMLInputElement).checked;
};

const handleDiscard = (): void => {
  settings.resetDraft();
  hydrateReposText();
};

// ── Watch for draft changes to clear error on edit ──
watch(
  () => settings.draft?.value,
  () => {
    settings.error.value = null;
  },
  { deep: true },
);
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Error banner -->
    <UAlert
      v-if="settings.error.value"
      class="shrink-0 rounded-none"
      color="error"
      variant="soft"
      :title="settings.error.value"
    />

    <!-- Success banner -->
    <UAlert
      v-if="settings.success.value"
      class="shrink-0 rounded-none"
      color="success"
      variant="soft"
      :title="settings.success.value"
    />

    <!-- Loading state -->
    <div v-if="settings.loading.value" class="flex flex-1 items-center justify-center p-8">
      <span class="text-sm text-slate-500">Loading settings...</span>
    </div>

    <!-- No data state -->
    <div v-else-if="!settings.draft.value" class="flex flex-1 items-center justify-center p-8">
      <span class="text-sm text-slate-500">No settings available.</span>
    </div>

    <!-- Form -->
    <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="flex-1 overflow-y-auto p-4">
        <div class="mx-auto max-w-3xl space-y-8">
          <!-- Section groups -->
          <div v-for="section in sectionNames" :key="section" class="space-y-3">
            <h3 class="text-sm font-semibold text-slate-300">{{ section }}</h3>
            <div class="space-y-2 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <div
                v-for="field in fieldsBySection[section]"
                :key="field.name"
                v-show="!excludedFieldNames.has(field.name) && !(field.name.startsWith('baby.promoteTo.') && !promoteEnabled)"
                class="grid grid-cols-1 gap-2 sm:grid-cols-3"
              >
                <!-- Label -->
                <label class="sm:self-center text-sm text-slate-400">
                  {{ field.label }}
                </label>

                <!-- Input area (span remaining cols) -->
                <div class="sm:col-span-2">
                  <!-- Number input -->
                  <input
                    v-if="field.type === 'number'"
                    :value="getNested(settings.draft.value, field.name)"
                    @input="onNumberInput(field.name, $event)"
                    type="number"
                    class="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
                  />

                  <!-- Select -->
                  <select
                    v-else-if="field.type === 'select' && 'options' in field"
                    :value="getNested(settings.draft.value, field.name)"
                    @change="onSelectChange(field.name, $event)"
                    class="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 focus:border-cyan-500 focus:outline-none"
                  >
                    <option value="">—</option>
                    <option
                      v-for="opt in field.options"
                      :key="String(opt.value)"
                      :value="opt.value"
                    >
                      {{ opt.label }}
                    </option>
                  </select>

                  <!-- Boolean input -->
                  <div v-else-if="field.type === 'boolean'" class="flex items-center gap-2">
                    <input
                      :checked="!!getNested(settings.draft.value, field.name)"
                      @change="onCheckboxChange(field.name, $event)"
                      type="checkbox"
                      class="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-cyan-500"
                    />
                    <span class="text-sm text-slate-400">
                      {{ getNested(settings.draft.value, field.name) ? 'True' : 'False' }}
                    </span>
                  </div>

                  <!-- Masked input (API keys) -->
                  <div v-else-if="field.type === 'masked'" class="flex items-center gap-2">
                    <input
                      :value="'••••••••'"
                      disabled
                      type="text"
                      class="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-500 focus:border-cyan-500 focus:outline-none"
                    />
                    <span class="text-xs text-slate-500">This can only be edited locally</span>
                  </div>

                  <!-- Text input -->
                  <input
                    v-else-if="field.type === 'text'"
                    :value="getNested(settings.draft.value, field.name)"
                    @input="onTextInput(field.name, $event)"
                    type="text"
                    class="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
                  />

                  <!-- JSON textarea -->
                  <textarea
                    v-else-if="field.type === 'json'"
                    :value="field.name === 'repos' ? reposText : ''"
                    @input="field.name === 'repos' ? onReposInput($event) : onTextareaInput(field.name, $event)"
                    rows="6"
                    class="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 font-mono text-xs text-slate-200 placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
                  />
                </div>
              </div>

              <div v-if="section === 'Baby'" class="flex items-center justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/30 px-4 py-3">
                <label class="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    aria-label="Enable promote-to"
                    :checked="promoteEnabled"
                    @change="handlePromoteToggle"
                    type="checkbox"
                    class="h-4 w-4 rounded border-slate-700 bg-slate-800 text-cyan-500 focus:ring-cyan-500"
                  />
                  <span>Enable promote-to</span>
                </label>
                <span class="text-xs text-slate-500">
                  Disabling this removes <code class="font-mono text-[11px]">baby.promoteTo</code> from the saved DTO.
                </span>
              </div>
            </div>
          </div>

          <!-- Mutation Command Patterns: editable list -->
          <div class="space-y-3">
            <h3 class="text-sm font-semibold text-slate-300">Mutation Command Patterns</h3>
            <div class="space-y-2 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <div
                v-for="(pattern, index) in mutationPatterns"
                :key="index"
                class="flex items-center gap-2"
              >
                <input
                  :value="pattern"
                  @input="onPatternInput(index, $event)"
                  type="text"
                  class="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
                  placeholder="regex pattern"
                />
                <button
                  type="button"
                  class="shrink-0 rounded-md bg-slate-800 px-2 py-1 text-xs text-slate-400 hover:text-red-400"
                  @click="handlePatternsRemove(index)"
                >
                  Remove
                </button>
              </div>
              <button
                type="button"
                class="text-xs text-cyan-400 hover:text-cyan-300"
                @click="handlePatternsAdd"
              >
                + Add pattern
              </button>
            </div>
          </div>

          <!-- Repos JSON -->
          <div class="space-y-3">
            <h3 class="text-sm font-semibold text-slate-300">Repos</h3>
            <div class="space-y-2 rounded-lg border border-slate-800 bg-slate-900/50 p-4">
              <textarea
                :value="reposText"
                @input="onReposInput($event)"
                rows="8"
                class="w-full rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 font-mono text-xs text-slate-200 placeholder-slate-600 focus:border-cyan-500 focus:outline-none"
              />
              <p v-if="settings.reposParseError.value" class="text-xs text-red-400">{{ settings.reposParseError.value }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer actions -->
      <div class="shrink-0 border-t border-slate-800 bg-slate-900 px-4 py-3">
        <div class="mx-auto flex max-w-3xl items-center justify-between">
          <div class="flex items-center gap-3">
            <span v-if="settings.dirty.value" class="text-xs text-amber-400">Unsaved changes</span>
            <span v-if="settings.reposParseError.value" class="text-xs text-red-400">Invalid repos JSON</span>
          </div>
          <div class="flex items-center gap-2">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              :disabled="!settings.dirty.value"
              @click="handleDiscard"
            >
              Discard
            </UButton>
            <UButton
              size="xs"
              color="primary"
              variant="soft"
              :loading="settings.saving.value"
              :disabled="!settings.dirty.value"
              @click="handleSave"
            >
              Save
            </UButton>
            <UButton
              size="xs"
              color="warning"
              variant="soft"
              :loading="settings.restarting.value"
              :disabled="settings.restarting.value"
              @click="openRestartConfirm"
            >
              Restart Daemon
            </UButton>
          </div>
        </div>
      </div>
    </div>

    <!-- Restart confirmation modal -->
    <UModal
      v-model:open="showRestartConfirm"
      title="Restart Daemon"
      :persist="false"
      @update:open="(val: boolean) => { showRestartConfirm = val; }"
    >
      <template #body>
        <div class="space-y-3">
          <p class="text-sm text-slate-400">
            Are you sure you want to restart the daemon? This will briefly interrupt all active runs.
          </p>
          <div class="flex justify-end gap-2">
            <UButton
              size="xs"
              color="neutral"
              variant="ghost"
              @click="closeRestartConfirm"
            >
              Cancel
            </UButton>
            <UButton
              size="xs"
              color="warning"
              variant="soft"
              :loading="settings.restarting.value"
              @click="async () => { await handleRestart(); closeRestartConfirm(); }"
            >
              Restart
            </UButton>
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
