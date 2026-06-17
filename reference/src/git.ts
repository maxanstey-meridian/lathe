// Git operations the driver performs (CONTRACT §5, R2–R4). The driver is the
// only thing that commits; Baby's git mutations are denied by the gate plugin.

import { execSync } from "child_process"
import { existsSync, readFileSync, rmSync, statSync, realpathSync } from "fs"
import { join, dirname, relative, isAbsolute, sep } from "path"

const git = (cwd: string, args: string): string =>
  execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim()

export type DiffStats = Record<string, { added: number; removed: number }>

// The run's working tree is a SELF-ROOTED clone, not a `git worktree`. A worktree
// keeps its `.git` as a FILE pointing back to <repo>/.git/worktrees/<name>, whose
// commondir resolves to <repo>/.git — so opencode's glob/grep/LSP compute the
// project root as <repo> and Daddy/super-daddy review the SOURCE tree, not the
// run's work (proven live in the serve log). A clone owns a real `.git` directory,
// so the project root resolves to the sandbox itself and the escape is structurally
// impossible. `--local` (the default for a local source) hardlinks objects — cheap,
// and with no alternates dependency on the source's object store (unlike --shared,
// which a source-repo GC could corrupt mid-run). `--branch <base>` creates a LOCAL
// branch named <base> inside the clone, so every later `git diff <base>` resolves.
export const createRunSandbox = (repo: string, sandboxPath: string, branch: string, base: string): void => {
  const dotGit = join(sandboxPath, ".git")
  // Crash recovery: reuse only a REAL sandbox (a .git directory). A bare/half-made
  // dir is not reused — `git clone` below fails loudly on an occupied path rather
  // than us silently deleting something during setup.
  if (existsSync(dotGit) && statSync(dotGit).isDirectory()) return
  git(dirname(sandboxPath), `clone --local --branch ${JSON.stringify(base)} ${JSON.stringify(repo)} ${JSON.stringify(sandboxPath)}`)
  git(sandboxPath, `checkout -b ${JSON.stringify(branch)}`)
}

// A run sandbox is a self-rooted `--local` clone iff its `.git` is a DIRECTORY
// (a legacy `git worktree` keeps `.git` as a FILE pointing back to the source).
// The two need different ref handling: a clone's branch lives only in its own
// refs and must be fetched into the source repo; a worktree already shares them.
export const isCloneSandbox = (sandboxPath: string): boolean => {
  const dotGit = join(sandboxPath, ".git")
  return existsSync(dotGit) && statSync(dotGit).isDirectory()
}

// Pull a branch out of a run's clone into another repo's ref namespace, e.g. so a
// super-daddy follow-up packet whose `base` is the parent run branch can pass
// admission (`git rev-parse --verify <base>`) and be cloned from the source repo
// at the parent's commits. `meridian accept` does the same fetch before merging.
export const fetchBranchFromClone = (repo: string, clone: string, branch: string): void => {
  git(repo, `fetch ${JSON.stringify(clone)} ${JSON.stringify(`${branch}:${branch}`)}`)
}

// Guarded teardown. `rm -rf` is a footgun, so this refuses unless the target is
// provably a run's OWN sandbox: after resolving symlinks, an absolute real
// directory whose path is exactly <runsDir>/<runId>/worktree and which holds a
// `.git`. A corrupt meta, a symlink, or a stray path can never steer it onto
// something else — every failed check throws instead of deleting.
export const removeRunSandbox = (sandboxPath: string, runsDir: string): void => {
  if (!existsSync(sandboxPath)) return // already tidy — accept is idempotent
  const real = realpathSync(sandboxPath) // resolve symlinks to the TRUE target
  const realRuns = realpathSync(runsDir)
  const rel = relative(realRuns, real)
  const parts = rel.split(sep)
  if (rel.startsWith("..") || isAbsolute(rel) || parts.length !== 2 || parts[1] !== "worktree") {
    throw new Error(
      `refusing to delete ${sandboxPath}: not a <runsDir>/<runId>/worktree path (resolved ${real}; runsDir ${realRuns})`,
    )
  }
  if (!statSync(real).isDirectory()) throw new Error(`refusing to delete ${sandboxPath}: not a directory`)
  if (!existsSync(join(real, ".git"))) throw new Error(`refusing to delete ${sandboxPath}: no .git — not a sandbox`)
  rmSync(real, { recursive: true, force: true })
}

