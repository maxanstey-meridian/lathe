import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { FRONTMATTER_RE, type OutcomeDef } from "./packet.js";
import { FinalReviewVerdict } from "./review.js";

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
  | { action: "author"; blockers: Finding[] }
  | { action: "stop" }
  | { action: "escalate"; reason: string };

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
    return { action: "escalate", reason: review.human_decision_needed ?? "reviewer escalated" };
  }
  if (review.verdict === "accept") {
    if (verificationGreen) {
      return { action: "stop" };
    }
    return {
      action: "escalate",
      reason:
        "reviewer accepted but a verification command is red — under-reported; not safe to auto-stop",
    };
  }
  // request_changes — author every finding, bounded only by the pass cap.
  if (review.findings.length === 0) {
    return {
      action: "escalate",
      reason:
        "reviewer requested changes but named no findings — nothing to author; not safe to auto-loop",
    };
  }
  if (pass >= maxPasses) {
    return {
      action: "escalate",
      reason: `hard cap reached (${pass}/${maxPasses}) and the reviewer still wants changes — convergence failed`,
    };
  }
  return { action: "author", blockers: review.findings };
};

// ---------------------------------------------------------------------------
// Fail-closed parse (CONTRACT §18 S11)

// Every top-level {...} object in the text, brace-matched with string/escape
// awareness so a brace inside a JSON string value (or a `}` in prose) can't
// throw off the depth counter.
const balancedObjects = (text: string): string[] => {
  const objects: string[] = [];
  let depth = 0;
  let startIdx = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (depth === 0) {
        startIdx = i;
      }
      depth++;
    } else if (ch === "}" && depth > 0) {
      depth--;
      if (depth === 0 && startIdx !== -1) {
        objects.push(text.slice(startIdx, i + 1));
        startIdx = -1;
      }
    }
  }
  return objects;
};

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
export const extractAuthoredPacket = (text: string): string => {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "---");
  if (start === -1) {
    return text.trim();
  }
  const slice = lines.slice(start);
  while (slice.length > 0) {
    const last = slice[slice.length - 1];
    if (last !== undefined && last.trim().startsWith("```")) {
      slice.pop();
    } else {
      break;
    }
  }
  return `${slice.join("\n").trim()}\n`;
};

export type FollowupLineage = {
  repo: string; // parent repo — infra, never authored
  baseBranch: string; // base for the follow-up = parent run's branch tip
  campaignId: string;
  parentRunId: string; // the run super-daddy just reviewed
  pass: number; // the NEW pass number (parent pass + 1)
  priorOutcomes: OutcomeDef[]; // delivered outcomes carried forward as regression
};

// Pure: (super-daddy's authored packet markdown) + lineage → an admittable packet.
// The author owns the intent (summary/outcomes/surface/verification/constraints/
// body); this stamps the lineage over the top (lineage WINS, stripping any infra
// the model wrongly authored). Throws if the reply has no parseable frontmatter —
// the caller treats that as an authoring failure (re-ask, then escalate), never a
// silent stall.
export const stampFollowupLineage = (authoredRaw: string, lineage: FollowupLineage): string => {
  const packet = extractAuthoredPacket(authoredRaw);
  const match = packet.match(FRONTMATTER_RE);
  if (!match || match[1] === undefined) {
    throw new Error("stampFollowupLineage: authored reply has no YAML frontmatter block");
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch (err) {
    throw new Error(
      `stampFollowupLineage: authored frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  };

  const body = (match[2] ?? "").trim();
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
