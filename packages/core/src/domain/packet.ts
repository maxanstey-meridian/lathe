import { parse as parseYaml } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Packet frontmatter (CONTRACT §4 K1)
// OutcomeDef — shared across packet, campaign regression, finding suggestions

const kebabRegex = /^[a-z0-9][a-z0-9-]*$/;

export const OutcomeDef = z.object({
  id: z.string().regex(kebabRegex, "outcome ids are kebab-case"),
  description: z.string().min(1),
});
export type OutcomeDef = z.infer<typeof OutcomeDef>;

export const VerificationCommand = z.object({
  command: z.string().min(1),
});
export type VerificationCommand = z.infer<typeof VerificationCommand>;

// ---------------------------------------------------------------------------
// Packet (CONTRACT §4)

export const PacketFrontmatter = z.object({
  repo: z.string().min(1),
  base: z.string().min(1),
  // One-line human description of what this run delivers — shown in `meridian
  // tail`'s status bar. Optional so hand-written/older packets still validate.
  summary: z.string().optional(),
  outcomes: z.array(OutcomeDef).min(1),
  expected_surface: z.array(z.string().min(1)).min(1),
  suspicious_surface: z.array(z.string().min(1)).default([]),
  verification: z.array(VerificationCommand).min(1),
  constraints: z.array(z.string()).default([]),
  // Autofix commands to run (best-effort) before verification, scoped to
  // expected_surface — never repo-wide. Harness appends surface entries as
  // quoted arguments; the command's own tooling handles glob expansion.
  autofix_commands: z.array(VerificationCommand).default([]),
  // Convergence lineage. All optional/defaulted.
  campaign_id: z.string().optional(),
  parent_run_id: z.string().optional(),
  pass: z.number().int().min(1).default(1),
  regression_outcomes: z.array(OutcomeDef).default([]),
  // Secret n+1 promotion flag — set by Daddy's follow-up render when promoting
  // Baby's harness onto Daddy's model at the convergence cap. Defaults false so
  // existing packets and the whole test corpus still parse unchanged. Stripped by
  // redactPacketInfra (INFRA_KEYS_RE) so the models never see it.
  promoted: z.boolean().default(false),
});
export type PacketFrontmatter = z.infer<typeof PacketFrontmatter>;

export type Packet = {
  runId: string;
  frontmatter: PacketFrontmatter;
  body: string;
  raw: string;
};

export type FreshQueuePriority = 0 | 1 | 2;

