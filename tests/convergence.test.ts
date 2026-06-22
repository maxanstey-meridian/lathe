import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { upsertPass } from "../src/domain/campaign.js";
import { parseStaged, convergedTip, decidePromotion } from "../src/domain/chain.js";
import {
  decideConvergence,
  parseSuperReview,
  renderFollowupPacket,
  assembleCommitMessage,
  renderNits,
} from "../src/domain/convergence.js";
import { parsePacketShape, type AdmissionResult } from "../src/domain/packet.js";
import {
  parseFinalReview,
  parsePlannerResponse,
  tryParseFinalReview,
} from "../src/domain/review.js";

const parsePacket = (path: string): AdmissionResult => {
  const raw = readFileSync(path, "utf-8");
  const runId = path.split("/").pop()?.replace(/\.md$/, "");
  return parsePacketShape(raw, runId);
};

// --- helpers ---

const finding = (id, severity = "P0", kind = "command_fail", extra = {}) => ({
  id,
  severity,
  title: `${id} description`,
  evidence: [],
  grounding: { kind, ref: kind === "none" ? "" : `ref-${id}` },
  ...extra,
});

const review = (verdict, findings, human = null) => ({
  verdict,
  findings,
  convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
  notes: "",
  human_decision_needed: human,
});

// --- decideConvergence: all 6 branches ---

test("decideConvergence: request_changes hands EVERY finding to the pass, regardless of severity/grounding", () => {
  const nitsOnly = review("request_changes", [
    finding("a", "P2", "none"),
    finding("b", "P3", "none"),
  ]);
  const d = decideConvergence(nitsOnly, true, 1, 3);
  assert.equal(d.action, "author");
  assert.equal(d.blockers.length, 2);
});

test("decideConvergence: request_changes with NO findings → escalate (wants changes, named none)", () => {
  const empty = decideConvergence(review("request_changes", []), true, 1, 3);
  assert.equal(empty.action, "escalate");
});

test("decideConvergence: stop only on accept + green (the ONLY stop path)", () => {
  assert.equal(decideConvergence(review("accept", []), true, 1, 3).action, "stop");
});

test("decideConvergence: accept + verification RED → escalate (under-reported)", () => {
  const red = decideConvergence(review("accept", []), false, 1, 3);
  assert.equal(red.action, "escalate");
  assert.ok(red.reason.includes("under-reported"));
});

test("decideConvergence: blockers author until the cap, then escalate", () => {
  const blocked = review("request_changes", [finding("x", "P0", "command_fail")]);
  const d1 = decideConvergence(blocked, true, 1, 3);
  assert.equal(d1.action, "author");
  assert.equal(d1.blockers.length, 1);
  const capped = decideConvergence(blocked, true, 3, 3);
  assert.equal(capped.action, "escalate");
  assert.ok(capped.reason.includes("cap"));
});

test("decideConvergence: explicit escalate / human_decision_needed always wins", () => {
  assert.equal(decideConvergence(review("escalate", []), true, 1, 3).action, "escalate");
  assert.equal(
    decideConvergence(review("accept", [], "needs a call"), true, 1, 3).action,
    "escalate",
  );
});

// --- parseSuperReview: valid, fenced, garbage, scar ---

test("parseSuperReview: valid, fenced, and garbage → escalate", () => {
  const good = {
    verdict: "request_changes",
    findings: [finding("x", "P0", "command_fail")],
    convergence: { recommend_stop: false, profile: { p0: 1, p1: 0, p2: 0, p3: 0 }, rationale: "r" },
    notes: "n",
    human_decision_needed: null,
  };
  assert.equal(parseSuperReview(JSON.stringify(good)).verdict, "request_changes");
  assert.equal(
    parseSuperReview("```json\n" + JSON.stringify(good) + "\n```").verdict,
    "request_changes",
  );
  const garbage = parseSuperReview("the build looks fine to me, ship it");
  assert.equal(garbage.verdict, "escalate");
  assert.ok(garbage.human_decision_needed);
});

