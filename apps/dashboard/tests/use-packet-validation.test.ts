import { strict as assert } from "node:assert";
import { test } from "vitest";

import type { RivetClient, RivetFetch } from "@lathe/contract";
import { createClient } from "@lathe/contract";

import { usePacketValidation } from "../app/pages/index/composables/usePacketValidation";

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

const makeSequencedFetch = (responses: Array<Response | Error>): RivetFetch => {
  let index = 0;
  return async (): Promise<Response> => {
    const response = responses[index];
    index += 1;
    if (response instanceof Error) {
      throw response;
    }
    if (response) {
      return response;
    }
    return fakeResponse({ error: "not found" }, 404);
  };
};

const makeClient = (responses: Map<string, Response>): RivetClient =>
  createClient({ baseUrl: "http://localhost", fetch: makeFakeFetch(responses) });

test("usePacketValidation stores preview from a successful packet validation", async () => {
  const c = makeClient(
    new Map([
      [
        "POST /packet",
        fakeResponse({
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
        }),
      ],
    ]),
  );

  const validation = usePacketValidation(c);
  await validation.validatePacket(
    "---\nrepo: test/repo\nbase: main\noutcomes: []\nexpected_surface: []\nsuspicious_surface: []\nverification: []\nconstraints: []\nautofix_commands: []\npromoted: false\npass: 0\n---\nbody",
    "test.md",
  );

  assert.equal(validation.previewError.value, null);
  assert.ok(validation.preview.value);
  assert.equal(validation.preview.value!.ok, true);
  assert.equal(validation.preview.value!.frontmatter!.repo, "test/repo");
  assert.equal(validation.preview.value!.body, "test body");
});

test("usePacketValidation clears stale errors and recovers on a later success", async () => {
  const validation = usePacketValidation(
    createClient({
      baseUrl: "http://localhost",
      fetch: makeSequencedFetch([
        new Error("connection refused"),
        fakeResponse({
          ok: false,
          frontmatter: null,
          body: "",
          problems: ["Missing 'repo' in frontmatter", "Invalid base branch"],
        }),
      ]),
    }),
  );

  await validation.validatePacket("invalid content", "bad.md");

  assert.equal(validation.preview.value, null);
  assert.equal(validation.previewError.value, "Unable to validate packet.");

  await validation.validatePacket("invalid content", "bad.md");

  assert.equal(validation.previewError.value, null);
  assert.ok(validation.preview.value);
  assert.equal(validation.preview.value!.ok, false);
  assert.deepEqual(validation.preview.value!.problems, ["Missing 'repo' in frontmatter", "Invalid base branch"]);
});
