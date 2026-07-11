import { test, expect } from "vitest";
import { computed, defineComponent, h, ref, type Ref } from "vue";
import { mount } from "@vue/test-utils";

import type { StatusDto } from "../app/pages/index/ports/lathe-status";
import { provideLatheStatus } from "../app/pages/index/ports/lathe-status";
import CommandBar from "../app/pages/index/components/CommandBar.vue";

const makeStatus = (activeRuns: Array<{ runId: string; outcomes: string; gateLatched: string | null; recentEvents: Array<{ at: string; event: string }> }>): StatusDto => ({
  activeRuns,
  queued: [],
  parked: [],
  campaigns: [],
  staged: [],
  review: { readyForReview: 0, failed: 0 },
  stopped: [],
});

const mountCommandBar = (statusRef: Ref<StatusDto | null>, activeTab = "console") => {
  const Harness = defineComponent({
    setup() {
      provideLatheStatus({
        status: statusRef,
        isLoading: ref(false),
        errorMessage: ref(null),
        isDaemonReachable: computed(() => true),
        isLive: ref(false),
        refresh: async () => undefined,
        requeue: async () => undefined,
      });
      return () => h(CommandBar, { activeTab });
    },
  });

  return mount(Harness, {
    global: {
      components: {
        UButton: { template: '<button v-bind="$attrs"><slot /></button>' },
      },
    },
  });
};

test("CommandBar: shows runId when a single active run exists", () => {
  const wrapper = mountCommandBar(ref(makeStatus([{
    runId: "single-run",
    outcomes: "1/1 done",
    gateLatched: null,
    recentEvents: [],
  }])));
  expect(wrapper.text()).toContain("single-run");
  wrapper.unmount();
});

test("CommandBar: shows count when multiple active runs exist", () => {
  const wrapper = mountCommandBar(ref(makeStatus([
    { runId: "run-a", outcomes: "1/1 done", gateLatched: null, recentEvents: [] },
    { runId: "run-b", outcomes: "0/1 done", gateLatched: null, recentEvents: [] },
  ])));
  expect(wrapper.text()).toContain("2 active");
  wrapper.unmount();
});

test("CommandBar: hides active run section when no active runs", () => {
  const wrapper = mountCommandBar(ref(makeStatus([])));
  expect(wrapper.text()).not.toContain("active");
  wrapper.unmount();
});

test("CommandBar: describes plan persistence as an import", () => {
  const wrapper = mountCommandBar(ref(makeStatus([])));
  expect(wrapper.text()).toContain("Import Plan");
  expect(wrapper.text()).not.toContain("Upload Packet");
  wrapper.unmount();
});
