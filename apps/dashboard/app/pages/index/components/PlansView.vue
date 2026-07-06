<script setup lang="ts">
import { computed, ref } from "vue";

import { injectLathePlans } from "../ports/lathe-plans";
import PlanEditor from "./PlanEditor.vue";

const plans = injectLathePlans();

const showDeleteConfirm = ref(false);
const saveLoading = ref(false);
const queueLoading = ref(false);

const isQueued = computed(() => !!plans.selectedPlan.value?.queuedRunId);

const handleSave = async (): Promise<void> => {
  saveLoading.value = true;
  try {
    await plans.savePlan();
  } finally {
    saveLoading.value = false;
  }
};

const handleQueue = async (): Promise<void> => {
  queueLoading.value = true;
  try {
    await plans.savePlan();
    await plans.queuePlan();
  } finally {
    queueLoading.value = false;
  }
};

const handleDelete = async (): Promise<void> => {
  if (!plans.selectedPlanId.value) {
    return;
  }
  try {
    await plans.deletePlan(plans.selectedPlanId.value);
  } finally {
    showDeleteConfirm.value = false;
  }
};

const handleSelect = (planId: string): void => {
  void plans.selectPlan(planId);
};

const openDeleteConfirm = (): void => {
  showDeleteConfirm.value = true;
};

const closeDeleteConfirm = (): void => {
  showDeleteConfirm.value = false;
};

const toggleTagFilter = (tag: string): void => {
  plans.activeTagFilter.value = plans.activeTagFilter.value === tag ? null : tag;
};
</script>

<template>
  <div class="flex h-full gap-4 p-4">
    <!-- Left pane: plan list -->
    <div class="flex w-72 shrink-0 flex-col">
      <h2 class="mb-2 text-sm font-semibold text-slate-300">Plans <span class="font-normal text-slate-600">({{ plans.filteredPlans.value.length }})</span></h2>

      <UInput
        v-model="plans.searchQuery.value"
        placeholder="Search plans..."
        size="sm"
        class="mb-2"
      />

      <div v-if="plans.allTags.value.length > 0" class="mb-2 flex flex-wrap gap-1">
        <button
          v-for="tag in plans.allTags.value"
          :key="tag"
          class="rounded-full px-2 py-0.5 text-xs transition-colors"
          :class="plans.activeTagFilter.value === tag
            ? 'bg-cyan-500/30 text-cyan-300'
            : 'bg-slate-700/50 text-slate-400 hover:bg-slate-700'"
          @click="toggleTagFilter(tag)"
        >
          {{ tag }}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-slate-800">
        <ul class="divide-y divide-slate-800">
          <li
            v-for="plan in plans.filteredPlans.value"
            :key="plan.planId"
            class="cursor-pointer px-3 py-2 transition-colors"
            :class="plans.selectedPlanId.value === plan.planId ? 'bg-cyan-500/10' : 'hover:bg-slate-800/50'"
            @click="handleSelect(plan.planId)"
          >
            <div class="flex items-center gap-2">
              <span class="truncate text-sm text-slate-300">{{ plan.title }}</span>
              <span
                v-if="plan.queuedRunId"
                class="shrink-0 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-xs text-amber-400"
              >queued</span>
            </div>
            <div class="mt-0.5 truncate font-mono text-xs text-slate-600">{{ plan.planId }}</div>
            <div v-if="plan.tags.length > 0" class="mt-1 flex flex-wrap gap-1">
              <span
                v-for="tag in plan.tags"
                :key="tag"
                class="rounded-full bg-slate-700/50 px-1.5 py-0.5 text-xs text-slate-400"
              >{{ tag }}</span>
            </div>
          </li>
        </ul>
        <div v-if="plans.filteredPlans.value.length === 0" class="py-6 text-center text-sm text-slate-600">
          No plans
        </div>
      </div>
    </div>

    <!-- Right pane: editor -->
    <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <div v-if="plans.errorMessage.value" class="mb-2">
        <UAlert color="error" variant="soft" :title="plans.errorMessage.value" />
      </div>

      <template v-if="plans.selectedPlan.value">
        <div class="mb-2 flex items-center gap-2">
          <h3 class="truncate text-sm font-semibold text-slate-300">{{ plans.selectedPlan.value.title }}</h3>
          <div class="ml-auto flex items-center gap-2">
            <UButton
              size="xs"
              color="primary"
              variant="soft"
              :loading="saveLoading"
              :disabled="!plans.isDirty.value"
              @click="handleSave"
            >
              Save
            </UButton>
            <UButton
              size="xs"
              color="success"
              variant="soft"
              :loading="queueLoading"
              :disabled="isQueued"
              @click="handleQueue"
            >
              Queue
            </UButton>
            <UButton
              size="xs"
              color="error"
              variant="ghost"
              :disabled="isQueued"
              @click="openDeleteConfirm"
            >
              Delete
            </UButton>
          </div>
        </div>

        <div class="min-h-0 flex-1">
          <ClientOnly>
            <PlanEditor />
          </ClientOnly>
        </div>
      </template>

      <div v-else class="flex h-full items-center justify-center text-sm text-slate-600">
        Select a plan from the list
      </div>
    </div>

    <UModal
      :open="showDeleteConfirm"
      title="Delete plan?"
      :persist="false"
      @update:open="(val: boolean) => { if (!val) closeDeleteConfirm(); }"
    >
      <template #body>
        <p class="text-sm text-slate-400">
          Delete <code class="font-mono text-xs text-slate-300">{{ plans.selectedPlanId.value }}</code>?
        </p>
      </template>
      <template #footer>
        <div class="flex justify-end gap-2">
          <UButton color="neutral" variant="soft" @click="closeDeleteConfirm">
            Cancel
          </UButton>
          <UButton color="error" variant="soft" :disabled="isQueued" @click="handleDelete">
            Delete
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