export const worktreeIsDirty = (worktree: string): boolean =>
  git(worktree, "status --porcelain").length > 0

// One WIP commit per run attempt (R3): at terminal status, park, or crash
// recovery. Returns undefined when there is nothing to commit.
export const wipCommit = (worktree: string, message: string): string | undefined => {
  if (!worktreeIsDirty(worktree)) return undefined
  git(worktree, "add -A")
  git(worktree, `commit -m ${JSON.stringify(message)} --no-verify`)
  return git(worktree, "rev-parse HEAD")
}

// Reword HEAD (R3): on convergence, super-daddy's commit message replaces the
// throwaway WIP line. Nothing is staged at this point (wipCommit already
// committed the tree), so --amend only rewords. Returns the new HEAD sha.
export const amendCommitMessage = (worktree: string, message: string): string => {
  git(worktree, `commit --amend -m ${JSON.stringify(message)} --no-verify`)
  return git(worktree, "rev-parse HEAD")
}

export const diffNameOnly = (worktree: string): string[] =>
  git(worktree, "diff --name-only HEAD").split("\n").map((l) => l.trim()).filter(Boolean)

// Diff against BASE, not HEAD. On resume the executor's prior work is
// WIP-committed (R3), so `diff HEAD` reads clean and the resume/rotation seed
// renders "(clean)" — telling a resumed executor "no changes exist" when its
// work is sitting in the commit. That false premise has parked completed runs
// (the executor reports the work missing; the planner, provoked, issues `stop`).
// `diff <base>` shows everything since the branch point — committed AND
// uncommitted — i.e. the actual work done this run, which is what the seed wants.
export const diffStat = (worktree: string, base: string): string => {
  try {
    return git(worktree, `diff --stat ${base}`)
  } catch {
    return ""
  }
}

// Carried from v1 watchdog-core (proven): numstat plus untracked text files, so
// junk files count toward the work interval and the surface check (v1 seam,
// accepted again in v2 §18).
export const readDiffStats = (worktree: string): DiffStats => {
  const stats: DiffStats = {}
  try {
    const output = git(worktree, "diff --numstat HEAD")
    for (const line of output.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [addedText, removedText, ...pathParts] = trimmed.split(/\s+/)
      const path = pathParts.join(" ")
      if (!path) continue
      const added = Number.parseInt(addedText ?? "0", 10)
      const removed = Number.parseInt(removedText ?? "0", 10)
      stats[path] = {
        added: Number.isFinite(added) ? added : 0,
        removed: Number.isFinite(removed) ? removed : 0,
      }
    }

    const untracked = git(worktree, "ls-files --others --exclude-standard")
    for (const file of untracked.split("\n").map((l) => l.trim()).filter(Boolean)) {
      // Dependency trees are never work product; without a .gitignore in the
      // target repo they'd count as thousands of out-of-surface files (seen
      // live: pnpm install latched the gate on node_modules/.bin/tsc et al).
      if (file.startsWith("node_modules/") || file.includes("/node_modules/")) continue
      if (stats[file]) continue
      const fullPath = join(worktree, file)
      if (!existsSync(fullPath)) continue
      try {
        const content = readFileSync(fullPath)
        if (content.length > 1024 * 1024 || content.includes(0)) continue
        stats[file] = { added: content.toString("utf-8").split("\n").length, removed: 0 }
      } catch {
        // Binary/unreadable untracked files do not count toward text LoC.
      }
    }
  } catch {
    // An unreadable diff returns what we have; the gate triggers that depend on
    // it simply see no delta. The surface gate itself cannot fail open this way
    // because globs come from validated frontmatter, not from this function.
  }
  return stats
}

