// Every durable file the system reads or writes, as a Zod schema (CONTRACT D6).
// Nothing load-bearing is ever parsed out of prose; the markdown packet body is
// for the models only.

import { z } from "zod"

// ---------------------------------------------------------------------------
// Packet (CONTRACT §4)

export const OutcomeDef = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "outcome ids are kebab-case"),
  description: z.string().min(1),
})
export type OutcomeDef = z.infer<typeof OutcomeDef>

export const VerificationCommand = z.object({
  // Run by the driver at the worktree ROOT (verification.ts). No `cwd:` — a shell
  // runs the command, so a subdir need goes in the command (`cd sub && …`); the
  // dropped field's only extra power was an absolute path out of the worktree,
  // which verified the wrong tree. An old packet's stray `cwd:` is ignored (zod
  // strips unknown keys) and the command runs at the root.
  command: z.string().min(1),
})

export const PacketFrontmatter = z.object({
  repo: z.string().min(1),
  base: z.string().min(1),
  // One-line human description of what this run delivers — shown in `meridian
  // tail`'s status bar so you can see at a glance what's cooking. The /packet skill
  // (Daddy) writes it; convergence follow-ups compose it from their blockers
  // (renderFollowupPacket). Optional so hand-written/older packets still validate
  // and the tail falls back to the run slug.
  summary: z.string().optional(),
  outcomes: z.array(OutcomeDef).min(1),
  expected_surface: z.array(z.string().min(1)).min(1),
  suspicious_surface: z.array(z.string().min(1)).default([]),
  verification: z.array(VerificationCommand).min(1),
  constraints: z.array(z.string()).default([]),
  // Convergence lineage (SUPER-DADDY.md). All optional/defaulted so existing
  // hand-authored packets parse unchanged; a super-daddy follow-up sets them.
  campaign_id: z.string().optional(),
  parent_run_id: z.string().optional(),
  pass: z.number().int().min(1).default(1),
  // Outcomes delivered by prior passes, carried forward as "must still pass" so a
  // follow-up cannot silently regress earlier work (oscillation guard).
  regression_outcomes: z.array(OutcomeDef).default([]),
})
export type PacketFrontmatter = z.infer<typeof PacketFrontmatter>

export type Packet = {
  runId: string
  frontmatter: PacketFrontmatter
  body: string
  raw: string
}

// ---------------------------------------------------------------------------
// Run meta (CONTRACT §3, §5)

export const BlockedReason = z.enum([
  "human_decision",
  "scope_expansion",
  "stop_condition",
  // A harness-detected stall: ladder, rotation bounce, consecutive turn
  // failures, or the run watchdog (§5 R10). Recoverable — auto-requeued up to
  // `maxStallRetries` before escalating to Max.
  "wedged",
  // A driver-level failure: executeRun itself threw (worktree/server/IO). NOT
  // auto-retried — a systemic fault would hot-loop on the same packet (§5 R10).
  "crashed",
])
export type BlockedReason = z.infer<typeof BlockedReason>

export const RunStatus = z.enum([
  "queued",
  "running",
  "interrupted",
  "ready_for_review",
  "blocked",
  "failed",
  "accepted",
])
export type RunStatus = z.infer<typeof RunStatus>

export const RunMeta = z.object({
  runId: z.string(),
  status: RunStatus,
  attempt: z.number().int().min(1),
  repo: z.string(),
  base: z.string(),
  branch: z.string(),
  worktree: z.string(),
  // Copied from the packet at run start so `meridian tail` can show it without
  // re-parsing the packet (the run slug is the fallback when absent).
  summary: z.string().optional(),
  babySessionId: z.string().optional(),
  daddySessionId: z.string().optional(),
  blockedReason: BlockedReason.optional(),
  blockedQuestion: z.string().optional(),
  // P6: count of automatic post-stall requeues spent on this run (§5 R10).
  // Carried across resumes; reset to 0 when Max answers a park (a human looked).
  stallRetries: z.number().int().min(0).default(0),
  // Count of consecutive reorients (hallucination recoveries) spent without an
  // intervening accepted planner decision — the misfire tripwire. Reset to 0 on
  // any accepted consult (the reseeded Baby recovered); at maxReorientRetries the
  // driver stops rotating and parks for Max.
  reorientRetries: z.number().int().min(0).default(0),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  updatedAt: z.string(),
})
export type RunMeta = z.infer<typeof RunMeta>

