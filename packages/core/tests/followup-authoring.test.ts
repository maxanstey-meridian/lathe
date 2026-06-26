import assert from "node:assert";
import { test } from "node:test";
import { renderFollowupAuthoring } from "../src/domain/prompts.ts";

// Minimal authoring input — blockers/priorOutcomes empty is fine for prompt shape.
const baseInput = {
  worktree: "/tmp/wt",
  packetSkillText: "PACKET SKILL TEXT",
  blockers: [],
  priorOutcomes: [],
  pass: 2,
  campaignId: "c",
};

test("renderFollowupAuthoring: demands the reply begin with --- and forbids fences", () => {
  const out = renderFollowupAuthoring(baseInput);
  assert.match(out, /FIRST character of your reply must be `---`/);
  assert.match(out, /do NOT wrap the packet in/);
});

test("renderFollowupAuthoring: a first attempt has no rejection or received block", () => {
  const out = renderFollowupAuthoring(baseInput);
  assert.ok(!out.includes("REJECTED at admission"));
  assert.ok(!out.includes("RECEIVED"));
});

test("renderFollowupAuthoring: a retry feeds back the problems AND a snippet of what was received", () => {
  const out = renderFollowupAuthoring({
    ...baseInput,
    priorProblems: ["no YAML frontmatter block (--- ... ---) at top of packet"],
    priorRawSnippet: "Here is the packet:\n\nsummary: oops — narration, no frontmatter",
  });
  assert.match(out, /REJECTED at admission/);
  assert.match(out, /no YAML frontmatter block/);
  assert.match(out, /<<<RECEIVED/);
  assert.ok(out.includes("Here is the packet:"));
});

test("renderFollowupAuthoring: problems without a snippet render no RECEIVED block", () => {
  const out = renderFollowupAuthoring({
    ...baseInput,
    priorProblems: ["frontmatter.repo: Required"],
  });
  assert.match(out, /REJECTED at admission/);
  assert.ok(!out.includes("RECEIVED"));
});
