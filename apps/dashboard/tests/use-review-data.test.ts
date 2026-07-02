import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { LatheStatus, StatusDto } from "../app/pages/index/ports/lathe-status";
import { createRenderer, computed, defineComponent, nextTick, ref, type Ref } from "vue";

import { useReviewData } from "../app/pages/index/composables/useReviewData";

type ReviewRun = {
  runId: string;
  status: string;
  outcomes: string;
  branch: string;
  repo: string;
  base: string;
  blockedQuestion: string | null;
};

type HostNode = {
  kind: "root" | "element" | "text" | "comment";
  children: HostNode[];
  text?: string;
};

const renderer = createRenderer<HostNode, HostNode>({
  patchProp: () => undefined,
  insert: (child, parent) => {
    parent.children.push(child);
  },
  remove: () => undefined,
  createElement: () => ({ kind: "element", children: [] }),
  createText: (text) => ({ kind: "text", children: [], text }),
  createComment: (text) => ({ kind: "comment", children: [], text }),
  setText: (node, text) => {
    node.text = text;
  },
  setElementText: (node, text) => {
    node.text = text;
  },
  parentNode: () => null,
  nextSibling: () => null,
  setScopeId: () => undefined,
  cloneNode: (node) => ({ ...node, children: [...node.children] }),
  insertStaticContent: (content) => [
    { kind: "comment", children: [], text: content },
    { kind: "comment", children: [], text: content },
  ],
});

const makeReviewRun = (runId: string, status: string): ReviewRun => ({
  runId,
  status,
  outcomes: `outcomes for ${runId}`,
  branch: `branch-${runId}`,
  repo: "test/repo",
  base: "main",
  blockedQuestion: null,
});

const makeStatus = (): StatusDto => ({
  activeRun: null,
  queued: [],
  parked: [],
  campaigns: [],
  staged: [],
  review: {
    readyForReview: 0,
    failed: 0,
  },
});

const makeLatheStatus = (status: Ref<StatusDto | null>): LatheStatus => ({
  status,
  isLoading: ref(false),
  errorMessage: ref(null),
  isDaemonReachable: computed(() => true),
  isLive: ref(false),
  refresh: async () => undefined,
});

const flush = async (): Promise<void> => {
  await nextTick();
  await Promise.resolve();
  await Promise.resolve();
};

const mountReviewDataHarness = (loadReviewRuns: () => Promise<ReviewRun[]> | ReviewRun[]) => {
  const status = ref<StatusDto | null>(null);
  let api: ReturnType<typeof useReviewData> | undefined;

  const Harness = defineComponent({
    setup() {
      api = useReviewData(makeLatheStatus(status), loadReviewRuns);
      return () => null;
    },
  });

  const app = renderer.createApp(Harness);
  const root: HostNode = { kind: "root", children: [] };
  app.mount(root);

  if (!api) {
    throw new Error("review data composable was not created");
  }

  return { api, app, status };
};

test("useReviewData fetches on mount and refetches when status changes", async () => {
  const firstRun = makeReviewRun("run-1", "ready_for_review");
  const secondRun = makeReviewRun("run-2", "failed");
  let callCount = 0;

  const { api, app, status } = mountReviewDataHarness(async () => {
    callCount += 1;
    return callCount === 1 ? [firstRun] : [secondRun];
  });

  await flush();
  assert.deepEqual(api.reviewRuns.value, [firstRun]);
  assert.equal(api.reviewError.value, null);

  status.value = makeStatus();
  await flush();

  assert.deepEqual(api.reviewRuns.value, [secondRun]);
  assert.equal(api.reviewError.value, null);

  app.unmount();
});

test("useReviewData surfaces load failures and recovers on a later refresh", async () => {
  const recoveredRun = makeReviewRun("run-3", "ready_for_review");
  let callCount = 0;

  const { api, app, status } = mountReviewDataHarness(async () => {
    callCount += 1;
    if (callCount === 1) {
      throw new Error("review backend down");
    }
    return [recoveredRun];
  });

  await flush();
  assert.deepEqual(api.reviewRuns.value, []);
  assert.equal(api.reviewError.value, "Unable to fetch review data.");

  status.value = makeStatus();
  await flush();

  assert.deepEqual(api.reviewRuns.value, [recoveredRun]);
  assert.equal(api.reviewError.value, null);

  app.unmount();
});
