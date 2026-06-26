import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { extractFrontmatter, normalizeForFrontmatter, type OutcomeDef } from "./packet.js";
import { FinalReviewVerdict } from "./review.js";
import { balancedObjects, repairYamlEscapes } from "./structured-extraction.js";

// ---------------------------------------------------------------------------
// Super-daddy convergence supervisor (SUPER-DADDY.md). A stronger, doctrine-anchored
// review ABOVE the per-run FinalReview; it decides whether the campaign converges,
// needs another pass, or must reach Max. Reuses FinalReviewVerdict (accept →
// converged, request_changes → author follow-up, escalate → flag Max).

export const FindingSeverity = z.enum(["P0", "P1", "P2", "P3"]);
export type FindingSeverity = z.infer<typeof FindingSeverity>;

// The grounding rule (SUPER-DADDY §5): severity is a function of EVIDENCE, not the
// reviewer's gut. A finding is a blocker only if it cites a failing command or a
// violated doctrine/contract clause; kind "none" forces it to a taste-call nit.
export const FindingGrounding = z.object({
  kind: z.enum(["command_fail", "clause", "none"]),
  ref: z.string().default(""),
});
export type FindingGrounding = z.infer<typeof FindingGrounding>;

const kebabRegex = /^[a-z0-9][a-z0-9-]*$/;

export const Finding = z.object({
  id: z.string().regex(kebabRegex, "finding ids are kebab-case"),
  severity: FindingSeverity,
  title: z.string().min(1),
  evidence: z.array(z.string()).default([]),
  grounding: FindingGrounding,
  // Proposed outcome id if this finding becomes a follow-up outcome (kebab-case).
  suggested_outcome_id: z.string().regex(kebabRegex, "outcome ids are kebab-case").optional(),
});
export type Finding = z.infer<typeof Finding>;

// The convergence signal (SUPER-DADDY §6). recommend_stop is what the reviewer
// PROPOSES; the authoritative decision recomputes grounded blockers from the
// findings (convergence.ts) so the model cannot escalate a vibe to P0/P1.
export const ConvergenceSignal = z.object({
  recommend_stop: z.boolean(),
  profile: z.object({
    p0: z.number().int(),
    p1: z.number().int(),
    p2: z.number().int(),
    p3: z.number().int(),
  }),
  rationale: z.string().default(""),
});
export type ConvergenceSignal = z.infer<typeof ConvergenceSignal>;

// The commit message super-daddy authors for a converged run (R3). On accept it
// replaces the driver's throwaway `WIP <runId>` line by amending the run's single
// commit — super-daddy is the right author because it has just read the whole
// diff, the report, and run verification. subject is a conventional-commit one-
// liner (imperative, ≤72 chars); body explains what changed and why. Only
// meaningful on accept, so the field is nullable on every other verdict.
export const CommitMessage = z.object({
  subject: z.string().min(1),
  body: z.string().default(""),
});
export type CommitMessage = z.infer<typeof CommitMessage>;

export const SuperReview = z.object({
  verdict: FinalReviewVerdict,
  findings: z.array(Finding).default([]),
  convergence: ConvergenceSignal,
  commit_message: CommitMessage.nullable().default(null),
  notes: z.string().default(""),
  human_decision_needed: z.string().nullable().default(null),
});
export type SuperReview = z.infer<typeof SuperReview>;

// ---------------------------------------------------------------------------
// The loop decision (single reviewer: super-daddy) — CONTRACT §18 S5

export type ConvergeDecision =
  // `promote` is the n+1 cap escape hatch: when set, the authored follow-up runs
  // Baby's harness on Daddy's model (the same task, a stronger engine). Only the
  // cap branch ever sets it true; every normal pass authors with promote=false.
  | { action: "author"; blockers: Finding[]; promote: boolean }
  | { action: "stop" }
  | { action: "escalate"; reason: string };

// Policy the caller supplies (it owns config, the pure decision does not): whether
// the cap may spend ONE promoted pass, and whether THIS run already was that pass.
export type PromotePolicy = { promoteAtCap: boolean; alreadyPromoted: boolean };

