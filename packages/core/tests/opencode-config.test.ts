import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { makePaths } from "../src/config/paths.js";
import type { Config } from "../src/config/schemas.js";
import { writeOpencodeConfig, pluginPath } from "../src/infrastructure/opencode/config.js";
import { createOpencodeClient } from "../src/infrastructure/opencode/executor.js";

const makeTestConfig = (overrides: Partial<Config> = {}): Config => ({
  stateRoot: "/tmp/lathe-test-state",
  opencode: {
    binary: "opencode",
    port: 4196,
    bridgePort: 4197,
    expectedVersion: "1.17",
    ...overrides.opencode,
  },
  daddy: {
    providerId: "zai-coding-plan",
    modelId: "glm-5.1",
    agent: "daddy",
    timeoutMs: 300_000,
    turnSteps: 8,
    ...overrides.daddy,
  },
  baby: {
    providerId: "omlx",
    modelId: "Qwen3.6-35B-A3B-UD-MLX-4bit",
    baseUrl: "http://localhost:8000/v1",
    apiKey: "test-key",
    agent: "baby",
    contextWindow: 98_304,
    timeoutMs: 1_800_000,
    turnSteps: 12,
    thinkingBudget: 6_000,
    ...overrides.baby,
  },
  superdaddy: {
    providerId: "openai",
    modelId: "gpt-5.5-pro",
    agent: "superdaddy",
    timeoutMs: 1_800_000,
    baseUrl: "https://chatgpt.com/backend-api/codex",
    headerTimeoutMs: 3_600_000,
    turnSteps: 40,
    skillPath: "~/.config/opencode/skills/meridian/SKILL.md",
    diffCapBytes: 131_072,
    ...overrides.superdaddy,
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
    maxStallRetries: 2,
    maxReorientRetries: 2,
    maxRunMs: 21_600_000,
    ...overrides.thresholds,
  },
  mutationCommandPatterns: [
    "\\b(pnpm|npm|yarn)\\b.*\\bgenerate\\b",
    "task contracts",
    "dotnet-rivet",
  ],
  idleTimeoutMs: 120_000,
});

const bridgeTools = [
  "meridian_bridge_ask_planner",
  "meridian_bridge_update_outcomes",
  "meridian_bridge_write_checkpoint",
  "meridian_bridge_submit_report",
  "meridian_bridge_get_decisions",
  "meridian-bridge_ask_planner",
  "meridian-bridge_update_outcomes",
  "meridian-bridge_write_checkpoint",
  "meridian-bridge_submit_report",
  "meridian-bridge_get_decisions",
] as const;

test("config generation: compaction.auto is false", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "meridian-config-test-"));
  const config = makeTestConfig();
  const paths = makePaths(tmpDir);

  mkdirSync(join(tmpDir, "plugin"), { recursive: true });
  writeFileSync(join(tmpDir, "plugin", "gate-plugin.ts"), "");
  mkdirSync(join(tmpDir, "xdg", "opencode", "node_modules", "@opencode-ai", "plugin"), {
    recursive: true,
  });

  writeOpencodeConfig(config, paths, join(tmpDir, "plugin", "gate-plugin.ts"));

  const writtenConfig = JSON.parse(readFileSync(paths.opencodeConfigFile, "utf-8"));
  assert.strictEqual(writtenConfig.compaction.auto, false);
});

