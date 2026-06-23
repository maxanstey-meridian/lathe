import { z } from "zod";

// ---------------------------------------------------------------------------
// Config (CONTRACT §14)
// Full C1 field set with every default (C2). Replicated from reference — this
// is the schema; the shape is truth.

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
      turnSteps: z.number().int().default(8),
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
      turnSteps: z.number().int().default(12),
      // Caps Baby's per-turn reasoning (oMLX `thinking_budget`, integer tokens):
      // on hitting it the server forces `</think>` and Baby answers from the
      // reasoning so far — bounds rumination spirals AND the reasoning tokens'
      // drain on the rotation budget (they count toward contextWindow). Start
      // generous and ratchet down in config.json; too low forces premature
      // answers on genuinely hard turns. null = uncapped (legacy behaviour).
      thinkingBudget: z.number().int().nullable().default(6_000),
    })
    .default({}),
  // Super-daddy: the convergence reviewer — the strongest frontier "pseudo-Max"
  // tier, the ONE reviewer that MUST execute (bash enabled). Default is
  // openai/gpt-5.5: it resolves through opencode's global auth (NOT
  // declared in the generated config, like daddy), it's the strongest reviewer
  // currently authed, and it mirrors Max's manual loop (today he reviews by
  // hand with GPT). Override modelId in config.json — e.g. "gpt-5.5-pro" for a
  // heavier pass — exactly as daddy.modelId is overridden today.
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
      // a verdict — far more tool-rounds than daddy's bounded recon (§4 "must
      // execute").
      turnSteps: z.number().int().default(40),
      // The judgement rubric (§4): the FULL skill, not the ambient SKILL_SMALL
      // the executors inherit. Live path (§14.4) — read fresh each pass.
      skillPath: z.string().default("~/.config/opencode/skills/meridian/SKILL.md"),
      // Opus has a large window; give it more of the diff inline than daddy's
      // 64KB.
      diffCapBytes: z.number().int().default(131_072),
    })
    .default({}),
  thresholds: z
    .object({
      rotationFraction: z.number().default(0.65),
      // A no-progress backstop, not a checkpoint cadence: with the limit-shout
      // now non-blocking (§10), 10 consecutive DEAD turns (no tool call, no
      // diff) is an unambiguous wedge.
      ladderParkAt: z.number().int().default(10),
      // No-progress ROTATION (L3, §10). A Baby that has stopped calling tools
      // and is narrating in a loop is rescued by a FRESH session far more
      // reliably than by more nudges. Must be ≥1 and < ladderParkAt so at
      // least one rotation fires before the park backstop.
      ladderRotateAt: z.number().int().positive().default(4),
      // NON-BLOCKING checkpoint reminder (§10): how long since Baby's last
      // planner check-in before the driver starts prepending a soft "consider
      // ask_planner" nudge to its continue prompt. Once past it, the nudge fires
      // EVERY turn until Baby actually checks in (which resets the clock) —
      // deliberately repetitive: Baby is an easily-distracted child, so we keep
      // shouting. It never latches and never ends the turn.
      checkpointNudgeMs: z
        .number()
        .int()
        .default(20 * 60 * 1000),
      // VOLUME checkpoint reminder (§10) — the work-interval cadence reborn as a
      // non-blocking shout, on a count axis instead of a clock. Once Baby has
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
      // At the convergence cap, run one more pass with Baby's full harness on
      // Daddy's model before escalating to Max. false restores today's
      // escalate-at-cap behaviour.
      promoteAtCap: z.boolean().default(true),
      // P6 liveness. maxStallRetries: automatic post-stall requeues before a
      // `wedged` run escalates to Max — the bounded "try again pls". maxRunMs:
      // wall-clock backstop on a single attempt — the livelock watchdog the
      // per-turn ladder can't catch (productive-looking turns that never
      // converge). Default 6h.
      maxStallRetries: z.number().int().min(0).default(2),
      // P6 sibling for hallucination recovery: max consecutive reorients (Baby
      // derailed → discard session, reseed with Daddy's fix) before the driver
      // stops rotating and parks for Max. Mirrors maxStallRetries' bounded
      // "try again pls"; 0 disables reorient.
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