test("parseSuperReview: reasoning prose + stray code fence does not shadow the real verdict", () => {
  const accept = {
    verdict: "accept",
    findings: [],
    convergence: {
      recommend_stop: true,
      profile: { p0: 0, p1: 0, p2: 0, p3: 0 },
      rationale: "all delivered",
    },
    notes: "8/8 outcomes delivered, suite green",
    human_decision_needed: null,
  };
  const response =
    "Let me check the deserialization.\n\n```csharp\nvar dict = {};\n```\n\n" +
    "This is correct. Verdict: accept.\n\n" +
    JSON.stringify(accept);
  assert.equal(parseSuperReview(response).verdict, "accept");
  const trailing = response + "\n\nfollow-up note: {not: valid json here}";
  assert.equal(parseSuperReview(trailing).verdict, "accept");
});

// --- parseFinalReview: valid, fence, garbage → request_changes ---

test("parseFinalReview: valid verdicts parse; garbage → request_changes", () => {
  const good = { verdict: "accept", findings: ["a"], notes: "ok" };
  assert.equal(parseFinalReview(JSON.stringify(good)).verdict, "accept");
  const fenced = parseFinalReview("```json\n" + JSON.stringify(good) + "\n```\nmore text");
  assert.equal(fenced.verdict, "accept");
  const garbage = parseFinalReview("the build looks fine to me, ship it");
  assert.equal(garbage.verdict, "request_changes");
});

test("parseFinalReview: prose example object before real verdict → parses the real verdict (balanced last-first)", () => {
  const good = { verdict: "accept", findings: ["all outcomes delivered"], notes: "8/8" };
  const response =
    "I'll show what a good verdict looks like:\n\n" +
    '{"verdict": "request_changes", "findings": ["example finding"]}\n\n' +
    "But the actual verdict is:\n\n" +
    JSON.stringify(good);
  assert.equal(parseFinalReview(response).verdict, "accept");
});

test("parseFinalReview: fenced verdict with surrounding prose → parses correctly", () => {
  const good = { verdict: "accept", findings: [], notes: "green" };
  const response =
    "Reviewed the diff. Everything looks good.\n\n" +
    "```json\n" +
    JSON.stringify(good) +
    "\n```\n\n" +
    "No issues found.";
  assert.equal(parseFinalReview(response).verdict, "accept");
});

test("tryParseFinalReview: returns null for unparseable input", () => {
  assert.equal(tryParseFinalReview("the build looks fine to me"), null);
  assert.equal(tryParseFinalReview(""), null);
  assert.equal(tryParseFinalReview("not json at all {with braces"), null);
});

test("tryParseFinalReview: returns parsed result for valid input", () => {
  const good = { verdict: "accept", findings: ["a"], notes: "ok" };
  const result = tryParseFinalReview(JSON.stringify(good));
  assert.ok(result);
  assert.equal(result.verdict, "accept");
});

test("tryParseFinalReview: returns null when fenced content is not valid JSON but prose is also not valid", () => {
  const result = tryParseFinalReview("```json\n{not valid json\n```\nstill broken");
  assert.equal(result, null);
});

test("tryParseFinalReview: fenced example object before real balanced-JSON verdict → parses the real verdict", () => {
  const real = { verdict: "accept", findings: ["all outcomes delivered"], notes: "8/8" };
  const response =
    "Here's what a verdict looks like:\n\n" +
    "```json\n" +
    JSON.stringify({
      verdict: "request_changes",
      findings: ["example finding"],
      notes: "example",
    }) +
    "\n```\n\n" +
    "The actual verdict:\n\n" +
    JSON.stringify(real);
  assert.equal(tryParseFinalReview(response)?.verdict, "accept");
  assert.equal(tryParseFinalReview(response)?.notes, "8/8");
});

// --- parsePlannerResponse: fences, braces, garbage → stop ---