// V7: the patch Daddy reviews at final review — tracked changes plus the
// contents of new untracked text files (the same node_modules/binary exclusions
// readDiffStats uses), capped so a large run can't blow Daddy's context. A
// truncation marker tells him to inspect the real tree (he has read-only repo
// tools); the cap is a floor on visibility, not the source of truth.
export const reviewableDiff = (worktree: string, maxBytes: number): string => {
  const sections: string[] = []
  try {
    const tracked = git(worktree, "diff HEAD")
    if (tracked) sections.push(tracked)
  } catch {
    /* unreadable diff → rely on the untracked listing + Daddy's own inspection */
  }
  try {
    const untracked = git(worktree, "ls-files --others --exclude-standard")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((f) => !f.startsWith("node_modules/") && !f.includes("/node_modules/"))
    for (const file of untracked) {
      const fullPath = join(worktree, file)
      if (!existsSync(fullPath)) continue
      try {
        const content = readFileSync(fullPath)
        if (content.length > 1024 * 1024 || content.includes(0)) continue
        sections.push(`--- new file: ${file} ---\n${content.toString("utf-8")}`)
      } catch {
        /* binary/unreadable untracked file — skip */
      }
    }
  } catch {
    /* no untracked listing available */
  }

  const full = sections.join("\n\n")
  if (full.length <= maxBytes) return full || "(no changes in the worktree)"
  return `${full.slice(0, maxBytes)}\n\n[diff truncated at ${maxBytes} bytes — run \`git diff HEAD\` and read files directly for the full picture]`
}

// Super-daddy reviews a FINISHED run, whose work the driver has already WIP-
// committed — so `git diff HEAD` (what reviewableDiff shows mid-run) is empty.
// The reviewable surface is the whole run branch against its base: `git diff
// <base>` captures committed WIP and any stray uncommitted edits in one shot.
// Untracked handling mirrors reviewableDiff so a new-file-only run still shows.
export const reviewableDiffAgainst = (worktree: string, base: string, maxBytes: number): string => {
  const sections: string[] = []
  try {
    const tracked = git(worktree, `diff ${base}`)
    if (tracked) sections.push(tracked)
  } catch {
    /* unreadable diff → rely on the untracked listing + super-daddy's own inspection */
  }
  try {
    const untracked = git(worktree, "ls-files --others --exclude-standard")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((f) => !f.startsWith("node_modules/") && !f.includes("/node_modules/"))
    for (const file of untracked) {
      const fullPath = join(worktree, file)
      if (!existsSync(fullPath)) continue
      try {
        const content = readFileSync(fullPath)
        if (content.length > 1024 * 1024 || content.includes(0)) continue
        sections.push(`--- new file: ${file} ---\n${content.toString("utf-8")}`)
      } catch {
        /* binary/unreadable untracked file — skip */
      }
    }
  } catch {
    /* no untracked listing available */
  }

  const full = sections.join("\n\n")
  if (full.length <= maxBytes) return full || "(no changes on this branch vs base)"
  return `${full.slice(0, maxBytes)}\n\n[diff truncated at ${maxBytes} bytes — run \`git diff ${base}\` and read files directly for the full picture]`
}

export const diffDelta = (
  baseline: DiffStats,
  current: DiffStats,
): { files: string[]; loc: number } => {
  const all = new Set([...Object.keys(baseline), ...Object.keys(current)])
  const changed: string[] = []
  let loc = 0
  for (const file of all) {
    const before = baseline[file] ?? { added: 0, removed: 0 }
    const after = current[file] ?? { added: 0, removed: 0 }
    const delta = Math.abs(after.added - before.added) + Math.abs(after.removed - before.removed)
    if (delta > 0) {
      changed.push(file)
      loc += delta
    }
  }
  return { files: changed, loc }
}
