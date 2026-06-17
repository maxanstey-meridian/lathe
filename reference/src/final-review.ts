// Daddy's final review (CONTRACT V7). The one acceptance check that cannot be
// mechanical: does the diff actually deliver each outcome, and is it sane.
// Prompt rendering + fail-closed parsing, mirroring planner.ts. The driver runs
// this only after the mechanical floor (V1/V3/V5/V6) has already passed, so a
// malformed or unreachable verdict fails closed to request_changes — the run
// bounces through the existing V1 retry path, never silently accepts.

import type { FinalReview as FinalReviewType, OutcomeLedger, Packet, SubmitReport } from "./schemas.js"
import { FinalReview } from "./schemas.js"

export const renderFinalReview = (
  packet: Packet,
  reviewableDiff: string,
  ledger: OutcomeLedger,
  report: SubmitReport,
): string => {
  const outcomeLines = ledger.outcomes.map((o) => `- ${o.id}: ${o.description}`).join("\n")
  const verificationLines =
    packet.frontmatter.verification.map((v) => `- \`${v.command}\``).join("\n") || "- (none declared)"
  const filesLines =
    report.filesChanged.length > 0
      ? report.filesChanged.map((f) => `- \`${f.path}\` (${f.classification}, ${f.action})`).join("\n")
      : "- (none reported)"

  return `FINAL REVIEW — the run is complete and you are the last gate before it reaches Max.

The mechanical floor has ALREADY PASSED, as fact, not as the executor's claim:
the driver ran every verification command itself in the worktree and all exited
0; every declared outcome is marked done with evidence; every changed file is
classified. Do not re-litigate those. Your job is the one thing the machine
cannot check: does this diff actually DELIVER each outcome, and is it sane?

You have full read-only access to this worktree (your cwd): \`git diff HEAD\`,
\`git log\`, rg, ast-grep, read. USE IT. The diff below is a possibly-truncated
convenience — do not trust it over the real tree. Inspect the files the outcomes
touch; grep for anything that smells wrong.

For EACH outcome, decide whether the diff delivers it and CITE where (file:line
or symbol). An outcome you cannot locate is not delivered. An \`accept\` with no
citations is itself a \`request_changes\`.

Then judge sanity — anything a green test would not catch: stubbed/mocked
behaviour passing as real, swallowed error paths, an outcome met in letter but
not intent, scope creep beyond the packet, a security or data footgun.

## Packet outcomes
${outcomeLines}

## Verification commands (ran green — fact)
${verificationLines}

## Files changed (classified by the executor)
${filesLines}

## Reviewable diff (convenience; inspect the real tree yourself)
${reviewableDiff}

## Response shape

Return ONLY JSON. No markdown fences, no prose outside JSON.

{
  "verdict": "accept | request_changes | escalate",
  "findings": ["<outcome-id>: delivered at <cite> — or NOT delivered because ...", "sanity: ..."],
  "notes": "one-line overall judgement",
  "human_decision_needed": null
}

- accept — every outcome located in the diff and the change is sound.
- request_changes — any outcome undelivered, or a correctness/scope/safety
  problem the executor must fix. Findings are shown to the executor verbatim, so
  make each specific and actionable.
- escalate — the work is mechanically complete but now exposes a decision only
  Max can make (product, UX, security, permission, tenancy, data retention,
  billing, legal, compliance, migration policy, scope beyond the packet). Put
  the exact decision in human_decision_needed.`
}

// Mirrors parsePlannerResponse: first fenced block, else outermost braces,
// safeParse, fail CLOSED. A planner that cannot produce a valid verdict on the
// final gate is treated as request_changes — the run does not pass on garbage.
export const parseFinalReview = (raw: string): FinalReviewType => {
  let cleaned = raw.trim()
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/)
  if (fenceMatch && fenceMatch[1] !== undefined) cleaned = fenceMatch[1].trim()

  const candidates: string[] = [cleaned]
  const start = cleaned.indexOf("{")
  const end = cleaned.lastIndexOf("}")
  if (start !== -1 && end > start) candidates.push(cleaned.slice(start, end + 1))

  for (const candidate of candidates) {
    try {
      const parsed = FinalReview.safeParse(JSON.parse(candidate))
      if (parsed.success) return parsed.data
    } catch {
      /* try next candidate */
    }
  }

  return {
    verdict: "request_changes",
    findings: ["Daddy's final-review response was not valid JSON; failing closed to request_changes."],
    notes: "unparseable verdict",
    human_decision_needed: null,
  }
}
