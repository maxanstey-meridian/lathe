// Super-daddy: the convergence reviewer (SUPER-DADDY §4). Where Daddy's
// final-review asks "did Baby do what THIS packet said?", super-daddy asks the
// harder, doctrine-anchored question: "does the delivered code meet the ORIGINAL
// packet AND Max's house doctrine — and if not, what grounded blockers must a
// follow-up pass fix?" It is the one reviewer that MUST execute (§4): it runs the
// verification suite itself, so a failing command is non-negotiable evidence and
// a green suite is the precondition for ever declaring convergence (§6).
//
// This file holds the pure prompt render + the thin agent invocation + a
// validation entry point (`meridian super-review <runId>`). The convergence
// DECISION (decideConvergence), campaign writes and packet
// authoring are P3 — deliberately not here, so the reviewer's verdict quality
// can be judged in isolation against runs already on disk before it drives any
// auto-loop (§14.3, §15 P2).

import { existsSync, readFileSync } from "fs"
import { loadConfig } from "./config.js"
import { expandHome, type Paths } from "./paths.js"
import { parsePacket } from "./packet.js"
import { reviewableDiffAgainst } from "./git.js"
import { readMetaIfExists } from "./runtime.js"
import {
  writeOpencodeConfig,
  spawnOpencodeServer,
  warnOnVersionDrift,
  waitForServer,
  createOpencodeClient,
  extractText,
  messageError,
  pluginPath,
  type OpencodeClient,
  type TurnResponse,
} from "./opencode.js"
import { startBridgeServer, listenBridge, type CurrentRunRef } from "./bridge.js"
import { parseSuperReview, decideConvergence } from "./convergence.js"
import type { Config, Packet, SuperReview } from "./schemas.js"

export type SuperReviewModel = { providerId: string; modelId: string; agent: string }

// The parsed verdict AND the raw model text it came from. The raw is the only
// thing that makes a parse failure debuggable — without it, an escalate that
// says "unparseable" is a black box (it parked a converged run twice, and the
// reviewer session is deleted right after, so there is no second chance to look).
export type SuperReviewResult = { review: SuperReview; raw: string }

export type SuperReviewInput = {
  packet: Packet // the ORIGINAL packet — the intent super-daddy anchors to (§4)
  diff: string // run branch vs base (committed WIP included; reviewableDiffAgainst)
  reportText: string // the run's report.md, as supplementary context (not trusted)
  skillText: string // Max's meridian skill — injected verbatim as the rubric (§4)
  pass: number // which convergence pass produced this run
  maxPasses: number // the hard cap, for the reviewer's urgency calibration (§8)
}

// --- the prompt (pure) -------------------------------------------------------

// The must-execute mandate and the shared body (rubric, packet, diff, grounding
// rule, response contract). Kept as named pieces so the verdict prompt reads as
// role-preamble + mandate + body.
const MUST_EXECUTE = `## YOU MUST EXECUTE — read-only review is not enough
You have bash. RUN the verification commands below yourself, plus whatever
build/typecheck/test the repo needs. Do not trust the report's claims; the report
is a possibly-stale convenience. A command that exits non-zero is non-negotiable
evidence of a blocker. A fully green suite is REQUIRED before you may recommend
stopping — you may never declare convergence while anything is red.`

