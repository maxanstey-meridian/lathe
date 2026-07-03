<script setup lang="ts">
import type { components } from "@lathe/contract";
import { injectLatheActions } from "../ports/lathe-actions";
import { injectLatheStatus } from "../ports/lathe-status";
import { clearAnswerAfterSuccess } from "../logic/action-results";

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
  await clearAnswerAfterSuccess(
    run.runId,
    answer,
    actions.answer,
    cancelAnswer,
  );
};
</script>

<template>
  <section>
    <h2 class="mb-2 text-sm font-semibold text-slate-300">Parked <span class="text-slate-600 font-normal">({{ status.status.value?.parked.length ?? 0 }})</span></h2>

    <template v-if="status.status.value?.parked.length">
      <div class="overflow-hidden rounded-lg border border-slate-800">
        <ul class="divide-y divide-slate-800">
          <li
            v-for="run in status.status.value.parked"
            :key="run.runId"
            class="bg-slate-900/50 px-3 py-3"
          >
            <div class="flex items-center justify-between gap-3">
              <span class="font-mono text-xs text-slate-300">{{ run.runId }}</span>
              <UBadge v-if="run.stallRetries > 0" color="warning" variant="soft" size="xs">
                {{ run.stallRetries }} auto-retr{{ run.stallRetries === 1 ? 'y' : 'ies' }}
              </UBadge>
            </div>

            <div v-if="run.blockedReason" class="mt-1 text-xs text-amber-400">
              {{ run.blockedReason }}
            </div>

            <div v-if="run.blockedQuestion" class="mt-1 text-xs text-slate-500">
              {{ run.blockedQuestion }}
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
                  variant="ghost"
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
      </div>
    </template>

    <div v-else class="rounded-lg border border-slate-800 py-6 text-center text-sm text-slate-600">No parked runs</div>
  </section>
</template>