// ---------------------------------------------------------------------------
// Outcome ledger (CONTRACT §8)

export const OutcomeStatus = z.enum(["not_started", "in_progress", "done", "blocked"])
export type OutcomeStatus = z.infer<typeof OutcomeStatus>

export const OutcomeEntry = z.object({
  id: z.string(),
  description: z.string(),
  status: OutcomeStatus,
  evidence: z.array(z.string()).default([]),
  state: z.string().optional(),
  nextAction: z.string().optional(),
  updatedAt: z.string(),
})
export type OutcomeEntry = z.infer<typeof OutcomeEntry>

export const OutcomeLedger = z.object({
  runId: z.string(),
  outcomes: z.array(OutcomeEntry),
  updatedAt: z.string(),
})
export type OutcomeLedger = z.infer<typeof OutcomeLedger>

// ---------------------------------------------------------------------------
// Planner (CONTRACT §9) — ask_repo_first is deleted in v2 (M3)

export const PlannerStatus = z.enum([
  "proceed",
  "proceed_with_constraints",
  "revise_slice",
  // Baby has drifted/hallucinated (inventing files, paths, or projects that
  // don't exist; acting on a confabulated premise) but the correct fix is clear
  // and needs no human. The driver discards Baby's session and reseeds a fresh
  // one handed the fix from safe_next_action — NOT a terminal park. Bounded by
  // maxReorientRetries, then falls through to a human_decision park.
  "reorient",
  "human_required",
  "stop",
])
export type PlannerStatus = z.infer<typeof PlannerStatus>

export const ACCEPTED_STATUSES: readonly PlannerStatus[] = [
  "proceed",
  "proceed_with_constraints",
]

export const QuestionType = z.enum([
  "repo_procedure",
  "architecture_discoverable",
  "handoff_interpretation",
  "stop_condition",
  "diff_audit",
  "reconciliation",
  "other",
])
export type QuestionType = z.infer<typeof QuestionType>

export const PlannerResponse = z.object({
  status: PlannerStatus,
  answer: z.string(),
  constraints: z.array(z.string()).default([]),
  evidence_used: z.array(z.string()).default([]),
  safe_next_action: z.string(),
  human_decision_needed: z.string().nullable().default(null),
})
export type PlannerResponse = z.infer<typeof PlannerResponse>

// The executor's ask_planner submission. The bridge captures this and hands it
// to the driver, which runs the Daddy consult OFF the MCP request path: a
// synchronous Daddy call held across the tool result is cancelled by opencode's
// MCP client at ~5min (a multi-minute consult then reads as "planner
// unavailable" and crashes the run). The driver runs it on its own 1h budget.
export type AskPlannerInput = {
  questionType: QuestionType
  currentSlice: string
  question: string
  approach: string
  evidence: string[]
}

// Final review (CONTRACT V7) — Daddy's one non-mechanical acceptance check.
// A purpose-built verdict: the mid-run slice statuses (proceed_with_constraints,
// revise_slice) don't map to a terminal judgement, so overloading them would
// muddy both.
export const FinalReviewVerdict = z.enum(["accept", "request_changes", "escalate"])
export type FinalReviewVerdict = z.infer<typeof FinalReviewVerdict>

export const FinalReview = z.object({
  verdict: FinalReviewVerdict,
  findings: z.array(z.string()).default([]),
  notes: z.string().default(""),
  human_decision_needed: z.string().nullable().default(null),
})
export type FinalReview = z.infer<typeof FinalReview>

// ---------------------------------------------------------------------------
// Super-daddy convergence supervisor (SUPER-DADDY.md). A stronger, doctrine-anchored
// review ABOVE the per-run FinalReview; it decides whether the campaign converges,
// needs another pass, or must reach Max. Reuses FinalReviewVerdict (accept →
// converged, request_changes → author follow-up, escalate → flag Max).