const reviewBody = (input: SuperReviewInput): string => {
  const fm = input.packet.frontmatter
  const outcomeLines = fm.outcomes.map((o) => `- ${o.id}: ${o.description}`).join("\n")
  const verificationLines =
    fm.verification.map((v) => `- \`${v.command}\``).join("\n") || "- (none declared)"
  const constraintLines = fm.constraints.length > 0 ? fm.constraints.map((c) => `- ${c}`).join("\n") : "- (none)"

  return `## The rubric — Max's house doctrine (this IS your grading criteria)
Grade the diff against this. Its architecture rules (data-transforms, port
boundaries, real-DB integration tests, fake naming, TOCTOU/unique-index data
safety) are what "meets doctrine" means; its "suppress noise" list is the
DEFINITION of a nit — cite which rule fires when you downgrade something.

<<<RUBRIC
${input.skillText}
RUBRIC

## Original packet — the intent you anchor to
Outcomes:
${outcomeLines}

Constraints:
${constraintLines}

Verification commands (RUN THESE — they must exit 0):
${verificationLines}

## Delivered work — the run's own report (supplementary; verify against the tree)
${input.reportText}

## Diff (run branch vs base; convenience — inspect the real tree yourself)
${input.diff}

## The grounding rule — ground every finding in evidence
Every finding must carry its evidence so the repair pass (and Max) can act without
guessing:
  - "command_fail": a verification/build/typecheck/test command you ran that exited
    non-zero — put the exact command in grounding.ref; or
  - "clause": a specific doctrine/contract rule it violates — quote the rule in
    grounding.ref.
A finding you cannot ground in either is a taste call: set grounding "none" and keep
its severity honest (P2/P3). Severity (P0–P3) is your read of how much each finding
matters — use it to order them and to decide accept-vs-request_changes, NOT to hide
a real issue. If you request_changes, EVERY finding you list becomes a fix target
for the next pass, so list the real ones and leave pure taste out.

## Test quality — a green suite is necessary, not sufficient
A suite that exits 0 proves nothing if it tests the wrong things. Inspect the
tests this run added or changed and raise a CLAUSE-grounded blocker (quote the
relevant rubric rule in grounding.ref) when you find:
  - MOCK-SOUP — a test that asserts against fakes/mocks/stubs instead of real
    behaviour (e.g. asserting a mock was called, or a hand-rolled in-memory fake
    stands in for the real adapter where the rubric wants a real-DB integration
    test). Verifying the mock, not the code, is not coverage.
  - INCOMPLETE COVERAGE — a NEW use case, handler, or decision branch this run
    introduced (e.g. the 404 / 422 / success mapping of a new endpoint) with NO
    direct test exercising it. The assembler being covered does not cover the use
    case that calls it.
Both are P1 grounded blockers that drive a follow-up pass — name the exact
untested symbol or the mock-asserting test in evidence. Stay in scope: judge only
what THIS run added or touched; pre-existing untested code is not your remit
(repairs-only). If the tests are honest and the new surface is directly covered,
say so explicitly in notes — do not invent a gap to look thorough.

## Scope — repairs only
You judge against the ORIGINAL intent. A gap against the packet or doctrine is a
blocker; a net-new feature idea is NOT in scope — log it at most as a P3 for Max.

## Response shape
Return ONLY JSON. No markdown fences, no prose outside the JSON.

{
  "verdict": "accept | request_changes | escalate",
  "findings": [
    {
      "id": "kebab-case-id",
      "severity": "P0 | P1 | P2 | P3",
      "title": "one line",
      "evidence": ["file:line or command output proving it"],
      "grounding": { "kind": "command_fail | clause | none", "ref": "the command, or the quoted rule" },
      "suggested_outcome_id": "kebab-id-if-this-becomes-a-followup-outcome"
    }
  ],
  "convergence": {
    "recommend_stop": true,
    "profile": { "p0": 0, "p1": 0, "p2": 0, "p3": 0 },
    "rationale": "why stop or continue, in one line"
  },
  "commit_message": {
    "subject": "type(scope): imperative summary, <=72 chars",
    "body": "what changed and why, wrapped prose; reference the outcomes delivered"
  },
  "notes": "one-line overall judgement",
  "human_decision_needed": null
}

## The commit message (accept only)
On accept ONLY, author commit_message — it REPLACES the driver's throwaway WIP
line on the run's single commit, so write it as the permanent history entry for
this change. Base it on the diff you just read, not the report's wording:
- subject: a conventional-commit line (\`feat:\`, \`fix:\`, \`refactor:\` …),
  imperative mood, no trailing period, ≤72 chars.
- body: a short prose paragraph (or a few bullet lines) covering WHAT changed and
  WHY, naming the outcomes delivered. No "as requested", no run/packet IDs, no
  Baby/Daddy/meridian references — it reads as a normal human commit.
On request_changes or escalate, set commit_message to null (the run is not
landing yet).

- accept — outcomes delivered, suite green, and the diff soundly meets the original
  intent and doctrine. Anything left is trivial enough to ship; note it in findings
  as P2/P3 if useful, but accept. recommend_stop true.
- request_changes — there is real work a single repair pass should do. List EVERY
  such finding (any severity) — they ALL become fix targets for the next pass.
  recommend_stop false.
- escalate — converged-but-for a decision only Max can make (product/UX/security/
  tenancy/data/billing/legal/migration policy), or you cannot safely judge. Put the
  exact decision in human_decision_needed.
- recommend_stop MUST be false if ANY verification command exited non-zero.`
}

export const renderSuperReview = (input: SuperReviewInput): string =>
  `CONVERGENCE REVIEW — you are super-daddy, the doctrine gate above the per-run
reviewer. This run reached \`ready_for_review\`; you decide whether the CAMPAIGN
converges (accept), needs one autonomous repair pass (request_changes), or must
wake Max (escalate).

You get ONE review of this work — there is no "I'll catch it next pass". So put
everything that genuinely matters into this verdict: every gap against the original
intent and every house-doctrine violation, each grounded in evidence. The small
stuff is exactly what makes a diff read as enterprise rather than sloppy, so don't
wave it through — if it's real, name it; it all goes into consideration.

But don't go mad. This is a convergence gate, not a wishlist: a diff that soundly
meets the intent and the doctrine should ACCEPT. Do not manufacture findings to
justify another pass, and do not block on pure taste. Front-load what's real and
accept when it's genuinely good enough.

You are, in effect, Max reviewing the diff: hold it to the ORIGINAL intent below
AND to the house doctrine in the rubric. Your cwd is the run's worktree.

${MUST_EXECUTE}

${reviewBody(input)}`

