// Super-daddy convergence logic (SUPER-DADDY.md). Pure: no I/O, no agents — the
// orchestrator (converge.ts) wires these into `meridian converge`. Everything here
// is unit-testable against fakes.
//
// The load-bearing decision: we TRUST super-daddy's verdict (Max: "no triaging,
// just trust super daddy"). There is no severity triage — the reviewer is told it
// gets one review and to put everything that genuinely matters into it (a
// deliberate framing; the pass cap, not a code-side filter, is what bounds the
// loop). So request_changes feeds EVERY finding to the follow-up pass. Severity
// and grounding stay on each finding — for ordering, evidence, and re-running a
// failed command — but never gate which findings reach Baby.

import { stringify as stringifyYaml } from "yaml"
import {
  PacketFrontmatter,
  SuperReview,
  type Finding,
  type OutcomeDef,
  type Packet,
} from "./schemas.js"

// --- the loop decision (single reviewer: super-daddy) ------------------------

export type ConvergeDecision =
  | { action: "author"; blockers: Finding[] } // request_changes → follow-up packet (every finding)
  | { action: "stop" } // accept → converged
  | { action: "escalate"; reason: string } // flag Max

// We trust the verdict. Order matters and every branch fails CLOSED toward Max:
//   1. reviewer escalated / needs a human            → escalate
//   2. accept but verification red                    → escalate (incoherent; under-reported)
//   3. accept + green                                 → stop (the ONLY stop path)
//   4. request_changes with no findings              → escalate (wants changes, named none)
//   5. request_changes + cap reached                  → escalate (convergence failed)
//   6. request_changes + passes left                  → author EVERY finding as a fix target
// On (6) we hand over ALL findings, not a severity-filtered subset: the verdict —
// not the label — is what says "this should not land yet", and the nits super-daddy
// would once have buried are exactly the enterprise polish Max wants fixed. The
// "one review" framing in the prompt keeps super-daddy front-loading, so this
// converges inside the cap rather than dribbling findings across passes.
export const decideConvergence = (
  review: SuperReview,
  verificationGreen: boolean,
  pass: number,
  maxPasses: number,
): ConvergeDecision => {
  if (review.verdict === "escalate" || review.human_decision_needed) {
    return { action: "escalate", reason: review.human_decision_needed ?? "reviewer escalated" }
  }
  if (review.verdict === "accept") {
    if (verificationGreen) return { action: "stop" }
    return {
      action: "escalate",
      reason: "reviewer accepted but a verification command is red — under-reported; not safe to auto-stop",
    }
  }
  // request_changes — author every finding, bounded only by the pass cap.
  if (review.findings.length === 0) {
    return {
      action: "escalate",
      reason: "reviewer requested changes but named no findings — nothing to author; not safe to auto-loop",
    }
  }
  if (pass >= maxPasses) {
    return {
      action: "escalate",
      reason: `hard cap reached (${pass}/${maxPasses}) and the reviewer still wants changes — convergence failed`,
    }
  }
  return { action: "author", blockers: review.findings }
}


// --- fail-closed parse (mirrors parseFinalReview) ----------------------------

// Every top-level {...} object in the text, brace-matched with string/escape
// awareness so a brace inside a JSON string value (or a `}` in prose) can't
// throw off the depth counter. Reasoning reviewers wrap the verdict in prose
// and stray code fences; scanning for balanced objects — rather than locking
// onto the first ``` fence — finds the verdict wherever it lands.
const balancedObjects = (text: string): string[] => {
  const objects: string[] = []
  let depth = 0
  let startIdx = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") {
      if (depth === 0) startIdx = i
      depth++
    } else if (ch === "}" && depth > 0) {
      depth--
      if (depth === 0 && startIdx !== -1) {
        objects.push(text.slice(startIdx, i + 1))
        startIdx = -1
      }
    }
  }
  return objects
}

// A super-review that cannot produce valid JSON fails closed to ESCALATE — the
// safest verdict (stop would converge on garbage, request_changes would author
// from no findings). Flagging Max is always recoverable.
export const parseSuperReview = (raw: string): SuperReview => {
  // Try every balanced {...} object, LAST first: the verdict JSON comes after
  // any reasoning/code-fence prose, so the last object that validates as a
  // SuperReview is the real verdict. Deliberately fence-agnostic — an earlier
  // ```csharp (or any) fenced block in the reviewer's reasoning must not shadow
  // the verdict. It did exactly that once: a gpt-5.5-pro `accept` was read as an
  // `escalate` (the old code locked onto the first fence), parking a converged run.
  for (const obj of balancedObjects(raw).reverse()) {
    try {
      const parsed = SuperReview.safeParse(JSON.parse(obj))
      if (parsed.success) return parsed.data
    } catch {
      /* not this object — try the next-earlier one */
    }
  }

  return {
    verdict: "escalate",
    findings: [],
    convergence: { recommend_stop: false, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "unparseable" },
    commit_message: null,
    notes: "super-review response was not valid JSON; failing closed to escalate",
    human_decision_needed: "Super-daddy returned an unparseable verdict — review the run manually.",
  }
}

// --- deterministic follow-up packet render -----------------------------------

export type FollowupPacketInput = {
  original: Packet // parent packet — source of repo, surface, verification, constraints
  parentRunId: string // the run super-daddy just reviewed
  campaignId: string
  pass: number // the NEW pass number (parent pass + 1)
  blockers: Finding[] // grounded blockers to fix (from decideConvergence; non-empty)
  priorOutcomes: OutcomeDef[] // delivered outcomes carried forward as regression
  baseBranch: string // base for the follow-up = parent run's branch tip
  timestamp: string // YYYYMMDD-HHMMSS — caller supplies so this stays pure
  slug: string // kebab slug for the run id / filename
}

