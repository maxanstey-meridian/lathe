export type FieldType =
  | "text"
  | "number"
  | "select"
  | "boolean"
  | "json"
  | "masked";

export type FieldDef =
  | { name: string; label: string; section: string; type: "text" | "number" | "select" | "boolean" | "masked"; description: string; keyPath?: string; options?: { label: string; value: string | boolean | number | null | undefined }[] }
  | { name: string; label: string; section: string; type: "json"; description: string; keyPath?: string };

export const settingsFields: FieldDef[] = [
  // ── State ──
  { name: "stateRoot", label: "State Root", section: "State", type: "text", description: "Root directory for all Lathe state — runs, DB, config.json, packets. Default: ~/.meridian/v3" },

  // ── OpenCode ──
  { name: "opencode.binary", label: "Binary", section: "OpenCode", type: "text", description: "Path or name of the opencode binary used to spawn executor sessions. Default: opencode" },
  { name: "opencode.port", label: "Port", section: "OpenCode", type: "number", description: "Port for opencode's main HTTP server (per-session, incremented from this base). Default: 4196" },
  { name: "opencode.bridgePort", label: "Bridge Port", section: "OpenCode", type: "number", description: "Port for opencode's bridge/MCP server (per-session, incremented from this base). Default: 4197" },
  { name: "opencode.expectedVersion", label: "Expected Version", section: "OpenCode", type: "text", description: "Minimum opencode version expected. A mismatch logs a warning but does not block. Default: 1.17" },

  // ── Daddy ──
  { name: "daddy.providerId", label: "Provider ID", section: "Daddy", type: "text", description: "Provider for the Daddy model (planner + final reviewer). Resolves through opencode's global auth, not an API key. Default: zai-coding-plan" },
  { name: "daddy.modelId", label: "Model ID", section: "Daddy", type: "text", description: "Model used for Daddy. Default: glm-5.1" },
  { name: "daddy.agent", label: "Agent", section: "Daddy", type: "text", description: "Agent name passed to opencode for Daddy sessions. Default: daddy" },
  { name: "daddy.timeoutMs", label: "Timeout (ms)", section: "Daddy", type: "number", description: "Per-turn timeout for Daddy. Default: 300000 (5 min)" },

  // ── Baby ──
  { name: "baby.providerId", label: "Provider ID", section: "Baby", type: "text", description: "Provider for the Baby executor model. Default: omlx" },
  { name: "baby.modelId", label: "Model ID", section: "Baby", type: "text", description: "Model used for Baby. Default: Qwen3.6-35B-A3B-UD-MLX-4bit" },
  { name: "baby.baseUrl", label: "Base URL", section: "Baby", type: "text", description: "API endpoint for Baby's provider. Default: http://maxs-mac-studio.local:8000/v1" },
  { name: "baby.apiKey", label: "API Key", section: "Baby", type: "masked", description: "API key for Baby's provider. Stored in config.json — masked here to avoid leaking secrets in the browser." },
  { name: "baby.agent", label: "Agent", section: "Baby", type: "text", description: "Agent name passed to opencode for Baby sessions. Default: baby" },
  { name: "baby.contextWindow", label: "Context Window", section: "Baby", type: "number", description: "Context window in tokens for Baby. Rotation triggers at rotationFraction of this. Default: 114688" },
  { name: "baby.timeoutMs", label: "Timeout (ms)", section: "Baby", type: "number", description: "Per-turn timeout for Baby. Default: 1800000 (30 min)" },
  { name: "baby.turnSteps", label: "Turn Steps", section: "Baby", type: "number", description: "Max tool calls per Baby turn before a forced checkpoint. Default: 30" },
  { name: "baby.thinkingMode", label: "Thinking Mode", section: "Baby", type: "select", description: "budget: caps reasoning tokens per turn at thinkingBudget. disabled: turns off reasoning entirely, every token goes to the answer. Default: budget", options: [
    { label: "Budget", value: "budget" },
    { label: "Disabled", value: "disabled" },
  ]},
  { name: "baby.thinkingBudget", label: "Thinking Budget", section: "Baby", type: "number", description: "Max reasoning tokens per turn when mode is budget. On hitting it, the server forces </think> and Baby answers from reasoning so far. Default: 6000" },
  { name: "baby.promoteTo.providerId", label: "Promote To Provider", section: "Baby", type: "text", description: "Provider to promote Baby's inference to at the convergence/rejection cap. Optional — when unset, promotion tracks Daddy's model automatically." },
  { name: "baby.promoteTo.modelId", label: "Promote To Model", section: "Baby", type: "text", description: "Model to promote Baby's inference to at the cap. Only used when promote-to is enabled. The agent stays 'baby'; only the inference changes." },

  // ── SuperDaddy ──
  { name: "superdaddy.providerId", label: "Provider ID", section: "SuperDaddy", type: "text", description: "Provider for the SuperDaddy convergence reviewer. Default: openai" },
  { name: "superdaddy.modelId", label: "Model ID", section: "SuperDaddy", type: "text", description: "Model used for SuperDaddy verification passes. Default: gpt-5.5" },
  { name: "superdaddy.agent", label: "Agent", section: "SuperDaddy", type: "text", description: "Agent name passed to opencode for SuperDaddy sessions. Default: superdaddy" },
  { name: "superdaddy.timeoutMs", label: "Timeout (ms)", section: "SuperDaddy", type: "number", description: "Per-turn timeout for SuperDaddy. Default: 1800000 (30 min)" },
  { name: "superdaddy.baseUrl", label: "Base URL", section: "SuperDaddy", type: "text", description: "API host for the reviewer provider. Only used when the provider differs from Baby's. Default: https://chatgpt.com/backend-api/codex" },
  { name: "superdaddy.headerTimeoutMs", label: "Header Timeout (ms)", section: "SuperDaddy", type: "number", description: "opencode's ProviderHeaderTimeout window. Set to false (in config.json) to disable the timer for diagnosis. Default: 3600000 (1h)" },
  { name: "superdaddy.apiKey", label: "API Key", section: "SuperDaddy", type: "masked", description: "Dummy key for a local proxy provider (e.g. claude-max-proxy). Left undefined for openai/codex which uses ChatGPT OAuth. Stored in config.json — masked here to avoid leaking secrets in the browser." },
  { name: "superdaddy.turnSteps", label: "Turn Steps", section: "SuperDaddy", type: "number", description: "Max steps per SuperDaddy turn — must run every verification command, inspect the tree, and emit a verdict. Default: 40" },
  { name: "superdaddy.skillPath", label: "Skill Path", section: "SuperDaddy", type: "text", description: "Path to the Meridian skill (judgement rubric). Read fresh each convergence pass. Default: ~/.config/opencode/skills/meridian/SKILL.md" },
  { name: "superdaddy.packetSkillPath", label: "Packet Skill Path", section: "SuperDaddy", type: "text", description: "Path to the packet-authoring skill for follow-up packets (request_changes → repair). Read fresh each authoring turn. Default: ~/.config/opencode/skills/packet/SKILL.md" },
  { name: "superdaddy.diffCapBytes", label: "Diff Cap (bytes)", section: "SuperDaddy", type: "number", description: "Max diff bytes included inline for SuperDaddy review. SuperDaddy has a large window so gets more of the diff than Daddy. Default: 131072 (128KB)" },
  { name: "superdaddy.transportRetries", label: "Transport Retries", section: "SuperDaddy", type: "number", description: "Immediate retries on transient transport drops (socket hang up, 5xx, reset) before returning an unreachable outcome. Fatal errors (auth/400) are never retried. Default: 2" },

  // ── Thresholds ──
  { name: "thresholds.rotationFraction", label: "Rotation Fraction", section: "Thresholds", type: "number", description: "Fraction of Baby's context window at which context is rotated (fresh session with summary). Default: 0.65" },
  { name: "thresholds.ladderParkAt", label: "Ladder Park At", section: "Thresholds", type: "number", description: "Consecutive dead turns (no tool call, no diff) before a run is parked as wedged. Backstop, not a checkpoint cadence. Default: 10" },
  { name: "thresholds.ladderRotateAt", label: "Ladder Rotate At", section: "Thresholds", type: "number", description: "Dead turns before a no-progress rotation — the session is replaced rather than nudged. Must be >= 1 and < ladderParkAt. Default: 4" },
  { name: "thresholds.checkpointNudgeMs", label: "Checkpoint Nudge (ms)", section: "Thresholds", type: "number", description: "Milliseconds since last planner check-in before a soft 'consider ask_planner' nudge is prepended. Non-blocking, never latches. Default: 1200000 (20 min)" },
  { name: "thresholds.checkpointToolCalls", label: "Checkpoint Tool Calls", section: "Thresholds", type: "number", description: "Tool calls since last planner check-in before a volume-based nudge is appended to every tool result. Non-blocking. Default: 50" },
  { name: "thresholds.checkpointFiles", label: "Checkpoint Files", section: "Thresholds", type: "number", description: "Files changed since last check-in before a volume nudge fires. Default: 6" },
  { name: "thresholds.checkpointLoc", label: "Checkpoint Loc", section: "Thresholds", type: "number", description: "Lines of diff since last check-in before a volume nudge fires. Default: 80" },
  { name: "thresholds.reportRejectionParkAt", label: "Report Rejection Park At", section: "Thresholds", type: "number", description: "Times Daddy rejects Baby's report before model promotion or run failure. Default: 3" },
  { name: "thresholds.checkpointBounceLimit", label: "Checkpoint Bounce Limit", section: "Thresholds", type: "number", description: "Max planner check-in bounces per turn (prevents ask_planner loops). Default: 1" },
  { name: "thresholds.verificationTimeoutMs", label: "Verification Timeout (ms)", section: "Thresholds", type: "number", description: "Timeout for a SuperDaddy verification pass. Default: 600000 (10 min)" },
  { name: "thresholds.maxPasses", label: "Max Passes", section: "Thresholds", type: "number", description: "Max convergence passes before a stalled campaign is forced to escalate to Max. Default: 3" },
  { name: "thresholds.maxReviewerUnreachable", label: "Max Reviewer Unreachable", section: "Thresholds", type: "number", description: "Consecutive transport-dropped SuperDaddy attempts before parking as 'Codex durably down'. Distinct from maxPasses (which counts real verdicts). Default: 3" },
  { name: "thresholds.promoteAtCap", label: "Promote At Cap", section: "Thresholds", type: "boolean", description: "When true, swap Baby's model to promoteTo at the rejection cap for one more set of retries. false disables the swap — Baby fails at the cap. Default: true" },
  { name: "thresholds.maxStallRetries", label: "Max Stall Retries", section: "Thresholds", type: "number", description: "Automatic requeues after a stall before a wedged run escalates to Max. Default: 2" },
  { name: "thresholds.maxCrashRetries", label: "Max Crash Retries", section: "Thresholds", type: "number", description: "Automatic requeues (front of line) after a crash before escalating to Max. Transient crashes retry; deterministic crashes park. Default: 2" },
  { name: "thresholds.maxReorientRetries", label: "Max Reorient Retries", section: "Thresholds", type: "number", description: "Max consecutive hallucination reorients before the driver stops rotating and parks for Max. 0 disables reorient. Default: 2" },
  { name: "thresholds.maxRunMs", label: "Max Run (ms)", section: "Thresholds", type: "number", description: "Wall-clock backstop per attempt — catches livelock that the per-turn ladder can't (productive-looking turns that never converge). Default: 21600000 (6h)" },
  { name: "thresholds.contextTokensFloor", label: "Context Tokens Floor", section: "Thresholds", type: "number", description: "Minimum tokens for a turn to not be treated as a dead landing (model received essentially no prompt). First turn is exempt. Default: 128" },

  // ── Misc ──
  { name: "idleTimeoutMs", label: "Idle Timeout (ms)", section: "Misc", type: "number", description: "Inactivity timer for sendMessage — destroys the request after this many ms of silence (no data chunks). Set to false in config.json to disable. Default: 120000 (2 min)" },

  // ── Concurrency ──
  { name: "concurrency.maxWorkers", label: "Max Workers", section: "Concurrency", type: "number", description: "Maximum parallel runs. 1 = sequential (one run at a time). Default: 1" },

  // ── Daemon ──
  { name: "daemon.host", label: "Host", section: "Daemon", type: "text", description: "Bind host for the Lathe daemon HTTP server. Default: 127.0.0.1" },
  { name: "daemon.port", label: "Port", section: "Daemon", type: "number", description: "Bind port for the Lathe daemon HTTP server. Default: 4198" },

  // ── Mutation Command Patterns ──
  { name: "mutationCommandPatterns", label: "Mutation Command Patterns", section: "Mutation Command Patterns", type: "text", description: "Regex patterns that flag commands as mutations (triggering invalidation). Commands matching these are treated as write operations. Default: [pnpm/npm/yarn generate, task contracts, dotnet-rivet]" },

  // ── Repos ──
  { name: "repos", label: "Repos (JSON)", section: "Repos", type: "json", description: "Per-repo seed configuration. Each repo key maps to a seed object with copies (files to copy into the worktree) and writes (files to write with content)." },
];

export const sectionNames = [...new Set(settingsFields.filter((field) => field.name !== "mutationCommandPatterns" && field.name !== "repos").map((field) => field.section))];

export const excludedFieldNames = new Set(["mutationCommandPatterns", "repos"]);