// We trust the verdict. Order matters and every branch fails CLOSED toward Max,
// with ONE deliberate escape hatch — the promoted pass at the cap:
//   1. accept + human_decision_needed                 → escalate
//   2. accept + green                                 → stop (the ONLY stop path)
//   3. accept but verification red                    → escalate
//   ── at the cap (last resort) ──
//   4. cap + promotion available + findings to author → author PROMOTED (Daddy's model)
//   5. cap + promotion spent / nothing to author      → escalate
//   ── below the cap ──
//   6. explicit escalate / human_decision_needed      → escalate
//   7. request_changes with no findings               → escalate
//   8. request_changes + passes left                  → author EVERY finding
//
// The cap branch is the ONLY place an `escalate` verdict can be turned back into a
// pass, and only once per campaign (alreadyPromoted guards re-promotion): before
// rejecting OR escalating at the cap, give Baby one more attempt at the same task
// on Daddy's model.
export const decideConvergence = (
  review: SuperReview,
  verificationGreen: boolean,
  pass: number,
  maxPasses: number,
  promote: PromotePolicy = { promoteAtCap: false, alreadyPromoted: false },
): ConvergeDecision => {
  // Accept is handled first so a clean accept is never diverted into a pass. A
  // human_decision_needed on an accept is a genuine "ask Max" and still escalates.
  if (review.verdict === "accept") {
    if (review.human_decision_needed) {
      return { action: "escalate", reason: review.human_decision_needed };
    }
    if (verificationGreen) {
      return { action: "stop" };
    }
    return {
      action: "escalate",
      reason:
        "reviewer accepted but a verification command is red — under-reported; not safe to auto-stop",
    };
  }

  // Not accepted: request_changes or escalate. At the cap, the promoted pass is the
  // last resort BEFORE giving up — but only if there are concrete findings to author
  // a repair from, and only if we have not already spent the promotion this campaign.
  const canAuthor = review.findings.length > 0;
  if (pass >= maxPasses) {
    if (promote.promoteAtCap && !promote.alreadyPromoted && canAuthor) {
      return { action: "author", blockers: review.findings, promote: true };
    }
    if (promote.alreadyPromoted) {
      return {
        action: "escalate",
        reason: `hard cap reached (${pass}/${maxPasses}) after a promoted pass on Daddy's model and the reviewer still will not converge — escalating to Max`,
      };
    }
    return {
      action: "escalate",
      reason: canAuthor
        ? `hard cap reached (${pass}/${maxPasses}) and the reviewer still wants changes — convergence failed`
        : `hard cap reached (${pass}/${maxPasses}) and the reviewer named no findings — convergence failed`,
    };
  }

  // Below the cap an explicit escalate / human ask still parks for Max.
  if (review.verdict === "escalate" || review.human_decision_needed) {
    return { action: "escalate", reason: review.human_decision_needed ?? "reviewer escalated" };
  }
  // request_changes below the cap — author every finding, no promotion.
  if (!canAuthor) {
    return {
      action: "escalate",
      reason:
        "reviewer requested changes but named no findings — nothing to author; not safe to auto-loop",
    };
  }
  return { action: "author", blockers: review.findings, promote: false };
};

// ---------------------------------------------------------------------------
// Fail-closed parse (CONTRACT §18 S11). The balanced-object scanner is
// single-sourced in structured-extraction.ts; this fence-agnostic parser reverses
// it (the verdict trails any reasoning/code-fence prose).

// A super-review that cannot produce valid JSON fails closed to ESCALATE — the
// safest verdict (stop would converge on garbage, request_changes would author
// from no findings). Flagging Max is always recoverable.
export const parseSuperReview = (raw: string): SuperReview => {
  // Try every balanced {...} object, LAST first: the verdict JSON comes after
  // any reasoning/code-fence prose, so the last object that validates as a
  // SuperReview is the real verdict. Deliberately fence-agnostic.
  for (const obj of balancedObjects(raw).reverse()) {
    try {
      const parsed = SuperReview.safeParse(JSON.parse(obj));
      if (parsed.success) {
        return parsed.data;
      }
    } catch {
      /* not this object — try the next-earlier one */
    }
  }

  return {
    verdict: "escalate",
    findings: [],
    convergence: {
      recommend_stop: false,
      profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
      rationale: "unparseable",
    },
    commit_message: null,
    notes: "super-review response was not valid JSON; failing closed to escalate",
    human_decision_needed: "Super-daddy returned an unparseable verdict — review the run manually.",
  };
};

// ---------------------------------------------------------------------------
// Follow-up packet: super-daddy authors the intent, the engine stamps the lineage
//
// On request_changes, super-daddy authors a FRESH packet (renderFollowupAuthoring)
// the same way a planner authors any handoff — picking its own outcomes, surface,
// and verification to fix the blockers it raised. The engine owns only the
// lineage/infra it must not be trusted to invent (the same fields the packet skill
// says never to author): repo, base, the campaign/parent/pass lineage,
// and the regression seal. These two pure helpers do that engine half.

// Super-daddy replies with the packet markdown; it MAY precede it with tool
// narration or wrap it in a code fence. Slice from the first frontmatter delimiter
// and drop any trailing fence so parsePacketShape (anchored at ^---) can parse it.
// extractAuthoredPacket — kept as a named view onto the shared tolerant
// normaliser (packet.ts). A reply WITH a frontmatter block comes back as the
// cleaned packet (narration/fences/CRLF/whitespace stripped) with a trailing
// newline; a reply with no frontmatter comes back trimmed so the caller fails
// closed downstream.
export const extractAuthoredPacket = (text: string): string => {
  const normalized = normalizeForFrontmatter(text);
  return extractFrontmatter(text) ? `${normalized.trim()}\n` : normalized.trim();
};

export type FollowupLineage = {
  repo: string; // parent repo — infra, never authored
  baseBranch: string; // base for the follow-up = parent run's branch tip
  campaignId: string;
  parentRunId: string; // the run super-daddy just reviewed
  pass: number; // the NEW pass number (parent pass + 1)
  priorOutcomes: OutcomeDef[]; // delivered outcomes carried forward as regression
  promoted: boolean; // run this follow-up on Daddy's model (cap escape hatch)
};

