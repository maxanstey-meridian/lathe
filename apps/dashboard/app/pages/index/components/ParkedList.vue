<script setup lang="ts">
import type { components } from "@lathe/contract";
import { injectLatheActions } from "../ports/lathe-actions";
import { injectLatheStatus } from "../ports/lathe-status";
import { truncate } from "../logic/formatters";

type StatusParkedRunDto = components["schemas"]["StatusParkedRunDto"];

const status = injectLatheStatus();
const actions = injectLatheActions();

const answerTexts = ref<Record<string, string>>({});

const cancelAnswer = (runId: string): void => {
  delete answerTexts.value[runId];
};

const openAnswer = (runId: string): void => {
  answerTexts.value[runId] = "";
};

const handleAnswer = async (run: StatusParkedRunDto): Promise<void> => {
  const answer = answerTexts.value[run.runId] ?? "proceed";
  try {
    await actions.answer(run.runId, answer);
    delete answerTexts.value[run.runId];
  } catch {
    // Error surfaced via latheActions.lastError
  }
};
</script>

<template>
  <UCard>
    <template #header>
      <h2 class="text-base font-semibold">Parked Runs</h2>
    </template>

    <template v-if="status.status.value?.parked.length">
      <ul class="space-y-3">
        <li
          v-for="run in status.status.value.parked"
          :key="run.runId"
          class="rounded-lg border border-slate-200 bg-white px-3 py-3"
        >
          <div class="flex items-center justify-between gap-3">
            <span class="font-mono text-sm font-medium">{{ run.runId }}</span>
            <UBadge v-if="run.stallRetries > 0" color="warning" variant="soft" size="xs">
              {{ run.stallRetries }} auto-retr{{ run.stallRetries === 1 ? 'y' : 'ies' }}
            </UBadge>
          </div>

          <div v-if="run.blockedReason" class="mt-1 text-xs text-slate-600">
            {{ run.blockedReason }}
          </div>

          <div v-if="run.blockedQuestion" class="mt-1 text-xs text-slate-500">
            {{ truncate(run.blockedQuestion, 120) }}
          </div>

          <div v-if="answerTexts[run.runId] !== undefined" class="mt-2 flex items-start gap-2">
            <UTextarea
              v-model="answerTexts[run.runId]"
              :rows="2"
              size="xs"
              placeholder="Answer the blocked question..."
              class="flex-1"
            />
            <div class="flex flex-col gap-1">
              <UButton
                size="xs"
                color="success"
                variant="soft"
                :loading="actions.answerLoading.value"
                :disabled="actions.answerLoading.value"
                @click="handleAnswer(run)"
              >
                Submit
              </UButton>
              <UButton
                size="xs"
                color="neutral"
                variant="soft"
                @click="cancelAnswer(run.runId)"
              >
                Cancel
              </UButton>
            </div>
          </div>

          <UButton
            v-else
            size="xs"
            color="success"
            variant="soft"
            :loading="actions.answerLoading.value"
            :disabled="actions.answerLoading.value"
            @click="openAnswer(run.runId)"
          >
            Answer
          </UButton>
        </li>
      </ul>
    </template>

    <div v-else class="py-6 text-center text-sm text-slate-500">No parked runs</div>
  </UCard>
</template>
