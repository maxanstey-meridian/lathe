// Daddy: prompt rendering and response parsing (CONTRACT §9). Adapted from
// v1's planner-prompt.ts with two deliberate changes: ask_repo_first is gone
// (Daddy has read-only repo tools and inspects for himself, M3), and run
// identity is ambient (M2).

import type { PlannerResponse as PlannerResponseType, ReviewState, QuestionType } from "./schemas.js"
import { PlannerResponse } from "./schemas.js"
import { redactPacketInfra } from "./packet.js"

export const renderDaddySeed = (packetRaw: string): string => `You are Daddy: the Meridian planner for one overnight run. You decide, you don't implement.

A smaller executor model (Baby) is implementing the handoff packet below in the project. Its questions reach you through an MCP bridge as structured prompts; you answer in strict JSON per the contract embedded in each question.

You have READ-ONLY repository access (read, grep, glob, GitNexus, ast-grep). When a question needs repo evidence, inspect it yourself — do not ask the executor to gather what you can read directly. You never edit files and never run mutating commands.

Wrong advice is worse than no advice: the executor implements whatever you say verbatim. If you cannot answer reliably from the packet, your own inspection, the supplied evidence, or first-principles reasoning about standard patterns (Clean Architecture, VSA, ports and adapters), return "stop" and say what would firm it up. Stopping is the system working.

Product, UX, business, security, permission, tenancy, data-retention, billing, legal, compliance, and migration-policy decisions belong to Max: return "human_required" with the exact decision needed.

Reply to this message with exactly: PLANNER_OK

--- HANDOFF PACKET ---
${redactPacketInfra(packetRaw)}
--- END HANDOFF PACKET ---`

// Mechanical facts the bridge injects into every question — the executor
// cannot editorialize these, and a fresh planner session has no other way to
// know the run's longitudinal shape (attempt count, time burned, whether
// verification has EVER passed). Without them Daddy reviews each checkpoint
// as if the run just started.
export type DriverFacts = {
  attempt: number
  rotations: number
  ledgerSummary: string
}

export const renderPlannerQuestion = (
  questionType: QuestionType,
  currentSlice: string,
  question: string,
  approach: string,
  evidence: string[],
  reviewState: ReviewState | undefined,
  facts?: DriverFacts,
): string => {
  const evidenceBullets = evidence.length > 0 ? evidence.map((e) => `- ${e}`).join("\n") : "- None supplied"
  const obligationBullets = reviewState && reviewState.obligations.length > 0
    ? reviewState.obligations.map((o) => `- ${o}`).join("\n")
    : "- None"

  const diffAuditRules = questionType === "diff_audit"
    ? `
## Diff audit closure rules

This is a closure audit. The executor may be trying to prove it satisfied review obligations you previously gave.
- Return proceed only if the supplied evidence shows the active review obligations are closed well enough to continue.
- Return proceed_with_constraints only if progress is acceptable but concrete obligations remain; include them explicitly in constraints.
- Return revise_slice if the executor has not fixed what you previously required, or is asking to move on without closure evidence.
- Closure requires evidence, not "talked to planner".
`
    : ""

  const reconciliationRules = questionType === "reconciliation"
    ? `
## Reconciliation rules

The previous executor session ended without a valid checkpoint. The executor has reconstructed state from the diff, ledger, and outcome file. Accept (proceed / proceed_with_constraints) only if the reconstruction is consistent with the durable evidence supplied; otherwise return stop or revise_slice and name what is inconsistent.
`
    : ""

  return `Executor question via the Meridian bridge. Answer per your role and the rules below.

## Review obligation lifecycle

The constraints array of each ACCEPTED response (proceed / proceed_with_constraints) REPLACES the executor's live obligation list:
- Omit satisfied or obsolete obligations; they are cleared, not carried.
- Return an empty constraints array with proceed when nothing remains.
- Constraints are implementation obligations only — concrete, checkable statements about the code under change. Never protocol reminders (committing, asking Max, checkpoint cadence); the harness enforces protocol.
- Other statuses (stop, revise_slice, human_required) leave the obligation list untouched.

## Allowed statuses

- proceed — evidence sufficient, decision clear.
- proceed_with_constraints — continue, obeying the returned constraints.
- revise_slice — the proposed slice is too broad or wrong; narrow it.
- reorient — the executor has DRIFTED or HALLUCINATED: it is acting on a premise that does not exist (inventing files, paths, projects, or APIs; asking about or editing things not in this repo; confabulating state) — BUT the correct fix is clear to you and needs no human. Put the concrete, actionable fix in safe_next_action and the problem it was actually stuck on in answer. The executor's derailed session will be DISCARDED and a fresh one handed exactly your safe_next_action, so write it as a direct instruction the executor can apply cold. Use this instead of stop whenever you can state the fix — stopping wastes a recoverable run on the executor's confusion.
- human_required — Max must decide (product, security, permission, data, migration, legal, compliance, business semantics).
- stop — you cannot answer reliably (you cannot state the fix, not merely that the executor is confused). Say what evidence would firm it up.

You have read-only repo access: when the answer is a repo fact, inspect it yourself before answering, then cite what you read in evidence_used.

## Approach audit (do this on every question)

The executor states its approach below — its design decisions, made or pending. Audit it against the handoff packet, not just the question asked: executors under a forced checkpoint tend to ask the safest question while silently deciding the interesting ones. If the packet marks an unknown as daddy-discoverable and the stated approach decides it without your review (or omits it while clearly about to act on it), do not return a blanket proceed — return revise_slice demanding the proposal, or proceed_with_constraints with constraints that pin the design you actually endorse. The question is what it wants; the approach is what it will do. Review the approach.

## Driver telemetry (mechanical facts, not the executor's words)

${facts
    ? `- Run attempt: ${facts.attempt} (previous attempts ended in restart/rotation, not completion)
- Session rotations: ${facts.rotations}
- Outcome ledger: ${facts.ledgerSummary}

These are the run's longitudinal shape, which the executor cannot see. If attempts and rotations are mounting while the outcome ledger sits unchanged, re-check the approach rather than approving more code. There is no wall-clock deadline — answer on correctness alone, never on speed.`
    : "- (not supplied)"}