// --- invocation (thin; mirrors runFinalReview, fails closed to escalate) -----

// What one review turn yields: the assistant text to parse, and — distinct from
// "the model said nothing" — any provider/transport error opencode attached to
// the turn (model unavailable, 400, auth, rate-limit). A provider error comes
// back as HTTP 200 with empty parts, so without surfacing it an infra failure is
// indistinguishable from a silent model and falls through to a misleading
// "unparseable" escalate.
type ReviewHarvest = { text: string; error: string | null }

// opencode's sendMessage returns ONLY the final message's parts. Super-daddy
// runs bash across several steps and routinely emits its verdict text in an
// earlier step, then ends on a tool/reasoning step — so the final message is
// often empty (seen live: a 0-char response fail-closed to escalate and parked a
// fully-converged run). Gather text from EVERY assistant message in the session,
// mirroring the driver's collectTurnParts; fall back to the final message if the
// listing fails, so a flaky list call never loses a verdict that DID arrive. In
// the same pass, pick up any turn error (checked on the POST response first, then
// across the session) so the caller can fail with the real reason.
const harvestReview = async (
  client: OpencodeClient,
  sessionId: string,
  response: TurnResponse,
): Promise<ReviewHarvest> => {
  try {
    const assistants = (await client.listMessages(sessionId)).filter((m) => m.info.role === "assistant")
    const text = assistants
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("\n")
    const error =
      messageError(response.info) ??
      assistants.map((m) => messageError(m.info)).find((e): e is string => e !== null) ??
      null
    return { text: text.trim().length > 0 ? text : extractText(response), error }
  } catch {
    return { text: extractText(response), error: messageError(response.info) }
  }
}

export const runSuperReview = async (
  client: OpencodeClient,
  sessionId: string,
  model: SuperReviewModel,
  timeoutMs: number,
  input: SuperReviewInput,
): Promise<SuperReviewResult> => {
  const prompt = renderSuperReview(input)
  try {
    const response = await client.sendMessage(sessionId, prompt, model, timeoutMs)
    const { text: raw, error } = await harvestReview(client, sessionId, response)
    // A provider/transport failure (model unavailable, 400, auth, rate-limit)
    // returns HTTP 200 with the failure on the turn's `error` and no text — that
    // is NOT the model returning a bad verdict. Throw the real reason so the
    // escalate below says e.g. "APIError (HTTP 400): … model is not supported …"
    // instead of the "unparseable" a 0-char parse would invent. (A timeout or a
    // dead socket already rejects out of sendMessage into the same catch.)
    if (error) throw new Error(error)
    return { review: parseSuperReview(raw), raw }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    // Unreachable reviewer fails CLOSED to escalate — never silently converge,
    // never author from no findings (mirrors convergence.parseSuperReview).
    return {
      review: {
        verdict: "escalate",
        findings: [],
        convergence: { recommend_stop: false, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "reviewer unreachable" },
        commit_message: null,
        notes: `super-review unavailable: ${detail}`,
        human_decision_needed: "Super-daddy was unreachable — review the run manually.",
      },
      raw: `«reviewer threw before producing text»: ${detail}`,
    }
  }
}

// --- loading a finished run off disk -----------------------------------------

export type LoadedRun = {
  runId: string
  worktree: string
  base: string // the run's base branch (what the diff is taken against)
  branch: string // the run's own branch — the base for any follow-up pass
  model: SuperReviewModel
  timeoutMs: number
  input: SuperReviewInput
}

