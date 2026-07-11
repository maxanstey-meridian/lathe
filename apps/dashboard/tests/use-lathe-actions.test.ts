import { strict as assert } from "node:assert";
import { test } from "vitest";

import type { RivetClient, RivetFetch } from "@lathe/contract";
import { createClient } from "@lathe/contract";

import { mapError, useLatheActions } from "../app/pages/index/composables/useLatheActions";

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

const makeSequencedFetch = (responses: Map<string, Response[]>): RivetFetch => {
  return async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const key = `${request.method} ${pathname}`;
    const queue = responses.get(key);
    const response = queue?.shift();
    if (response) {
      return response;
    }
    return fakeResponse({ error: "not found" }, 404);
  };
};

const makeClient = (responses: Map<string, Response>): RivetClient =>
  createClient({ baseUrl: "http://localhost", fetch: makeFakeFetch(responses) });

const makeSequencedClient = (responses: Map<string, Response[]>): RivetClient =>
  createClient({ baseUrl: "http://localhost", fetch: makeSequencedFetch(responses) });

test("useLatheActions stop success: returns true and clears lastError", async () => {
  let refreshCount = 0;
  const mockRefresh = async (): Promise<void> => {
    refreshCount += 1;
  };

  const c = makeClient(new Map([["POST /runs/test/stop", fakeResponse({ id: "test" })]]));
  const actions = useLatheActions(mockRefresh, c);
  const result = await actions.stop("test");

  assert.equal(result, true);
  assert.equal(actions.lastError.value, null);
  assert.equal(refreshCount, 1);
});

test("useLatheActions stop non-2xx: lastError populated and not refreshed", async () => {
  let refreshCount = 0;
  const mockRefresh = async (): Promise<void> => {
    refreshCount += 1;
  };

  const c = makeClient(new Map([["POST /runs/test/stop", fakeResponse({ message: "run not found" }, 404)]]));
  const actions = useLatheActions(mockRefresh, c);
  const result = await actions.stop("test");

  assert.equal(result, false);
  assert.equal(actions.lastError.value, "run not found");
  assert.equal(refreshCount, 0);
});

test("useLatheActions stop missing data: returns false and records an error", async () => {
  let refreshCount = 0;
  const mockRefresh = async (): Promise<void> => {
    refreshCount += 1;
  };

  const c = makeClient(new Map([["POST /runs/test/stop", new Response(null, { status: 200 })]]));
  const actions = useLatheActions(mockRefresh, c);
  const result = await actions.stop("test");

  assert.equal(result, false);
  assert.ok(actions.lastError.value);
  assert.equal(refreshCount, 0);
});

test("useLatheActions stop throws: returns false and records the thrown error", async () => {
  let refreshCount = 0;
  const mockRefresh = async (): Promise<void> => {
    refreshCount += 1;
  };

  const c = createClient({
    baseUrl: "http://localhost",
    fetch: async () => {
      throw new Error("network failure");
    },
  });
  const actions = useLatheActions(mockRefresh, c);
  const result = await actions.stop("test");

  assert.equal(result, false);
  assert.equal(actions.lastError.value, "network failure");
  assert.equal(refreshCount, 0);
});

test("useLatheActions enqueueContent success", async () => {
  let refreshCount = 0;
  const mockRefresh = async (): Promise<void> => {
    refreshCount += 1;
  };

  const c = makeClient(new Map([["POST /runs/content", fakeResponse({ id: "new-run" })]]));
  const actions = useLatheActions(mockRefresh, c);
  const result = await actions.enqueueContent("x.md", "x");

  assert.equal(result, true);
  assert.equal(actions.lastError.value, null);
  assert.equal(refreshCount, 1);
});

