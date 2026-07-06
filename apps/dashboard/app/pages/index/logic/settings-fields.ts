export type FieldType =
  | "text"
  | "number"
  | "select"
  | "boolean"
  | "json"
  | "masked";

export type FieldDef =
  | { name: string; label: string; section: string; type: "text" | "number" | "select" | "boolean" | "masked"; keyPath?: string; options?: { label: string; value: string | boolean | number | null | undefined }[] }
  | { name: string; label: string; section: string; type: "json"; keyPath?: string };

export const settingsFields: FieldDef[] = [
  // ── State ──
  { name: "stateRoot", label: "State Root", section: "State", type: "text" },

  // ── OpenCode ──
  { name: "opencode.binary", label: "Binary", section: "OpenCode", type: "text" },
  { name: "opencode.port", label: "Port", section: "OpenCode", type: "number" },
  { name: "opencode.bridgePort", label: "Bridge Port", section: "OpenCode", type: "number" },
  { name: "opencode.expectedVersion", label: "Expected Version", section: "OpenCode", type: "text" },

  // ── Daddy ──
  { name: "daddy.providerId", label: "Provider ID", section: "Daddy", type: "text" },
  { name: "daddy.modelId", label: "Model ID", section: "Daddy", type: "text" },
  { name: "daddy.agent", label: "Agent", section: "Daddy", type: "text" },
  { name: "daddy.timeoutMs", label: "Timeout (ms)", section: "Daddy", type: "number" },

  // ── Baby ──
  { name: "baby.providerId", label: "Provider ID", section: "Baby", type: "text" },
  { name: "baby.modelId", label: "Model ID", section: "Baby", type: "text" },
  { name: "baby.baseUrl", label: "Base URL", section: "Baby", type: "text" },
  { name: "baby.apiKey", label: "API Key", section: "Baby", type: "masked" },
  { name: "baby.agent", label: "Agent", section: "Baby", type: "text" },
  { name: "baby.contextWindow", label: "Context Window", section: "Baby", type: "number" },
  { name: "baby.timeoutMs", label: "Timeout (ms)", section: "Baby", type: "number" },
  { name: "baby.turnSteps", label: "Turn Steps", section: "Baby", type: "number" },
  { name: "baby.thinkingMode", label: "Thinking Mode", section: "Baby", type: "select", options: [
    { label: "Budget", value: "budget" },
    { label: "Disabled", value: "disabled" },
  ]},
  { name: "baby.thinkingBudget", label: "Thinking Budget", section: "Baby", type: "number" },
  { name: "baby.promoteTo.providerId", label: "Promote To Provider", section: "Baby", type: "text" },
  { name: "baby.promoteTo.modelId", label: "Promote To Model", section: "Baby", type: "text" },

  // ── SuperDaddy ──
  { name: "superdaddy.providerId", label: "Provider ID", section: "SuperDaddy", type: "text" },
  { name: "superdaddy.modelId", label: "Model ID", section: "SuperDaddy", type: "text" },
  { name: "superdaddy.agent", label: "Agent", section: "SuperDaddy", type: "text" },
  { name: "superdaddy.timeoutMs", label: "Timeout (ms)", section: "SuperDaddy", type: "number" },
  { name: "superdaddy.baseUrl", label: "Base URL", section: "SuperDaddy", type: "text" },
  { name: "superdaddy.headerTimeoutMs", label: "Header Timeout (ms)", section: "SuperDaddy", type: "number" },
  { name: "superdaddy.apiKey", label: "API Key", section: "SuperDaddy", type: "masked" },
  { name: "superdaddy.turnSteps", label: "Turn Steps", section: "SuperDaddy", type: "number" },
  { name: "superdaddy.skillPath", label: "Skill Path", section: "SuperDaddy", type: "text" },
  { name: "superdaddy.packetSkillPath", label: "Packet Skill Path", section: "SuperDaddy", type: "text" },
  { name: "superdaddy.diffCapBytes", label: "Diff Cap (bytes)", section: "SuperDaddy", type: "number" },
  { name: "superdaddy.transportRetries", label: "Transport Retries", section: "SuperDaddy", type: "number" },

  // ── Thresholds ──
  { name: "thresholds.rotationFraction", label: "Rotation Fraction", section: "Thresholds", type: "number" },
  { name: "thresholds.ladderParkAt", label: "Ladder Park At", section: "Thresholds", type: "number" },
  { name: "thresholds.ladderRotateAt", label: "Ladder Rotate At", section: "Thresholds", type: "number" },
  { name: "thresholds.checkpointNudgeMs", label: "Checkpoint Nudge (ms)", section: "Thresholds", type: "number" },
  { name: "thresholds.checkpointToolCalls", label: "Checkpoint Tool Calls", section: "Thresholds", type: "number" },
  { name: "thresholds.checkpointFiles", label: "Checkpoint Files", section: "Thresholds", type: "number" },
  { name: "thresholds.checkpointLoc", label: "Checkpoint Loc", section: "Thresholds", type: "number" },
  { name: "thresholds.reportRejectionParkAt", label: "Report Rejection Park At", section: "Thresholds", type: "number" },
  { name: "thresholds.checkpointBounceLimit", label: "Checkpoint Bounce Limit", section: "Thresholds", type: "number" },
  { name: "thresholds.verificationTimeoutMs", label: "Verification Timeout (ms)", section: "Thresholds", type: "number" },
  { name: "thresholds.maxPasses", label: "Max Passes", section: "Thresholds", type: "number" },
  { name: "thresholds.maxReviewerUnreachable", label: "Max Reviewer Unreachable", section: "Thresholds", type: "number" },
  { name: "thresholds.promoteAtCap", label: "Promote At Cap", section: "Thresholds", type: "boolean" },
  { name: "thresholds.maxStallRetries", label: "Max Stall Retries", section: "Thresholds", type: "number" },
  { name: "thresholds.maxCrashRetries", label: "Max Crash Retries", section: "Thresholds", type: "number" },
  { name: "thresholds.maxReorientRetries", label: "Max Reorient Retries", section: "Thresholds", type: "number" },
  { name: "thresholds.maxRunMs", label: "Max Run (ms)", section: "Thresholds", type: "number" },
  { name: "thresholds.contextTokensFloor", label: "Context Tokens Floor", section: "Thresholds", type: "number" },

  // ── Misc ──
  { name: "idleTimeoutMs", label: "Idle Timeout (ms)", section: "Misc", type: "number" },

  // ── Concurrency ──
  { name: "concurrency.maxWorkers", label: "Max Workers", section: "Concurrency", type: "number" },

  // ── Daemon ──
  { name: "daemon.host", label: "Host", section: "Daemon", type: "text" },
  { name: "daemon.port", label: "Port", section: "Daemon", type: "number" },

  // ── Mutation Command Patterns ──
  { name: "mutationCommandPatterns", label: "Mutation Command Patterns", section: "Mutation Command Patterns", type: "text" },

  // ── Repos ──
  { name: "repos", label: "Repos (JSON)", section: "Repos", type: "json" },
];

export const sectionNames = [...new Set(settingsFields.filter((field) => field.name !== "mutationCommandPatterns" && field.name !== "repos").map((field) => field.section))];

export const excludedFieldNames = new Set(["mutationCommandPatterns", "repos"]);
