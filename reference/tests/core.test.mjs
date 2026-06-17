// Pure-logic tests over the compiled output (pnpm build first; `pnpm test`
// runs both). Each block names the CONTRACT clause it pins.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"

import { globToRegExp, gateTriggerReason, checkpointNudgeDue, rotationGateState, volumeCheckpointReason } from "../dist/gate.js"
import { parsePlannerResponse } from "../dist/planner.js"
import { outcomeProblems, runVerification, classifyChangedFiles } from "../dist/verification.js"
import { checkpointProblems, decideStallRecovery, stallAction } from "../dist/runtime.js"
import { parsePacket, stampBaseFromHead } from "../dist/packet.js"
import { diffDelta, reviewableDiff, createRunSandbox, removeRunSandbox } from "../dist/git.js"
import { parseFinalReview, renderFinalReview } from "../dist/final-review.js"
import {
  decideConvergence,
  parseSuperReview,
  renderFollowupPacket,
} from "../dist/convergence.js"
import { renderSuperReview } from "../dist/super-review.js"
import { upsertPass } from "../dist/campaign.js"
import { renderNits, assembleCommitMessage } from "../dist/converge.js"
import { qPlannerDecision, qPlannerUnavailable } from "../dist/prompts.js"
import { parseStaged, convergedTip, decidePromotion } from "../dist/chain.js"

// --- G3/G5: glob translation (carried from v1) -------------------------------

test("globToRegExp: ** crosses directories, * does not", () => {
  assert.ok(globToRegExp("src/**").test("src/a/b/c.ts"))
  assert.ok(globToRegExp("src/*.ts").test("src/a.ts"))
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"))
  assert.ok(globToRegExp("greeting.txt").test("greeting.txt"))
  assert.ok(!globToRegExp("greeting.txt").test("other.txt"))
})

// --- M3 fail-closed planner parse --------------------------------------------

test("parsePlannerResponse: fenced JSON, bare JSON, garbage → stop", () => {
  const good = { status: "proceed", answer: "a", constraints: [], evidence_used: [], safe_next_action: "x", human_decision_needed: null }
  assert.equal(parsePlannerResponse(JSON.stringify(good)).status, "proceed")
  assert.equal(parsePlannerResponse("```json\n" + JSON.stringify(good) + "\n```").status, "proceed")
  assert.equal(parsePlannerResponse("prefix " + JSON.stringify(good) + " suffix").status, "proceed")
  assert.equal(parsePlannerResponse("I think you should probably proceed").status, "stop")
  assert.equal(parsePlannerResponse('{"status": "ask_repo_first", "answer": "x"}').status, "stop") // deleted status → invalid → stop
})

// --- planner parse robustness: verbose reasoning with stray braces, JSON last --
// Pins the live failure (chess run 20260613-143821): GLM-as-Daddy emitted
// chain-of-thought containing braces, then valid JSON at the end. The v1
// "first { to last }" slice spanned both and failed → false stop → park.

test("parsePlannerResponse: reasoning prose with braces then trailing JSON → parses the verdict", () => {
  const verbose = `Let me weigh this. squares: Array<Array<Piece | null>>.
I considered { mailbox } and { 0x88 } board representations before deciding.
Here is my verdict:
{"status":"proceed_with_constraints","answer":"8x8 copy-and-test endorsed","constraints":["copyBoard must deep-copy"],"evidence_used":["packet"],"safe_next_action":"write board.ts","human_decision_needed":null}`
  const r = parsePlannerResponse(verbose)
  assert.equal(r.status, "proceed_with_constraints")
  assert.equal(r.constraints[0], "copyBoard must deep-copy")
})

// --- V3: outcome claims vs ledger --------------------------------------------

const ledger = (entries) => ({ runId: "r", outcomes: entries, updatedAt: "t" })
const entry = (id, status, evidence = []) => ({ id, description: id, status, evidence, updatedAt: "t" })
const report = (status, claims) => ({
  status,
  summary: "s",
  filesChanged: [],
  behaviourChanged: [],
  sourceOfTruthFollowed: [],
  outcomeClaims: claims,
  verificationClaims: [],
  escalations: [],
  remainingUncertainty: [],
})

test("outcomeProblems: mismatch, omission, and ready-with-unfinished all rejected", () => {
  const l = ledger([entry("a", "done", ["ev"]), entry("b", "in_progress")])
  assert.equal(outcomeProblems(report("blocked", [{ id: "a", status: "done" }, { id: "b", status: "in_progress" }]), l).length, 0)
  assert.ok(outcomeProblems(report("blocked", [{ id: "a", status: "done" }]), l).some((p) => p.includes("omits")))
  assert.ok(outcomeProblems(report("blocked", [{ id: "a", status: "in_progress" }, { id: "b", status: "in_progress" }]), l).some((p) => p.includes("ledger says")))
  assert.ok(outcomeProblems(report("ready_for_review", [{ id: "a", status: "done" }, { id: "b", status: "in_progress" }]), l).some((p) => p.includes("requires every outcome done")))
})

// --- O4: checkpoint validation -------------------------------------------------

const packet = {
  runId: "r",
  frontmatter: {
    repo: "/x",
    base: "main",
    outcomes: [{ id: "a", description: "a" }, { id: "b", description: "b" }],
    expected_surface: ["src/**"],
    suspicious_surface: [],
    verification: [{ command: "true" }],
    constraints: [],
  },
  body: "",
  raw: "",
}

// The driver now ASSEMBLES the checkpoint from the ledger, so the outcome block
// cannot diverge from its source — checkpointProblems is reduced to defence:
// every packet outcome present, no phantom ids, done implies evidence. The old
// state/next-action and ledger-mismatch checks are gone (they policed structure
// the executor no longer writes).
test("checkpointProblems: defensive checks — omission, unknown id, done-without-evidence", () => {
  const l = ledger([entry("a", "done", ["ev"]), entry("b", "in_progress")])
  const cp = (outcomes) => ({ number: 1, reason: "rotation", summary: "s", outcomes, filesChanged: [], filesInspected: [], uncertainties: [], writtenAt: "t" })

  // A faithful assembly from the ledger passes — including an in_progress entry
  // with no structured state (it now lives in the prose summary instead).
  const valid = cp([
    { id: "a", status: "done", evidence: ["ev"] },
    { id: "b", status: "in_progress", evidence: [] },
  ])
  assert.equal(checkpointProblems(valid, packet, l).length, 0)

  assert.ok(checkpointProblems(cp([{ id: "a", status: "done", evidence: ["ev"] }]), packet, l).some((p) => p.includes("omits")))
  assert.ok(
    checkpointProblems(cp([{ id: "a", status: "done", evidence: ["ev"] }, { id: "b", status: "in_progress", evidence: [] }, { id: "z", status: "done", evidence: ["ev"] }]), packet, l)
      .some((p) => p.includes("unknown outcome")),
  )
  assert.ok(
    checkpointProblems(cp([{ id: "a", status: "done", evidence: [] }, { id: "b", status: "in_progress", evidence: [] }]), packet, l)
      .some((p) => p.includes("no evidence")),
  )
})

