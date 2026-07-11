import { strict as assert } from "node:assert";
import { mount } from "@vue/test-utils";
import { ref } from "vue";
import { test, vi } from "vitest";

const runs = ref<Array<{ runId: string; status: string; outcomes: string }>>([]);
const accept = vi.fn(async () => true);
const reject = vi.fn(async () => true);

vi.mock("../app/pages/index/ports/review-data", () => ({
  injectReviewData: () => ({
    reviewRuns: runs,
    reviewError: ref(null),
    removeRun: vi.fn(),
  }),
}));

vi.mock("../app/pages/index/ports/lathe-actions", () => ({
  injectLatheActions: () => ({
    accept,
    reject,
    acceptLoading: ref(false),
    rejectLoading: ref(false),
  }),
}));

import ReviewList from "../app/pages/index/components/ReviewList.vue";

const mountReviewList = () => mount(ReviewList, {
  global: {
    components: {
      UAlert: { props: ["title"], template: "<div>{{ title }}</div>" },
      UBadge: { template: "<span><slot /></span>" },
      UButton: { template: "<button v-bind='$attrs'><slot /></button>" },
      UTextarea: {
        props: ["modelValue"],
        emits: ["update:modelValue"],
        template: "<textarea :value='modelValue' @input='$emit(\"update:modelValue\", $event.target.value)' />",
      },
    },
  },
});

test.each([
  ["ready_for_review", true, true],
  ["blocked", false, false],
  ["failed", false, false],
  ["stopped", false, false],
  ["accepted", false, false],
])("ReviewList actions for %s", (status, canPrepare, canRequestChanges) => {
  runs.value = [{ runId: `run-${status}`, status, outcomes: "" }];
  const text = mountReviewList().text();

  assert.equal(text.includes("Prepare for Merge"), canPrepare);
  assert.equal(text.includes("Request Changes"), canRequestChanges);
});

test("ReviewList opens change-request input and requires a non-empty reason", async () => {
  runs.value = [{ runId: "run-review", status: "ready_for_review", outcomes: "" }];
  const wrapper = mountReviewList();
  const requestButton = wrapper.findAll("button").find((button) => button.text() === "Request Changes");

  assert.ok(requestButton);
  assert.equal(requestButton.attributes("disabled"), undefined);
  await requestButton.trigger("click");

  const submitButton = wrapper.findAll("button").find((button) => button.text() === "Submit Changes");
  assert.ok(submitButton);
  assert.notEqual(submitButton.attributes("disabled"), undefined);

  await wrapper.find("textarea").setValue("  narrow the scope  ");
  assert.equal(submitButton.attributes("disabled"), undefined);
  await submitButton.trigger("click");
  assert.deepEqual(reject.mock.calls.at(-1), ["run-review", "narrow the scope"]);
});
