import { strict as assert } from "node:assert";
import { test } from "vitest";

import type { RivetClient, RivetFetch } from "@lathe/contract";
import { createClient } from "@lathe/contract";

import type { SettingsDto } from "../packages/contract/src/lathe.contract";
import { useLatheSettings } from "../app/pages/index/composables/useLatheSettings";

const fakeResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const settingsResponse = (settings: SettingsDto, restartRequired = false) => ({ settings, restartRequired });

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

const baseSettings: SettingsDto = {
  stateRoot: "/tmp/lathe",
  opencode: { binary: "opencode", port: 4196, bridgePort: 4197, expectedVersion: "1.17" },
  daddy: { providerId: "zai-coding-plan", modelId: "glm-5.1", agent: "daddy", timeoutMs: 300_000 },
  baby: {
    providerId: "omlx", modelId: "Qwen3.6-35B", baseUrl: "http://localhost:8000/v1",
    apiKey: "secret-key", agent: "baby", contextWindow: 114_688, timeoutMs: 1_800_000,
    turnSteps: 30, thinkingMode: "budget", thinkingBudget: 6_000,
    models: {
      large: {
        providerId: "omlx", modelId: "Qwen3.6-70B", baseUrl: "http://localhost:8000/v1",
        contextWindow: 200_000, apiKey: "model-key", timeoutMs: 1_800_000, thinkingBudget: null,
      },
    },
  },
  superdaddy: {
    providerId: "openai", modelId: "gpt-5.5", agent: "superdaddy", timeoutMs: 1_800_000,
    baseUrl: "https://chatgpt.com/backend-api/codex", headerTimeoutMs: 3_600_000,
    turnSteps: 40, skillPath: "~/.config/opencode/skills/meridian/SKILL.md",
    packetSkillPath: "~/.config/opencode/skills/packet/SKILL.md",
    diffCapBytes: 131_072,
  },
  thresholds: {
    rotationFraction: 0.65, ladderParkAt: 10, ladderRotateAt: 4,
    checkpointNudgeMs: 1_200_000, checkpointToolCalls: 50, checkpointFiles: 6,
    checkpointLoc: 80, reportRejectionParkAt: 3, checkpointBounceLimit: 1,
    verificationTimeoutMs: 600_000, maxPasses: 3,
    promoteAtCap: true,
    maxReorientRetries: 2, maxRunMs: 21_600_000, contextTokensFloor: 128,
  },
  idleTimeoutMs: false,
  concurrency: { maxWorkers: 1 },
  daemon: { host: "127.0.0.1", port: 4198 },
  mutationCommandPatterns: ["\\b(pnpm|npm|yarn)\\b.*\\bgenerate\\b"],
  repos: {
    repo: {
      seed: { copies: [], writes: {} },
      setup: { commands: [{ command: "pnpm install", dir: "." }] },
    },
  },
};

test("useLatheSettings load: sets loaded and draft from GET /settings", async () => {
  const c = makeClient(new Map([["GET /settings", fakeResponse(settingsResponse(baseSettings))]]));
  const s = useLatheSettings(c);

  await s.load();

  assert.equal(s.loading.value, false);
  assert.ok(s.loaded.value !== null);
  assert.deepStrictEqual(s.loaded.value, baseSettings);
  assert.deepStrictEqual(s.draft.value, baseSettings);
});

test("useLatheSettings dirty: false when draft untouched", async () => {
  const c = makeClient(new Map([["GET /settings", fakeResponse(settingsResponse(baseSettings))]]));
  const s = useLatheSettings(c);

  await s.load();
  assert.equal(s.dirty.value, false);
});

test("useLatheSettings dirty: true after mutating draft", async () => {
  const c = makeClient(new Map([["GET /settings", fakeResponse(settingsResponse(baseSettings))]]));
  const s = useLatheSettings(c);

  await s.load();
  if (s.draft.value) {
    s.draft.value.opencode.port = 4199;
  }
  assert.equal(s.dirty.value, true);
});

test("useLatheSettings save: sends full SettingsDto and resets dirty", async () => {
  const savedSettings: SettingsDto = { ...baseSettings, opencode: { ...baseSettings.opencode, port: 4199 } };
  const c = makeSequencedClient(
    new Map([
      ["GET /settings", [fakeResponse(settingsResponse(baseSettings))]],
      ["PUT /settings", [fakeResponse(settingsResponse(savedSettings, true), 200)]],
    ]),
  );
  const s = useLatheSettings(c);

  await s.load();
  if (s.draft.value) {
    s.draft.value.opencode.port = 4199;
  }
  assert.equal(s.dirty.value, true);

  const result = await s.save();
  assert.equal(result, true);
  assert.equal(s.dirty.value, false);
  assert.equal(s.error.value, null);
  assert.deepStrictEqual(s.loaded.value, savedSettings);
  assert.equal(s.restartRequired.value, true);
});