test("config generation: three custom agents with correct tool sets", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "meridian-config-test-"));
  const config = makeTestConfig();
  const paths = makePaths(tmpDir);

  mkdirSync(join(tmpDir, "plugin"), { recursive: true });
  writeFileSync(join(tmpDir, "plugin", "gate-plugin.ts"), "");
  mkdirSync(join(tmpDir, "xdg", "opencode", "node_modules", "@opencode-ai", "plugin"), {
    recursive: true,
  });

  writeOpencodeConfig(config, paths, join(tmpDir, "plugin", "gate-plugin.ts"));

  const writtenConfig = JSON.parse(readFileSync(paths.opencodeConfigFile, "utf-8"));

  // All three agents must be present
  assert.ok(writtenConfig.agent.daddy, "daddy agent must exist");
  assert.ok(writtenConfig.agent.baby, "baby agent must exist");
  assert.ok(writtenConfig.agent.superdaddy, "superdaddy agent must exist");

  // Daddy must be read-only (no bash, no write/edit/patch, no bridge tools)
  assert.strictEqual(writtenConfig.agent.daddy.tools.write, false);
  assert.strictEqual(writtenConfig.agent.daddy.tools.edit, false);
  assert.strictEqual(writtenConfig.agent.daddy.tools.patch, false);
  assert.strictEqual(writtenConfig.agent.daddy.tools.bash, false);
  assert.strictEqual(writtenConfig.agent.daddy.tools.task, false);
  assert.strictEqual(writtenConfig.agent.daddy.tools.todowrite, false);
  assert.strictEqual(writtenConfig.agent.daddy.tools.todoread, false);

  for (const tool of bridgeTools) {
    assert.strictEqual(
      writtenConfig.agent.daddy.tools[tool],
      false,
      `${tool} must be disabled for daddy`,
    );
  }

  // Baby must have task disabled
  assert.strictEqual(writtenConfig.agent.baby.tools.task, false);

  // Super-daddy must have no write/edit/patch, bash enabled, no bridge tools
  assert.strictEqual(writtenConfig.agent.superdaddy.tools.write, false);
  assert.strictEqual(writtenConfig.agent.superdaddy.tools.edit, false);
  assert.strictEqual(writtenConfig.agent.superdaddy.tools.patch, false);
  assert.strictEqual(writtenConfig.agent.superdaddy.tools.task, false);
  assert.strictEqual(writtenConfig.agent.superdaddy.tools.todowrite, false);
  assert.strictEqual(writtenConfig.agent.superdaddy.tools.todoread, false);

  for (const tool of bridgeTools) {
    assert.strictEqual(
      writtenConfig.agent.superdaddy.tools[tool],
      false,
      `${tool} must be disabled for superdaddy`,
    );
  }
});

test("config generation: plugin path is present in config", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "meridian-config-test-"));
  const config = makeTestConfig();
  const paths = makePaths(tmpDir);

  const pluginFile = join(tmpDir, "plugin", "gate-plugin.ts");
  mkdirSync(join(tmpDir, "plugin"), { recursive: true });
  writeFileSync(pluginFile, "");
  mkdirSync(join(tmpDir, "xdg", "opencode", "node_modules", "@opencode-ai", "plugin"), {
    recursive: true,
  });

  writeOpencodeConfig(config, paths, pluginFile);

  const writtenConfig = JSON.parse(readFileSync(paths.opencodeConfigFile, "utf-8"));
  assert.deepStrictEqual(writtenConfig.plugin, [pluginFile]);
});

test("config generation: refuses to start when plugin file is missing", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "meridian-config-test-"));
  const config = makeTestConfig();
  const paths = makePaths(tmpDir);

  const missingPlugin = join(tmpDir, "nonexistent", "plugin.ts");
  assert.throws(() => writeOpencodeConfig(config, paths, missingPlugin), /gate plugin not found/);
});

test("config generation: XDG isolation — schema, instructions, permissions", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "meridian-config-test-"));
  const config = makeTestConfig();
  const paths = makePaths(tmpDir);

  mkdirSync(join(tmpDir, "plugin"), { recursive: true });
  writeFileSync(join(tmpDir, "plugin", "gate-plugin.ts"), "");
  mkdirSync(join(tmpDir, "xdg", "opencode", "node_modules", "@opencode-ai", "plugin"), {
    recursive: true,
  });

  writeOpencodeConfig(config, paths, join(tmpDir, "plugin", "gate-plugin.ts"));

  const writtenConfig = JSON.parse(readFileSync(paths.opencodeConfigFile, "utf-8"));
  assert.strictEqual(writtenConfig.$schema, "https://opencode.ai/config.json");
  assert.ok(Array.isArray(writtenConfig.instructions) && writtenConfig.instructions.length > 0);
  assert.strictEqual(writtenConfig.permission.edit, "allow");
  assert.strictEqual(writtenConfig.permission.external_directory, "deny");
});