// --- V6: driver-built files-changed table (classification is mechanical) --------

test("classifyChangedFiles: globs decide classification; the table IS the diff", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumb-classify-"))
  try {
    execSync("git init -q -b main && git commit -q --allow-empty -m init", { cwd: dir, shell: "/bin/zsh" })
    mkdirSync(join(dir, "src"))
    writeFileSync(join(dir, "src", "in.ts"), "export const a = 1\n")
    mkdirSync(join(dir, "weird"))
    writeFileSync(join(dir, "weird", "sus.ts"), "export const b = 2\n")
    writeFileSync(join(dir, "stray.txt"), "loose\n")

    const files = classifyChangedFiles(dir, ["src/**"], ["weird/**"])
    const byPath = Object.fromEntries(files.map((f) => [f.path, f.classification]))

    assert.equal(byPath["src/in.ts"], "expected")
    assert.equal(byPath["weird/sus.ts"], "suspicious")
    assert.equal(byPath["stray.txt"], "acceptable-but-not-predeclared")
    // Completeness is structural: every changed file is present, all kept.
    assert.equal(files.length, 3)
    assert.ok(files.every((f) => f.action === "kept"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- K3: admission fail-closed -------------------------------------------------

test("parsePacket: bad filename, missing repo, valid case", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumb-test-"))
  try {
    const repo = join(dir, "repo")
    mkdirSync(repo)
    execSync("git init -q -b main && git commit -q --allow-empty -m init", { cwd: repo, shell: "/bin/zsh" })

    const fm = (repoPath) => `---
repo: ${repoPath}
base: main
outcomes:
  - id: a
    description: a happens
expected_surface:
  - "src/**"
verification:
  - command: "true"
---
body`

    const badName = join(dir, "not-a-valid-name.md")
    writeFileSync(badName, fm(repo))
    const r1 = parsePacket(badName)
    assert.ok(!r1.ok && r1.problems.some((p) => p.includes("filename")))

    const missingRepo = join(dir, "20260612-120000-x.md")
    writeFileSync(missingRepo, fm(join(dir, "nope")))
    const r2 = parsePacket(missingRepo)
    assert.ok(!r2.ok && r2.problems.some((p) => p.includes("does not exist")))

    const good = join(dir, "20260612-120001-good.md")
    writeFileSync(good, fm(repo))
    const r3 = parsePacket(good)
    assert.ok(r3.ok)
    assert.equal(r3.packet.runId, "20260612-120001-good")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- G5: trigger priority on a real worktree ------------------------------------

test("gateTriggerReason: only first-edit and reconciliation gate — no work/time cadence", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumb-gate-"))
  try {
    execSync("git init -q -b main && git commit -q --allow-empty -m init", { cwd: dir, shell: "/bin/zsh" })
    const base = {
      runId: "r",
      latched: false,
      firstEditApproved: false,
      reconciliationRequired: false,
      expectedGlobs: ["allowed/**"],
      suspiciousGlobs: [],
      baselineDiffStats: {},
      mutationCommandPatterns: [],
      updatedAt: "t",
    }

    // Clean tree, first edit unapproved → no latch demanded until an edit lands.
    assert.equal(gateTriggerReason(base, dir), undefined)

    // Out-of-surface file no longer wins a surface block (gate removed); it is
    // simply the first edit landing → first-edit reason, same as any file.
    writeFileSync(join(dir, "rogue.txt"), "boo\n")
    const reason = gateTriggerReason(base, dir)
    assert.ok(reason?.includes("first edit"), reason)
    assert.ok(!reason?.includes("out-of-surface"), "surface gate must be gone: " + reason)

    // Once first edit is approved, NO cadence gates — a large delta does not
    // trip a work-interval checkpoint (cadence removed).
    writeFileSync(join(dir, "big.txt"), Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n")
    const approved = { ...base, firstEditApproved: true }
    assert.equal(gateTriggerReason(approved, dir), undefined, "work-interval cadence must be gone")

    // A stale accepted-decision timestamp does not trip a time-interval
    // checkpoint either (cadence removed).
    const stale = { ...approved, lastAcceptedDecisionAt: new Date(Date.now() - 30 * 60 * 1000).toISOString() }
    assert.equal(gateTriggerReason(stale, dir), undefined, "time-interval cadence must be gone")

    // Reconciliation still latches regardless of cadence.
    const recon = { ...approved, reconciliationRequired: true }
    assert.ok(gateTriggerReason(recon, dir)?.includes("reconciliation"), "reconciliation must still gate")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("rotationGateState: every replaced session re-latches first-edit; crash path stacks reconciliation", () => {
  const base = {
    runId: "r",
    latched: false,
    firstEditApproved: true, // the prior session had already earned approval
    reconciliationRequired: false,
    expectedGlobs: ["allowed/**"],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    mutationCommandPatterns: [],
    updatedAt: "t",
  }

  // Clean rotation (valid checkpoint): first-edit re-latched, no reconciliation.
  const clean = rotationGateState(base, true)
  assert.equal(clean.next.firstEditApproved, false, "a replaced session must re-earn first-edit approval")
  assert.equal(clean.next.latched, true)
  assert.equal(clean.next.reconciliationRequired, false, "a valid checkpoint needs no reconciliation")
  assert.ok(clean.reason.includes("first edit"), clean.reason)

  // Crash rotation (no checkpoint): reconciliation stacked on the first-edit latch.
  const crash = rotationGateState(base, false)
  assert.equal(crash.next.firstEditApproved, false)
  assert.equal(crash.next.latched, true)
  assert.equal(crash.next.reconciliationRequired, true, "no checkpoint → reconciliation")
  assert.ok(crash.reason.includes("reconciliation"), crash.reason)
})

test("volumeCheckpointReason: tool calls OR files OR LoC since check-in trips the non-blocking shout, whichever first", () => {
  const limits = { checkpointToolCalls: 50, checkpointFiles: 6, checkpointLoc: 80 }
  const noDelta = { files: [], loc: 0 }

  // Under every threshold → silent.
  assert.equal(volumeCheckpointReason(49, noDelta, limits), undefined)

  // Tool-call axis — the read-heavy spiral the diff axes are blind to.
  const tc = volumeCheckpointReason(50, noDelta, limits)
  assert.ok(tc?.includes("50 tool calls"), tc)

  // Files axis (tool calls under the line).
  const f = volumeCheckpointReason(3, { files: ["a", "b", "c", "d", "e", "f"], loc: 10 }, limits)
  assert.ok(f?.includes("6 files"), f)

  // LoC axis.
  const l = volumeCheckpointReason(3, { files: ["a"], loc: 80 }, limits)
  assert.ok(l?.includes("80 changed LoC"), l)

  // Tool-call axis wins the message when both cross (checked first).
  const both = volumeCheckpointReason(50, { files: ["a", "b", "c", "d", "e", "f"], loc: 99 }, limits)
  assert.ok(both?.includes("tool calls"), both)
})

test("checkpointNudgeDue: the cadence reborn as a non-blocking, un-throttled shout", () => {
  const INTERVAL = 20 * 60 * 1000
  const now = Date.now()
  const iso = (msAgo) => new Date(now - msAgo).toISOString()
  const base = {
    runId: "r",
    latched: false,
    firstEditApproved: true,
    reconciliationRequired: false,
    expectedGlobs: [],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    mutationCommandPatterns: [],
    updatedAt: "t",
  }

  // A fresh run (no plan accepted yet) is never nagged.
  assert.equal(checkpointNudgeDue({ ...base, firstEditApproved: false, lastAcceptedDecisionAt: iso(INTERVAL * 2) }, now, INTERVAL), undefined)

  // Approved but no accepted-decision timestamp → nothing to measure from.
  assert.equal(checkpointNudgeDue(base, now, INTERVAL), undefined)

  // Within the interval → not due (the grace before nagging starts).
  assert.equal(checkpointNudgeDue({ ...base, lastAcceptedDecisionAt: iso(5 * 60 * 1000) }, now, INTERVAL), undefined)

  // Past the interval → due, reports the elapsed minutes since the last check-in.
  assert.equal(checkpointNudgeDue({ ...base, lastAcceptedDecisionAt: iso(30 * 60 * 1000) }, now, INTERVAL), 30)

  // NOT throttled: there is no nudge-silencing state. As long as the last check-in
  // is past the interval it stays due — every turn — until clearGate moves
  // lastAcceptedDecisionAt forward. The minutes simply keep climbing.
  assert.equal(checkpointNudgeDue({ ...base, lastAcceptedDecisionAt: iso(90 * 60 * 1000) }, now, INTERVAL), 90)
})

// --- V1: driver-executed verification -------------------------------------------

test("runVerification: real exit codes from driver-side execution", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumb-verify-"))
  try {
    writeFileSync(join(dir, "greeting.txt"), "hello\n")
    const fm = {
      ...packet.frontmatter,
      verification: [{ command: "grep -q hello greeting.txt" }, { command: "grep -q goodbye greeting.txt" }],
    }
    const results = runVerification(fm, dir, 10_000)
    assert.equal(results[0].exitCode, 0)
    assert.notEqual(results[1].exitCode, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("runVerification: commands always run at the worktree root; a subdir need goes in the command", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumb-verify-"))
  try {
    // No `cwd:` field exists any more — ground truth always runs at the worktree
    // root. A subdir is reached via the shell (`cd sub && …`), which stays in-tree;
    // a marker at the root proves the cwd, and a stray `cwd:` key on an old packet
    // is ignored (zod strips it) rather than steering execution.
    mkdirSync(join(dir, "sub"))
    writeFileSync(join(dir, "marker.txt"), "x\n")
    writeFileSync(join(dir, "sub", "inner.txt"), "y\n")
    const fm = {
      ...packet.frontmatter,
      verification: [
        { command: "test -f marker.txt" }, // root cwd
        { command: "cd sub && test -f inner.txt" }, // subdir via the shell
        { command: "test -f marker.txt", cwd: "/tmp" }, // stray cwd ignored → still root
      ],
    }
    const results = runVerification(fm, dir, 10_000)
    assert.equal(results[0].exitCode, 0)
    assert.equal(results[1].exitCode, 0)
    assert.equal(results[2].exitCode, 0) // ran at root despite the stray cwd
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- self-rooted sandbox: the wrong-tree fix --------------------------------------

const initSourceRepo = (root) => {
  const repo = join(root, "source")
  mkdirSync(repo)
  const g = (c) => execSync(`git ${c}`, { cwd: repo, stdio: "ignore" })
  g("init -q -b main")
  g("config user.email t@t.t")
  g("config user.name t")
  writeFileSync(join(repo, "a.txt"), "base\n")
  g("add -A")
  g("commit -qm base")
  const baseSha = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim()
  return { repo, baseSha }
}

test("stampBaseFromHead: omitted base is stamped from the repo's current branch; explicit base is honored", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plumb-base-"))
  try {
    const repo = join(tmp, "source")
    mkdirSync(repo)
    const g = (c) => execSync(`git ${c}`, { cwd: repo, stdio: "ignore" })
    g("init -q -b main")
    g("config user.email t@t.t")
    g("config user.name t")
    g("commit -q --allow-empty -m init")
    g("checkout -q -b uploads") // the branch Daddy reconned in — HEAD is the intended base

    const baseless = `---\nrepo: ${repo}\noutcomes:\n  - id: x\n    description: y\n---\nbody`

    // Omitted base → stamped with the repo's CURRENT branch, not a hardcoded default.
    const stamped = stampBaseFromHead(baseless)
    assert.match(stamped, /^---\nbase: uploads\n/, "must stamp HEAD branch as base")
    assert.ok(stamped.endsWith("---\nbody"), "body preserved")

    // Explicit base is a deliberate override (e.g. super-daddy follow-up) — never clobbered.
    const explicit = baseless.replace(`repo: ${repo}\n`, `repo: ${repo}\nbase: some-other-branch\n`)
    assert.equal(stampBaseFromHead(explicit), explicit, "explicit base left untouched")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("createRunSandbox: a self-rooted clone — .git is a real dir (no worktree linkage), forked at base", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plumb-sandbox-"))
  try {
    const { repo, baseSha } = initSourceRepo(tmp)
    const runsDir = join(tmp, "runs")
    const sandbox = join(runsDir, "20990101-000000-x", "worktree")
    mkdirSync(join(runsDir, "20990101-000000-x"), { recursive: true })

    createRunSandbox(repo, sandbox, "meridian/x", "main")

    // The whole point: .git is a real DIRECTORY, not a worktree pointer file, and
    // carries no commondir linking back to the source repo. This is the regression
    // guard — a worktree would fail both.
    assert.ok(statSync(join(sandbox, ".git")).isDirectory(), ".git must be a directory")
    assert.ok(!existsSync(join(sandbox, ".git", "commondir")), "must not be a linked worktree")
    // Run branch checked out, forked exactly at base.
    assert.equal(execSync("git rev-parse --abbrev-ref HEAD", { cwd: sandbox }).toString().trim(), "meridian/x")
    assert.equal(execSync("git rev-parse HEAD", { cwd: sandbox }).toString().trim(), baseSha)
    // A LOCAL <base> branch exists so later `git diff <base>` resolves inside the clone.
    execSync("git rev-parse --verify main", { cwd: sandbox, stdio: "ignore" }) // throws if absent
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("removeRunSandbox: deletes only a real <runsDir>/<id>/worktree sandbox; refuses everything else", () => {
  const tmp = mkdtempSync(join(tmpdir(), "plumb-rm-"))
  try {
    const runsDir = join(tmp, "runs")
    const sandbox = join(runsDir, "20990101-000000-x", "worktree")
    mkdirSync(sandbox, { recursive: true })
    mkdirSync(join(sandbox, ".git")) // looks like a real sandbox

    // Refuses: runsDir itself, the run dir, a non-"worktree" sibling, an outside
    // path, and a "worktree" dir with no .git. None of these get deleted.
    assert.throws(() => removeRunSandbox(runsDir, runsDir), /refusing to delete/)
    assert.throws(() => removeRunSandbox(join(runsDir, "20990101-000000-x"), runsDir), /refusing to delete/)
    const sibling = join(runsDir, "20990101-000000-x", "other")
    mkdirSync(sibling)
    mkdirSync(join(sibling, ".git"))
    assert.throws(() => removeRunSandbox(sibling, runsDir), /refusing to delete/)
    const outside = join(tmp, "elsewhere")
    mkdirSync(outside)
    mkdirSync(join(outside, ".git"))
    assert.throws(() => removeRunSandbox(outside, runsDir), /refusing to delete/)
    const noGit = join(runsDir, "20990101-000000-y", "worktree")
    mkdirSync(noGit, { recursive: true })
    assert.throws(() => removeRunSandbox(noGit, runsDir), /no \.git/)

    // Everything it refused still exists.
    assert.ok(existsSync(sandbox) && existsSync(sibling) && existsSync(outside) && existsSync(noGit))
    // A missing path is a no-op (accept is idempotent).
    removeRunSandbox(join(runsDir, "gone", "worktree"), runsDir)
    // The genuine article IS deleted.
    removeRunSandbox(sandbox, runsDir)
    assert.ok(!existsSync(sandbox), "the real sandbox is deleted")
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

// --- diff delta arithmetic -------------------------------------------------------

test("diffDelta: counts files and LoC against baseline", () => {
  const baseline = { "a.ts": { added: 5, removed: 0 } }
  const current = { "a.ts": { added: 9, removed: 1 }, "b.ts": { added: 3, removed: 0 } }
  const delta = diffDelta(baseline, current)
  assert.deepEqual(delta.files.sort(), ["a.ts", "b.ts"])
  assert.equal(delta.loc, 5 + 3)
})

// --- V7: final review fails closed -----------------------------------------------

test("parseFinalReview: valid verdicts parse; garbage and bad verdicts → request_changes", () => {
  const accept = { verdict: "accept", findings: ["thing: at src/x.ts:3"], notes: "ok", human_decision_needed: null }
  assert.equal(parseFinalReview(JSON.stringify(accept)).verdict, "accept")
  assert.equal(parseFinalReview("```json\n" + JSON.stringify(accept) + "\n```").verdict, "accept")
  assert.equal(parseFinalReview("here you go " + JSON.stringify(accept) + " done").verdict, "accept")

  const esc = { verdict: "escalate", findings: [], notes: "max call", human_decision_needed: "pick a retention policy" }
  const parsedEsc = parseFinalReview(JSON.stringify(esc))
  assert.equal(parsedEsc.verdict, "escalate")
  assert.equal(parsedEsc.human_decision_needed, "pick a retention policy")

  // Fail closed: prose, and a verdict outside the enum, both become request_changes.
  assert.equal(parseFinalReview("looks great to me, ship it").verdict, "request_changes")
  assert.equal(parseFinalReview('{"verdict":"proceed","findings":[]}').verdict, "request_changes")
})

test("renderFinalReview: states the floor passed and lists every outcome", () => {
  const pkt = {
    runId: "20260613-demo",
    frontmatter: {
      repo: "~/x", base: "main",
      outcomes: [{ id: "engine-mates", description: "engine finds mate in 2" }],
      expected_surface: ["src/**"], suspicious_surface: [],
      verification: [{ command: "pnpm test" }], constraints: [],
    },
    body: "", raw: "",
  }
  const ledger = { runId: pkt.runId, outcomes: [{ id: "engine-mates", description: "engine finds mate in 2", status: "done", evidence: ["test green"], updatedAt: "t" }], updatedAt: "t" }
  const report = { status: "ready_for_review", summary: "s", filesChanged: [{ path: "src/engine.ts", classification: "expected", reason: "core", action: "kept" }], behaviourChanged: [], sourceOfTruthFollowed: [], outcomeClaims: [{ id: "engine-mates", status: "done" }], verificationClaims: [], escalations: [], remainingUncertainty: [] }
  const prompt = renderFinalReview(pkt, "diff goes here", ledger, report)
  assert.ok(prompt.includes("engine-mates"))
  assert.ok(prompt.includes("pnpm test"))
  assert.ok(prompt.includes("ALREADY PASSED"))
  assert.ok(prompt.includes("git diff HEAD"))
})

test("reviewableDiff: shows tracked changes + untracked files, caps with a marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumb-review-"))
  try {
    execSync("git init -q -b main && git commit -q --allow-empty -m init", { cwd: dir, shell: "/bin/zsh" })
    writeFileSync(join(dir, "tracked.txt"), "one\n")
    execSync("git add tracked.txt && git commit -q -m add", { cwd: dir, shell: "/bin/zsh" })
    writeFileSync(join(dir, "tracked.txt"), "one\ntwo\n")
    writeFileSync(join(dir, "fresh.txt"), "brand new\n")

    const diff = reviewableDiff(dir, 64 * 1024)
    assert.ok(diff.includes("two"), "tracked change visible")
    assert.ok(diff.includes("new file: fresh.txt"), "untracked file inlined")
    assert.ok(diff.includes("brand new"), "untracked content inlined")

    // Tiny cap → truncation marker.
    assert.ok(reviewableDiff(dir, 16).includes("truncated"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- SUPER-DADDY: no severity triage — we trust the verdict --------------------

const finding = (id, severity, kind, extra = {}) => ({
  id,
  severity,
  title: `${id} title`,
  evidence: [`${id} at file.ts:1`],
  grounding: { kind, ref: kind === "none" ? "" : `ref-${id}` },
  ...extra,
})

test("decideConvergence: request_changes hands EVERY finding to the pass, regardless of severity/grounding", () => {
  // The triage is gone: a request_changes verdict with only ungrounded P2/P3 nits
  // still authors a follow-up that fixes them all (this is the FluentResults class
  // of finding that used to be silently dropped to nits.md).
  const nitsOnly = review("request_changes", [finding("a", "P2", "none"), finding("b", "P3", "none")])
  const d = decideConvergence(nitsOnly, true, 1, 3)
  assert.equal(d.action, "author")
  assert.equal(d.blockers.length, 2)
})

test("decideConvergence: request_changes with NO findings → escalate (wants changes, named none)", () => {
  const empty = decideConvergence(review("request_changes", []), true, 1, 3)
  assert.equal(empty.action, "escalate")
})

// --- SUPER-DADDY §6/§8: the loop decision, every branch fails closed to Max ----

const review = (verdict, findings, human = null) => ({
  verdict,
  findings,
  convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
  notes: "",
  human_decision_needed: human,
})

test("decideConvergence: stop only on no-blockers AND green", () => {
  // no blockers + green → stop
  assert.equal(decideConvergence(review("accept", [finding("n", "P3", "none")]), true, 1, 3).action, "stop")
  // no blockers + RED → escalate (under-reported, never stop on red)
  const red = decideConvergence(review("accept", []), false, 1, 3)
  assert.equal(red.action, "escalate")
  assert.ok(red.reason.includes("under-reported"))
})

test("decideConvergence: blockers author until the cap, then escalate", () => {
  const blocked = review("request_changes", [finding("x", "P0", "command_fail")])
  const d1 = decideConvergence(blocked, true, 1, 3)
  assert.equal(d1.action, "author")
  assert.equal(d1.blockers.length, 1)
  // cap reached → escalate, not another pass
  const capped = decideConvergence(blocked, true, 3, 3)
  assert.equal(capped.action, "escalate")
  assert.ok(capped.reason.includes("cap"))
})

test("decideConvergence: explicit escalate / human_decision_needed always wins", () => {
  assert.equal(decideConvergence(review("escalate", []), true, 1, 3).action, "escalate")
  assert.equal(decideConvergence(review("accept", [], "needs a call"), true, 1, 3).action, "escalate")
})

// --- fail-closed parse --------------------------------------------------------

test("parseSuperReview: valid, fenced, and garbage → escalate", () => {
  const good = {
    verdict: "request_changes",
    findings: [finding("x", "P0", "command_fail")],
    convergence: { recommend_stop: false, profile: { p0: 1, p1: 0, p2: 0, p3: 0 }, rationale: "r" },
    notes: "n",
    human_decision_needed: null,
  }
  assert.equal(parseSuperReview(JSON.stringify(good)).verdict, "request_changes")
  assert.equal(parseSuperReview("```json\n" + JSON.stringify(good) + "\n```").verdict, "request_changes")
  const garbage = parseSuperReview("the build looks fine to me, ship it")
  assert.equal(garbage.verdict, "escalate")
  assert.ok(garbage.human_decision_needed)
})

test("parseSuperReview: reasoning prose + a stray non-json fence does not shadow the real verdict", () => {
  const accept = {
    verdict: "accept",
    findings: [],
    convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "all delivered" },
    notes: "8/8 outcomes delivered, suite green",
    human_decision_needed: null,
  }
  // The live regression: gpt-5.5-pro reasoned in prose, dropped a ```csharp
  // block, THEN emitted the unfenced verdict. The old first-fence parser locked
  // onto the C# block and read this accept as an escalate, parking a converged run.
  const response =
    "Let me check the deserialization.\n\n```csharp\nvar dict = JsonSerializer.Deserialize<Dictionary<string, string>>(json);\n```\n\n" +
    "This is correct. OK, I'm confident. Verdict: accept.\n\n" +
    JSON.stringify(accept)
  assert.equal(parseSuperReview(response).verdict, "accept")
  // And when the verdict IS the last of several objects, the last valid one wins.
  const trailing = response + "\n\nfollow-up note: {not: valid json here}"
  assert.equal(parseSuperReview(trailing).verdict, "accept")
})

// --- SUPER-DADDY §9: deterministic render round-trips through admission --------

test("renderFollowupPacket: produces a packet parsePacket accepts, with lineage + regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumb-converge-"))
  try {
    const repo = join(dir, "repo")
    mkdirSync(repo)
    execSync("git init -q -b main && git commit -q --allow-empty -m init", { cwd: repo, shell: "/bin/zsh" })
    execSync("git branch meridian/parent", { cwd: repo, shell: "/bin/zsh" })

    const original = {
      runId: "20260614-100000-feature",
      frontmatter: {
        repo,
        base: "main",
        outcomes: [{ id: "feature", description: "the feature" }],
        expected_surface: ["src/**"],
        suspicious_surface: [],
        verification: [{ command: "true" }],
        constraints: ["keep it clean"],
        pass: 1,
        regression_outcomes: [],
      },
      body: "original",
      raw: "",
    }

    const out = renderFollowupPacket({
      original,
      parentRunId: "20260614-100000-feature",
      campaignId: "feature",
      pass: 2,
      blockers: [
        { id: "fix-typecheck", severity: "P0", title: "ui typecheck fails", evidence: ["use-x.ts:29"], grounding: { kind: "command_fail", ref: "pnpm check" }, suggested_outcome_id: "ui-typecheck-passes" },
      ],
      priorOutcomes: [{ id: "feature", description: "the feature" }],
      baseBranch: "meridian/parent",
      timestamp: "20260614-180000",
      slug: "feature-followup",
    })

    assert.equal(out.runId, "20260614-180000-feature-followup")

    const file = join(dir, out.filename)
    writeFileSync(file, out.content)
    const parsed = parsePacket(file)
    assert.ok(parsed.ok, "rendered packet must pass admission: " + (parsed.ok ? "" : parsed.problems.join("; ")))
    assert.equal(parsed.packet.frontmatter.base, "meridian/parent")
    // summary is composed from the blockers so tail shows what the pass is fixing.
    assert.equal(parsed.packet.frontmatter.summary, "convergence pass 2 — ui typecheck fails")
    assert.equal(parsed.packet.frontmatter.campaign_id, "feature")
    assert.equal(parsed.packet.frontmatter.parent_run_id, "20260614-100000-feature")
    assert.equal(parsed.packet.frontmatter.pass, 2)
    // outcome uses the suggested id; regression + the failing command are carried.
    assert.equal(parsed.packet.frontmatter.outcomes[0].id, "ui-typecheck-passes")
    assert.equal(parsed.packet.frontmatter.regression_outcomes[0].id, "feature")
    assert.ok(parsed.packet.frontmatter.verification.some((v) => v.command === "pnpm check"))
    assert.ok(parsed.packet.frontmatter.constraints.some((c) => c.includes("must STILL pass")))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Live red-test regression: a reviewer reused the ORIGINAL outcome id as its
// suggested_outcome_id, which produced a packet where the same id was both a new
// outcome AND a regression guard (fix-this AND must-not-change). The repaired
// outcome must be excluded from regression, and no id may appear in both sets.
test("renderFollowupPacket: a repaired outcome is never also a regression guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumb-converge-"))
  try {
    const repo = join(dir, "repo")
    mkdirSync(repo)
    execSync("git init -q -b main && git commit -q --allow-empty -m init", { cwd: repo, shell: "/bin/zsh" })
    execSync("git branch work", { cwd: repo, shell: "/bin/zsh" })

    const out = renderFollowupPacket({
      original: {
        runId: "20260101-000000-add",
        frontmatter: {
          repo, base: "main",
          outcomes: [{ id: "add-returns-sum", description: "add returns the sum" }],
          expected_surface: ["*.js"], suspicious_surface: [],
          verification: [{ command: "node test.js" }], constraints: [], pass: 1, regression_outcomes: [],
        },
        body: "", raw: "",
      },
      parentRunId: "20260101-000000-add",
      campaignId: "20260101-000000-add",
      pass: 2,
      // reviewer reused the original outcome id as the blocker's outcome id
      blockers: [finding("add-bug", "P1", "command_fail", { suggested_outcome_id: "add-returns-sum" })],
      priorOutcomes: [{ id: "add-returns-sum", description: "add returns the sum" }],
      baseBranch: "work",
      timestamp: "20260102-000000",
      slug: "add-fix2",
    })

    const file = join(dir, out.filename)
    writeFileSync(file, out.content)
    const parsed = parsePacket(file)
    assert.ok(parsed.ok, "packet must admit: " + (parsed.ok ? "" : parsed.problems.join("; ")))
    const outIds = new Set(parsed.packet.frontmatter.outcomes.map((o) => o.id))
    const regIds = new Set(parsed.packet.frontmatter.regression_outcomes.map((o) => o.id))
    assert.ok(outIds.has("add-returns-sum"))
    // the repaired outcome must NOT also be carried as a regression guard
    assert.equal([...outIds].some((id) => regIds.has(id)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- SUPER-DADDY §4/§5/§6: the convergence-review prompt ----------------------

const superReviewInput = (over = {}) => ({
  packet: {
    runId: "20260614-120000-rename",
    frontmatter: {
      repo: "~/app", base: "main",
      outcomes: [{ id: "rename-visible", description: "renamed name shows everywhere" }],
      expected_surface: ["apps/**"], suspicious_surface: [],
      verification: [{ command: "pnpm -C apps/ui typecheck" }], constraints: ["no net-new deps"],
      pass: 1, campaign_id: undefined, parent_run_id: undefined, regression_outcomes: [],
    },
    body: "", raw: "",
  },
  diff: "DIFF-SENTINEL-12345",
  reportText: "the run reported all outcomes done",
  skillText: "DOCTRINE-RUBRIC-SENTINEL: data-transforms over hierarchies",
  pass: 1,
  maxPasses: 3,
  ...over,
})

test("renderSuperReview: injects rubric, anchors to the packet, demands execution + grounding", () => {
  const prompt = renderSuperReview(superReviewInput())
  // §4 the skill text IS the rubric, injected verbatim
  assert.ok(prompt.includes("DOCTRINE-RUBRIC-SENTINEL: data-transforms over hierarchies"))
  // anchored to the original packet's outcomes, verification, constraints
  assert.ok(prompt.includes("rename-visible"))
  assert.ok(prompt.includes("pnpm -C apps/ui typecheck"))
  assert.ok(prompt.includes("no net-new deps"))
  // the diff is embedded
  assert.ok(prompt.includes("DIFF-SENTINEL-12345"))
  // §4 must-execute and §5 grounding rule are both stated
  assert.ok(prompt.includes("YOU MUST EXECUTE"))
  assert.ok(prompt.includes("command_fail"))
  assert.ok(prompt.includes("clause"))
  // repairs-only scope (§9) and the JSON-only contract
  assert.ok(prompt.includes("repairs only") || prompt.includes("Repairs only") || prompt.includes("Scope"))
  assert.ok(prompt.includes("Return ONLY JSON"))
  // test-quality lens: mock-soup + incomplete-coverage are explicit blockers
  assert.ok(prompt.includes("MOCK-SOUP"))
  assert.ok(prompt.includes("INCOMPLETE COVERAGE"))
})

test("renderSuperReview: states the cannot-converge-on-red rule and the one-review framing", () => {
  const prompt = renderSuperReview(superReviewInput({ pass: 2, maxPasses: 5 }))
  // The "one review" lie (a la the baby gates): the reviewer is NOT told the real
  // pass budget — same prose every pass keeps it front-loading rather than holding
  // findings back for a "next time" it believes it doesn't get.
  assert.ok(prompt.includes("ONE review"))
  assert.ok(!prompt.includes("pass 2 of at most 5"))
  // …but it is still told to accept when good enough, so it converges inside the cap
  assert.ok(prompt.includes("should ACCEPT"))
  // §6 invariant must be communicated to the reviewer, not just enforced in code
  assert.ok(/recommend_stop MUST be false if ANY verification command exited non-zero/i.test(prompt))
})

// --- SUPER-DADDY §7: two-party reconciliation --------------------------------
// Reuses the `review` and `finding` helpers defined above. A grounded blocker =
// a P0/P1 finding with command_fail/clause grounding; outcome via `extra`.
const gblocker = (id, severity = "P1", outcome) =>
  finding(id, severity, "command_fail", outcome ? { suggested_outcome_id: outcome } : {})

test("decideConvergence: clean review + green → stop (the only stop path)", () => {
  assert.equal(decideConvergence(review("accept", []), true, 1, 3).action, "stop")
})

test("decideConvergence: no grounded blocker but verification RED → escalate, not stop (§6)", () => {
  assert.equal(decideConvergence(review("accept", []), false, 1, 3).action, "escalate")
})

test("decideConvergence: grounded blockers + passes left → author the follow-up", () => {
  const d = decideConvergence(review("request_changes", [gblocker("b1", "P1", "oc1")]), true, 1, 3)
  assert.equal(d.action, "author")
  assert.equal(d.blockers.length, 1)
})

test("decideConvergence: grounded blockers + cap reached → escalate (convergence failed)", () => {
  assert.equal(decideConvergence(review("request_changes", [gblocker("b1")]), true, 3, 3).action, "escalate")
})

test("decideConvergence: an explicit escalate / human_decision wins", () => {
  assert.equal(decideConvergence(review("escalate", []), true, 1, 3).action, "escalate")
  assert.equal(decideConvergence(review("accept", [], "needs a product call"), true, 1, 3).action, "escalate")
})

// --- SUPER-DADDY §10: campaign ledger merge ----------------------------------

test("upsertPass: creates on first pass, appends, and replaces a re-recorded run", () => {
  const init = { campaignId: "c", originalRunId: "r1", originalIntent: "i", maxPasses: 3 }
  const c1 = upsertPass(undefined, init, { runId: "r1", pass: 1, verdict: "request_changes", groundedBlockers: 2, atIso: "t1" }, "open")
  assert.equal(c1.passes.length, 1)
  assert.equal(c1.status, "open")
  assert.equal(c1.campaignId, "c")

  const c2 = upsertPass(c1, init, { runId: "r2", pass: 2, verdict: "accept", groundedBlockers: 0, atIso: "t2" }, "converged")
  assert.equal(c2.passes.length, 2)
  assert.equal(c2.status, "converged")
  assert.equal(c2.originalRunId, "r1") // preserved from the original campaign

  const c3 = upsertPass(c2, init, { runId: "r2", pass: 2, verdict: "accept", groundedBlockers: 0, atIso: "t3" }, "converged")
  assert.equal(c3.passes.length, 2) // r2 replaced, not duplicated
  assert.equal(c3.passes[1].atIso, "t3")
})

// --- SUPER-DADDY §10/§13: nits.md surfacing ----------------------------------
// On accept/escalate, every finding super-daddy raised is a note for Max (the
// caller only invokes renderNits off the author path). No triage, no downgrade.

test("renderNits: no findings → undefined (nothing to surface)", () => {
  assert.equal(renderNits("run1", review("accept", [])), undefined)
})

test("renderNits: lists each finding as a note", () => {
  const md = renderNits("run1", review("accept", [finding("only-sd", "P2", "none"), finding("vibe", "P3", "none")]))
  assert.ok(md)
  assert.ok(md.includes("only-sd"))
  assert.ok(md.includes("vibe"))
  assert.equal((md.match(/^## /gm) ?? []).length, 2) // two distinct notes
})

test("renderNits: a finding's severity is shown verbatim — no downgrade (we trust super-daddy)", () => {
  const md = renderNits("run1", review("accept", [finding("vibe", "P1", "none")]))
  assert.ok(md?.includes("vibe"))
  assert.ok(md?.includes("[P1]")) // the model's own severity, surfaced as-is
})

// --- R3: super-daddy authors the converged commit message --------------------

test("assembleCommitMessage: subject + body joined with a blank line, trimmed", () => {
  const msg = assembleCommitMessage({
    subject: "feat: add readable transcript segments",
    body: "Render per-speaker segments via the shared assembler.\n",
  })
  assert.equal(msg, "feat: add readable transcript segments\n\nRender per-speaker segments via the shared assembler.")
})

test("assembleCommitMessage: empty body → subject only, no trailing blank lines", () => {
  const msg = assembleCommitMessage({ subject: "fix: handle empty speaker list", body: "   " })
  assert.equal(msg, "fix: handle empty speaker list")
})

// --- §5 R10: stall recovery decision (P6) ------------------------------------

test("decideStallRecovery: a wedged park under the cap → requeue, count incremented", () => {
  const d = decideStallRecovery({ status: "blocked", blockedReason: "wedged", stallRetries: 0 }, 2)
  assert.deepEqual(d, { action: "requeue", stallRetries: 1 })
  const d2 = decideStallRecovery({ status: "blocked", blockedReason: "wedged", stallRetries: 1 }, 2)
  assert.deepEqual(d2, { action: "requeue", stallRetries: 2 })
})

test("decideStallRecovery: a wedged park at the cap → escalate (never an infinite retry)", () => {
  const d = decideStallRecovery({ status: "blocked", blockedReason: "wedged", stallRetries: 2 }, 2)
  assert.deepEqual(d, { action: "escalate", stallRetries: 2 })
})

test("decideStallRecovery: crashed and judgement parks are never auto-recovered", () => {
  for (const reason of ["crashed", "human_decision", "scope_expansion", "stop_condition"]) {
    assert.deepEqual(
      decideStallRecovery({ status: "blocked", blockedReason: reason, stallRetries: 0 }, 2),
      { action: "none" },
      `${reason} must not auto-retry`,
    )
  }
})

test("decideStallRecovery: non-blocked statuses are never touched", () => {
  assert.deepEqual(decideStallRecovery({ status: "ready_for_review", stallRetries: 0 }, 2), { action: "none" })
  assert.deepEqual(decideStallRecovery({ status: "running", stallRetries: 0 }, 2), { action: "none" })
})

test("decideStallRecovery: maxStallRetries 0 disables auto-recovery (first wedge escalates)", () => {
  assert.deepEqual(
    decideStallRecovery({ status: "blocked", blockedReason: "wedged", stallRetries: 0 }, 0),
    { action: "escalate", stallRetries: 0 },
  )
})

// --- L3: no-progress action — rotate before park (the narration-loop rescue) --

test("stallAction: nudges on dead turns that are neither a rotate boundary nor the park", () => {
  // rotateAt 4, parkAt 10: turns 1-3 nudge, 4 rotates, 5-7 nudge, 8 rotates, 9 nudge.
  assert.equal(stallAction(1, 4, 10), "nudge")
  assert.equal(stallAction(3, 4, 10), "nudge")
  assert.equal(stallAction(5, 4, 10), "nudge")
  assert.equal(stallAction(9, 4, 10), "nudge")
})

test("stallAction: rotates every rotateAt dead turns — a fresh session breaks the loop", () => {
  assert.equal(stallAction(4, 4, 10), "rotate")
  assert.equal(stallAction(8, 4, 10), "rotate")
})

test("stallAction: parks once the dead-turn count hits the backstop, and park always wins", () => {
  assert.equal(stallAction(10, 4, 10), "park")
  assert.equal(stallAction(11, 4, 10), "park")
  // park is checked first: a rotate boundary AT/above the park still parks (8 is a
  // multiple of 4, but parkAt 8 means the run is already wedged → park, not rotate).
  assert.equal(stallAction(8, 4, 8), "park")
})

test("stallAction: a misconfigured rotateAt ≥ parkAt can never rotate forever — bounded by park", () => {
  // rotateAt 12 never reaches a boundary below parkAt 10, so it only ever nudges
  // then parks — the backstop is the guarantee, not the rotate cadence.
  for (let l = 1; l < 10; l++) assert.equal(stallAction(l, 12, 10), "nudge")
  assert.equal(stallAction(10, 12, 10), "park")
})

// --- §9 async consult: the driver delivers Daddy's verdict next turn ----------
const plannerVerdict = (over = {}) => ({
  status: "proceed",
  answer: "Use a discriminated union for the status field.",
  constraints: ["narrow the union to the three live states"],
  evidence_used: ["src/status.ts"],
  safe_next_action: "implement the union",
  human_decision_needed: null,
  ...over,
})

test("qPlannerDecision: an accepted verdict carries the planner payload and clears Baby to proceed", () => {
  const prompt = qPlannerDecision(plannerVerdict())
  // the { planner } payload Baby used to get inline is reproduced verbatim
  assert.ok(prompt.includes('"planner"'))
  assert.ok(prompt.includes("Use a discriminated union for the status field."))
  assert.ok(prompt.includes("narrow the union to the three live states"))
  // accepted → proceed framing, obligations called out, gate clear
  assert.ok(/proceed with implementation/i.test(prompt))
  assert.ok(prompt.includes("live review obligations"))
  assert.ok(!/revise_slice: narrow/i.test(prompt))
})

test("qPlannerDecision: a revise_slice verdict tells Baby to narrow and re-ask, not implement", () => {
  const prompt = qPlannerDecision(plannerVerdict({ status: "revise_slice", answer: "too broad" }))
  assert.ok(/revise_slice: narrow/i.test(prompt))
  assert.ok(/ask_planner again BEFORE editing/i.test(prompt))
  assert.ok(!/proceed with implementation/i.test(prompt))
})

test("qPlannerUnavailable: surfaces the real detail and the retry-then-park instruction", () => {
  const prompt = qPlannerUnavailable("socket hang up")
  assert.ok(prompt.includes("socket hang up"))
  assert.ok(/ask_planner once more/i.test(prompt))
  assert.ok(/submit_report with status blocked/i.test(prompt))
})

// --- §19 chaining: relaxed staged parse + the pure promotion decision ---------
// Pins the bootstrap that lets a long build (v3) accumulate across nights: a
// staged child names an upstream campaign and only enters the queue once that
// campaign has CONVERGED, basing off the converged tip.

const stagedChild = (extra = "") =>
  `---
repo: /tmp/whatever
${extra}outcomes:
  - id: a
    description: do a thing
expected_surface:
  - "src/**"
verification:
  - command: "pnpm test"
---
body`

test("parseStaged: a child with parent_run_id and NO base validates (base stamped at promotion)", () => {
  const r = parseStaged(stagedChild("parent_run_id: 20260618-010000-head\n"), "20260618-020000-child.md")
  assert.ok(r.ok)
  assert.equal(r.info.runId, "20260618-020000-child")
  assert.equal(r.info.parentRunId, "20260618-010000-head")
})

test("parseStaged: a parent-less head with no base still validates (admits from HEAD later)", () => {
  const r = parseStaged(stagedChild(), "20260618-010000-head.md")
  assert.ok(r.ok)
  assert.equal(r.info.parentRunId, undefined)
})

test("parseStaged: a non-runId filename is rejected (so _CHAIN.md / READMEs are skipped upstream)", () => {
  const r = parseStaged(stagedChild(), "_CHAIN.md")
  assert.ok(!r.ok)
})

test("parseStaged: missing frontmatter and missing outcomes both fail closed", () => {
  assert.ok(!parseStaged("no frontmatter here", "20260618-020000-child.md").ok)
  const noOutcomes = `---\nrepo: /tmp/x\nexpected_surface:\n  - "src/**"\nverification:\n  - command: "t"\n---\nb`
  assert.ok(!parseStaged(noOutcomes, "20260618-020000-child.md").ok)
})

const campaign = (status, passes) => ({
  campaignId: "20260618-010000-head",
  originalRunId: "20260618-010000-head",
  originalIntent: "x",
  status,
  maxPasses: 3,
  passes,
  updatedAt: "2026-06-18T00:00:00.000Z",
})
const pass = (runId, verdict, n = 1) => ({ runId, pass: n, verdict, groundedBlockers: 0, atIso: "2026-06-18T00:00:00.000Z" })

test("convergedTip: the LATEST accepted pass is the tip (a super-daddy repair pass can be it)", () => {
  assert.equal(
    convergedTip(campaign("converged", [pass("20260618-010000-head", "request_changes", 1), pass("20260618-010500-head-fix2", "accept", 2)])),
    "20260618-010500-head-fix2",
  )
  assert.equal(convergedTip(campaign("open", [pass("r", "request_changes")])), undefined)
})

test("decidePromotion: no parent → promote-now", () => {
  assert.equal(decidePromotion(undefined, undefined).action, "promote-now")
})

test("decidePromotion: parent not started / still open → wait (stays staged)", () => {
  assert.equal(decidePromotion("20260618-010000-head", undefined).action, "wait")
  assert.equal(decidePromotion("20260618-010000-head", campaign("open", [pass("r", "request_changes")])).action, "wait")
})

test("decidePromotion: parent needs_max → hold (never build on unblessed work)", () => {
  assert.equal(decidePromotion("20260618-010000-head", campaign("needs_max", [pass("r", "escalate")])).action, "hold")
})

test("decidePromotion: parent converged → promote-with-base off the accepted tip branch", () => {
  const d = decidePromotion("20260618-010000-head", campaign("converged", [pass("20260618-010500-head-fix2", "accept", 2)]))
  assert.equal(d.action, "promote-with-base")
  assert.equal(d.tipRunId, "20260618-010500-head-fix2")
  assert.equal(d.base, "meridian/20260618-010500-head-fix2")
})

test("decidePromotion: converged but no accepted pass → hold (incoherent, surface it)", () => {
  assert.equal(decidePromotion("20260618-010000-head", campaign("converged", [])).action, "hold")
})
