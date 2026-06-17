// Packet parse + admission validation (CONTRACT §4). Fail closed: a packet
// that does not fully validate never enters the queue and never runs (K3, D5).

import { existsSync, readFileSync } from "fs"
import { join, basename } from "path"
import { execSync } from "child_process"
import { parse as parseYaml } from "yaml"
import { PacketFrontmatter, type Packet } from "./schemas.js"
import { expandHome } from "./paths.js"

export const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/

export type AdmissionResult =
  | { ok: true; packet: Packet }
  | { ok: false; problems: string[] }

// Infra-only frontmatter the executor/planner must NOT see: the absolute repo
// path, the base branch, and convergence lineage. Exposing them invites "is the
// project here, or at that path/branch?" confusion (the planner once inspected
// the source repo from the packet's `repo:` path instead of its own worktree).
// The agents work in their cwd, which IS the project root — so strip these lines
// from the packet view. Work fields (outcomes, surface, verification,
// constraints) and the body stay intact.
const INFRA_KEYS_RE = /^(repo|base|campaign_id|parent_run_id|pass):/
export const redactPacketInfra = (raw: string): string => {
  const match = FRONTMATTER_RE.exec(raw)
  if (!match || match[1] === undefined || match[2] === undefined) return raw
  const kept = match[1]
    .split("\n")
    .filter((line) => !INFRA_KEYS_RE.test(line))
    .join("\n")
  return `---\n${kept}\n---\n${match[2]}`
}

// `base` is the branch the worktree forks from — infra Daddy shouldn't have to
// author (it's redacted from the agent view above for the same reason). When the
// packet omits it, stamp the repo's CURRENT branch: at admission Daddy has just
// finished reconning in that repo, so HEAD is the branch the work belongs on.
// Resolved ONCE here, at the admission boundary, then frozen into the queue copy —
// never re-derived at run time, when HEAD may have moved to another run's base.
// An explicit `base:` (e.g. a super-daddy follow-up targeting the parent run's
// branch) is honored as a deliberate override and left untouched. On any failure
// (no frontmatter, bad YAML, missing/detached repo) the raw is returned unchanged
// so parsePacket reports the real, specific problem.
export const stampBaseFromHead = (raw: string): string => {
  const match = FRONTMATTER_RE.exec(raw)
  if (!match || match[1] === undefined) return raw

  let parsed: unknown
  try {
    parsed = parseYaml(match[1])
  } catch {
    return raw
  }
  if (parsed === null || typeof parsed !== "object") return raw
  const fm = parsed as Record<string, unknown>

  if (typeof fm.base === "string" && fm.base.length > 0) return raw // explicit override
  if (typeof fm.repo !== "string" || fm.repo.length === 0) return raw // parse reports missing repo

  let head: string
  try {
    head = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: expandHome(fm.repo),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return raw
  }
  if (head.length === 0 || head === "HEAD") return raw // detached: no branch to fork — parse rejects missing base

  return `---\nbase: ${head}\n${match[1]}\n---\n${match[2] ?? ""}`
}

// runIdOverride: requeued runs re-validate their frozen copy (packet.md),
// whose filename no longer carries the runId — the run dir does.
export const parsePacket = (path: string, runIdOverride?: string): AdmissionResult => {
  const problems: string[] = []
  if (!existsSync(path)) return { ok: false, problems: [`packet not found: ${path}`] }

  const raw = readFileSync(path, "utf-8")
  const match = raw.match(FRONTMATTER_RE)
  if (!match || match[1] === undefined) {
    return { ok: false, problems: ["no YAML frontmatter block (--- ... ---) at top of packet"] }
  }

  let yamlValue: unknown
  try {
    yamlValue = parseYaml(match[1])
  } catch (err) {
    return { ok: false, problems: [`frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`] }
  }

  const fm = PacketFrontmatter.safeParse(yamlValue)
  if (!fm.success) {
    return {
      ok: false,
      problems: fm.error.issues.map((i) => `frontmatter.${i.path.join(".")}: ${i.message}`),
    }
  }

  const frontmatter = { ...fm.data, repo: expandHome(fm.data.repo) }

  const ids = frontmatter.outcomes.map((o) => o.id)
  if (new Set(ids).size !== ids.length) problems.push("outcome ids are not unique")

  if (!existsSync(frontmatter.repo)) {
    problems.push(`repo does not exist: ${frontmatter.repo}`)
  } else if (!existsSync(join(frontmatter.repo, ".git"))) {
    problems.push(`repo is not a git repository: ${frontmatter.repo}`)
  } else {
    try {
      execSync(`git rev-parse --verify --quiet ${JSON.stringify(frontmatter.base)}`, {
        cwd: frontmatter.repo,
        stdio: ["ignore", "pipe", "ignore"],
      })
    } catch {
      problems.push(`base branch does not exist in repo: ${frontmatter.base}`)
    }
  }

  if (problems.length > 0) return { ok: false, problems }

  const runId = runIdOverride ?? basename(path).replace(/\.md$/, "")
  if (!/^\d{8}-\d{6}-[a-z0-9-]+$/.test(runId)) {
    return {
      ok: false,
      problems: [`packet filename must be YYYYMMDD-HHMMSS-<slug>.md, got: ${basename(path)}`],
    }
  }

  return { ok: true, packet: { runId, frontmatter, body: match[2] ?? "", raw } }
}
