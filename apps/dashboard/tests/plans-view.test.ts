import { strict as assert } from "node:assert";
import { flushPromises, mount } from "@vue/test-utils";
import { computed, ref } from "vue";
import { beforeEach, test, vi } from "vitest";

const savePlan = vi.fn<() => Promise<boolean>>();
const queuePlan = vi.fn<() => Promise<boolean>>();
const selectedPlan = ref({
  planId: "plan-1",
  title: "Plan 1",
  raw: "# Plan",
  tags: [],
  queuedRunId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

vi.mock("../app/pages/index/ports/lathe-plans", () => ({
  injectLathePlans: () => ({
    plans: ref([]),
    filteredPlans: computed(() => []),
    selectedPlan,
    selectedPlanId: ref("plan-1"),
    isLoading: ref(false),
    errorMessage: ref(null),
    isDirty: computed(() => true),
    editedContent: ref("# Plan"),
    editedTags: ref([]),
    tagInput: ref(""),
    searchQuery: ref(""),
    activeTagFilter: ref(null),
    allTags: computed(() => []),
    refresh: vi.fn(),
    selectPlan: vi.fn(),
    savePlan,
    queuePlan,
    deletePlan: vi.fn(),
    addTag: vi.fn(),
    removeTag: vi.fn(),
    markDirty: vi.fn(),
  }),
}));

import PlansView from "../app/pages/index/components/PlansView.vue";

const mountPlansView = () => mount(PlansView, {
  global: {
    stubs: {
      ClientOnly: { template: "<div><slot /></div>" },
      PlanEditor: true,
      UAlert: true,
      UInput: true,
      UModal: true,
      UButton: { template: "<button v-bind='$attrs'><slot /></button>" },
    },
  },
});

beforeEach(() => {
  savePlan.mockReset();
  queuePlan.mockReset();
});

test("PlansView does not queue when saving the current plan fails", async () => {
  savePlan.mockResolvedValue(false);
  queuePlan.mockResolvedValue(true);
  const wrapper = mountPlansView();
  const queueButton = wrapper.findAll("button").find((button) => button.text() === "Queue");

  assert.ok(queueButton);
  await queueButton.trigger("click");
  await flushPromises();

  assert.equal(savePlan.mock.calls.length, 1);
  assert.equal(queuePlan.mock.calls.length, 0);
  wrapper.unmount();
});

test("PlansView queues after saving the current plan succeeds", async () => {
  savePlan.mockResolvedValue(true);
  queuePlan.mockResolvedValue(true);
  const wrapper = mountPlansView();
  const queueButton = wrapper.findAll("button").find((button) => button.text() === "Queue");

  assert.ok(queueButton);
  await queueButton.trigger("click");
  await flushPromises();

  assert.equal(queuePlan.mock.calls.length, 1);
  wrapper.unmount();
});
