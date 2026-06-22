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
});
export type PacketFrontmatter = z.infer<typeof PacketFrontmatter>;

export type Packet = {
  runId: string;
  frontmatter: PacketFrontmatter;
  body: string;
  raw: string;
};

// ---------------------------------------------------------------------------
// Admission result type

export type AdmissionResult = { ok: true; packet: Packet } | { ok: false; problems: string[] };

// ---------------------------------------------------------------------------
// Regexes (CONTRACT §4 — must match reference exactly)

export const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const RUNID_RE = /^\d{8}-\d{6}-[a-z0-9-]+$/;
const INFRA_KEYS_RE = /^(repo|base|campaign_id|parent_run_id|pass):/;

// ---------------------------------------------------------------------------
// parsePacketShape — pure parse, no fs, no child_process (CONTRACT K3, D5)

export const parsePacketShape = (raw: string, runId?: string): AdmissionResult => {
  const problems: string[] = [];

  const match = raw.match(FRONTMATTER_RE);
  if (!match || match[1] === undefined) {
    return { ok: false, problems: ["no YAML frontmatter block (--- ... ---) at top of packet"] };
  }

  let yamlValue: unknown;
  try {
    yamlValue = parseYaml(match[1]);
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
  if (new Set(ids).size !== ids.length) problems.push("outcome ids are not unique");

  if (runId) {
    if (!RUNID_RE.test(runId)) {
      problems.push(`packet filename must be YYYYMMDD-HHMMSS-<slug>.md, got: ${runId}`);
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    packet: { runId: runId ?? "", frontmatter: fm.data, body: match[2] ?? "", raw },
  };
};

// ---------------------------------------------------------------------------
// redactPacketInfra — strip infra keys from what models see (CONTRACT K4)

export const redactPacketInfra = (raw: string): string => {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match || match[1] === undefined || match[2] === undefined) return raw;
  const kept = match[1]
    .split("\n")
    .filter((line) => !INFRA_KEYS_RE.test(line))
    .join("\n");
  return `---\n${kept}\n---\n${match[2]}`;
};

// ---------------------------------------------------------------------------
// stampBase — pure half of base stamping given head branch (CONTRACT K1)

export const stampBase = (raw: string, headBranch: string): string => {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match || match[1] === undefined) return raw;

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1]);
  } catch {
    return raw;
  }
  if (parsed === null || typeof parsed !== "object") return raw;
  const fm = parsed as Record<string, unknown>;

  if (typeof fm.base === "string" && fm.base.length > 0) return raw; // explicit override
  if (typeof fm.repo !== "string" || fm.repo.length === 0) return raw; // no repo, can't stamp
  if (headBranch.length === 0 || headBranch === "HEAD") return raw; // detached / no branch

  return `---\nbase: ${headBranch}\n${match[1]}\n---\n${match[2] ?? ""}`;
};

// ---------------------------------------------------------------------------
// YAML frontmatter field extractors — pure string ops, shared by admission
// (store.ts) and queue meta construction (initMetaFromQueue).
// ---------------------------------------------------------------------------

export const extractRepoFromYaml = (raw: string): string | undefined => {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match || !match[1]) return undefined;
  const repoLine = match[1].split("\n").find((line) => /^repo:\s/.test(line));
  if (!repoLine) return undefined;
  const value = repoLine.replace(/^repo:\s*/, "").trim();
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value.startsWith("'") && value.endsWith("'")
      ? value.slice(1, -1)
      : value;
};

export const extractBaseFromYaml = (raw: string): string | undefined => {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match || !match[1]) return undefined;
  const baseLine = match[1].split("\n").find((line) => /^base:\s/.test(line));
  if (!baseLine) return undefined;
  const value = baseLine.replace(/^base:\s*/, "").trim();
  return value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value.startsWith("'") && value.endsWith("'")
      ? value.slice(1, -1)
      : value || undefined;
};