export const loadRunForReview = (config: Config, paths: Paths, runId: string): LoadedRun => {
  const meta = readMetaIfExists(paths, runId)
  if (!meta) throw new Error(`no run on disk: ${runId}`)
  if (!existsSync(meta.worktree)) throw new Error(`run ${runId} has no worktree at ${meta.worktree}`)

  // The frozen copy is packet.md, whose filename no longer carries the runId —
  // pass it explicitly, exactly as requeued-run validation does (cli.ts/queue.ts).
  const parsed = parsePacket(paths.packetFile(runId), runId)
  if (!parsed.ok) throw new Error(`packet for ${runId} does not validate:\n  ${parsed.problems.join("\n  ")}`)

  const skillPath = expandHome(config.superdaddy.skillPath)
  if (!existsSync(skillPath)) throw new Error(`meridian skill (rubric) not found at ${skillPath}`)
  const skillText = readFileSync(skillPath, "utf-8")

  const reportFile = paths.reportFile(runId)
  const reportText = existsSync(reportFile) ? readFileSync(reportFile, "utf-8") : "(no report.md on disk)"

  const diff = reviewableDiffAgainst(meta.worktree, meta.base, config.superdaddy.diffCapBytes)

  return {
    runId,
    worktree: meta.worktree,
    base: meta.base,
    branch: meta.branch,
    model: { providerId: config.superdaddy.providerId, modelId: config.superdaddy.modelId, agent: config.superdaddy.agent },
    timeoutMs: config.superdaddy.timeoutMs,
    input: {
      packet: parsed.packet,
      diff,
      reportText,
      skillText,
      pass: parsed.packet.frontmatter.pass,
      maxPasses: config.thresholds.maxPasses,
    },
  }
}

// --- the validation command (P2): review one finished run, print the verdict --
// No campaign write, no packet authoring, no run-status mutation — that is P3.
// This proves the reviewer + the P1 convergence logic end to end against a run
// already on disk (§15 P2: "does it independently surface the same class of
// issues?"). It DOES spin up opencode (super-daddy must execute) and takes the
// single-driver lock, so it must not run concurrently with `meridian run`.

export const superReviewCommand = async (runId: string, modelIdOverride?: string): Promise<number> => {
  const { config, paths } = loadConfig()
  let loaded: LoadedRun
  try {
    loaded = loadRunForReview(config, paths, runId)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    return 1
  }
  // Debug-only override so a trial can pick a cheaper/faster reviewer than the
  // configured default without mutating config.json (e.g. gpt-5.5 vs gpt-5.5-pro).
  if (modelIdOverride) loaded = { ...loaded, model: { ...loaded.model, modelId: modelIdOverride } }

  // Bridge first — it is the single-driver lock; super-daddy holds no bridge
  // tools, so an empty ref is correct (requireRun never fires for it).
  const ref: CurrentRunRef = { current: undefined }
  const bridgeServer = startBridgeServer(config, ref)
  await listenBridge(bridgeServer, config)

  writeOpencodeConfig(config, paths, pluginPath())
  warnOnVersionDrift(config)
  const serverProcess = spawnOpencodeServer(config, paths)

  try {
    await waitForServer(config)
    const client: OpencodeClient = createOpencodeClient(config)
    const sessionId = await client.createSession(`superdaddy:${runId}`, loaded.worktree)
    console.error(`super-daddy (${loaded.model.providerId}/${loaded.model.modelId}) reviewing ${runId} — executing verification, this may take a while…`)

    const { review, raw } = await runSuperReview(client, sessionId, loaded.model, loaded.timeoutMs, loaded.input)
    await client.deleteSession(sessionId)

    printReview(review, loaded.input.pass, config.thresholds.maxPasses, raw)
    return 0
  } finally {
    bridgeServer.close()
    serverProcess.kill()
  }
}

// What the P3 loop will do with this verdict, previewed read-only. verificationGreen
// is proxied here from the presence of a command_fail finding (super-daddy ran the
// suite, the driver did not); P3 will capture real exit codes.
const printReview = (review: SuperReview, pass: number, maxPasses: number, raw: string): void => {
  const verificationGreen = !review.findings.some((f) => f.grounding.kind === "command_fail")
  const decision = decideConvergence(review, verificationGreen, pass, maxPasses)

  console.log(`\n=== super-review verdict (pass ${pass}/${maxPasses}) ===`)
  console.log(`reviewer verdict:  ${review.verdict}`)
  console.log(`notes:             ${review.notes}`)
  if (review.human_decision_needed) console.log(`human decision:    ${review.human_decision_needed}`)
  console.log(`\nfindings (${review.findings.length}):`)
  for (const f of review.findings)
    console.log(`  [${f.severity}] ${f.id}: ${f.title}  (${f.grounding.kind}${f.grounding.kind !== "none" ? `: ${f.grounding.ref}` : ""})`)
  const tail =
    decision.action === "escalate"
      ? ` — ${decision.reason}`
      : decision.action === "author"
        ? ` — ${decision.blockers.length} finding(s) → follow-up pass`
        : ""
  console.log(`\nwhat the converge loop would do: ${decision.action}${tail}`)
  console.log(`\n--- raw SuperReview JSON (parsed) ---`)
  console.log(JSON.stringify(review, null, 2))
  // The verbatim model text. When the parsed verdict above is a fail-closed
  // "unparseable" escalate, THIS is what actually came back — the only way to
  // see whether it was malformed JSON, a schema mismatch, or a truncated reply.
  console.log(`\n--- raw model response (${raw.length} chars) ---`)
  console.log(raw)
}