// Pure: (super-daddy's authored packet markdown) + lineage → an admittable packet.
// The author owns the intent (summary/outcomes/surface/verification/constraints/
// body); this stamps the lineage over the top (lineage WINS, stripping any infra
// the model wrongly authored). Throws if the reply has no parseable frontmatter —
// the caller treats that as an authoring failure (re-ask, then escalate), never a
// silent stall.
export const stampFollowupLineage = (authoredRaw: string, lineage: FollowupLineage): string => {
  const parts = extractFrontmatter(authoredRaw);
  if (!parts) {
    throw new Error("stampFollowupLineage: authored reply has no YAML frontmatter block");
  }

  // Salvage mirrors the JSON candidate approach: on a parse failure, repair the known
  // corruption class (invalid backslash escapes inside double-quoted scalars — a model
  // markdown-escaping a backtick, the cli-cutover scar) and try the repaired candidate
  // before declaring the frontmatter invalid. Repair only runs on failure, so a
  // well-formed scalar's meaning is never touched.
  let parsed: unknown;
  try {
    parsed = parseYaml(parts.yaml);
  } catch (firstErr) {
    const repaired = repairYamlEscapes(parts.yaml);
    let salvaged = false;
    if (repaired !== parts.yaml) {
      try {
        parsed = parseYaml(repaired);
        salvaged = true;
      } catch {
        /* repair did not help — fall through to the concrete failure below */
      }
    }
    if (!salvaged) {
      const detail = firstErr instanceof Error ? firstErr.message : String(firstErr);
      throw new Error(
        `stampFollowupLineage: authored frontmatter is not valid YAML even after escape repair: ${detail}. ` +
          "Most often this is a backslash before a backtick or other character inside a double-quoted value — " +
          "do not escape backticks; use single quotes or a block scalar for values containing backticks or backslashes.",
      );
    }
  }
  const authored: Record<string, unknown> =
    parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};

  // An outcome being REPAIRED this pass cannot also be a regression guard ("must
  // still pass unchanged") — exclude any prior outcome whose id the author reused
  // as one of its new outcome ids.
  const authoredOutcomes = Array.isArray(authored.outcomes) ? authored.outcomes : [];
  const authoredIds = new Set(
    authoredOutcomes
      .map((o) => (o !== null && typeof o === "object" ? (o as { id?: unknown }).id : undefined))
      .filter((id): id is string => typeof id === "string"),
  );
  const regression = lineage.priorOutcomes.filter((o) => !authoredIds.has(o.id));

  // Lineage WINS: spread the authored intent, then stamp every infra field over it
  // so a model that wrongly authored `base`/`repo`/etc. cannot poison the lineage.
  const frontmatter = {
    ...authored,
    repo: lineage.repo,
    base: lineage.baseBranch,
    campaign_id: lineage.campaignId,
    parent_run_id: lineage.parentRunId,
    pass: lineage.pass,
    regression_outcomes: regression,
    // Infra, never authored: a model cannot promote its own follow-up onto Daddy's
    // model. Coerce so a lineage that omits it (legacy callers) stamps an explicit
    // false rather than a YAML `null`.
    promoted: lineage.promoted === true,
  };

  const body = parts.body.trim();
  return `---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n\n${body}\n`;
};

// ---------------------------------------------------------------------------
// Assemble commit message and render nits (§18 convergence helpers)
// ---------------------------------------------------------------------------

// Super-daddy authors subject + body; the commit wants them as one string with a
// blank line between (git's subject/body convention). Trim so a model that pads
// the body never leaves a trailing blank-line-only commit.
export const assembleCommitMessage = (cm: CommitMessage): string => {
  const body = cm.body.trim();
  return body.length > 0 ? `${cm.subject.trim()}\n\n${body}` : cm.subject.trim();
};

// Nits surfacing (§10/§13): when the loop is NOT authoring a fix pass,
// super-daddy's findings are the "by the way" notes Max reads in the morning.
// Pure render so it can be unit-tested; the I/O wrapper lives in converge.ts.
export const renderNits = (runId: string, primary: SuperReview): string | undefined => {
  const nits = primary.findings;
  if (nits.length === 0) {
    return undefined;
  }

  const lines = [
    `# Notes — ${runId}`,
    "",
    "Findings from super-daddy's review that the loop is not auto-fixing — here for",
    "your call, not the loop's.",
    "",
  ];
  for (const finding of nits) {
    lines.push(`## [${finding.severity}] ${finding.title}`);
    lines.push(`- id: \`${finding.id}\``);
    if (finding.grounding.kind !== "none" && finding.grounding.ref.trim().length > 0) {
      lines.push(`- grounding (${finding.grounding.kind}): ${finding.grounding.ref}`);
    }
    for (const e of finding.evidence) {
      lines.push(`- ${e}`);
    }
    lines.push("");
  }
  return lines.join("\n");
};
