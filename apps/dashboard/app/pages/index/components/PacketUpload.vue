<script setup lang="ts">
import type { components } from "@lathe/contract";
import { injectLatheActions } from "../ports/lathe-actions";
import { client } from "@lathe/contract";

type ValidatePacketResponse = components["schemas"]["ValidatePacketResponse"];
type ValidatePacketFrontmatter = components["schemas"]["ValidatePacketFrontmatter"];

const actions = injectLatheActions();

const file = ref<File | null>(null);
const preview = ref<ValidatePacketResponse | null>(null);
const previewError = ref<string | null>(null);
const selectedFileName = ref<string | null>(null);
const selectedFileContent = ref<string | null>(null);

const selectedFile = async (event: Event): Promise<void> => {
  const target = event.target as HTMLInputElement;
  const uploadedFile = target.files?.[0];
  if (!uploadedFile) {
    return;
  }
  if (!uploadedFile.name.endsWith(".md")) {
    previewError.value = "Only .md files are accepted.";
    preview.value = null;
    return;
  }
  previewError.value = null;
  file.value = uploadedFile;
  selectedFileName.value = uploadedFile.name;
  try {
    const content = await uploadedFile.text();
    selectedFileContent.value = content;
    const result = await client.POST("/packet", {
      body: { content, filename: uploadedFile.name },
    });
    preview.value = result.data ?? null;
  } catch {
    previewError.value = "Unable to validate packet.";
    preview.value = null;
  }
};

const handleQueue = async (): Promise<void> => {
  if (!selectedFileContent.value || !selectedFileName.value) {
    return;
  }
  try {
    await actions.enqueueContent(selectedFileName.value, selectedFileContent.value);
  } catch {
    // Error surfaced via latheActions.lastError
  }
};
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-base font-semibold">Upload Packet</h2>
    </template>

    <UAlert v-if="previewError" color="error" variant="soft" :title="previewError" />

    <div class="flex items-center gap-3">
      <label class="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:border-slate-300">
        <svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
        </svg>
        <span>{{ selectedFileName ?? "Choose .md file..." }}</span>
        <input
          type="file"
          accept=".md"
          class="hidden"
          @change="selectedFile"
        />
      </label>

      <UButton
        v-if="preview?.ok && selectedFileContent"
        color="success"
        variant="soft"
        :loading="actions.enqueueContentLoading.value"
        :disabled="actions.enqueueContentLoading.value"
        @click="handleQueue"
      >
        Queue
      </UButton>

      <UButton
        v-if="file"
        color="neutral"
        variant="soft"
        @click="file = null; preview = null; previewError = null; selectedFileName = null; selectedFileContent = null;"
      >
        Clear
      </UButton>
    </div>

    <template v-if="preview?.ok && preview.frontmatter">
      <div class="mt-4 space-y-3">
        <div class="grid gap-2 sm:grid-cols-2">
          <div>
            <dt class="text-xs font-medium uppercase text-slate-500">Repo</dt>
            <dd class="mt-1 font-mono text-sm">{{ preview.frontmatter.repo }}</dd>
          </div>
          <div>
            <dt class="text-xs font-medium uppercase text-slate-500">Base</dt>
            <dd class="mt-1 font-mono text-sm">{{ preview.frontmatter.base }}</dd>
          </div>
          <div v-if="preview.frontmatter.compare_commit">
            <dt class="text-xs font-medium uppercase text-slate-500">Compare Commit</dt>
            <dd class="mt-1 font-mono text-sm">{{ preview.frontmatter.compare_commit }}</dd>
          </div>
          <div v-if="preview.frontmatter.campaign_id">
            <dt class="text-xs font-medium uppercase text-slate-500">Campaign</dt>
            <dd class="mt-1 font-mono text-sm">{{ preview.frontmatter.campaign_id }}</dd>
          </div>
          <div v-if="preview.frontmatter.parent_run_id">
            <dt class="text-xs font-medium uppercase text-slate-500">Parent Run</dt>
            <dd class="mt-1 font-mono text-sm">{{ preview.frontmatter.parent_run_id }}</dd>
          </div>
          <div v-if="preview.frontmatter.pass">
            <dt class="text-xs font-medium uppercase text-slate-500">Pass</dt>
            <dd class="mt-1 text-sm">{{ preview.frontmatter.pass }}</dd>
          </div>
        </div>

        <div v-if="preview.frontmatter.summary">
          <dt class="text-xs font-medium uppercase text-slate-500">Summary</dt>
          <dd class="mt-1 text-sm text-slate-700">{{ preview.frontmatter.summary }}</dd>
        </div>

        <div v-if="preview.frontmatter.outcomes.length">
          <dt class="text-xs font-medium uppercase text-slate-500">Outcomes</dt>
          <ul class="mt-1 space-y-1">
            <li v-for="outcome in preview.frontmatter.outcomes" :key="outcome.id" class="flex items-start gap-2 text-sm">
              <span class="font-mono text-xs text-slate-400">{{ outcome.id }}</span>
              <span class="text-slate-700">{{ outcome.description }}</span>
            </li>
          </ul>
        </div>

        <div v-if="preview.frontmatter.expected_surface.length">
          <dt class="text-xs font-medium uppercase text-slate-500">Expected Surface</dt>
          <ul class="mt-1 space-y-1">
            <li v-for="surface in preview.frontmatter.expected_surface" :key="surface" class="font-mono text-xs text-slate-600">
              {{ surface }}
            </li>
          </ul>
        </div>

        <div v-if="preview.frontmatter.verification.length">
          <dt class="text-xs font-medium uppercase text-slate-500">Verification</dt>
          <ul class="mt-1 space-y-1">
            <li v-for="(check, index) in preview.frontmatter.verification" :key="index" class="font-mono text-xs text-slate-600">
              {{ check.command }}
            </li>
          </ul>
        </div>
      </div>
    </template>

    <template v-else-if="preview && !preview.ok">
      <UAlert color="warning" variant="soft" title="Validation failed">
        <template #description>
          <ul class="mt-2 space-y-1">
            <li v-for="problem in preview.problems" :key="problem" class="text-sm text-slate-600">
              {{ problem }}
            </li>
          </ul>
        </template>
      </UAlert>
    </template>

    <div v-else class="py-6 text-center text-sm text-slate-500">
      No packet selected
    </div>
  </UCard>
</template>