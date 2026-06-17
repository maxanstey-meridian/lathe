// OpenCode adapter: spawn/supervise the server (T4), generate its hermetic
// config, and a thin HTTP client. POST /session/:id/message is synchronous —
// the response arrives when the turn ends (proven by v1's bridge) — so the
// driver loop needs no SSE: turn = one awaited POST, then a message-list fetch
// for journaling.
//
// Endpoint shapes are grounded on v1's working code where possible; session
// creation and message listing are the two least-proven calls (CONTRACT §19) —
// both parse leniently and fail loudly.

import { spawn, execSync, type ChildProcess } from "child_process"
import { writeFileSync, mkdirSync, createWriteStream, existsSync, copyFileSync, cpSync, rmSync } from "fs"
import { request as httpRequest } from "http"
import { homedir } from "os"
import { dirname, join } from "path"
import type { Config } from "./schemas.js"
import type { Paths } from "./paths.js"

// ---------------------------------------------------------------------------
// Generated config: the driver's serve instance loads ONLY this — our gate
// plugin, our bridge MCP, the two model providers. v1's global watchdog and
// bridge never see v2 sessions.

export const writeOpencodeConfig = (config: Config, paths: Paths, pluginPath: string): string => {
  // D5: a missing plugin file would mean an UNGATED executor — opencode skips
  // absent plugins without a sound. Refuse to start instead.
  if (!existsSync(pluginPath)) {
    throw new Error(`gate plugin not found at ${pluginPath} — refusing to run an ungated executor`)
  }
  const oc = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pluginPath],
    // The isolated XDG home cuts off the global AGENTS.md as a side effect, so
    // doctrine is re-attached explicitly: Max's house doctrine for both models.
    // One source of truth — Max edits the global file, runs inherit it.
    instructions: [join(homedir(), ".config", "opencode", "skills", "meridian", "SKILL_SMALL.md")],
    compaction: { auto: false }, // rotation replaces compaction (D2); never summarize
    // Unattended serve must never stall on a permission ask; the gate plugin
    // enforces the actual rules (§10) and denies what must be denied.
    // external_directory: DENY. The run sandbox is a self-rooted clone (real .git
    // dir, see createRunSandbox), so opencode roots ON the sandbox and every legit
    // read/write is internal. Anything resolving OUTSIDE the sandbox is the
    // wrong-tree escape we just killed — denying it makes a regression a hard,
    // visible failure instead of a silent main-repo read. (Was `allow`, which
    // waved through Daddy reading the SOURCE tree via the old worktree linkage.)
    permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "deny" },
    // ask_planner holds its MCP call open while Daddy thinks. Raised to 1h to
    // match daddy.timeoutMs, so the MCP layer never abandons a slow GLM consult
    // before the daddy timeout itself would — both ceilings are now 1h.
    experimental: { mcp_timeout: 3_600_000 },
    model: `${config.baby.providerId}/${config.baby.modelId}`,
    provider: {
      [config.baby.providerId]: {
        npm: "@ai-sdk/openai-compatible",
        name: "Baby inference",
        options: {
          baseURL: config.baby.baseUrl,
          apiKey: config.baby.apiKey,
          timeout: config.baby.timeoutMs,
          chunkTimeout: 600_000,
        },
        models: {
          [config.baby.modelId]: {
            name: config.baby.modelId,
            limit: { context: config.baby.contextWindow, output: 16_384 },
            // Forwarded into oMLX's ChatCompletionRequest body (grounded in its
            // OpenAPI schema). On reaching it the server forces `</think>` and
            // Baby answers — see config.baby.thinkingBudget. Omitted when null.
            ...(config.baby.thinkingBudget !== null
              ? { options: { thinking_budget: config.baby.thinkingBudget } }
              : {}),
          },
        },
      },
      // Daddy's provider (zai-coding-plan by default) is NOT declared here:
      // it resolves through opencode's provider registry + global auth
      // (~/.local/share/opencode/auth.json), same as v1.
      //
      // Super-daddy's provider (openai by default) ALSO resolves via global auth.
      // Pin its baseURL to the Codex backend — the endpoint a direct curl with
      // this ChatGPT-OAuth token answers in ~0.5s even on a 100K-char prompt.
      // Credentials/headers still come from opencode's openai-oauth handling;
      // only the host is fixed. Guarded so it never clobbers Baby's full provider
      // declaration when the two share a providerId.
      ...(config.superdaddy.providerId !== config.baby.providerId
        ? {
            [config.superdaddy.providerId]: {
              options: {
                baseURL: config.superdaddy.baseUrl,
                headerTimeout: config.superdaddy.headerTimeoutMs,
                // Present only for a local proxy provider (e.g. claude-max-proxy);
                // openai/codex omits it and uses opencode's ChatGPT-OAuth instead.
                ...(config.superdaddy.apiKey ? { apiKey: config.superdaddy.apiKey } : {}),
              },
            },
          }
        : {}),
    },
    mcp: {
      "meridian-bridge": {
        type: "remote",
        url: `http://127.0.0.1:${config.opencode.bridgePort}/mcp`,
      },
    },
    // Custom agents so neither model inherits a stock agent's full toolbox.
    // Daddy: read-only inspection, and NO bridge tools — the planner must
    // never answer itself through its own MCP (learned live: the stock plan
    // agent gave GLM the merged global config's toy box and it spiralled for
    // 10+ minutes on one ask_planner). Baby: build tools minus subagents
    // (defense in depth alongside the gate plugin's hard catch).
    agent: {
      daddy: {
        description: "Meridian planner — decides, never implements",
        mode: "primary",
        // Forces a text answer after N recon iterations — bounds verdict spirals.
        steps: config.daddy.turnSteps,
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
        description: "Meridian executor — implements the packet",
        mode: "primary",
        // Turns end after ≤N tool-rounds, returning control to the driver at
        // bounded intervals — rotation and gate evaluation cannot be starved
        // by one marathon turn (learned live: a 30-minute single turn hit the
        // transport timeout and cost a reconciliation).
        steps: config.baby.turnSteps,
        tools: { task: false },
      },
      // Super-daddy: the convergence reviewer (SUPER-DADDY §4). Unlike daddy it
      // MUST execute — bash is ENABLED so it runs the packet's verification plus
      // its own build/typecheck/test; a failing command is its only path to a
      // grounded blocker (§5). Still NO write/edit/patch (it reviews, never fixes)
      // and NO bridge tools (it must never answer itself, same rule as daddy).
      superdaddy: {
        description: "Meridian convergence reviewer — judges delivered work against the packet and doctrine; executes verification, never edits",
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
  }
  mkdirSync(dirname(paths.opencodeConfigFile), { recursive: true })
  writeFileSync(paths.opencodeConfigFile, JSON.stringify(oc, null, 2), "utf-8")

  // OpenCode auto-installs @opencode-ai/plugin into its config home before
  // loading ANY plugin, and a bare dir makes that install fail against its
  // pinned registry snapshot — after which plugins are silently skipped
  // (found live: an unanswered permission ask froze a run for 25 minutes
  // because the gate plugin never loaded). Seed from the global config dir,
  // which has a working install.
  const configHome = dirname(paths.opencodeConfigFile)
  const globalDir = join(homedir(), ".config", "opencode")
  if (!existsSync(join(configHome, "node_modules", "@opencode-ai", "plugin"))) {
    if (!existsSync(join(globalDir, "node_modules", "@opencode-ai", "plugin"))) {
      throw new Error(
        `cannot seed ${configHome}: ${globalDir}/node_modules/@opencode-ai/plugin missing — run npm install in ${globalDir} first (an unseeded config home means the gate plugin silently fails to load)`,
      )
    }
    // A REAL copy of the package.json/lockfile/node_modules trio — a symlink
    // gets deleted by opencode's background installer before it fails against
    // its pinned registry (found live, twice). With a consistent trio present
    // the failure stays a harmless WARN, same as the global dir.
    rmSync(join(configHome, "node_modules"), { recursive: true, force: true })
    cpSync(join(globalDir, "node_modules"), join(configHome, "node_modules"), { recursive: true })
    copyFileSync(join(globalDir, "package.json"), join(configHome, "package.json"))
    if (existsSync(join(globalDir, "package-lock.json"))) {
      copyFileSync(join(globalDir, "package-lock.json"), join(configHome, "package-lock.json"))
    }
  }
  return paths.opencodeConfigFile
}

