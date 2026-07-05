import { test, expect } from "vitest";
import { computed, defineComponent, h, nextTick, ref, type Ref } from "vue";
import { mount } from "@vue/test-utils";

import type { StatusDto } from "../app/pages/index/ports/lathe-status";
import type { TailSnapshotDto } from "@lathe/contract";
import { provideLatheStatus } from "../app/pages/index/ports/lathe-status";
import { provideLatheTail } from "../app/pages/index/ports/lathe-tail";
import { provideLatheActions } from "../app/pages/index/ports/lathe-actions";
import { tailStateFromSnapshot } from "../app/pages/index/logic/tail-state";
import TailView from "../app/pages/index/components/TailView.vue";

const makeSnapshot = (runId: string): TailSnapshotDto => ({
  runId,
  summary: "test",
  status: "running",
  startedAt: "2026-07-01T18:00:00.000Z",
  models: { baby: "baby", promoted: "daddy", daddy: "daddy", super: "super" },
  promoted: false,
  budget: 100000,
  worktree: "/tmp/w",
  outcomesDone: 0,
  outcomesTotal: 1,
  gateReason: null,
  contextTokens: 0,
  turn: 0,
  rotations: 0,
  journal: [],
  lastSeq: 0,
});

const makeStatus = (activeRunIds: string[]): StatusDto => ({
  activeRuns: activeRunIds.map((runId) => ({ runId, outcomes: "1/1 done", gateLatched: null, recentEvents: [] })),
  queued: [],
  parked: [],
  campaigns: [],
  staged: [],
  review: { readyForReview: 0, failed: 0 },
  stopped: [],
});

const mountTailView = (
  statusRef: Ref<StatusDto | null>,
  tailRef: Ref<ReturnType<typeof tailStateFromSnapshot>>,
  stopMock: { callCount: number; lastRunId: string | null },
) => {
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
      provideLatheTail({
        state: tailRef,
        isLoading: ref(false),
        isLive: ref(true),
        errorMessage: ref(null),
        now: ref(Date.parse("2026-07-01T18:00:00.000Z")),
        selectedRunId: ref(null),
        refresh: async () => undefined,
        selectRun: () => {},
      });
      provideLatheActions({
        stopLoading: ref(false),
        answerLoading: ref(false),
        acceptLoading: ref(false),
        rejectLoading: ref(false),
        enqueueContentLoading: ref(false),
        lastError: ref(null),
        isLoading: computed(() => false),
        stop: async (runId: string) => {
          stopMock.callCount += 1;
          stopMock.lastRunId = runId;
          return true;
        },
        answer: async () => true,
        accept: async () => true,
        reject: async () => true,
        enqueueContent: async () => true,
      });
      return () => h(TailView);
    },
  });

  return mount(Harness, {
    global: {
      components: {
        UButton: { template: '<button v-bind="$attrs"><slot /></button>' },
        UAlert: { template: '<span v-bind="$attrs"><slot /></span>' },
        UModal: {
          props: { open: Boolean, title: String, persist: Boolean },
          template: '<div v-if="open" class="modal"><slot name="body" /><slot name="footer" /></div>',
        },
        USelect: {
          props: { modelValue: String, items: Array },
          template: '<div class="u-select" />',
        },
        TailPane: { template: '<div class="tail-pane" />' },
      },
    },
  });
};

const stopButtons = (wrapper: ReturnType<typeof mount>) =>
  wrapper.findAll("button").filter((b) => b.text().trim() === "Stop");

test("TailView: Stop button visible when tailed run is in activeRuns", () => {
  const statusRef = ref(makeStatus(["tail-run"]));
  const tailRef = ref(tailStateFromSnapshot(makeSnapshot("tail-run")));
  const stopMock = { callCount: 0, lastRunId: null };

  const wrapper = mountTailView(statusRef, tailRef, stopMock);
  expect(stopButtons(wrapper).length).toBe(1);
  wrapper.unmount();
});

test("TailView: Stop button hidden when tailed run is not in activeRuns", () => {
  const statusRef = ref(makeStatus(["other-run"]));
  const tailRef = ref(tailStateFromSnapshot(makeSnapshot("tail-run")));
  const stopMock = { callCount: 0, lastRunId: null };

  const wrapper = mountTailView(statusRef, tailRef, stopMock);
  expect(stopButtons(wrapper).length).toBe(0);
  wrapper.unmount();
});

test("TailView: Stop action targets the tailed run id", async () => {
  const statusRef = ref(makeStatus(["tail-run", "other-run"]));
  const tailRef = ref(tailStateFromSnapshot(makeSnapshot("tail-run")));
  const stopMock = { callCount: 0, lastRunId: null };

  const wrapper = mountTailView(statusRef, tailRef, stopMock);

  // Click header Stop → opens modal
  const headerStop = stopButtons(wrapper)[0];
  await headerStop.trigger("click");
  await nextTick();

  // Modal now open — find the confirm Stop (second Stop button)
  const buttons = stopButtons(wrapper);
  expect(buttons.length).toBe(2);
  const modalStop = buttons[1];
  await modalStop.trigger("click");
  await nextTick();

  expect(stopMock.callCount).toBe(1);
  expect(stopMock.lastRunId).toBe("tail-run");

  wrapper.unmount();
});
