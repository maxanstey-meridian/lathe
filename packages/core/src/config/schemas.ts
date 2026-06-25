import { z } from "zod";

// ---------------------------------------------------------------------------
// Config (CONTRACT §14)
// Full field set with every default. This schema owns the config shape.

export const Config = z.object({
  stateRoot: z.string().default("~/.meridian/v3"),
  opencode: z
    .object({
      binary: z.string().default("opencode"),
      port: z.number().int().default(4196),
      bridgePort: z.number().int().default(4197),
      expectedVersion: z.string().default("1.17"),
    })
    .default({}),
  daddy: z
    .object({
      // zai-coding-plan resolves through opencode's global auth (subscription),
      // not the pay-as-you-go glm-api key — same choice v1 made.
      providerId: z.string().default("zai-coding-plan"),
      modelId: z.string().default("glm-5.1"),
      agent: z.string().default("daddy"),
      timeoutMs: z.number().int().default(300_000),
    })
    .default({}),
  baby: z
    .object({
      providerId: z.string().default("omlx"),
      modelId: z.string().default("Qwen3.6-35B-A3B-UD-MLX-4bit"),
      baseUrl: z.string().default("http://maxs-mac-studio.local:8000/v1"),
      apiKey: z.string().default("api-key"),
      agent: z.string().default("baby"),
      contextWindow: z.number().int().default(114_688),
      timeoutMs: z.number().int().default(1_800_000),
      turnSteps: z.number().int().default(30),
      // Caps executor per-turn reasoning (oMLX `thinking_budget`, integer tokens):
      // on hitting it the server forces `</think>` and Baby answers from the
      // reasoning so far — bounds rumination spirals AND the reasoning tokens'
      // drain on the rotation budget (they count toward contextWindow). Start
      // generous and ratchet down in config.json; too low forces premature
      // answers on genuinely hard turns. null = uncapped (legacy behaviour).
      thinkingBudget: z.number().int().nullable().default(6_000),
      // The model the executor is promoted to when daddy's final review rejects its
      // report reportRejectionParkAt times — "one more try on a bigger model".
      // Defaults to daddy's provider/model (GLM). The agent stays "baby"; only
      // inference changes. Ephemeral: the promotion
      // lasts only for the rest of THIS run's turn loop; the next run resets to
      // baby's normal model.
      promoteTo: z
        .object({
          providerId: z.string().default("zai-coding-plan"),
          modelId: z.string().default("glm-5.1"),
        })
        .default({}),
    })
    .default({}),
  // Super-daddy: the convergence reviewer. It must execute (bash enabled). Default is
  // openai/gpt-5.5: it resolves through opencode's global auth (NOT
  // declared in the generated config, like daddy). Override modelId in config.json
  // for a heavier pass.
  superdaddy: z
    .object({
      providerId: z.string().default("openai"),
      modelId: z.string().default("gpt-5.5"),
      agent: z.string().default("superdaddy"),
      timeoutMs: z.number().int().default(1_800_000),
      // The reviewer provider's API host and header-timeout window, applied only
      // when the reviewer's provider differs from Baby's (see opencode.ts).
      // baseUrl pins the Codex backend; headerTimeoutMs is opencode's
      // ProviderHeaderTimeout window. Use false to disable that timer for
      // diagnosis.
      baseUrl: z.string().default("https://chatgpt.com/backend-api/codex"),
      headerTimeoutMs: z.union([z.number().int(), z.literal(false)]).default(3_600_000),
      // A dummy key for a LOCAL proxy provider (e.g. claude-max-proxy, which
      // bridges a Claude Max sub to a standard Anthropic API and ignores the
      // key value). Set it so opencode's provider authenticates with this
      // instead of hunting for real creds/global auth. Left undefined for
      // openai/codex (which uses opencode's ChatGPT-OAuth) — only spread into
      // provider options when present.
      apiKey: z.string().optional(),
      // One turn must run every verification command, inspect the tree, and emit
      // a verdict.
      turnSteps: z.number().int().default(40),
      // The judgement rubric (§4): the FULL skill, not the ambient SKILL_SMALL
      // the executors inherit. Live path (§14.4) — read fresh each pass.
      skillPath: z.string().default("~/.config/opencode/skills/meridian/SKILL.md"),
      // The packet-authoring spec super-daddy follows when it authors a follow-up
      // packet (request_changes → repair pass). The SAME skill the planner uses to
      // author any handoff packet. Read fresh each authoring turn, like skillPath.
      packetSkillPath: z.string().default("~/.config/opencode/skills/packet/SKILL.md"),
      // Opus has a large window; give it more of the diff inline than daddy's
      // 64KB.
      diffCapBytes: z.number().int().default(131_072),
      // In-adapter immediate retries on a TRANSIENT transport drop (socket hang
      // up, 5xx, reset) before giving up and returning an unreachable outcome.
      // The Codex backend drops sockets often enough that one extra attempt
      // usually lands; a fatal error (auth/400) is never retried.
      transportRetries: z.number().int().min(0).default(2),
    })
    .default({}),
  thresholds: z
    .object({
      rotationFraction: z.number().default(0.65),
      // A no-progress backstop, not a checkpoint cadence: 10 consecutive dead turns
      // (no tool call, no diff) is an unambiguous wedge.
      ladderParkAt: z.number().int().default(10),
      // No-progress ROTATION (L3, §10). A tool-inactive session is replaced rather
      // than nudged indefinitely. Must be ≥1 and < ladderParkAt so at
      // least one rotation fires before the park backstop.
      ladderRotateAt: z.number().int().positive().default(4),
      // NON-BLOCKING checkpoint reminder (§10): how long since the executor's last
      // planner check-in before the driver starts prepending a soft "consider
      // ask_planner" nudge to its continue prompt. Once past it, the nudge fires
      // EVERY turn until the executor checks in (which resets the clock). It never
      // latches and never ends the turn.
      checkpointNudgeMs: z
        .number()
        .int()
        .default(20 * 60 * 1000),
      // VOLUME checkpoint reminder (§10): non-blocking count-axis reminder. Once
      // the executor has
      // made `checkpointToolCalls` tool calls (any tool), or changed
      // `checkpointFiles`/`checkpointLoc` of diff, since its last planner
      // check-in, the SAME message a block would show is appended to every tool
      // result until it checks in. Never blocks.
      checkpointToolCalls: z.number().int().default(50),
      checkpointFiles: z.number().int().default(6),
      checkpointLoc: z.number().int().default(80),
      reportRejectionParkAt: z.number().int().default(3),
      checkpointBounceLimit: z.number().int().default(1),
      verificationTimeoutMs: z.number().int().default(600_000),
      // Super-daddy circuit breaker: max convergence passes before a stalled
      // campaign is forced to escalate to Max.
      maxPasses: z.number().int().min(1).default(3),
      // Convergence-level budget for CONSECUTIVE unreachable (transport-dropped)
      // super-daddy attempts. Below it the run self-retries (stays ready, no pass
      // recorded); at it the run parks for Max as a real "Codex durably down".
      // Distinct from maxPasses, which counts real verdicts.
      maxReviewerUnreachable: z.number().int().min(1).default(3),
      // When daddy's final review rejects baby's report reportRejectionParkAt
      // times, swap baby's model to baby.promoteTo for one more set of retries
      // before failing the run. false disables the swap — baby just fails at the
      // rejection cap as if promoteTo were absent.
      promoteAtCap: z.boolean().default(true),
      // P6 liveness. maxStallRetries: automatic post-stall requeues before a
      // `wedged` run escalates to Max. maxRunMs:
      // wall-clock backstop on a single attempt — the livelock watchdog the
      // per-turn ladder can't catch (productive-looking turns that never
      // converge). Default 6h.
      maxStallRetries: z.number().int().min(0).default(2),
      // P6 sibling for hallucination recovery: max consecutive reorients before
      // the driver stops rotating and parks for Max. 0 disables reorient.
      maxReorientRetries: z.number().int().min(0).default(2),
      maxRunMs: z
        .number()
        .int()
        .default(6 * 60 * 60 * 1000),
      // Floor below which a turn is treated as a dead landing (model received
      // essentially no prompt). First-turn exempt (a fresh session always starts
      // with the full seed). Kept low (128) so a legitimate small turn never
      // trips it — even a minimal tool-call round-trip exceeds this.
      contextTokensFloor: z.number().int().default(128),
    })
    .default({}),
  // Idle timeout: inactivity timer for sendMessage — destroys the request after
  // idleTimeoutMs of silence (no data chunks). Matches the headerTimeoutMs
  // pattern at line 60 (z.union with false to disable for diagnosis).
  idleTimeoutMs: z.union([z.number().int(), z.literal(false)]).default(120_000),
  mutationCommandPatterns: z
    .array(z.string())
    .default(["\\b(pnpm|npm|yarn)\\b.*\\bgenerate\\b", "task contracts", "dotnet-rivet"]),
});

export type Config = z.infer<typeof Config>;