test("parsePlannerResponse: fenced JSON, bare JSON, garbage → stop", () => {
  const good = {
    status: "proceed",
    answer: "a",
    constraints: [],
    evidence_used: [],
    safe_next_action: "x",
    human_decision_needed: null,
  };
  assert.equal(parsePlannerResponse(JSON.stringify(good)).status, "proceed");
  assert.equal(
    parsePlannerResponse("```json\n" + JSON.stringify(good) + "\n```").status,
    "proceed",
  );
  assert.equal(
    parsePlannerResponse("prefix " + JSON.stringify(good) + " suffix").status,
    "proceed",
  );
  assert.equal(parsePlannerResponse("I think you should probably proceed").status, "stop");
  assert.equal(parsePlannerResponse('{"status": "ask_repo_first", "answer": "x"}').status, "stop");
});

test("parsePlannerResponse: reasoning prose with braces then trailing JSON → parses the verdict", () => {
  const verbose = `Let me weigh this. squares: Array<Array<Piece | null>>.
I considered { mailbox } and { 0x88 } board representations before deciding.
Here is my verdict:
{"status":"proceed_with_constraints","answer":"8x8 copy-and-test endorsed","constraints":["copyBoard must deep-copy"],"evidence_used":["packet"],"safe_next_action":"write board.ts","human_decision_needed":null}`;
  const r = parsePlannerResponse(verbose);
  assert.equal(r.status, "proceed_with_constraints");
  assert.equal(r.constraints[0], "copyBoard must deep-copy");
});

// --- renderFollowupPacket: round-trip through admission ---