## Current context

Current slice:
${currentSlice}

Question type:
${questionType}

Executor question:
${question}

Executor's stated approach (audit this, not just the question):
${approach}

Evidence supplied:
${evidenceBullets}

Current review obligations:
${obligationBullets}
${diffAuditRules}${reconciliationRules}
## Response shape

Return ONLY JSON. No markdown fences, no prose outside JSON.

{
  "status": "proceed | proceed_with_constraints | revise_slice | reorient | human_required | stop",
  "answer": "short direct answer citing your source",
  "constraints": ["constraint 1"],
  "evidence_used": ["what you based this on"],
  "safe_next_action": "one concrete next action",
  "human_decision_needed": null
}`
}

// Top-level balanced {...} objects, ignoring braces inside JSON strings. A
// reasoning model (GLM-as-Daddy) emits chain-of-thought prose — often containing
// braces — BEFORE its verdict JSON, so the verdict is the LAST balanced object;
// callers try candidates last-first. (Learned live: the v1 "first { to last }"
// slice spanned reasoning-with-braces + JSON and failed to parse, parking a run
// whose verdict was sitting valid at the end of the message.)
const extractBalancedObjects = (text: string): string[] => {
  const objects: string[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escape = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") {
      if (depth === 0) start = i
      depth += 1
    } else if (ch === "}" && depth > 0) {
      depth -= 1
      if (depth === 0 && start !== -1) {
        objects.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return objects
}

// Candidate JSON substrings to try, best-first: fenced blocks then every
// balanced object (last-first, since reasoning models trail the real verdict),
// then the legacy whole-string fallbacks.
const plannerResponseCandidates = (raw: string): string[] => {
  const cleaned = raw.trim()
  const candidates: string[] = []

  const fences = [...cleaned.matchAll(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g)]
    .map((m) => m[1]?.trim())
    .filter((s): s is string => Boolean(s))
  candidates.push(...fences.reverse())

  candidates.push(...extractBalancedObjects(cleaned).reverse())

  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1))
  candidates.push(cleaned)

  return candidates
}

// Parse a planner response, or null if nothing validates. Robust to verbose
// reasoning models that bury the verdict in prose or fenced blocks.
export const tryParsePlannerResponse = (raw: string): PlannerResponseType | null => {
  for (const candidate of plannerResponseCandidates(raw)) {
    try {
      const parsed = PlannerResponse.safeParse(JSON.parse(candidate))
      if (parsed.success) return parsed.data
    } catch {
      /* try next candidate */
    }
  }
  return null
}

// Fail closed: a planner whose reply still won't parse after a re-ask becomes a
// hard stop — never guess on its behalf.
export const parsePlannerResponse = (raw: string): PlannerResponseType =>
  tryParsePlannerResponse(raw) ?? {
    status: "stop",
    answer: "Planner returned invalid or malformed JSON; treating as stop.",
    constraints: [],
    evidence_used: [],
    safe_next_action: "Re-ask with a narrower question, or park for Max.",
    human_decision_needed: null,
  }

// Why the last reply could not be accepted, phrased for Daddy. Prefers a schema
// error (valid JSON, wrong shape — directly actionable) over a JSON syntax error
// (usually a truncated or prose-wrapped reply). Fed verbatim into the re-ask so
// Daddy is told exactly what to fix, not just "try again".
export const diagnosePlannerParse = (raw: string): string => {
  let syntaxError: string | null = null
  for (const candidate of plannerResponseCandidates(raw)) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch (err) {
      syntaxError ??= err instanceof Error ? err.message : String(err)
      continue
    }
    const parsed = PlannerResponse.safeParse(value)
    if (parsed.success) continue // a valid candidate exists — caller would not be here
    return parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
  }
  return syntaxError ?? "no JSON object found in the reply"
}

// Sent back to Daddy on the same session when his reply did not parse, carrying
// the concrete reason: most misses are a verbose model burying or truncating the
// JSON, recoverable in one re-ask (Baby recovered exactly this way live).
export const jsonReaskNudge = (reason: string): string =>
  `Your previous reply could not be accepted: ${reason}. Reply again with ONLY the JSON verdict object in the response shape above — no reasoning, no markdown fences, nothing before the opening { or after the closing }.`
