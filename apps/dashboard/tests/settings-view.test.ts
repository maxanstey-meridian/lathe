import { strict as assert } from "node:assert";

import { mount } from "@vue/test-utils";
import { nextTick, ref, computed } from "vue";
import { test, vi } from "vitest";

import type { SettingsDto } from "@lathe/contract";

var settingsState: ReturnType<typeof makeSettingsState> | undefined;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const baseSettings: SettingsDto = {
  stateRoot: "/tmp/lathe",
  opencode: { binary: "opencode", port: 4196, bridgePort: 4197, expectedVersion: "1.17" },
  daddy: { providerId: "zai-coding-plan", modelId: "glm-5.1", agent: "daddy", timeoutMs: 300_000 },
  baby: {
    providerId: "omlx",
    modelId: "Qwen3.6-35B",
    baseUrl: "http://localhost:8000/v1",
    apiKey: "secret-key",
    agent: "baby",
    contextWindow: 114_688,
    timeoutMs: 1_800_000,
    turnSteps: 30,
    thinkingMode: "budget",
    thinkingBudget: 6_000,
    promoteTo: { providerId: "promoter", modelId: "promote-model" },
    models: {},
  },
  superdaddy: {
    providerId: "openai",
    modelId: "gpt-5.5",
    agent: "superdaddy",
    timeoutMs: 1_800_000,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    headerTimeoutMs: 3_600_000,
    apiKey: "super-secret",
    turnSteps: 40,
    skillPath: "~/.config/opencode/skills/meridian/SKILL.md",
    packetSkillPath: "~/.config/opencode/skills/packet/SKILL.md",
    diffCapBytes: 131_072,
  },
  thresholds: {
    rotationFraction: 0.65,
    ladderParkAt: 10,
    ladderRotateAt: 4,
    checkpointNudgeMs: 1_200_000,
    checkpointToolCalls: 50,
    checkpointFiles: 6,
    checkpointLoc: 80,
    reportRejectionParkAt: 3,
    checkpointBounceLimit: 1,
    verificationTimeoutMs: 600_000,
    maxPasses: 3,
    promoteAtCap: true,
    maxReorientRetries: 2,
    maxRunMs: 21_600_000,
    contextTokensFloor: 128,
  },
  idleTimeoutMs: 120_000,
  concurrency: { maxWorkers: 1 },
  daemon: { host: "127.0.0.1", port: 4198 },
  mutationCommandPatterns: ["\\b(pnpm|npm|yarn)\\b.*\\bgenerate\\b"],
  repos: {
    "team/repo": {
      seed: {
        copies: ["main"],
        writes: { build: "dist" },
      },
      setup: { commands: [{ command: "pnpm install", dir: "." }] },
    },
  },
};

const makeSettingsState = () => {
  const loaded = ref<SettingsDto | null>(clone(baseSettings));
  const draft = ref<SettingsDto | null>(clone(baseSettings));
  const loading = ref(false);
  const saving = ref(false);
  const restarting = ref(false);
  const error = ref<string | null>(null);
  const success = ref<string | null>(null);
  const restartRequired = ref(false);
  const reposParseError = ref<string | null>(null);

  return {
    loaded,
    draft,
    loading,
    saving,
    restarting,
    error,
    success,
    restartRequired,
    reposParseError,
    dirty: computed(() => JSON.stringify(loaded.value) !== JSON.stringify(draft.value)),
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => true),
    restart: vi.fn(async () => true),
    resetDraft: vi.fn(() => {
      draft.value = clone(loaded.value);
      reposParseError.value = null;
    }),
  };
};

const flush = async (): Promise<void> => {
  await nextTick();
  await Promise.resolve();
};

const loadSettingsView = async () => {
  vi.resetModules();
  vi.doMock("../app/pages/index/ports/lathe-settings", () => ({
    injectLatheSettings: () => {
      if (!settingsState) {
        throw new Error("settingsState was not initialized");
      }
      return settingsState;
    },
  }));

  const module = await import("../app/pages/index/components/SettingsView.vue");
  return module.default;
};

const mountSettingsView = async () =>
  mount(await loadSettingsView(), {
    global: {
      components: {
        UAlert: { props: ["title"], template: "<div><slot />{{ title }}</div>" },
        UButton: { template: "<button v-bind='$attrs'><slot /></button>" },
        UModal: {
          props: ["open", "title", "persist"],
          emits: ["update:open"],
          template: "<div v-if='open'><slot name='body' /></div>",
        },
        UTooltip: { props: ["text"], template: "<span><slot />{{ text }}</span>" },
        UIcon: { template: "<span />" },
      },
    },
  });

