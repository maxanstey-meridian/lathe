// Hermetic opencode config generation + server supervision. Generates the isolated
// XDG config, spawns the serve process, and waits for readiness.
// The gate plugin, the custom agents, and the off-MCP transport are all wired here.

import { spawn, execSync, type ChildProcess } from "node:child_process";
import {
  writeFileSync,
  mkdirSync,
  createWriteStream,
  existsSync,
  copyFileSync,
  cpSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Paths } from "../../config/paths.js";
import type { Config } from "../../config/schemas.js";

// ---------------------------------------------------------------------------
// Generated config: the driver's serve instance loads ONLY this — our gate
// plugin, our bridge MCP, the two model providers.
//
// D5: a missing plugin file would mean an UNGATED executor — opencode skips
// absent plugins without a sound. Refuse to start instead.

export const writeOpencodeConfig = (
  config: Config,
  paths: Paths,
  pluginPath: string,
  globalConfigDir: string = join(homedir(), ".config", "opencode"),
): string => {
  if (!existsSync(pluginPath)) {
    throw new Error(`gate plugin not found at ${pluginPath} — refusing to run an ungated executor`);
  }
  const oc = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pluginPath],
    // The isolated XDG home cuts off the global AGENTS.md as a side effect, so
    // doctrine is re-attached explicitly: Max's house doctrine for both models.
    // Runs inherit the global file directly.
    instructions: [join(homedir(), ".config", "opencode", "skills", "meridian", "SKILL.md")],
    compaction: { auto: false }, // rotation replaces compaction (D2); never summarize
    // Unattended serve must never stall on a permission ask; the gate plugin
    // enforces the actual rules (§10) and denies what must be denied.
    // external_directory: DENY. The run sandbox is a self-rooted clone (real .git
    // dir, see createRunSandbox), so opencode roots ON the sandbox and every legit
    // read/write is internal. Anything resolving OUTSIDE the sandbox is the
    // wrong-tree escape; denying it makes a regression a hard, visible failure
    // instead of a silent main-repo read.
    permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "deny" },
    // ask_planner holds its MCP call open while Daddy thinks. Raised to 1h to
    // match daddy.timeoutMs, so the MCP layer never abandons a slow GLM consult
    // before the daddy timeout itself would — both ceilings are now 1h.
    experimental: { mcp_timeout: 3_600_000 },
    model: `${config.baby.providerId}/${config.baby.modelId}`,
    provider: (() => {
      type ProviderEntry = {
        npm?: string;
        name?: string;
        options: Record<string, unknown>;
        models?: Record<
          string,
          {
            name: string;
            limit: { context: number; output: number };
            options?: Record<string, unknown>;
          }
        >;
      };

      const providerMap = new Map<string, ProviderEntry>();
      const builtInProviderIds = new Set(["opencode"]);

      const defaultProviderId = config.baby.providerId;
      const defaultModelId = config.baby.modelId;
      const defaultContextWindow = config.baby.contextWindow;

      const thinkingOptions =
        config.baby.thinkingMode === "disabled"
          ? { options: { think: false } }
          : config.baby.thinkingBudget !== null
            ? { options: { thinking_budget: config.baby.thinkingBudget } }
            : {};

      if (!builtInProviderIds.has(defaultProviderId)) {
        providerMap.set(defaultProviderId, {
          npm: "@ai-sdk/openai-compatible",
          name: "Baby inference",
          options: {
            baseURL: config.baby.baseUrl,
            apiKey: config.baby.apiKey,
            timeout: config.baby.timeoutMs,
            chunkTimeout: 600_000,
          },
          models: {
            [defaultModelId]: {
              name: defaultModelId,
              limit: { context: defaultContextWindow, output: 16_384 },
              ...thinkingOptions,
            },
          },
        });
      }

      for (const [key, entry] of Object.entries(config.baby.models)) {
        const existing = providerMap.get(entry.providerId);
        if (existing) {
          if ((existing.options.baseURL as string) !== entry.baseUrl) {
            console.warn(
              `opencode config: baby.models[${key}] has providerId "${entry.providerId}" ` +
                `but baseUrl "${entry.baseUrl}" conflicts with already-declared baseUrl ` +
                `"${existing.options.baseURL}" — skipping this model entry`,
            );
            continue;
          }
          existing.models![entry.modelId] = {
            name: entry.modelId,
            limit: { context: entry.contextWindow, output: 16_384 },
            ...(entry.thinkingBudget !== null
              ? { options: { thinking_budget: entry.thinkingBudget } }
              : {}),
          };
        } else {
          providerMap.set(entry.providerId, {
            npm: "@ai-sdk/openai-compatible",
            name: "Baby inference",
            options: {
              baseURL: entry.baseUrl,
              apiKey: entry.apiKey,
              timeout: entry.timeoutMs,
              chunkTimeout: 600_000,
            },
            models: {
              [entry.modelId]: {
                name: entry.modelId,
                limit: { context: entry.contextWindow, output: 16_384 },
                ...(entry.thinkingBudget !== null
                  ? { options: { thinking_budget: entry.thinkingBudget } }
                  : {}),
              },
            },
          });
        }
      }

      const providerObj: Record<string, ProviderEntry> = {};
      for (const [providerId, entry] of providerMap) {
        providerObj[providerId] = entry;
      }

      // Daddy resolves through opencode's global auth, so it is intentionally
      // not declared in the generated provider map. Super-daddy joins the same
      // way when baseUrl is null (built-in provider resolving through global
      // auth, e.g. zai-coding-plan, ollama-cloud). When baseUrl is set, the
      // provider entry overrides the endpoint (e.g. openai → Codex backend).
      if (!providerMap.has(config.superdaddy.providerId) && config.superdaddy.baseUrl !== null) {
        // Super-daddy only joins when its providerId is unused by baby entries.
        providerObj[config.superdaddy.providerId] = {
          options: {
            baseURL: config.superdaddy.baseUrl,
            headerTimeout: config.superdaddy.headerTimeoutMs,
            // Present only for a local proxy provider (e.g. claude-max-proxy);
            // openai/codex omits it and uses opencode's ChatGPT-OAuth instead.
            ...(typeof config.superdaddy.apiKey === "string"
              ? { apiKey: config.superdaddy.apiKey }
              : {}),
          },
        };
      }

      return providerObj;
    })(),
    mcp: {
      "meridian-bridge": {
        type: "remote",
        url: `http://127.0.0.1:${config.opencode.bridgePort}/mcp`,
      },
    },
    // Custom agents so neither model inherits a stock agent's full toolbox.
    // Daddy: read-only inspection, and NO bridge tools — the planner must
    // never answer itself through its own MCP. Baby: build tools minus subagents
    // (defense in depth alongside the gate plugin's hard catch).
    agent: {
      daddy: {
        description: "Lathe planner — decides, never implements",
        mode: "primary",
        tools: {
          write: false,
          edit: false,
          patch: false,
          bash: false,
          task: false,
          todowrite: false,
          todoread: false,
          meridian_bridge_ask_planner: false,
          meridian_bridge_update_outcomes: false,
          meridian_bridge_write_checkpoint: false,
          meridian_bridge_submit_report: false,
          meridian_bridge_get_decisions: false,
          "meridian-bridge_ask_planner": false,
          "meridian-bridge_update_outcomes": false,
          "meridian-bridge_write_checkpoint": false,
          "meridian-bridge_submit_report": false,
          "meridian-bridge_get_decisions": false,
        },
      },
      baby: {
        description: "Lathe executor — implements the packet",
        mode: "primary",
        // Turns end after ≤N tool-rounds, returning control to the driver at
        // bounded intervals so rotation and gate evaluation cannot be starved.
        steps: config.baby.turnSteps,
        tools: { task: false },
      },
      // Super-daddy: the convergence reviewer (SUPER-DADDY §4). Unlike daddy it
      // MUST execute — bash is ENABLED so it runs the packet's verification plus
      // its own build/typecheck/test; a failing command is its only path to a
      // grounded blocker (§5). Still NO write/edit/patch (it reviews, never fixes)
      // and NO bridge tools (it must never answer itself, same rule as daddy).
      superdaddy: {
        description:
          "Lathe convergence reviewer — judges delivered work against the packet and doctrine; executes verification, never edits",
        mode: "primary",
        steps: config.superdaddy.turnSteps,
        tools: {
          write: false,
          edit: false,
          patch: false,
          task: false,
          todowrite: false,
          todoread: false,
          meridian_bridge_ask_planner: false,
          meridian_bridge_update_outcomes: false,
          meridian_bridge_write_checkpoint: false,
          meridian_bridge_submit_report: false,
          meridian_bridge_get_decisions: false,
          "meridian-bridge_ask_planner": false,
          "meridian-bridge_update_outcomes": false,
          "meridian-bridge_write_checkpoint": false,
          "meridian-bridge_submit_report": false,
          "meridian-bridge_get_decisions": false,
        },
      },
    },
  };
  mkdirSync(dirname(paths.opencodeConfigFile), { recursive: true });
  writeFileSync(paths.opencodeConfigFile, JSON.stringify(oc, null, 2), "utf-8");

  // OpenCode auto-installs @opencode-ai/plugin into its config home before
  // loading ANY plugin, and a bare dir makes that install fail against its
  // pinned registry snapshot — after which plugins are silently skipped
  // (found live: an unanswered permission ask froze a run for 25 minutes
  // because the gate plugin never loaded). Seed from the global config dir,
  // which has a working install.
  const configHome = dirname(paths.opencodeConfigFile);
  const globalDir = globalConfigDir;
  if (!existsSync(join(configHome, "node_modules", "@opencode-ai", "plugin"))) {
    if (!existsSync(join(globalDir, "node_modules", "@opencode-ai", "plugin"))) {
      throw new Error(
        `cannot seed ${configHome}: ${globalDir}/node_modules/@opencode-ai/plugin missing — run npm install in ${globalDir} first (an unseeded config home means the gate plugin silently fails to load)`,
      );
    }
    // A REAL copy of the package.json/lockfile/node_modules trio — a symlink
    // gets deleted by opencode's background installer before it fails against
    // its pinned registry (found live, twice). With a consistent trio present
    // the failure stays a harmless WARN, same as the global dir.
    rmSync(join(configHome, "node_modules"), { recursive: true, force: true });
    cpSync(join(globalDir, "node_modules"), join(configHome, "node_modules"), { recursive: true });
    copyFileSync(join(globalDir, "package.json"), join(configHome, "package.json"));
    if (existsSync(join(globalDir, "package-lock.json"))) {
      copyFileSync(join(globalDir, "package-lock.json"), join(configHome, "package-lock.json"));
    }
  }
  return paths.opencodeConfigFile;
};

