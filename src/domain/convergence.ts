import { z } from "zod"
import { stringify as stringifyYaml } from "yaml"
import { FinalReviewVerdict } from "./review.js"
import { PacketFrontmatter, type OutcomeDef, type Packet } from "./packet.js"

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

const kebabRegex = /^[a-z0-9][a-z0-9-]*$/

export const Finding = z.object({
  id: z.string().regex(kebabRegex, "finding ids are kebab-case"),
  severity: FindingSeverity,
  title: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  grounding: FindingGrounding,
  // Proposed outcome id if this finding becomes a follow-up outcome (kebab-case).
  suggested_outcome_id: z.string().regex(kebabRegex, "outcome ids are kebab-case").optional(),
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

// ---------------------------------------------------------------------------
// The loop decision (single reviewer: super-daddy) — CONTRACT §18 S5

export type ConvergeDecision =
  | { action: "author"; blockers: Finding[] }
  | { action: "stop" }
  | { action: "escalate"; reason: string }

// We trust the verdict. Order matters and every branch fails CLOSED toward Max:
//   1. reviewer escalated / needs a human            → escalate
//   2. accept but verification red                    → escalate
//   3. accept + green                                 → stop (the ONLY stop path)
//   4. request_changes with no findings              → escalate
//   5. request_changes + cap reached                  → escalate
//   6. request_changes + passes left                  → author EVERY finding
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

// ---------------------------------------------------------------------------
// Fail-closed parse (CONTRACT §18 S11)

// Every top-level {...} object in the text, brace-matched with string/escape
// awareness so a brace inside a JSON string value (or a `}` in prose) can't
// throw off the depth counter.
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
  // SuperReview is the real verdict. Deliberately fence-agnostic.
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

// ---------------------------------------------------------------------------
// Deterministic follow-up packet render

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

// ---------------------------------------------------------------------------
// Assemble commit message and render nits (§18 convergence helpers)
// ---------------------------------------------------------------------------

// Super-daddy authors subject + body; the commit wants them as one string with a
// blank line between (git's subject/body convention). Trim so a model that pads
// the body never leaves a trailing blank-line-only commit.
export const assembleCommitMessage = (cm: CommitMessage): string => {
  const body = cm.body.trim()
  return body.length > 0 ? `${cm.subject.trim()}\n\n${body}` : cm.subject.trim()
}

// Nits surfacing (§10/§13): when the loop is NOT authoring a fix pass,
// super-daddy's findings are the "by the way" notes Max reads in the morning.
// Pure render so it can be unit-tested; the I/O wrapper lives in converge.ts.
export const renderNits = (runId: string, primary: SuperReview): string | undefined => {
  const nits = primary.findings
  if (nits.length === 0) return undefined

  const lines = [
    `# Notes — ${runId}`,
    "",
    "Findings from super-daddy's review that the loop is not auto-fixing — here for",
    "your call, not the loop's.",
    "",
  ]
  for (const finding of nits) {
    lines.push(`## [${finding.severity}] ${finding.title}`)
    lines.push(`- id: \`${finding.id}\``)
    if (finding.grounding.kind !== "none" && finding.grounding.ref.trim().length > 0) {
      lines.push(`- grounding (${finding.grounding.kind}): ${finding.grounding.ref}`)
    }
    for (const e of finding.evidence) lines.push(`- ${e}`)
    lines.push("")
  }
  return lines.join("\n")
}