test("renderFollowupPacket: produces a packet parsePacket accepts, with lineage + regression", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumb-converge-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execSync("git init -q -b main && git commit -q --allow-empty -m init", {
      cwd: repo,
      shell: "/bin/zsh",
    });
    execSync("git branch meridian/parent", { cwd: repo, shell: "/bin/zsh" });

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
    };

    const out = renderFollowupPacket({
      original,
      parentRunId: "20260614-100000-feature",
      campaignId: "feature",
      pass: 2,
      blockers: [
        {
          id: "fix-typecheck",
          severity: "P0",
          title: "ui typecheck fails",
          evidence: ["use-x.ts:29"],
          grounding: { kind: "command_fail", ref: "pnpm check" },
          suggested_outcome_id: "ui-typecheck-passes",
        },
      ],
      priorOutcomes: [{ id: "feature", description: "the feature" }],
      baseBranch: "meridian/parent",
      timestamp: "20260614-180000",
      slug: "feature-followup",
    });

    assert.equal(out.runId, "20260614-180000-feature-followup");

    const file = join(dir, out.filename);
    writeFileSync(file, out.content);
    const parsed = parsePacket(file);
    assert.ok(
      parsed.ok,
      "rendered packet must pass admission: " + (parsed.ok ? "" : parsed.problems.join("; ")),
    );
    assert.equal(parsed.packet.frontmatter.base, "meridian/parent");
    assert.equal(parsed.packet.frontmatter.summary, "convergence pass 2 — ui typecheck fails");
    assert.equal(parsed.packet.frontmatter.campaign_id, "feature");
    assert.equal(parsed.packet.frontmatter.parent_run_id, "20260614-100000-feature");
    assert.equal(parsed.packet.frontmatter.pass, 2);
    assert.equal(parsed.packet.frontmatter.outcomes[0].id, "ui-typecheck-passes");
    assert.equal(parsed.packet.frontmatter.regression_outcomes[0].id, "feature");
    assert.ok(parsed.packet.frontmatter.verification.some((v) => v.command === "pnpm check"));
    assert.ok(parsed.packet.frontmatter.constraints.some((c) => c.includes("must STILL pass")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderFollowupPacket: a repaired outcome is never also a regression guard", () => {
  const dir = mkdtempSync(join(tmpdir(), "plumb-converge-"));
  try {
    const repo = join(dir, "repo");
    mkdirSync(repo);
    execSync("git init -q -b main && git commit -q --allow-empty -m init", {
      cwd: repo,
      shell: "/bin/zsh",
    });
    execSync("git branch work", { cwd: repo, shell: "/bin/zsh" });

    const out = renderFollowupPacket({
      original: {
        runId: "20260101-000000-add",
        frontmatter: {
          repo,
          base: "main",
          outcomes: [{ id: "add-returns-sum", description: "add returns the sum" }],
          expected_surface: ["*.js"],
          suspicious_surface: [],
          verification: [{ command: "node test.js" }],
          constraints: [],
          pass: 1,
          regression_outcomes: [],
        },
        body: "",
        raw: "",
      },
      parentRunId: "20260101-000000-add",
      campaignId: "20260101-000000-add",
      pass: 2,
      blockers: [
        finding("add-bug", "P1", "command_fail", { suggested_outcome_id: "add-returns-sum" }),
      ],
      priorOutcomes: [{ id: "add-returns-sum", description: "add returns the sum" }],
      baseBranch: "work",
      timestamp: "20260102-000000",
      slug: "add-fix2",
    });

    const file = join(dir, out.filename);
    writeFileSync(file, out.content);
    const parsed = parsePacket(file);
    assert.ok(parsed.ok, "packet must admit: " + (parsed.ok ? "" : parsed.problems.join("; ")));
    const outIds = new Set(parsed.packet.frontmatter.outcomes.map((o) => o.id));
    const regIds = new Set(parsed.packet.frontmatter.regression_outcomes.map((o) => o.id));
    assert.ok(outIds.has("add-returns-sum"));
    assert.equal(
      [...outIds].some((id) => regIds.has(id)),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderFollowupPacket: no blockers → throws", () => {
  assert.throws(() =>
    renderFollowupPacket({
      original: {
        runId: "20260101-000000-a",
        frontmatter: {
          repo: "/tmp/x",
          base: "main",
          outcomes: [{ id: "a", description: "a" }],
          expected_surface: ["src/**"],
          verification: [{ command: "true" }],
          constraints: [],
          pass: 1,
          regression_outcomes: [],
        },
        body: "",
        raw: "",
      },
      parentRunId: "20260101-000000-a",
      campaignId: "c",
      pass: 2,
      blockers: [],
      priorOutcomes: [],
      baseBranch: "main",
      timestamp: "20260102-000000",
      slug: "a-fix2",
    }),
  );
});

// --- upsertPass: first pass, append, replace ---

test("upsertPass: creates on first pass, appends, and replaces a re-recorded run", () => {
  const init = { campaignId: "c", originalRunId: "r1", originalIntent: "i", maxPasses: 3 };
  const c1 = upsertPass(
    undefined,
    init,
    { runId: "r1", pass: 1, verdict: "request_changes", groundedBlockers: 2, atIso: "t1" },
    "open",
  );
  assert.equal(c1.passes.length, 1);
  assert.equal(c1.status, "open");
  assert.equal(c1.campaignId, "c");

  const c2 = upsertPass(
    c1,
    init,
    { runId: "r2", pass: 2, verdict: "accept", groundedBlockers: 0, atIso: "t2" },
    "converged",
  );
  assert.equal(c2.passes.length, 2);
  assert.equal(c2.status, "converged");
  assert.equal(c2.originalRunId, "r1");

  const c3 = upsertPass(
    c2,
    init,
    { runId: "r2", pass: 2, verdict: "accept", groundedBlockers: 0, atIso: "t3" },
    "converged",
  );
  assert.equal(c3.passes.length, 2);
  assert.equal(c3.passes[1].atIso, "t3");
});

// --- renderNits ---

test("renderNits: no findings → undefined", () => {
  assert.equal(renderNits("run1", review("accept", [])), undefined);
});

test("renderNits: lists each finding as a note", () => {
  const md = renderNits(
    "run1",
    review("accept", [finding("only-sd", "P2", "none"), finding("vibe", "P3", "none")]),
  );
  assert.ok(md);
  assert.ok(md.includes("only-sd"));
  assert.ok(md.includes("vibe"));
  assert.equal((md.match(/^## /gm) ?? []).length, 2);
});

test("renderNits: severity surfaced verbatim", () => {
  const md = renderNits("run1", review("accept", [finding("vibe", "P1", "none")]));
  assert.ok(md?.includes("[P1]"));
});

// --- assembleCommitMessage ---

test("assembleCommitMessage: subject + body joined with blank line, trimmed", () => {
  const msg = assembleCommitMessage({
    subject: "feat: add readable transcript segments",
    body: "Render per-speaker segments via the shared assembler.\n",
  });
  assert.equal(
    msg,
    "feat: add readable transcript segments\n\nRender per-speaker segments via the shared assembler.",
  );
});

test("assembleCommitMessage: empty body → subject only", () => {
  const msg = assembleCommitMessage({ subject: "fix: handle empty speaker list", body: "   " });
  assert.equal(msg, "fix: handle empty speaker list");
});

// --- parseStaged ---

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
body`;

test("parseStaged: a child with parent_run_id and NO base validates", () => {
  const r = parseStaged(
    stagedChild("parent_run_id: 20260618-010000-head\n"),
    "20260618-020000-child.md",
  );
  assert.ok(r.ok);
  assert.equal(r.info.runId, "20260618-020000-child");
  assert.equal(r.info.parentRunId, "20260618-010000-head");
});

test("parseStaged: a parent-less head with no base still validates", () => {
  const r = parseStaged(stagedChild(), "20260618-010000-head.md");
  assert.ok(r.ok);
  assert.equal(r.info.parentRunId, undefined);
});

test("parseStaged: non-runId filename is rejected", () => {
  const r = parseStaged(stagedChild(), "_CHAIN.md");
  assert.ok(!r.ok);
});

test("parseStaged: missing frontmatter and missing outcomes both fail closed", () => {
  assert.ok(!parseStaged("no frontmatter here", "20260618-020000-child.md").ok);
  const noOutcomes = `---\nrepo: /tmp/x\nexpected_surface:\n  - "src/**"\nverification:\n  - command: "t"\n---\nb`;
  assert.ok(!parseStaged(noOutcomes, "20260618-020000-child.md").ok);
});

// --- convergedTip ---

const campaign = (status, passes) => ({
  campaignId: "20260618-010000-head",
  originalRunId: "20260618-010000-head",
  originalIntent: "x",
  status,
  maxPasses: 3,
  passes,
  updatedAt: "2026-06-18T00:00:00.000Z",
});
const pass = (runId, verdict, n = 1) => ({
  runId,
  pass: n,
  verdict,
  groundedBlockers: 0,
  atIso: "2026-06-18T00:00:00.000Z",
});

test("convergedTip: the LATEST accepted pass is the tip", () => {
  assert.equal(
    convergedTip(
      campaign("converged", [
        pass("20260618-010000-head", "request_changes", 1),
        pass("20260618-010500-head-fix2", "accept", 2),
      ]),
    ),
    "20260618-010500-head-fix2",
  );
  assert.equal(convergedTip(campaign("open", [pass("r", "request_changes")])), undefined);
});

// --- decidePromotion: all 5 branches ---

test("decidePromotion: no parent → promote-now", () => {
  assert.equal(decidePromotion(undefined, undefined).action, "promote-now");
});

test("decidePromotion: parent not started / still open → wait", () => {
  assert.equal(decidePromotion("20260618-010000-head", undefined).action, "wait");
  assert.equal(
    decidePromotion("20260618-010000-head", campaign("open", [pass("r", "request_changes")]))
      .action,
    "wait",
  );
});

test("decidePromotion: parent needs_max → hold", () => {
  assert.equal(
    decidePromotion("20260618-010000-head", campaign("needs_max", [pass("r", "escalate")])).action,
    "hold",
  );
});

test("decidePromotion: parent converged → promote-with-base off the accepted tip branch", () => {
  const d = decidePromotion(
    "20260618-010000-head",
    campaign("converged", [pass("20260618-010500-head-fix2", "accept", 2)]),
  );
  assert.equal(d.action, "promote-with-base");
  assert.equal(d.tipRunId, "20260618-010500-head-fix2");
  assert.equal(d.base, "meridian/20260618-010500-head-fix2");
});

test("decidePromotion: converged but no accepted pass → hold (incoherent)", () => {
  assert.equal(decidePromotion("20260618-010000-head", campaign("converged", [])).action, "hold");
});