// ---------------------------------------------------------------------------
// Server supervision

export const spawnOpencodeServer = (
  config: Config,
  paths: Paths,
): ChildProcess => {
  const child = spawn(
    "env",
    [
      `XDG_CONFIG_HOME=${paths.xdgConfigHome}`,
      `OPENCODE_CONFIG=${paths.opencodeConfigFile}`,
      config.opencode.binary,
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(config.opencode.port),
      "--print-logs",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  // Serve logs are the first place to look when a provider hangs instead of
  // erroring (learned the hard way on build day).
  const logFile = createWriteStream(paths.serveLogFile, { flags: "a" });
  child.stderr?.pipe(logFile);
  return child;
};

// §18: the opencode version is pinned by expectation, not hope — a silent
// upgrade changes plugin hooks, session APIs, and event shapes under us.
export const warnOnVersionDrift = (config: Config): void => {
  if (!config.opencode.expectedVersion) {
    return;
  }
  try {
    const version = execSync(`${config.opencode.binary} --version`, { encoding: "utf-8" }).trim();
    if (!version.includes(config.opencode.expectedVersion)) {
      console.error(
        `WARNING: opencode is ${version}, expected ${config.opencode.expectedVersion} — harness behavior is only proven against the pinned version`,
      );
    }
  } catch {
    /* version probe is advisory */
  }
};

export const waitForServer = async (config: Config, timeoutMs = 30_000): Promise<void> => {
  const url = `http://127.0.0.1:${config.opencode.port}/session`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `opencode server did not become ready on port ${config.opencode.port} within ${timeoutMs}ms`,
  );
};

// The plugin path: ships with @lathe/core at packages/core/plugin/gate-plugin.ts.
// Source execution resolves from src/infrastructure/opencode; bundled execution
// resolves from dist. Support both layouts so the built daemon stays gated.
export const pluginPath = (): string => {
  const here = dirname(new URL(import.meta.url).pathname);
  const sourcePath = join(here, "..", "..", "..", "plugin", "gate-plugin.ts");
  if (existsSync(sourcePath)) {
    return sourcePath;
  }
  return join(here, "..", "plugin", "gate-plugin.ts");
};