// ---------------------------------------------------------------------------
// Server supervision

export const spawnOpencodeServer = (config: Config, paths: Paths): ChildProcess => {
  const child = spawn(
    config.opencode.binary,
    ["serve", "--hostname", "127.0.0.1", "--port", String(config.opencode.port), "--print-logs"],
    {
      env: {
        ...process.env,
        // Isolated config home: opencode MERGES every config location it
        // finds, so pointing XDG_CONFIG_HOME at our own dir is the only way
        // to keep the global ~/.config/opencode (v1 watchdog, v1 bridge,
        // extra MCPs) out of the serve instance. Auth stays global via
        // XDG_DATA_HOME, untouched.
        XDG_CONFIG_HOME: paths.xdgConfigHome,
        OPENCODE_CONFIG: paths.opencodeConfigFile,
      },
      stdio: ["ignore", "ignore", "pipe"],
    },
  )
  // Serve logs are the first place to look when a provider hangs instead of
  // erroring (learned the hard way on build day).
  const logFile = createWriteStream(paths.serveLogFile, { flags: "a" })
  child.stderr?.pipe(logFile)
  return child
}

// §18: the opencode version is pinned by expectation, not hope — a silent
// upgrade changes plugin hooks, session APIs, and event shapes under us.
export const warnOnVersionDrift = (config: Config): void => {
  if (!config.opencode.expectedVersion) return
  try {
    const version = execSync(`${config.opencode.binary} --version`, { encoding: "utf-8" }).trim()
    if (!version.includes(config.opencode.expectedVersion)) {
      console.error(
        `WARNING: opencode is ${version}, expected ${config.opencode.expectedVersion} — harness behavior is only proven against the pinned version`,
      )
    }
  } catch {
    /* version probe is advisory */
  }
}

