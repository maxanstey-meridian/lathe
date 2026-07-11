import type { components } from "@lathe/contract";
import type { ComputedRef, Ref } from "vue";

import { useProvideInject } from "~/composables/useProvideInject";

export type PlanSummary = components["schemas"]["PlanDto"];
export type PlanDetail = components["schemas"]["PlanDetailDto"];

export interface LathePlans {
  readonly plans: Ref<PlanSummary[]>;
  readonly filteredPlans: ComputedRef<PlanSummary[]>;
  readonly selectedPlan: Ref<PlanDetail | null>;
  readonly selectedPlanId: Ref<string | null>;
  readonly isLoading: Ref<boolean>;
  readonly errorMessage: Ref<string | null>;
  readonly isDirty: ComputedRef<boolean>;
  readonly editedContent: Ref<string>;
  readonly editedTags: Ref<string[]>;
  readonly tagInput: Ref<string>;
  readonly searchQuery: Ref<string>;
  readonly activeTagFilter: Ref<string | null>;
  readonly allTags: ComputedRef<string[]>;
  readonly refresh: () => Promise<void>;
  readonly selectPlan: (planId: string | null) => Promise<void>;
  readonly savePlan: () => Promise<boolean>;
  readonly queuePlan: () => Promise<boolean>;
  readonly deletePlan: (planId: string) => Promise<boolean>;
  readonly addTag: () => void;
  readonly removeTag: (tag: string) => void;
  readonly markDirty: () => void;
}

export const [injectLathePlans, provideLathePlans] = useProvideInject<LathePlans>("LathePlans");
