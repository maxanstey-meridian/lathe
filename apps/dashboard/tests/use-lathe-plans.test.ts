import { strict as assert } from "node:assert";
import { test } from "vitest";

import type { RivetClient, RivetFetch } from "@lathe/contract";
import { createClient } from "@lathe/contract";

import { useLathePlans } from "../app/pages/index/composables/useLathePlans";

const fakeResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const makeFakeFetch = (responses: Map<string, Response>): RivetFetch => {
  return async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const key = `${request.method} ${pathname}`;
    const response = responses.get(key);
    if (response) {
      return response;
    }
    return fakeResponse({ code: "NOT_FOUND", message: "not found" }, 404);
  };
};

const makeSequencedFetch = (responses: Map<string, Response[]>): RivetFetch => {
  return async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const key = `${request.method} ${pathname}`;
    const queue = responses.get(key);
    const response = queue?.shift();
    if (response) {
      return response;
    }
    return fakeResponse({ code: "NOT_FOUND", message: "not found" }, 404);
  };
};

const makeClient = (responses: Map<string, Response>): RivetClient =>
  createClient({ baseUrl: "http://localhost", fetch: makeFakeFetch(responses) });

const makeSequencedClient = (responses: Map<string, Response[]>): RivetClient =>
  createClient({ baseUrl: "http://localhost", fetch: makeSequencedFetch(responses) });

const planDto = (overrides?: Partial<{
  planId: string;
  title: string;
  tags: string[];
  queuedRunId: string | null;
  createdAt: string;
  updatedAt: string;
}>) => ({
  planId: "20260706-200000-test",
  title: "Test Plan",
  tags: [] as string[],
  queuedRunId: null,
  createdAt: "2026-07-06T20:00:00.000Z",
  updatedAt: "2026-07-06T20:00:00.000Z",
  ...overrides,
});

const planDetail = (overrides?: Partial<{
  planId: string;
  title: string;
  raw: string;
  tags: string[];
  queuedRunId: string | null;
  createdAt: string;
  updatedAt: string;
}>) => ({
  planId: "20260706-200000-test",
  title: "Test Plan",
  raw: "---\nrepo: /tmp\n---\n\n# Body",
  tags: [] as string[],
  queuedRunId: null,
  createdAt: "2026-07-06T20:00:00.000Z",
  updatedAt: "2026-07-06T20:00:00.000Z",
  ...overrides,
});

test("useLathePlans: fetch list", async () => {
  const responses = new Map<string, Response>([
    ["GET /plans", fakeResponse([planDto({ planId: "p1", title: "Alpha" }), planDto({ planId: "p2", title: "Beta" })])],
  ]);
  const composable = useLathePlans(makeClient(responses));
  await composable.refresh();
  assert.equal(composable.plans.value.length, 2);
  assert.equal(composable.plans.value[0]!.planId, "p1");
});

test("useLathePlans: select plan loads detail", async () => {
  const responses = new Map<string, Response>([
    ["GET /plans/p1", fakeResponse(planDetail({ planId: "p1", raw: "# Hello" }))],
  ]);
  const composable = useLathePlans(makeClient(responses));
  await composable.selectPlan("p1");
  assert.equal(composable.selectedPlan.value?.planId, "p1");
  assert.equal(composable.editedContent.value, "# Hello");
});

test("useLathePlans: save plan PUTs content and tags", async () => {
  const responses = new Map<string, Response[]>([
    ["GET /plans/p1", [fakeResponse(planDetail({ planId: "p1" }))]],
    ["PUT /plans/p1", [fakeResponse(planDto({ planId: "p1", title: "Updated", tags: ["urgent"] }))]],
  ]);
  const composable = useLathePlans(makeSequencedClient(responses));
  await composable.selectPlan("p1");

  composable.editedContent.value = "# Updated content";
  composable.editedTags.value = ["urgent"];
  composable.markDirty();
  assert.ok(composable.isDirty.value);

  const ok = await composable.savePlan();
  assert.ok(ok);
  assert.ok(!composable.isDirty.value);
  assert.equal(composable.plans.value.length, 0);
});

test("useLathePlans: queue plan stamps queuedRunId", async () => {
  const responses = new Map<string, Response[]>([
    ["GET /plans/p1", [fakeResponse(planDetail({ planId: "p1" }))]],
    ["POST /plans/p1/queue", [fakeResponse({ runId: "p1" })]],
  ]);
  const composable = useLathePlans(makeSequencedClient(responses));
  await composable.selectPlan("p1");

  const ok = await composable.queuePlan();
  assert.ok(ok);
  assert.equal(composable.selectedPlan.value?.queuedRunId, "p1");
});

test("useLathePlans: delete plan removes from list and clears selection", async () => {
  const responses = new Map<string, Response[]>([
    ["GET /plans", [fakeResponse([planDto({ planId: "p1" })])]],
    ["GET /plans/p1", [fakeResponse(planDetail({ planId: "p1" }))]],
    ["DELETE /plans/p1", [fakeResponse({ deleted: true })]],
  ]);
  const composable = useLathePlans(makeSequencedClient(responses));
  await composable.refresh();
  await composable.selectPlan("p1");

  const ok = await composable.deletePlan("p1");
  assert.ok(ok);
  assert.equal(composable.plans.value.length, 0);
  assert.equal(composable.selectedPlan.value, null);
});

test("useLathePlans: addTag / removeTag update local edits without racing background saves", async () => {
  const responses = new Map<string, Response[]>([
    ["GET /plans", [fakeResponse([planDto({ planId: "p1" })])]],
    ["GET /plans/p1", [fakeResponse(planDetail({ planId: "p1", tags: [] }))]],
  ]);
  const composable = useLathePlans(makeSequencedClient(responses));
  await composable.refresh();
  await composable.selectPlan("p1");

  composable.tagInput.value = "bug";
  composable.addTag();
  assert.deepEqual(composable.editedTags.value, ["bug"]);
  assert.ok(composable.isDirty.value);

  composable.removeTag("bug");
  assert.deepEqual(composable.editedTags.value, []);
  assert.ok(composable.isDirty.value);
});

test("useLathePlans: save failure surfaces the API error and preserves dirty state", async () => {
  const responses = new Map<string, Response[]>([
    ["GET /plans/p1", [fakeResponse(planDetail({ planId: "p1" }))]],
    ["PUT /plans/p1", [fakeResponse({ code: "save_failed", message: "disk full" }, 500)]],
  ]);
  const composable = useLathePlans(makeSequencedClient(responses));
  await composable.selectPlan("p1");
  composable.editedContent.value = "# Changed";
  composable.markDirty();

  const ok = await composable.savePlan();

  assert.equal(ok, false);
  assert.equal(composable.errorMessage.value, "disk full");
  assert.ok(composable.isDirty.value);
});

test("useLathePlans: selectPlan(null) clears all state", async () => {
  const composable = useLathePlans(makeClient(new Map()));
  composable.editedContent.value = "x";
  composable.editedTags.value = ["a"];
  composable.markDirty();

  await composable.selectPlan(null);

  assert.equal(composable.selectedPlan.value, null);
  assert.equal(composable.editedContent.value, "");
  assert.deepEqual(composable.editedTags.value, []);
  assert.ok(!composable.isDirty.value);
});