test("useLatheSettings save: preserves edits made while the submitted snapshot is in flight", async () => {
  let resolveSave: ((response: Response) => void) | undefined;
  let submitted: SettingsDto | undefined;
  const c = createClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      if (request.method === "GET") return fakeResponse(settingsResponse(baseSettings));
      submitted = JSON.parse(await request.text()) as SettingsDto;
      return new Promise<Response>((resolve) => { resolveSave = resolve; });
    },
  });
  const s = useLatheSettings(c);
  await s.load();
  s.draft.value!.opencode.port = 4199;

  const save = s.save();
  s.draft.value!.daemon.port = 5000;
  await new Promise((resolve) => setTimeout(resolve, 0));
  resolveSave!(fakeResponse(settingsResponse({ ...baseSettings, opencode: { ...baseSettings.opencode, port: 4199 } }, true)));
  assert.equal(await save, true);

  assert.equal(submitted?.opencode.port, 4199);
  assert.equal(submitted?.daemon.port, 4198);
  assert.equal(s.draft.value?.daemon.port, 5000);
  assert.equal(s.loaded.value?.daemon.port, 4198);
  assert.equal(s.dirty.value, true);
});

test("useLatheSettings save: concurrent calls coalesce into one request", async () => {
  let saves = 0;
  let resolveSave: ((response: Response) => void) | undefined;
  const c = createClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      if (request.method === "GET") return fakeResponse(settingsResponse(baseSettings));
      saves += 1;
      return new Promise<Response>((resolve) => { resolveSave = resolve; });
    },
  });
  const s = useLatheSettings(c);
  await s.load();

  const first = s.save();
  const second = s.save();
  assert.equal(saves, 1);
  resolveSave!(fakeResponse(settingsResponse(baseSettings)));
  assert.deepStrictEqual(await Promise.all([first, second]), [true, true]);
  assert.equal(saves, 1);
});

test("useLatheSettings save: 400 sets error and returns false", async () => {
  const c = makeSequencedClient(
    new Map([
      ["GET /settings", [fakeResponse(settingsResponse(baseSettings))]],
      ["PUT /settings", [fakeResponse({ code: "VALIDATION", message: "invalid port" }, 400)]],
    ]),
  );
  const s = useLatheSettings(c);

  await s.load();
  if (s.draft.value) {
    s.draft.value.opencode.port = -1;
  }

 const result = await s.save();
  assert.equal(result, false);
  assert.equal(s.error.value, "invalid port");
});

test("useLatheSettings restart: POST /restart success", async () => {
  const c = makeClient(new Map([
    ["POST /restart", fakeResponse({ restarting: true })],
  ]));
  const s = useLatheSettings(c);

  const result = await s.restart();
  assert.equal(result, true);
  assert.equal(s.error.value, null);
  assert.ok(s.success.value);
});

test("useLatheSettings restart: 400 sets error", async () => {
  const c = makeClient(new Map([
    ["POST /restart", fakeResponse({ code: "UNAVAILABLE", message: "daemon not ready" }, 400)],
  ]));
  const s = useLatheSettings(c);

  const result = await s.restart();
  assert.equal(result, false);
  assert.equal(s.error.value, "daemon not ready");
});

test("useLatheSettings resetDraft: restores draft from loaded", async () => {
  const c = makeClient(new Map([["GET /settings", fakeResponse(settingsResponse(baseSettings))]]));
  const s = useLatheSettings(c);

  await s.load();
  if (s.draft.value) {
    s.draft.value.opencode.port = 9999;
  }
  assert.equal(s.dirty.value, true);

  s.resetDraft();
  assert.equal(s.dirty.value, false);
});

test("useLatheSettings load: network error sets error message", async () => {
  const c = createClient({
    baseUrl: "http://localhost",
    fetch: async () => { throw new Error("network failure"); },
  });
  const s = useLatheSettings(c);

  await s.load();
  assert.equal(s.loading.value, false);
  assert.equal(s.loaded.value, null);
  assert.ok(s.error.value);
  assert.equal(s.error.value, "network failure");
});

test("useLatheSettings save: sends full SettingsDto (not partial patch)", async () => {
  let capturedBody: unknown = null;
  const customFetch: RivetFetch = async (request: Request): Promise<Response> => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    const key = `${request.method} ${pathname}`;
    if (key === "PUT /settings") {
      const body = await request.text();
      capturedBody = body;
      return fakeResponse(settingsResponse(baseSettings, true));
    }
    if (key === "GET /settings") {
      return fakeResponse(settingsResponse(baseSettings));
    }
    return fakeResponse({ code: "NOT_FOUND", message: "not found" }, 404);
  };

  const c = createClient({ baseUrl: "http://localhost", fetch: customFetch });
  const s = useLatheSettings(c);

  await s.load();
  await s.save();

  assert.ok(typeof capturedBody === "string");
  const parsed = JSON.parse(capturedBody as string);
  assert.ok("stateRoot" in parsed);
  assert.ok("opencode" in parsed);
  assert.ok("daddy" in parsed);
  assert.ok("baby" in parsed);
  assert.ok("superdaddy" in parsed);
  assert.ok("thresholds" in parsed);
  assert.ok("repos" in parsed);
});

test("useLatheSettings restart: loading state managed correctly", async () => {
  let resolvePromise: ((value: Response) => void) | null = null;
  const customFetch: RivetFetch = async (): Promise<Response> => {
    return new Promise<Response>((resolve) => { resolvePromise = resolve; });
  };

  const c = createClient({ baseUrl: "http://localhost", fetch: customFetch });
  const s = useLatheSettings(c);

  const restartPromise = s.restart();
  assert.equal(s.restarting.value, true);

  // Resolve after a short delay
  await new Promise((r) => setTimeout(r, 50));
  resolvePromise?.(fakeResponse({ restarting: true }));

  await restartPromise;
  assert.equal(s.restarting.value, false);
  assert.equal(s.success.value, "Daemon restarting");
});
