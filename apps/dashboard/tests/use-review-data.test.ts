import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { RivetClient, RivetFetch } from "@lathe/contract";
import { createClient } from "@lathe/contract";

import { fetchReviewRunsWithClient } from "../app/pages/index/composables/fetchReviewRuns";

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
    return fakeResponse({ error: "not found" }, 404);
  };
};

const makeClient = (responses: Map<string, Response>): RivetClient =>
  createClient({ baseUrl: "http://localhost", fetch: makeFakeFetch(responses) });

test("fetchReviewRuns returns runs from successful response", async () => {
  const c = makeClient(new Map([["GET /review", fakeResponse({
    runs: [
      { runId: "run-1", status: "ready_for_review", outcomes: "outcome A", branch: "feat/1", repo: "test/repo", base: "main", blockedQuestion: null },
      { runId: "run-2", status: "ready_for_review", outcomes: "outcome B", branch: "feat/2", repo: "test/repo", base: "main", blockedQuestion: "is this right?" },
    ],
  })]]));

  const runs = await fetchReviewRunsWithClient(c);

  assert.equal(runs.length, 2);
  assert.equal(runs[0].runId, "run-1");
  assert.equal(runs[0].status, "ready_for_review");
  assert.equal(runs[1].runId, "run-2");
  assert.equal(runs[1].blockedQuestion, "is this right?");
});

test("fetchReviewRuns returns empty array when no runs", async () => {
  const c = makeClient(new Map([["GET /review", fakeResponse({ runs: [] })]]));

  const runs = await fetchReviewRunsWithClient(c);

  assert.equal(runs.length, 0);
});

test("fetchReviewRuns throws on network error", async () => {
  const c = createClient({ baseUrl: "http://localhost", fetch: async () => { throw new Error("network error"); } });

  await assert.rejects(fetchReviewRunsWithClient(c), /network error/);
});

test("fetchReviewRuns returns empty array when response has no runs field", async () => {
  const c = makeClient(new Map([["GET /review", fakeResponse({})]]));

  const runs = await fetchReviewRunsWithClient(c);

  assert.equal(runs.length, 0);
});