test("useLatheActions enqueueContent non-2xx", async () => {
  let refreshCount = 0;
  const mockRefresh = async (): Promise<void> => {
    refreshCount += 1;
  };

  const c = makeClient(new Map([["POST /runs/content", fakeResponse({ message: "validation failed" }, 400)]]));
  const actions = useLatheActions(mockRefresh, c);
  const result = await actions.enqueueContent("x.md", "x");

  assert.equal(result, false);
  assert.equal(actions.lastError.value, "validation failed");
  assert.equal(refreshCount, 0);
});

test("useLatheActions answer success and failure", async () => {
  let refreshCount = 0;
  const mockRefresh = async (): Promise<void> => {
    refreshCount += 1;
  };

  const c = makeSequencedClient(
    new Map([
      [
        "POST /runs/test/answer",
        [fakeResponse({ id: "test-answer" }), fakeResponse({ message: "answer rejected" }, 400)],
      ],
    ]),
  );
  const actions = useLatheActions(mockRefresh, c);

  const success = await actions.answer("test", "because it is ready");
  assert.equal(success, true);
  assert.equal(actions.lastError.value, null);
  assert.equal(refreshCount, 1);

  const failure = await actions.answer("test", "because it is ready");
  assert.equal(failure, false);
  assert.equal(actions.lastError.value, "answer rejected");
  assert.equal(refreshCount, 1);
});

test("useLatheActions accept success and failure", async () => {
  let refreshCount = 0;
  const mockRefresh = async (): Promise<void> => {
    refreshCount += 1;
  };

  const c = makeSequencedClient(
    new Map([
      [
        "POST /runs/test/accept",
        [fakeResponse({ id: "test-accept" }), fakeResponse({ message: "accept rejected" }, 403)],
      ],
    ]),
  );
  const actions = useLatheActions(mockRefresh, c);

  const success = await actions.accept("test");
  assert.equal(success, true);
  assert.equal(actions.lastError.value, null);
  assert.equal(refreshCount, 1);

  const failure = await actions.accept("test");
  assert.equal(failure, false);
  assert.equal(actions.lastError.value, "accept rejected");
  assert.equal(refreshCount, 1);
});

test("useLatheActions reject success and failure", async () => {
  let refreshCount = 0;
  const mockRefresh = async (): Promise<void> => {
    refreshCount += 1;
  };

  const c = makeSequencedClient(
    new Map([
      [
        "POST /runs/test/reject",
        [fakeResponse({ id: "test-reject" }), fakeResponse({ message: "reject rejected" }, 500)],
      ],
    ]),
  );
  const actions = useLatheActions(mockRefresh, c);

  const success = await actions.reject("test", "not good enough");
  assert.equal(success, true);
  assert.equal(actions.lastError.value, null);
  assert.equal(refreshCount, 1);

  const failure = await actions.reject("test", "not good enough");
  assert.equal(failure, false);
  assert.equal(actions.lastError.value, "reject rejected");
  assert.equal(refreshCount, 1);
});

test("useLatheActions direct composable clears stale lastError after a later success", async () => {
  let refreshCount = 0;
  const mockRefresh = async (): Promise<void> => {
    refreshCount += 1;
  };

  const c = makeSequencedClient(
    new Map([
      [
        "POST /runs/test/stop",
        [fakeResponse({ message: "run not found" }, 404), fakeResponse({ id: "test" })],
      ],
    ]),
  );
  const actions = useLatheActions(mockRefresh, c);

  const first = await actions.stop("test");
  assert.equal(first, false);
  assert.equal(actions.lastError.value, "run not found");
  assert.equal(refreshCount, 0);

  const second = await actions.stop("test");
  assert.equal(second, true);
  assert.equal(actions.lastError.value, null);
  assert.equal(refreshCount, 1);
});

test("mapError extracts message from error objects", async () => {
  assert.equal(mapError("plain string"), "plain string");
  assert.equal(mapError({ message: "obj message" }), "obj message");
  assert.equal(mapError(new Error("err obj")), "err obj");
  assert.equal(mapError(null), "The action could not be completed.");
  assert.equal(mapError(undefined), "The action could not be completed.");
  assert.equal(mapError(""), "The action could not be completed.");
});
