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
    transportRetries: 2,
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
    maxReviewerUnreachable: 3,
    promoteAtCap: true,
    maxStallRetries: 2,
    maxCrashRetries: 2,
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
  const reposParseError = ref<string | null>(null);

  return {
    loaded,
    draft,
    loading,
    saving,
    restarting,
    error,
    success,
    reposParseError,
    dirty: computed(() => JSON.stringify(loaded.value) !== JSON.stringify(draft.value)),
    load: vi.fn(async () => undefined),
    save: vi.fn(async () => true),
    restart: vi.fn(async () => true),
    resetDraft: vi.fn(() => {
      draft.value = clone(baseSettings);
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

  const reposTextarea = wrapper.get("textarea");
  assert.equal((reposTextarea.element as HTMLTextAreaElement).value.includes("team/repo"), true);

  await reposTextarea.setValue(JSON.stringify({
    "team/new-repo": {
      seed: {
        copies: ["main"],
        writes: { build: "dist" },
      },
    },
  }, null, 2));

  assert.equal(settingsState.reposParseError.value, null);
  assert.deepEqual(settingsState.draft.value?.repos, {
    "team/new-repo": {
      seed: {
        copies: ["main"],
        writes: { build: "dist" },
      },
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
  assert.equal(settingsState.restart.mock.calls.length, 0);

  const confirm = wrapper.findAll("button").find((button) => button.text() === "Restart");
  assert.ok(confirm);

  await confirm!.trigger("click");
  await flush();
  assert.equal(settingsState.restart.mock.calls.length, 1);

  wrapper.unmount();
});
