import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { RivetClient, RivetFetch } from "@lathe/contract";
import { createClient } from "@lathe/contract";

import { validatePacketWithClient } from "../app/pages/index/composables/usePacketValidation";

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

test("validatePacket success with valid frontmatter", async () => {
  const c = makeClient(new Map([["POST /packet", fakeResponse({
    ok: true,
    frontmatter: {
      repo: "test/repo",
      base: "main",
      compare_commit: "abc123",
      summary: "test summary",
      outcomes: [{ id: "test", description: "test outcome" }],
      expected_surface: [],
      suspicious_surface: [],
      verification: [{ command: "echo ok" }],
      constraints: [],
      autofix_commands: [],
      promoted: false,
      pass: 0,
    },
    body: "test body",
    problems: [],
  })]]));

  const result = await validatePacketWithClient(c, "---\nrepo: test/repo\nbase: main\noutcomes: []\nexpected_surface: []\nsuspicious_surface: []\nverification: []\nconstraints: []\nautofix_commands: []\npromoted: false\npass: 0\n---\nbody", "test.md");

  assert.equal(result.error, null);
  assert.ok(result.data);
  assert.equal(result.data!.ok, true);
  assert.equal(result.data!.frontmatter!.repo, "test/repo");
  assert.equal(result.data!.frontmatter!.base, "main");
});

test("validatePacket handles validation failure with problems", async () => {
  const c = makeClient(new Map([["POST /packet", fakeResponse({
    ok: false,
    frontmatter: null,
    body: "",
    problems: ["Missing 'repo' in frontmatter", "Invalid base branch"],
  })]]));

  const result = await validatePacketWithClient(c, "invalid content", "bad.md");

  assert.equal(result.error, null);
  assert.ok(result.data);
  assert.equal(result.data!.ok, false);
  assert.deepEqual(result.data!.problems, ["Missing 'repo' in frontmatter", "Invalid base branch"]);
});

test("validatePacket handles network error", async () => {
  const c = createClient({ baseUrl: "http://localhost", fetch: async () => { throw new Error("connection refused"); } });

  const result = await validatePacketWithClient(c, "content", "test.md");

  assert.ok(result.error);
  assert.equal(result.data, null);
});
