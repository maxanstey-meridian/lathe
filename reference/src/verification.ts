// Mechanical verification enforcement (CONTRACT §11). The driver executes the
// packet's verification commands ITSELF, in the worktree, at submission time —
// real exit codes, no parsing of the executor's bash activity, and staleness
// is impossible by construction (the run happens after all mutations).
//
// Baby running tests itself mid-run is fine and encouraged for iteration; it
// just isn't what acceptance is based on.

import { execSync } from "child_process"
import { resolve } from "path"
import type { SubmitReport, OutcomeLedger, PacketFrontmatter, ReportFile } from "./schemas.js"
import { globToRegExp } from "./gate.js"
import { readDiffStats } from "./git.js"

export type VerificationResult = { command: string; exitCode: number; outputTail: string }

export const runVerification = (
  frontmatter: PacketFrontmatter,
  worktree: string,
  timeoutMs: number,
): VerificationResult[] => {
  const wt = resolve(worktree)
  return frontmatter.verification.map((v) => {
    // Ground truth ALWAYS runs at the worktree root (CONTRACT §11) — there is no
    // per-command cwd to point it elsewhere. Commands run through a shell, so a
    // subdir need is expressed in the command itself (`cd sub && …`, `-C`, or a
    // path arg), which can't escape the worktree. The removed `cwd:` field's only
    // power over the command string was an absolute path OUT of the worktree —
    // exactly the wrong-tree hazard the guard used to refuse, now unexpressible.
    try {
      const output = execSync(v.command, {
        cwd: wt,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: timeoutMs,
        shell: "/bin/zsh",
      })
      return { command: v.command, exitCode: 0, outputTail: output.slice(-400) }
    } catch (err) {
      const e = err as { status?: number | null; stdout?: string; stderr?: string; message?: string }
      return {
        command: v.command,
        exitCode: typeof e.status === "number" ? e.status : 1,
        outputTail: `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-400) || (e.message ?? "failed"),
      }
    }
  })
}

// V6: the report's files-changed table, built by the DRIVER from the worktree
// diff — not the executor. Completeness is therefore structural: the table IS
// the diff, so it can never omit a changed file. Classification is mechanical
// glob-matching against the packet surface; the JUDGEMENT on whether an
// out-of-surface change is acceptable belongs to Daddy's final review (V7), not
// to Baby. The executor narrates WHY a file changed in its prose summary; this
// function records WHAT changed, objectively.
export const classifyChangedFiles = (
  worktree: string,
  expectedGlobs: string[],
  suspiciousGlobs: string[],
): ReportFile[] => {
  const expected = expectedGlobs.map(globToRegExp)
  const suspicious = suspiciousGlobs.map(globToRegExp)
  return Object.keys(readDiffStats(worktree))
    .sort()
    .map((path) => {
      if (expected.some((re) => re.test(path))) {
        return { path, classification: "expected" as const, reason: "in the declared change surface", action: "kept" as const }
      }
      if (suspicious.some((re) => re.test(path))) {
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

// V1: the verification block of the report is the driver's OWN run, not the
// executor's claim — real exit codes from runVerification, recorded verbatim.
export const toVerificationClaims = (
  results: VerificationResult[],
): SubmitReport["verificationClaims"] =>
  results.map((r) => ({
    command: r.command,
    result: r.exitCode === 0 ? ("passed" as const) : ("failed" as const),
    ...(r.outputTail ? { notes: r.outputTail.slice(-200) } : {}),
  }))

// V3: report outcome claims must match the ledger, and ready_for_review
// requires every outcome resolved.
export const outcomeProblems = (report: SubmitReport, ledger: OutcomeLedger): string[] => {
  const problems: string[] = []
  const byId = new Map(ledger.outcomes.map((o) => [o.id, o]))

  for (const claim of report.outcomeClaims) {
    const entry = byId.get(claim.id)
    if (!entry) {
      problems.push(`report claims unknown outcome id: ${claim.id}`)
      continue
    }
    if (entry.status !== claim.status) {
      problems.push(
        `report claims outcome ${claim.id} is ${claim.status} but the ledger says ${entry.status} — update the ledger via update_outcomes (with evidence) or correct the claim`,
      )
    }
  }

  for (const entry of ledger.outcomes) {
    if (!report.outcomeClaims.some((c) => c.id === entry.id)) {
      problems.push(`report omits outcome ${entry.id} — every outcome must be claimed`)
    }
  }

  if (report.status === "ready_for_review") {
    for (const entry of ledger.outcomes) {
      if (entry.status !== "done") {
        problems.push(
          `ready_for_review requires every outcome done; ${entry.id} is ${entry.status} — finish it, or submit as blocked/failed`,
        )
      }
    }
  }

  return problems
}