test("SettingsView: hydrates repos, round-trips promote-to, and masks API keys", async () => {
  settingsState = makeSettingsState();

  const wrapper = await mountSettingsView();
  await flush();

  assert.equal(settingsState.load.mock.calls.length, 1);
  assert.equal(wrapper.text().includes("Edit in /tmp/lathe/config.json"), true);
  assert.equal(wrapper.findAll("input[disabled][type='text']").length, 2);
  assert.equal(wrapper.text().includes("Implementation"), true);
  assert.equal(wrapper.text().includes("Planner"), true);
  assert.equal(wrapper.text().includes("Acceptance Review"), true);

  const reposTextarea = wrapper.get("textarea");
  assert.equal((reposTextarea.element as HTMLTextAreaElement).value.includes("team/repo"), true);

  await reposTextarea.setValue(JSON.stringify({
    "team/new-repo": {
      seed: {
        copies: ["main"],
        writes: { build: "dist" },
      },
      setup: { commands: [{ command: "pnpm install", dir: "." }] },
    },
  }, null, 2));

  assert.equal(settingsState.reposParseError.value, null);
  assert.deepEqual(settingsState.draft.value?.repos, {
    "team/new-repo": {
      seed: {
        copies: ["main"],
        writes: { build: "dist" },
      },
      setup: { commands: [{ command: "pnpm install", dir: "." }] },
    },
  });

  await reposTextarea.setValue("{");
  assert.equal(settingsState.reposParseError.value, "Invalid JSON");
  assert.equal(wrapper.text().includes("Invalid repos JSON"), true);

  const promoteToggle = wrapper.get("input[aria-label='Enable promote-to']");
  await promoteToggle.setChecked(false);
  assert.equal(settingsState.draft.value?.baby.promoteTo, undefined);

  await promoteToggle.setChecked(true);
  assert.deepEqual(settingsState.draft.value?.baby.promoteTo, { providerId: "", modelId: "" });

  wrapper.unmount();
});

test("SettingsView: guarded restart confirmation calls restart only after confirm", async () => {
  settingsState = makeSettingsState();

  const wrapper = await mountSettingsView();
  await flush();

  const buttons = wrapper.findAll("button");
  const restartDaemon = buttons.find((button) => button.text() === "Restart Daemon");
  assert.ok(restartDaemon);

  await restartDaemon!.trigger("click");
  await flush();
  assert.equal(wrapper.text().includes("Are you sure you want to restart the daemon?"), true);
  assert.equal(wrapper.text().includes("Active runs will be stopped and must be requeued manually."), true);
  assert.equal(settingsState.restart.mock.calls.length, 0);

  const confirm = wrapper.findAll("button").find((button) => button.text() === "Restart");
  assert.ok(confirm);

  await confirm!.trigger("click");
  await flush();
  assert.equal(settingsState.restart.mock.calls.length, 1);

  wrapper.unmount();
});

test("SettingsView: restores prior numeric values when timeouts are re-enabled", async () => {
  settingsState = makeSettingsState();
  settingsState.draft.value!.idleTimeoutMs = 45_000;
  settingsState.draft.value!.superdaddy.headerTimeoutMs = 90_000;

  const wrapper = await mountSettingsView();
  await flush();

  const idleToggle = wrapper.get("input[aria-label='Enable Idle Timeout (ms)']");
  const headerToggle = wrapper.get("input[aria-label='Enable Header Timeout (ms)']");
  await idleToggle.setChecked(false);
  await headerToggle.setChecked(false);
  assert.equal(settingsState.draft.value?.idleTimeoutMs, false);
  assert.equal(settingsState.draft.value?.superdaddy.headerTimeoutMs, false);

  await idleToggle.setChecked(true);
  await headerToggle.setChecked(true);
  assert.equal(settingsState.draft.value?.idleTimeoutMs, 45_000);
  assert.equal(settingsState.draft.value?.superdaddy.headerTimeoutMs, 90_000);

  wrapper.unmount();
});

test("SettingsView: uses documented defaults when disabled timeouts have no prior numeric value", async () => {
  settingsState = makeSettingsState();
  settingsState.loaded.value!.idleTimeoutMs = false;
  settingsState.loaded.value!.superdaddy.headerTimeoutMs = false;
  settingsState.draft.value!.idleTimeoutMs = false;
  settingsState.draft.value!.superdaddy.headerTimeoutMs = false;

  const wrapper = await mountSettingsView();
  await flush();

  await wrapper.get("input[aria-label='Enable Idle Timeout (ms)']").setChecked(true);
  await wrapper.get("input[aria-label='Enable Header Timeout (ms)']").setChecked(true);

  assert.equal(settingsState.draft.value?.idleTimeoutMs, 120_000);
  assert.equal(settingsState.draft.value?.superdaddy.headerTimeoutMs, 3_600_000);

  wrapper.unmount();
});