export type FollowupPacket = { runId: string; filename: string; content: string }

const RUN_ID_RE = /^\d{8}-\d{6}-[a-z0-9-]+$/

const outcomeIdOf = (b: Finding): string => b.suggested_outcome_id ?? b.id

const dedupeVerification = <T extends { command: string }>(cmds: T[]): T[] => {
  const seen = new Set<string>()
  return cmds.filter((c) => (seen.has(c.command) ? false : (seen.add(c.command), true)))
}

const renderBlockerBody = (b: Finding): string => {
  const lines = [`### ${b.severity} \`${outcomeIdOf(b)}\` — ${b.title}`]
  if (b.grounding.kind !== "none") lines.push("", `Grounding (${b.grounding.kind}): ${b.grounding.ref}`)
  if (b.evidence.length > 0) lines.push("", ...b.evidence.map((e) => `- ${e}`))
  return lines.join("\n")
}

// Pure: (review findings + parent packet) → a valid packet markdown string. Throws
// on a programming error (no blockers, or a frontmatter that fails its own schema)
// — the caller only reaches here on action:"author", which guarantees blockers.
export const renderFollowupPacket = (input: FollowupPacketInput): FollowupPacket => {
  const { original, parentRunId, campaignId, pass, blockers, priorOutcomes, baseBranch, timestamp, slug } = input
  if (blockers.length === 0) throw new Error("renderFollowupPacket: no blockers — nothing to author (converged)")

  const runId = `${timestamp}-${slug}`
  if (!RUN_ID_RE.test(runId)) {
    throw new Error(`renderFollowupPacket: runId must be YYYYMMDD-HHMMSS-<slug>, got: ${runId}`)
  }

  // Two blockers can map to the same outcome id (independent reviewers, or a
  // reviewer reusing the original id); dedupe so the packet can't carry a
  // duplicate outcome (which parsePacket rejects at admission). First wins.
  const outcomes: OutcomeDef[] = []
  const seenOutcomeIds = new Set<string>()
  for (const b of blockers) {
    const id = outcomeIdOf(b)
    if (seenOutcomeIds.has(id)) continue
    seenOutcomeIds.add(id)
    outcomes.push({ id, description: b.evidence.length > 0 ? `${b.title} — ${b.evidence.join("; ")}` : b.title })
  }

  // Re-run the original suite (now must pass) plus the specific failing commands.
  const failCommands = blockers
    .filter((b) => b.grounding.kind === "command_fail" && b.grounding.ref.trim().length > 0)
    .map((b) => ({ command: b.grounding.ref.trim() }))
  const verification = dedupeVerification([...original.frontmatter.verification, ...failCommands])

  // An outcome being REPAIRED this pass cannot also be a regression guard ("must
  // still pass unchanged") — that's self-contradictory. Exclude any prior outcome
  // whose id is now a blocker outcome. (Triggered live when a reviewer reused the
  // original outcome id as its suggested_outcome_id.)
  const regression = priorOutcomes.filter((o) => !seenOutcomeIds.has(o.id))
  const regressionIds = regression.map((o) => o.id)
  const constraints = [
    ...original.frontmatter.constraints,
    ...(regressionIds.length > 0
      ? [`Regression: these prior outcomes must STILL pass unchanged: ${regressionIds.join(", ")}.`]
      : []),
    "Scope is repair only: fix the blockers below against the original packet and Max's doctrine. Do not add net-new features.",
  ]

  // A plain "what is this run doing" line for `meridian tail`, composed from what
  // the follow-up is fixing — no human and no model in this path, so the render
  // derives it from its own blockers (capped to one readable line).
  const summary = `convergence pass ${pass} — ${blockers.map((b) => b.title).join("; ")}`.slice(0, 120)

  // Field order here is the on-disk order — kept readable, lineage up top.
  const frontmatterObj = {
    repo: original.frontmatter.repo,
    base: baseBranch,
    summary,
    campaign_id: campaignId,
    parent_run_id: parentRunId,
    pass,
    outcomes,
    regression_outcomes: regression,
    expected_surface: original.frontmatter.expected_surface,
    suspicious_surface: original.frontmatter.suspicious_surface,
    verification,
    constraints,
  }

  // Fail closed: never emit a packet that wouldn't survive its own admission check.
  const validated = PacketFrontmatter.safeParse(frontmatterObj)
  if (!validated.success) {
    throw new Error(
      `renderFollowupPacket: produced invalid frontmatter — ${validated.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    )
  }

  const body = [
    `# ${slug} — convergence pass ${pass}`,
    "",
    `Campaign \`${campaignId}\`, follow-up to run \`${parentRunId}\`. Super-daddy reviewed the`,
    `delivered work against the original packet and Max's doctrine and found grounded blockers.`,
    `Fix exactly these; do not expand scope.`,
    "",
    "## Blockers to fix",
    "",
    blockers.map(renderBlockerBody).join("\n\n"),
    "",
    ...(regression.length > 0
      ? [
          "## Must not regress",
          "",
          "Delivered by earlier passes — must still pass:",
          "",
          ...regression.map((o) => `- \`${o.id}\`: ${o.description}`),
          "",
        ]
      : []),
  ].join("\n")

  const content = `---\n${stringifyYaml(frontmatterObj).trimEnd()}\n---\n\n${body}\n`
  return { runId, filename: `${runId}.md`, content }
}
