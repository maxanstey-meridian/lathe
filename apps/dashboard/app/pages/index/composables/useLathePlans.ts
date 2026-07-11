import type { LathePlans } from "../ports/lathe-plans";
import type { RivetClient } from "@lathe/contract";
import type { PlanSummary } from "../ports/lathe-plans";
import { computed, ref } from "vue";

import { client } from "@lathe/contract";

const fuzzyMatch = (query: string, target: string): boolean => {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
};

const planMatches = (plan: PlanSummary, query: string): boolean => {
  if (!query) return true;
  if (fuzzyMatch(query, plan.title)) return true;
  if (fuzzyMatch(query, plan.planId)) return true;
  return plan.tags.some((tag) => fuzzyMatch(query, tag));
};

export const useLathePlans = (c: RivetClient = client): LathePlans => {
  const plans = ref<PlanSummary[]>([]);
  const selectedPlan = ref<LathePlans["selectedPlan"]["value"]>(null);
  const selectedPlanId = ref<string | null>(null);
  const isLoading = ref(false);
  const errorMessage = ref<string | null>(null);
  const editedContent = ref("");
  const editedTags = ref<string[]>([]);
  const tagInput = ref("");
  const dirty = ref(false);
  const searchQuery = ref("");
  const activeTagFilter = ref<string | null>(null);

  const isDirty = computed(() => dirty.value);

  const allTags = computed(() => {
    const tagSet = new Set<string>();
    for (const plan of plans.value) {
      for (const tag of plan.tags) {
        tagSet.add(tag);
      }
    }
    return [...tagSet].sort();
  });

  const filteredPlans = computed(() => {
    let result = plans.value;
    if (activeTagFilter.value) {
      result = result.filter((p) => p.tags.includes(activeTagFilter.value!));
    }
    if (searchQuery.value.trim()) {
      const q = searchQuery.value.trim();
      result = result.filter((p) => planMatches(p, q));
    }
    return result;
  });

  const markDirty = (): void => {
    dirty.value = true;
  };

  const refresh = async (): Promise<void> => {
    isLoading.value = true;
    errorMessage.value = null;
    try {
      const result = await c.GET("/plans");
      plans.value = result.data ?? [];
    } catch {
      errorMessage.value = "Unable to fetch plans.";
    } finally {
      isLoading.value = false;
    }
  };

  const selectPlan = async (planId: string | null): Promise<void> => {
    if (!planId) {
      selectedPlan.value = null;
      selectedPlanId.value = null;
      editedContent.value = "";
      editedTags.value = [];
      dirty.value = false;
      return;
    }
    isLoading.value = true;
    errorMessage.value = null;
    try {
      const result = await c.GET("/plans/{planId}", { params: { path: { planId } } });
      selectedPlan.value = result.data ?? null;
      selectedPlanId.value = planId;
      editedContent.value = result.data?.raw ?? "";
      editedTags.value = result.data?.tags ? [...result.data.tags] : [];
      dirty.value = false;
    } catch {
      errorMessage.value = "Unable to fetch plan.";
      selectedPlan.value = null;
      selectedPlanId.value = null;
    } finally {
      isLoading.value = false;
    }
  };

  const savePlan = async (): Promise<boolean> => {
    if (!selectedPlanId.value) {
      return false;
    }
    errorMessage.value = null;
    try {
      const result = await c.PUT("/plans/{planId}", {
        params: { path: { planId: selectedPlanId.value } },
        body: { content: editedContent.value, tags: editedTags.value },
      });
      if (result.data) {
        const updated = result.data;
        plans.value = plans.value.map((p) => (p.planId === updated.planId ? updated : p));
        if (selectedPlan.value?.planId === updated.planId) {
          selectedPlan.value = { ...selectedPlan.value, ...updated };
        }
        dirty.value = false;
        return true;
      }
      return false;
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : "Unable to save plan.";
      return false;
    }
  };

  const queuePlan = async (): Promise<boolean> => {
    if (!selectedPlanId.value) {
      return false;
    }
    errorMessage.value = null;
    try {
      const result = await c.POST("/plans/{planId}/queue", {
        params: { path: { planId: selectedPlanId.value } },
      });
      if (result.data) {
        const runId = result.data.runId;
        const updated = plans.value.map((p) =>
          p.planId === selectedPlanId.value ? { ...p, queuedRunId: runId } : p,
        );
        plans.value = updated;
        if (selectedPlan.value) {
          selectedPlan.value = { ...selectedPlan.value, queuedRunId: runId };
        }
        dirty.value = false;
        return true;
      }
      return false;
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : "Unable to queue plan.";
      return false;
    }
  };

  const deletePlan = async (planId: string): Promise<boolean> => {
    errorMessage.value = null;
    try {
      const result = await c.DELETE("/plans/{planId}", {
        params: { path: { planId } },
      });
      if (result.response.ok) {
        plans.value = plans.value.filter((p) => p.planId !== planId);
        if (selectedPlanId.value === planId) {
          selectedPlan.value = null;
          selectedPlanId.value = null;
          editedContent.value = "";
          editedTags.value = [];
          dirty.value = false;
        }
        return true;
      }
      return false;
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : "Unable to delete plan.";
      return false;
    }
  };

  const addTag = (): void => {
    const tag = tagInput.value.trim();
    if (tag && !editedTags.value.includes(tag)) {
      editedTags.value = [...editedTags.value, tag];
      tagInput.value = "";
      markDirty();
      void savePlan();
    }
  };

  const removeTag = (tag: string): void => {
    editedTags.value = editedTags.value.filter((t) => t !== tag);
    markDirty();
    void savePlan();
  };

  return {
    plans,
    filteredPlans,
    selectedPlan,
    selectedPlanId,
    isLoading,
    errorMessage,
    isDirty,
    editedContent,
    editedTags,
    tagInput,
    searchQuery,
    activeTagFilter,
    allTags,
    refresh,
    selectPlan,
    savePlan,
    queuePlan,
    deletePlan,
    addTag,
    removeTag,
    markDirty,
  };
};