export const FindingSeverity = z.enum(["P0", "P1", "P2", "P3"])
export type FindingSeverity = z.infer<typeof FindingSeverity>

// The grounding rule (SUPER-DADDY §5): severity is a function of EVIDENCE, not the
// reviewer's gut. A finding is a blocker only if it cites a failing command or a
// violated doctrine/contract clause; kind "none" forces it to a taste-call nit.
export const FindingGrounding = z.object({
  kind: z.enum(["command_fail", "clause", "none"]),
  ref: z.string().default(""),
})
export type FindingGrounding = z.infer<typeof FindingGrounding>

export const Finding = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "finding ids are kebab-case"),
  severity: FindingSeverity,
  title: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  grounding: FindingGrounding,
  // Proposed outcome id if this finding becomes a follow-up outcome (kebab-case).
  suggested_outcome_id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "outcome ids are kebab-case").optional(),
})
export type Finding = z.infer<typeof Finding>

// The convergence signal (SUPER-DADDY §6). recommend_stop is what the reviewer
// PROPOSES; the authoritative decision recomputes grounded blockers from the
// findings (convergence.ts) so the model cannot escalate a vibe to P0/P1.
export const ConvergenceSignal = z.object({
  recommend_stop: z.boolean(),
  profile: z.object({ p0: z.number().int(), p1: z.number().int(), p2: z.number().int(), p3: z.number().int() }),
  rationale: z.string().default(""),
})
export type ConvergenceSignal = z.infer<typeof ConvergenceSignal>

// The commit message super-daddy authors for a converged run (R3). On accept it
// replaces the driver's throwaway `WIP <runId>` line by amending the run's single
// commit — super-daddy is the right author because it has just read the whole
// diff, the report, and run verification. subject is a conventional-commit one-
// liner (imperative, ≤72 chars); body explains what changed and why. Only
// meaningful on accept, so the field is nullable on every other verdict.
export const CommitMessage = z.object({
  subject: z.string().min(1),
  body: z.string().default(""),
})
export type CommitMessage = z.infer<typeof CommitMessage>

export const SuperReview = z.object({
  verdict: FinalReviewVerdict,
  findings: z.array(Finding).default([]),
  convergence: ConvergenceSignal,
  commit_message: CommitMessage.nullable().default(null),
  notes: z.string().default(""),
  human_decision_needed: z.string().nullable().default(null),
})
export type SuperReview = z.infer<typeof SuperReview>

// A campaign is the chain of runs converging one original intent (SUPER-DADDY §10).
export const CampaignStatus = z.enum(["open", "converged", "needs_max"])
export type CampaignStatus = z.infer<typeof CampaignStatus>

export const CampaignPass = z.object({
  runId: z.string(),
  pass: z.number().int().min(1),
  verdict: FinalReviewVerdict,
  groundedBlockers: z.number().int(),
  atIso: z.string(),
})
export type CampaignPass = z.infer<typeof CampaignPass>

export const Campaign = z.object({
  campaignId: z.string(),
  originalRunId: z.string(),
  originalIntent: z.string(),
  status: CampaignStatus,
  maxPasses: z.number().int().min(1),
  passes: z.array(CampaignPass).default([]),
  updatedAt: z.string(),
})
export type Campaign = z.infer<typeof Campaign>

export const Decision = z.object({
  timestamp: z.string(),
  source: z.enum(["daddy", "max"]),
  questionType: z.string(),
  currentSlice: z.string().optional(),
  question: z.string(),
  approach: z.string().optional(),
  evidence: z.array(z.string()).default([]),
  status: z.string(),
  answer: z.string(),
  constraints: z.array(z.string()).default([]),
  messageId: z.string().optional(),
})
export type Decision = z.infer<typeof Decision>

// ---------------------------------------------------------------------------
// Review state (CONTRACT M5 — replacement semantics)