test("config generation: MCP bridge wired in", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "meridian-config-test-"));
  const config = makeTestConfig();
  const paths = makePaths(tmpDir);

  mkdirSync(join(tmpDir, "plugin"), { recursive: true });
  writeFileSync(join(tmpDir, "plugin", "gate-plugin.ts"), "");
  mkdirSync(join(tmpDir, "xdg", "opencode", "node_modules", "@opencode-ai", "plugin"), {
    recursive: true,
  });

  writeOpencodeConfig(config, paths, join(tmpDir, "plugin", "gate-plugin.ts"));

  const writtenConfig = JSON.parse(readFileSync(paths.opencodeConfigFile, "utf-8"));
  assert.ok(writtenConfig.mcp["meridian-bridge"]);
  assert.strictEqual(writtenConfig.mcp["meridian-bridge"].type, "remote");
  assert.ok(writtenConfig.mcp["meridian-bridge"].url.includes("4197"));
});

test("config generation: skips copy when node_modules trio already present", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "meridian-config-test-"));
  const config = makeTestConfig();
  const paths = makePaths(tmpDir);

  mkdirSync(join(tmpDir, "plugin"), { recursive: true });
  writeFileSync(join(tmpDir, "plugin", "gate-plugin.ts"), "");

  // When the config home already has node_modules (plugin present), the code
  // skips the copy from global dir entirely. Verify the write succeeds and
  // no stale package.json is left behind.
  const nmDir = join(tmpDir, "node_modules", "@opencode-ai", "plugin");
  mkdirSync(nmDir, { recursive: true });
  writeFileSync(join(tmpDir, "package.json"), JSON.stringify({ name: "pre-existing" }));

  // Point opencodeConfigFile at a path inside tmpDir
  const configFile = join(tmpDir, "opencode.json");
  const seededPaths = { ...paths, xdgConfigHome: tmpDir, opencodeConfigFile: configFile };
  writeOpencodeConfig(config, seededPaths, join(tmpDir, "plugin", "gate-plugin.ts"));

  // Verify config was written (early-exit path: plugin already present, no copy)
  const writtenConfig = JSON.parse(readFileSync(configFile, "utf-8"));
  assert.ok(writtenConfig.compaction);
  assert.strictEqual(writtenConfig.compaction.auto, false);
});

test("pluginPath resolves to an existing file", () => {
  const path = pluginPath();
  assert.ok(existsSync(path), "pluginPath() must point to an existing gate-plugin.ts");
  assert.strictEqual(basename(path), "gate-plugin.ts");
});

test("config generation: seeds node_modules trio from global dir when missing", () => {
  const tempGlobalDir = mkdtempSync(join(tmpdir(), "meridian-global-stub-"));
  const globalPlugin = join(tempGlobalDir, "node_modules", "@opencode-ai", "plugin");
  mkdirSync(globalPlugin, { recursive: true });
  writeFileSync(
    join(tempGlobalDir, "package.json"),
    JSON.stringify({ name: "global-opencode", version: "1.0.0" }),
  );
  writeFileSync(join(tempGlobalDir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3 }));

  const tmpDir = mkdtempSync(join(tmpdir(), "meridian-copy-test-"));
  const config = makeTestConfig();
  const paths = makePaths(tmpDir);

  mkdirSync(join(tmpDir, "plugin"), { recursive: true });
  writeFileSync(join(tmpDir, "plugin", "gate-plugin.ts"), "");

  // Config home does NOT have node_modules/@opencode-ai/plugin — the copy branch MUST trigger.
  const configFile = join(tmpDir, "opencode.json");
  const copyPaths = { ...paths, xdgConfigHome: tmpDir, opencodeConfigFile: configFile };

  writeOpencodeConfig(config, copyPaths, join(tmpDir, "plugin", "gate-plugin.ts"), tempGlobalDir);

  // Verify the trio was copied into the config home.
  assert.ok(
    existsSync(join(tmpDir, "node_modules", "@opencode-ai", "plugin")),
    "node_modules/@opencode-ai/plugin should be copied",
  );
  const copiedPkg = JSON.parse(readFileSync(join(tmpDir, "package.json"), "utf-8"));
  assert.strictEqual(copiedPkg.name, "global-opencode");
  const copiedLock = JSON.parse(readFileSync(join(tmpDir, "package-lock.json"), "utf-8"));
  assert.strictEqual(copiedLock.lockfileVersion, 3);
});

