// Glob translation + file classification (CONTRACT §10 G6, V6).
// Pure, no fs, no git, no Date. The adapter layer translates globs
// to regex and takes the diff path list; this file is borrowable
// by both the driver and the plugin.

// Carried verbatim from v1 watchdog-core (proven glob → regex).
// ** crosses directories, * does not.
export const globToRegExp = (glob: string): RegExp => {
  let pattern = ""
  let i = 0
  while (i < glob.length) {
    const ch = glob[i]
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*"
        i += glob[i + 2] === "/" ? 3 : 2
        continue
      }
      pattern += "[^/]*"
      i += 1
      continue
    }
    pattern += /[a-zA-Z0-9_-]/.test(ch ?? "") ? ch : `\\${ch}`
    i += 1
  }
  return new RegExp(`^${pattern}$`)
}

// V6: the report's files-changed table, mechanical glob-match.
// Takes the diff path list (not a worktree) — the adapter's job
// is to compute that list. Returns every path classified as
// expected | suspicious | acceptable-but-not-predeclared, all kept.
export const classifyChangedFiles = (
  diffPaths: string[],
  expectedGlobs: string[],
  suspiciousGlobs: string[],
): Array<{ path: string } & { classification: "expected" | "suspicious" | "acceptable-but-not-predeclared"; reason: string; action: "kept" }> => {
  const expected = expectedGlobs.map((g) => {
    const re = globToRegExp(g)
    return { re, glob: g }
  })
  const suspicious = suspiciousGlobs.map((g) => {
    const re = globToRegExp(g)
    return { re, glob: g }
  })

  return diffPaths.slice().sort().map((path) => {
    if (expected.some(({ re }) => re.test(path))) {
      return { path, classification: "expected" as const, reason: "in the declared change surface", action: "kept" as const }
    }
    if (suspicious.some(({ re }) => re.test(path))) {
      return { path, classification: "suspicious" as const, reason: "in the suspicious surface — flagged for review", action: "kept" as const }
    }
    return {
      path,
      classification: "acceptable-but-not-predeclared" as const,
      reason: "changed but not in the declared surface",
      action: "kept" as const,
    }
  })
}

// Diff delta arithmetic — pure function of baseline and current stats.
// Called by both the driver (gateTriggerReason) and tests.
export type DiffStats = Record<string, { added: number; removed: number }>

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