export const waitForServer = async (config: Config, timeoutMs = 30_000): Promise<void> => {
  const url = `http://127.0.0.1:${config.opencode.port}/session`
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`opencode server did not become ready on port ${config.opencode.port} within ${timeoutMs}ms`)
}

// ---------------------------------------------------------------------------
// HTTP client

export type MessagePart = {
  type: string
  text?: string
  tool?: string
  callID?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    metadata?: Record<string, unknown>
  }
}

export type MessageInfo = {
  id: string
  sessionID: string
  role?: string
  providerID?: string
  modelID?: string
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  cost?: number
  // opencode attaches a provider/transport failure to the assistant message's
  // `error` and STILL returns HTTP 200 with empty parts — so the POST resolves
  // "successfully" and the failed turn is indistinguishable from the model
  // choosing to stay silent (confirmed live: a 400 "model not supported" turn
  // carries info.error and zero parts). Modelled so callers can surface the real
  // reason. data.message is the upstream message, statusCode the HTTP status,
  // responseBody the raw provider body.
  error?: {
    name?: string
    data?: { message?: string; statusCode?: number; responseBody?: string }
  }
}

export type TurnResponse = { info: MessageInfo; parts: MessagePart[] }

const parseStreamingBody = (body: string): TurnResponse => {
  // Carried from v1: SSE / NDJSON bodies carry data: lines or bare JSON lines;
  // the complete message (info + parts) is among the payloads.
  const payloads: unknown[] = []
  for (const line of body.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === "[DONE]") continue
    const data = trimmed.startsWith("data: ") ? trimmed.slice(6).trim() : trimmed
    if (data === "[DONE]") continue
    try {
      payloads.push(JSON.parse(data))
    } catch {
      /* skip unparseable */
    }
  }
  const complete = payloads.find(
    (p): p is TurnResponse =>
      typeof p === "object" && p !== null && "info" in p && "parts" in p,
  )
  if (!complete) throw new Error("streaming response contained no complete message payload")
  return complete
}

export type OpencodeClient = {
  createSession: (title: string, directory: string) => Promise<string>
  sendMessage: (
    sessionId: string,
    text: string,
    model: { providerId: string; modelId: string; agent: string },
    timeoutMs: number,
    // When the caller is a bridge tool handler, its MCP abort signal: if the
    // executor abandons the call (turn rotated/ended), the request is destroyed
    // at once instead of squatting its resources until timeoutMs. Optional —
    // Baby turns pass none and behave exactly as before.
    signal?: AbortSignal,
  ) => Promise<TurnResponse>
  listMessages: (sessionId: string) => Promise<TurnResponse[]>
  deleteSession: (sessionId: string) => Promise<void>
}