const QueuePriorityFrontmatter = z
  .object({
    campaign_id: z.string().optional(),
    parent_run_id: z.string().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Admission result type

export type AdmissionResult = { ok: true; packet: Packet } | { ok: false; problems: string[] };

// ---------------------------------------------------------------------------
// Regexes (CONTRACT §4)

export const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const RUNID_RE = /^\d{8}-\d{6}-[a-z0-9-]+$/;
const INFRA_KEYS_RE = /^(repo|base|campaign_id|parent_run_id|pass|promoted):/;

// ---------------------------------------------------------------------------
// Tolerant frontmatter extraction (CONTRACT §4 K3) — the ONE place every caller
// goes through to split a packet into (yaml, body).
//
// A model authoring a packet (super-daddy's repair pass, whose reply is several
// assistant messages joined) or a hand-written packet wraps or dirties the
// frontmatter in predictable ways the strict FRONTMATTER_RE rejects even though
// the packet inside is well-formed: narration before the first `---`, a code fence
// around the whole document, CRLF endings, a BOM, or trailing whitespace on the
// `---` delimiter lines. normalizeForFrontmatter cleans exactly those and nothing
// else, so an already-clean packet is returned byte-for-byte unchanged and parses
// identically. It never invents frontmatter: a reply with no `---` line comes back
// (CRLF/BOM aside) untouched, and the caller fails closed.

export const normalizeForFrontmatter = (raw: string): string => {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");

  // Skip any preamble before the first `---` line (narration, a leading ```fence).
  const open = lines.findIndex((l) => l.trim() === "---");
  if (open === -1) {
    return text;
  }
  const sliced = lines.slice(open);

  // Drop a trailing code fence wrapping the packet (its opening fence, if any, was
  // preamble and is already gone with the slice above). The fence may be followed
  // by blank lines (a model often emits "```\n"), so look past trailing blanks to
  // find it — but only TRUNCATE if a fence is actually there, so a fence-less
  // packet keeps its trailing blank lines untouched (the no-op guarantee).
  let end = sliced.length;
  while (end > 0 && sliced[end - 1]?.trim() === "") {
    end--;
  }
  if (end > 0 && sliced[end - 1]?.trim().startsWith("```")) {
    sliced.length = end - 1;
  }

  // Clean the two frontmatter delimiters so `^---\n…\n---` matches even when they
  // carried trailing whitespace. The opening delimiter is sliced[0] by
  // construction; the closing one is the next bare `---`. Body `---` is left alone.
  sliced[0] = "---";
  for (let i = 1; i < sliced.length; i++) {
    if (sliced[i]?.trim() === "---") {
      sliced[i] = "---";
      break;
    }
  }
  return sliced.join("\n");
};

export type FrontmatterParts = { yaml: string; body: string };

// Extract the frontmatter YAML and body from a (possibly dirty) packet string.
// Returns undefined when there is no `--- … ---` block — callers fail closed.
export const extractFrontmatter = (raw: string): FrontmatterParts | undefined => {
  const match = normalizeForFrontmatter(raw).match(FRONTMATTER_RE);
  if (!match || match[1] === undefined) {
    return undefined;
  }
  return { yaml: match[1], body: match[2] ?? "" };
};

export const describeFrontmatterProblem = (raw: string): string => {
  const normalized = normalizeForFrontmatter(raw);
  const lines = normalized.split("\n");
  const open = lines.findIndex((line) => line.trim() === "---");
  if (open === -1) {
    return "no YAML frontmatter opening delimiter (---) found";
  }
  const close = lines.findIndex((line, index) => index > open && line.trim() === "---");
  if (close === -1) {
    const firstBodyLine = lines.find((line, index) => index > open && line.trim().startsWith("#"));
    return firstBodyLine
      ? `YAML frontmatter opened with --- but is missing the closing standalone --- before ${firstBodyLine.trim()}`
      : "YAML frontmatter opened with --- but is missing the closing standalone --- before the markdown body";
  }
  return "no YAML frontmatter block (--- ... ---) at top of packet";
};

// ---------------------------------------------------------------------------
// parsePacketShape — pure parse, no fs, no child_process (CONTRACT K3, D5)

export const parsePacketShape = (raw: string, runId?: string): AdmissionResult => {
  const problems: string[] = [];

  const parts = extractFrontmatter(raw);
  if (!parts) {
    return { ok: false, problems: [describeFrontmatterProblem(raw)] };
  }

  let yamlValue: unknown;
  try {
    yamlValue = parseYaml(parts.yaml);
  } catch (err) {
    return {
      ok: false,
      problems: [
        `frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }

  const fm = PacketFrontmatter.safeParse(yamlValue);
  if (!fm.success) {
    return {
      ok: false,
      problems: fm.error.issues.map((i) => `frontmatter.${i.path.join(".")}: ${i.message}`),
    };
  }

  const ids = fm.data.outcomes.map((o) => o.id);
  if (new Set(ids).size !== ids.length) {
    problems.push("outcome ids are not unique");
  }

  if (runId) {
    if (!RUNID_RE.test(runId)) {
      problems.push(`packet filename must be YYYYMMDD-HHMMSS-<slug>.md, got: ${runId}`);
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }

  return {
    ok: true,
    packet: { runId: runId ?? "", frontmatter: fm.data, body: parts.body, raw },
  };
};

// Fresh queue packets share one filesystem inbox, but lifecycle repair/chain work
// must outrank unrelated packets. Invalid/unparseable packets sort last; admission
// still owns the actual rejection path.
export const freshQueuePriority = (raw: string): FreshQueuePriority => {
  const parts = extractFrontmatter(raw);
  if (!parts) {
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(parts.yaml);
  } catch {
    return 2;
  }

  const fm = QueuePriorityFrontmatter.safeParse(parsed);
  if (!fm.success) {
    return 2;
  }

  if (fm.data.campaign_id !== undefined) {
    return 0;
  }
  if (fm.data.parent_run_id !== undefined) {
    return 1;
  }
  return 2;
};

// ---------------------------------------------------------------------------
// redactPacketInfra — strip infra keys from what models see (CONTRACT K4)

export const redactPacketInfra = (raw: string): string => {
  const parts = extractFrontmatter(raw);
  if (!parts) {
    return raw;
  }
  const kept = parts.yaml
    .split("\n")
    .filter((line) => !INFRA_KEYS_RE.test(line))
    .join("\n");
  return `---\n${kept}\n---\n${parts.body}`;
};

// ---------------------------------------------------------------------------
// stampBase — pure half of base stamping given head branch (CONTRACT K1)

export const stampBase = (raw: string, headBranch: string): string => {
  const parts = extractFrontmatter(raw);
  if (!parts) {
    return raw;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(parts.yaml);
  } catch {
    return raw;
  }
  if (parsed === null || typeof parsed !== "object") {
    return raw;
  }
  const fm = parsed as Record<string, unknown>;

  if (typeof fm.base === "string" && fm.base.length > 0) {
    return raw;
  } // explicit override
  if (typeof fm.repo !== "string" || fm.repo.length === 0) {
    return raw;
  } // no repo, can't stamp
  if (headBranch.length === 0 || headBranch === "HEAD") {
    return raw;
  } // detached / no branch

  return `---\nbase: ${headBranch}\n${parts.yaml}\n---\n${parts.body}`;
};

// ---------------------------------------------------------------------------
// YAML frontmatter field extractors — pure string ops, shared by admission
// (store.ts) and queue meta construction (initMetaFromQueue).
// ---------------------------------------------------------------------------

export const extractRepoFromYaml = (raw: string): string | undefined => {
  const parts = extractFrontmatter(raw);
  if (!parts) {
    return undefined;
  }
  const repoLine = parts.yaml.split("\n").find((line) => /^repo:\s/.test(line));
  if (!repoLine) {
    return undefined;
  }
  const value = repoLine.replace(/^repo:\s*/, "").trim();
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value.startsWith("'") && value.endsWith("'")
      ? value.slice(1, -1)
      : value;
};

export const extractBaseFromYaml = (raw: string): string | undefined => {
  const parts = extractFrontmatter(raw);
  if (!parts) {
    return undefined;
  }
  const baseLine = parts.yaml.split("\n").find((line) => /^base:\s/.test(line));
  if (!baseLine) {
    return undefined;
  }
  const value = baseLine.replace(/^base:\s*/, "").trim();
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value.startsWith("'") && value.endsWith("'")
      ? value.slice(1, -1)
      : value || undefined;
};