export const ReviewState = z.object({
  runId: z.string(),
  obligations: z.array(z.string()),
  lastDecisionAt: z.string().optional(),
  updatedAt: z.string(),
})
export type ReviewState = z.infer<typeof ReviewState>

// ---------------------------------------------------------------------------
// Gate state (CONTRACT §10) — driver-written, plugin-read

export const DiffStat = z.object({ added: z.number(), removed: z.number() })

export const GateState = z.object({
  runId: z.string(),
  latched: z.boolean(),
  latchReason: z.string().optional(),
  firstEditApproved: z.boolean(),
  reconciliationRequired: z.boolean(),
  expectedGlobs: z.array(z.string()),
  suspiciousGlobs: z.array(z.string()),
  baselineDiffStats: z.record(z.string(), DiffStat),
  lastAcceptedDecisionAt: z.string().optional(),
  // Plumbed to the plugin (§10) so its allow-path checkpoint NOTICE uses the same
  // interval as the driver's per-turn nudge. Optional so gate-state written before
  // this field still validates on resume (the plugin falls back to 20 min).
  checkpointNudgeMs: z.number().int().optional(),
  // Volume-based checkpoint reminder (§10) — the work-interval cadence reborn as a
  // non-blocking SHOUT. The plugin reads these and appends the SAME message a block
  // would show (without throwing) once Baby has done this much work since its last
  // planner check-in: `checkpointToolCalls` tool calls (any tool, reads included),
  // or `checkpointFiles`/`checkpointLoc` of diff. Optional → gate-state from before
  // these fields still validates (plugin falls back to no volume reminder).
  checkpointToolCalls: z.number().int().optional(),
  checkpointFiles: z.number().int().optional(),
  checkpointLoc: z.number().int().optional(),
  mutationCommandPatterns: z.array(z.string()).default([]),
  updatedAt: z.string(),
})
export type GateState = z.infer<typeof GateState>

// ---------------------------------------------------------------------------
// Active run pointer (driver-written, plugin-read)

export const ActiveRun = z.object({
  runId: z.string(),
  runDir: z.string(),
  worktree: z.string(),
  babySessionId: z.string(),
  startedAt: z.string(),
})
export type ActiveRun = z.infer<typeof ActiveRun>

// ---------------------------------------------------------------------------
// Checkpoint (CONTRACT §8 O4)

export const CheckpointOutcome = z.object({
  id: z.string(),
  status: OutcomeStatus,
  evidence: z.array(z.string()).default([]),
  state: z.string().optional(),
  nextAction: z.string().optional(),
})

export const Checkpoint = z.object({
  number: z.number().int(),
  reason: z.string(),
  summary: z.string(),
  outcomes: z.array(CheckpointOutcome).min(1),
  filesChanged: z.array(z.object({ path: z.string(), reason: z.string().optional() })).default([]),
  filesInspected: z.array(z.object({ path: z.string(), learned: z.string().optional() })).default([]),
  uncertainties: z.array(z.string()).default([]),
  writtenAt: z.string(),
})
export type Checkpoint = z.infer<typeof Checkpoint>

// ---------------------------------------------------------------------------
// Report (CONTRACT §11, V4)

export const FileClassification = z.enum([
  "expected",
  "acceptable-but-not-predeclared",
  "suspicious",
  "forbidden",
])
export type FileClassification = z.infer<typeof FileClassification>

export const ReportFile = z.object({
  path: z.string(),
  classification: FileClassification,
  reason: z.string(),
  action: z.enum(["kept", "reverted", "split", "needs-approval"]),
})
export type ReportFile = z.infer<typeof ReportFile>

export const SubmitReport = z.object({
  status: z.enum(["ready_for_review", "blocked", "failed"]),
  blockedReason: BlockedReason.optional(),
  blockedQuestion: z.string().optional(),
  summary: z.string().min(1),
  filesChanged: z.array(ReportFile).default([]),
  behaviourChanged: z.array(z.string()).default([]),
  sourceOfTruthFollowed: z.array(z.string()).default([]),
  outcomeClaims: z.array(z.object({ id: z.string(), status: OutcomeStatus })).min(1),
  verificationClaims: z
    .array(z.object({ command: z.string(), result: z.enum(["passed", "failed", "not_run"]), notes: z.string().optional() }))
    .default([]),
  escalations: z.array(z.string()).default([]),
  remainingUncertainty: z.array(z.string()).default([]),
})
export type SubmitReport = z.infer<typeof SubmitReport>