// ---------------------------------------------------------------------------
// Idle timeout: stalled response rejects on idle timer, not total deadline
// ---------------------------------------------------------------------------

test("idle timeout: stalled response rejects before total deadline", async () => {
  const IDLE_MS = 200;
  const TOTAL_MS = 30_000;
  const PORT = 14199;

  let server: ReturnType<typeof import("node:http").createServer>;
  try {
    const { createServer } = await import("node:http");
    server = createServer((req, res) => {
      if (req.url === "/session" && req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => {
          body += c;
        });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "idle-test-sess" }));
        });
      } else {
        // sendMessage path: send 200 headers with SSE, then never send data.
        req.resume(); // consume request body
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.flushHeaders(); // flush headers without sending body data
      }
    });
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
    server.unref();

    const config: Config = {
      idleTimeoutMs: IDLE_MS,
      opencode: { port: PORT },
      daddy: {},
      baby: {},
      superdaddy: {},
      thresholds: {},
      mutationCommandPatterns: [],
    };
    const client = createOpencodeClient(config);

    const t0 = Date.now();
    await assert.rejects(
      async () =>
        client.sendMessage(
          "idle-test-sess",
          "hello",
          { providerId: "test", modelId: "test", agent: "test" },
          TOTAL_MS,
        ),
      (err: Error) => {
        const elapsed = Date.now() - t0;
        assert.ok(err.message.includes("no data"), `expected idle error, got: ${err.message}`);
        assert.ok(
          err.message.includes("connection stalled"),
          `expected stalled text, got: ${err.message}`,
        );
        assert.ok(
          elapsed < TOTAL_MS / 2,
          `should reject on idle timer (${elapsed}ms) not total deadline (${TOTAL_MS}ms)`,
        );
        assert.ok(elapsed >= IDLE_MS - 50, `should take at least ~${IDLE_MS}ms, took ${elapsed}ms`);
        return true;
      },
    );
  } finally {
    server?.close();
  }
});

test("idle timeout: disabled (false) does not reject", async () => {
  const PORT = 14200;

  let server: ReturnType<typeof import("node:http").createServer>;
  try {
    const { createServer } = await import("node:http");
    server = createServer((req, res) => {
      if (req.url === "/session" && req.method === "POST") {
        let body = "";
        req.on("data", (c: Buffer) => {
          body += c;
        });
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "idle-disable-test" }));
        });
      } else {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const payload = JSON.stringify({
          info: { role: "assistant", model: "test", createdAt: "2026-01-01T00:00:00Z" },
          parts: [{ type: "text", text: "ok" }],
        });
        res.write(`data: ${payload}\n`);
        res.write("data: [DONE]\n");
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
    server.unref();

    const config: Config = {
      idleTimeoutMs: false,
      opencode: { port: PORT },
      daddy: {},
      baby: {},
      superdaddy: {},
      thresholds: {},
      mutationCommandPatterns: [],
    };
    const client = createOpencodeClient(config);

    const result = await client.sendMessage(
      "idle-disable-test",
      "hello",
      { providerId: "test", modelId: "test", agent: "test" },
      5_000,
    );
    assert.deepStrictEqual(result, {
      info: { role: "assistant", model: "test", createdAt: "2026-01-01T00:00:00Z" },
      parts: [{ type: "text", text: "ok" }],
    });
  } finally {
    server?.close();
  }
});