export const createOpencodeClient = (config: Config): OpencodeClient => {
  const base = `http://127.0.0.1:${config.opencode.port}`

  // Sessions are scoped to a directory via the query param (proven live):
  // Baby and Daddy both live in the run's worktree, so file access inside it
  // is internal and the repo never trips external-directory permission asks.
  const createSession = async (title: string, directory: string): Promise<string> => {
    const res = await fetch(`${base}/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    })
    if (!res.ok) throw new Error(`session create failed: ${res.status} ${await res.text()}`)
    const data = (await res.json()) as { id?: string }
    if (!data.id) throw new Error(`session create returned no id: ${JSON.stringify(data)}`)
    return data.id
  }

  // node:http, not fetch: a turn's response can take as long as the model
  // takes (30-min default for a local 35B). undici's fetch kills any request
  // whose headers/body stall past ~300s — learned live when every Baby turn
  // longer than 5 minutes died with "fetch failed". The only timeout here is
  // ours.
  const sendMessage: OpencodeClient["sendMessage"] = (sessionId, text, model, timeoutMs, signal) =>
    new Promise<TurnResponse>((resolve, reject) => {
      const payload = JSON.stringify({
        model: { providerID: model.providerId, modelID: model.modelId },
        agent: model.agent,
        parts: [{ type: "text", text }],
      })
      const req = httpRequest(
        `${base}/session/${sessionId}/message`,
        { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } },
        (res) => {
          const chunks: Buffer[] = []
          res.on("data", (c: Buffer) => chunks.push(c))
          res.on("end", () => {
            cleanup()
            const body = Buffer.concat(chunks).toString("utf-8")
            if ((res.statusCode ?? 500) >= 400) {
              reject(new Error(`message send failed: ${res.statusCode} ${body.slice(0, 500)}`))
              return
            }
            try {
              const contentType = res.headers["content-type"] ?? ""
              if (contentType.includes("application/json") || contentType.includes("text/plain")) {
                resolve(JSON.parse(body) as TurnResponse)
              } else {
                resolve(parseStreamingBody(body))
              }
            } catch (err) {
              reject(err instanceof Error ? err : new Error(String(err)))
            }
          })
          res.on("error", (err) => {
            cleanup()
            reject(err)
          })
        },
      )
      // Two ways the request settles early: our own deadline, or the caller
      // aborting (MCP request cancelled). Both destroy the socket, which surfaces
      // as a req 'error' → reject, which the caller's catch then handles.
      const timer = setTimeout(() => req.destroy(new Error(`turn exceeded ${timeoutMs}ms`)), timeoutMs)
      const onAbort = (): void => {
        req.destroy(new Error("request cancelled by caller (abandoned)"))
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
      }
      req.on("error", (err) => {
        cleanup()
        reject(err)
      })
      if (signal?.aborted === true) {
        req.destroy(new Error("request cancelled by caller (abandoned)"))
      } else {
        signal?.addEventListener("abort", onAbort, { once: true })
      }
      req.end(payload)
    })

  const listMessages = async (sessionId: string): Promise<TurnResponse[]> => {
    const res = await fetch(`${base}/session/${sessionId}/message`)
    if (!res.ok) throw new Error(`message list failed: ${res.status} ${await res.text()}`)
    return (await res.json()) as TurnResponse[]
  }

  const deleteSession = async (sessionId: string): Promise<void> => {
    await fetch(`${base}/session/${sessionId}`, { method: "DELETE" })
  }

  return { createSession, sendMessage, listMessages, deleteSession }
}

// Subscribe to the serve instance's global SSE event feed — the same stream
// the opencode TUI renders from. Used by `meridian tail` for live token-level
// output; the driver itself never depends on it (turns are awaited POSTs).
export type OpencodeEvent = { type: string; properties?: Record<string, unknown> }

export const subscribeEvents = (
  config: Config,
  directory: string,
  onEvent: (event: OpencodeEvent) => void,
): { close: () => void } => {
  // The feed is per-instance, scoped by directory exactly like sessions —
  // an unscoped subscription sees only its own server.connected handshake.
  const url = `http://127.0.0.1:${config.opencode.port}/event?directory=${encodeURIComponent(directory)}`
  const req = httpRequest(url, { method: "GET" }, (res) => {
    let buffer = ""
    res.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8")
      let idx: number
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith("data:")) continue
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as OpencodeEvent)
        } catch {
          /* partial or non-JSON frame — skip */
        }
      }
    })
  })
  req.on("error", () => {
    /* server gone — tail falls back to journal-only */
  })
  req.end()
  return { close: () => req.destroy() }
}

// A one-line, self-diagnosing rendering of a turn's provider error (MessageInfo
// .error), or null when the turn carried none. This is the whole difference
// between "APIError (HTTP 400): … model is not supported …" and an opaque empty
// turn that gets mistaken for an unparseable verdict.
export const messageError = (info: MessageInfo): string | null => {
  const e = info.error
  if (!e) return null
  const status = typeof e.data?.statusCode === "number" ? ` (HTTP ${e.data.statusCode})` : ""
  const detail = e.data?.message ?? e.name ?? "unknown provider error"
  return `${e.name ?? "provider error"}${status}: ${detail}`
}

export const extractText = (response: TurnResponse): string =>
  response.parts
    .filter((p) => p.type === "text" && p.text)
    .map((p) => p.text)
    .join("\n")

export const extractReasoning = (response: TurnResponse): string =>
  response.parts
    .filter((p) => p.type === "reasoning" && p.text)
    .map((p) => p.text)
    .join("\n")

export const gateDeniedPart = (part: MessagePart): boolean =>
  part.type === "tool" &&
  part.state?.status === "error" &&
  `${part.state.output ?? ""}${part.state.error ?? ""}`.includes("MERIDIAN GATE")

export const pluginPath = (): string => {
  // The plugin ships with this repo; the generated opencode config points at
  // it. This file compiles to dist/opencode.js, so the repo root is ONE level
  // up. (Two levels — the original bug — pointed outside the repo, and
  // opencode SILENTLY skips missing plugins: every early run executed with no
  // gate plugin at all. Hence the existence check in writeOpencodeConfig.)
  const here = dirname(new URL(import.meta.url).pathname)
  return join(here, "..", "plugin", "gate-plugin.ts")
}