test("SettingsView: discard does not restore a cached optional timeout edit", async () => {
  settingsState = makeSettingsState();
  settingsState.loaded.value!.idleTimeoutMs = false;
  settingsState.draft.value!.idleTimeoutMs = false;

  const wrapper = await mountSettingsView();
  await flush();

  const toggle = wrapper.get("input[aria-label='Enable Idle Timeout (ms)']");
  await toggle.setChecked(true);
  settingsState.draft.value!.idleTimeoutMs = 45_000;
  await toggle.setChecked(false);
  settingsState.draft.value!.daemon.port = 4_999;
  await flush();
  const discard = wrapper.findAll("button").find((button) => button.text() === "Discard");
  assert.ok(discard);
  await discard!.trigger("click");
  await flush();
  assert.equal(settingsState.resetDraft.mock.calls.length, 1);
  await wrapper.get("input[aria-label='Enable Idle Timeout (ms)']").setChecked(true);

  assert.equal(settingsState.draft.value?.idleTimeoutMs, 120_000);
  wrapper.unmount();
});

test("SettingsView: preserves invalid repos text entered while save is pending", async () => {
  settingsState = makeSettingsState();
  let resolveSave: ((saved: boolean) => void) | undefined;
  settingsState.save.mockImplementation(() => new Promise<boolean>((resolve) => { resolveSave = resolve; }));

  const wrapper = await mountSettingsView();
  await flush();
  settingsState.draft.value!.daemon.port = 5_000;
  await flush();

  const saveButton = wrapper.findAll("button").find((button) => button.text() === "Save");
  assert.ok(saveButton);
  await saveButton!.trigger("click");
  const reposTextarea = wrapper.get("textarea");
  await reposTextarea.setValue("{");
  resolveSave!(true);
  await flush();

  assert.equal((reposTextarea.element as HTMLTextAreaElement).value, "{");
  assert.equal(settingsState.reposParseError.value, "Invalid JSON");
  wrapper.unmount();
});

test("SettingsView: incomplete numeric input preserves the prior DTO value and shows feedback", async () => {
  settingsState = makeSettingsState();
  const wrapper = await mountSettingsView();
  await flush();

  const portInput = wrapper.findAll("input[type='number']").find((input) => input.element.value === "4196");
  assert.ok(portInput);
  await portInput!.setValue("");

  assert.equal(settingsState.draft.value!.opencode.port, 4196);
  assert.equal(wrapper.text().includes("Enter a valid number"), true);

  await portInput!.setValue("4200");
  assert.equal(settingsState.draft.value!.opencode.port, 4200);
  assert.equal(wrapper.text().includes("Enter a valid number"), false);
  wrapper.unmount();
});

test("SettingsView: disabling an optional number clears incomplete-value feedback", async () => {
  settingsState = makeSettingsState();
  const wrapper = await mountSettingsView();
  await flush();

  const toggle = wrapper.get("input[aria-label='Enable Idle Timeout (ms)']");
  const input = toggle.element.parentElement!.querySelector<HTMLInputElement>("input[type='number']")!;
  await wrapper.get(`input[aria-label='Enable Idle Timeout (ms)'] + input`).setValue("");
  assert.equal(wrapper.text().includes("Enter a valid number"), true);

  await toggle.setChecked(false);
  assert.equal(settingsState.draft.value!.idleTimeoutMs, false);
  assert.equal(wrapper.text().includes("Enter a valid number"), false);
  assert.equal(input.disabled, true);
  wrapper.unmount();
});

test("SettingsView: surfaces when saved settings require restart", async () => {
  settingsState = makeSettingsState();
  settingsState.restartRequired.value = true;
  const wrapper = await mountSettingsView();
  await flush();

  assert.equal(wrapper.text().includes("Saved settings require a daemon restart before they take effect."), true);
  wrapper.unmount();
});

test("SettingsView: clearing the acceptance review base URL writes null", async () => {
  settingsState = makeSettingsState();
  const wrapper = await mountSettingsView();
  await flush();

  const baseUrlInput = wrapper.findAll("input[type='text']").find(
    (input) => input.element.value === "https://chatgpt.com/backend-api/codex",
  );
  assert.ok(baseUrlInput);
  await baseUrlInput!.setValue("");

  assert.equal(settingsState.draft.value!.superdaddy.baseUrl, null);
  wrapper.unmount();
});