// ---------------------------------------------------------------------------
// Journal (CONTRACT §13) — discriminated on `event`

const base = { at: z.string(), turn: z.number().int().optional() }

export const JournalEvent = z.discriminatedUnion("event", [
  z.object({ ...base, event: z.literal("run_started"), runId: z.string(), attempt: z.number().int() }),
  z.object({ ...base, event: z.literal("prompt_sent"), promptName: z.string(), preview: z.string() }),
  z.object({
    ...base,
    event: z.literal("turn_ended"),
    messageId: z.string(),
    tokens: z.object({ input: z.number(), output: z.number(), reasoning: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
    contextTokens: z.number(),
    text: z.string(),
    reasoning: z.string().optional(),
  }),
  z.object({
    ...base,
    event: z.literal("tool_call"),
    tool: z.string(),
    callId: z.string().optional(),
    command: z.string().optional(),
    target: z.string().optional(),
    status: z.enum(["completed", "error"]),
    exitCode: z.number().optional(),
    outputPreview: z.string().optional(),
    gateDenied: z.boolean().default(false),
  }),
  z.object({ ...base, event: z.literal("gate_latched"), reason: z.string() }),
  z.object({ ...base, event: z.literal("gate_cleared"), decisionAt: z.string() }),
  // The non-blocking volume reminder crossed its threshold this turn — journaled so
  // it is VISIBLE in the tail (the plugin's per-call shout to Baby is not). §10.
  z.object({ ...base, event: z.literal("checkpoint_volume_nudge"), reason: z.string(), toolCalls: z.number().int() }),
  z.object({
    ...base,
    event: z.literal("planner_exchange"),
    questionType: z.string(),
    question: z.string(),
    status: z.string(),
    answer: z.string(),
    constraints: z.array(z.string()),
    evidence_used: z.array(z.string()).default([]),
    safe_next_action: z.string().default(""),
    human_decision_needed: z.string().nullable().default(null),
  }),
  z.object({ ...base, event: z.literal("outcomes_updated"), outcomes: z.array(z.object({ id: z.string(), status: OutcomeStatus })) }),
  z.object({ ...base, event: z.literal("checkpoint_written"), number: z.number().int(), valid: z.boolean(), problems: z.array(z.string()).default([]) }),
  z.object({ ...base, event: z.literal("rotation"), phase: z.enum(["teardown_demanded", "session_replaced", "no_progress"]), contextTokens: z.number().optional(), newSessionId: z.string().optional() }),
  z.object({ ...base, event: z.literal("verification_run"), command: z.string(), exitCode: z.number() }),
  z.object({ ...base, event: z.literal("report_submitted"), status: z.string() }),
  z.object({ ...base, event: z.literal("report_rejected"), problems: z.array(z.string()) }),
  z.object({ ...base, event: z.literal("report_accepted"), status: z.string() }),
  z.object({ ...base, event: z.literal("final_review"), verdict: FinalReviewVerdict, findings: z.array(z.string()) }),
  z.object({ ...base, event: z.literal("ladder_step"), count: z.number().int() }),
  z.object({ ...base, event: z.literal("parked"), reason: BlockedReason, question: z.string().optional() }),
  z.object({ ...base, event: z.literal("committed"), sha: z.string(), message: z.string() }),
  z.object({ ...base, event: z.literal("driver_note"), note: z.string() }),
  z.object({ ...base, event: z.literal("stall_recovery"), action: z.enum(["requeue", "escalate"]), stallRetries: z.number().int() }),
  z.object({ ...base, event: z.literal("reorient"), attempt: z.number().int(), fix: z.string() }),
])
export type JournalEvent = z.infer<typeof JournalEvent>

// ---------------------------------------------------------------------------
// Config (CONTRACT §15)

export const Config = z.object({
  stateRoot: z.string().default("~/.meridian/v2"),
  opencode: z.object({
    binary: z.string().default("opencode"),
    port: z.number().int().default(4196),
    bridgePort: z.number().int().default(4197),
    expectedVersion: z.string().default("1.17"),
  }).default({}),
  daddy: z.object({
    // zai-coding-plan resolves through opencode's global auth (subscription),
    // not the pay-as-you-go glm-api key — same choice v1 made.
    providerId: z.string().default("zai-coding-plan"),
    modelId: z.string().default("glm-5.1"),
    agent: z.string().default("daddy"),
    timeoutMs: z.number().int().default(300_000),
    turnSteps: z.number().int().default(8),
  }).default({}),
  baby: z.object({
    providerId: z.string().default("omlx"),
    modelId: z.string().default("Qwen3.6-35B-A3B-UD-MLX-4bit"),
    baseUrl: z.string().default("http://maxs-mac-studio.local:8000/v1"),
    apiKey: z.string().default("api-key"),
    agent: z.string().default("baby"),
    contextWindow: z.number().int().default(98_304),
    timeoutMs: z.number().int().default(1_800_000),
    turnSteps: z.number().int().default(12),
    // Caps Baby's per-turn reasoning (oMLX `thinking_budget`, integer tokens):
    // on hitting it the server forces `</think>` and Baby answers from the
    // reasoning so far — bounds rumination spirals AND the reasoning tokens'
    // drain on the rotation budget (they count toward contextWindow). Start
    // generous and ratchet down in config.json; too low forces premature
    // answers on genuinely hard turns. null = uncapped (legacy behaviour).
    thinkingBudget: z.number().int().nullable().default(6_000),
  }).default({}),
  // Super-daddy (SUPER-DADDY §4): the convergence reviewer — the strongest frontier
  // "pseudo-Max" tier, the ONE reviewer that MUST execute (bash enabled; §4 "must
  // execute"). Default is openai/gpt-5.5-pro: it resolves through opencode's global
  // auth (NOT declared in the generated config, like daddy), it's the strongest
  // reviewer currently authed, and it mirrors Max's manual loop (today he reviews by
  // hand with GPT). Override modelId in config.json — e.g. "gpt-5.5" for a faster,
  // cheaper pass — exactly as daddy.modelId is overridden today.
  superdaddy: z.object({
    providerId: z.string().default("openai"),
    modelId: z.string().default("gpt-5.5-pro"),
    agent: z.string().default("superdaddy"),
    timeoutMs: z.number().int().default(1_800_000),
    // The reviewer provider's API host and header-timeout window, applied only
    // when the reviewer's provider differs from Baby's (see opencode.ts).
    // baseUrl pins the Codex backend; headerTimeoutMs is opencode's
    // ProviderHeaderTimeout window. Use false to disable that timer for
    // diagnosis.
    baseUrl: z.string().default("https://chatgpt.com/backend-api/codex"),
    headerTimeoutMs: z.union([z.number().int(), z.literal(false)]).default(3_600_000),
    // A dummy key for a LOCAL proxy provider (e.g. claude-max-proxy, which bridges
    // a Claude Max sub to a standard Anthropic API and ignores the key value). Set
    // it so opencode's provider authenticates with this instead of hunting for real
    // creds/global auth. Left undefined for openai/codex (which uses opencode's
    // ChatGPT-OAuth) — only spread into provider options when present.
    apiKey: z.string().optional(),
    // One turn must run every verification command, inspect the tree, and emit a
    // verdict — far more tool-rounds than daddy's bounded recon (§4 "must execute").
    turnSteps: z.number().int().default(40),
    // The judgement rubric (§4): the FULL skill, not the ambient SKILL_SMALL the
    // executors inherit. Live path (§14.4) — read fresh each pass.
    skillPath: z.string().default("~/.config/opencode/skills/meridian/SKILL.md"),
    // Opus has a large window; give it more of the diff inline than daddy's 64KB.
    diffCapBytes: z.number().int().default(131_072),
  }).default({}),
  thresholds: z.object({
    rotationFraction: z.number().default(0.65),
    // A no-progress backstop, not a checkpoint cadence: with the limit-shout now
    // non-blocking (§10), 10 consecutive DEAD turns (no tool call, no diff) is an
    // unambiguous wedge. It was 50 only to give a hard-BLOCKED Baby room to fight
    // the gate toward ask_planner — that justification is gone.
    ladderParkAt: z.number().int().default(10),
    // No-progress ROTATION (L3, §10). A Baby that has stopped calling tools and
    // is narrating in a loop is rescued by a FRESH session far more reliably than
    // by more nudges — proven live: stuck runs only ever recovered on rotation,
    // never on the Nth nudge, and a narration loop keeps context too cheap to
    // trip the context-budget rotation (§5). So every `ladderRotateAt` dead turns,
    // blow the wedged session away and reseed from durable state. Must be ≥1 and
    // < ladderParkAt so at least one rotation fires before the park backstop; the
    // ladder is NOT reset on rotation, so a Baby still narrating after it marches
    // on to ladderParkAt and parks (bounded — never a rotation livelock).
    ladderRotateAt: z.number().int().positive().default(4),
    // NON-BLOCKING checkpoint reminder (§10): how long since Baby's last planner
    // check-in before the driver starts prepending a soft "consider ask_planner"
    // nudge to its continue prompt. Once past it, the nudge fires EVERY turn until
    // Baby actually checks in (which resets the clock) — deliberately repetitive:
    // Baby is an easily-distracted child, so we keep shouting. It never latches
    // and never ends the turn — the throwing cadence reborn as a shout, not a wall.
    checkpointNudgeMs: z.number().int().default(20 * 60 * 1000),
    // VOLUME checkpoint reminder (§10) — the work-interval cadence reborn as a
    // non-blocking shout, on a count axis instead of a clock. Once Baby has made
    // `checkpointToolCalls` tool calls (any tool — the read-heavy debug spiral the
    // time/diff axes are blind to), or changed `checkpointFiles`/`checkpointLoc` of
    // diff, since its last planner check-in, the SAME message a block would show is
    // appended to every tool result until it checks in. Never blocks. Files/LoC
    // defaults carried from the old work-interval (6 / 80).
    checkpointToolCalls: z.number().int().default(50),
    checkpointFiles: z.number().int().default(6),
    checkpointLoc: z.number().int().default(80),
    reportRejectionParkAt: z.number().int().default(3),
    checkpointBounceLimit: z.number().int().default(1),
    verificationTimeoutMs: z.number().int().default(600_000),
    // Super-daddy circuit breaker (SUPER-DADDY §8): max convergence passes before
    // a stalled campaign is forced to escalate to Max.
    maxPasses: z.number().int().min(1).default(3),
    // P6 liveness (§5 R10). maxStallRetries: automatic post-stall requeues before
    // a `wedged` run escalates to Max — the bounded "try again pls" (mirrors
    // maxPasses; 0 disables auto-recovery). maxRunMs: wall-clock backstop on a
    // single attempt — the livelock watchdog the per-turn ladder can't catch
    // (productive-looking turns that never converge). Default 6h.
    maxStallRetries: z.number().int().min(0).default(2),
    // P6 sibling for hallucination recovery: max consecutive reorients (Baby
    // derailed → discard session, reseed with Daddy's fix) before the driver
    // stops rotating and parks for Max. Mirrors maxStallRetries' bounded
    // "try again pls"; 0 disables reorient (a derail then parks immediately).
    maxReorientRetries: z.number().int().min(0).default(2),
    maxRunMs: z.number().int().default(6 * 60 * 60 * 1000),
  }).default({}),
  mutationCommandPatterns: z.array(z.string()).default([
    "\\b(pnpm|npm|yarn)\\b.*\\bgenerate\\b",
    "task contracts",
    "dotnet-rivet",
  ]),
})
export type Config = z.infer<typeof Config>
