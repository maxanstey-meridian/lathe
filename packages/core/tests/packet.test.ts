import assert from "node:assert";
import { test } from "node:test";
import {
  extractFrontmatter,
  normalizeForFrontmatter,
  parsePacketShape,
  redactPacketInfra,
  stampBase,
} from "../src/domain/index.ts";

// ---- parsePacketShape ----

test("parse: valid packet with runId returns ok", () => {
  const raw = `---
repo: /tmp/repo
base: main
outcomes:
  - id: feature-a
    description: Adds feature A
  - id: feature-b
    description: Adds feature B
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body text here
`;
  const result = parsePacketShape(raw, "20260618-030000-v3-test");
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.packet.runId, "20260618-030000-v3-test");
    assert.strictEqual(result.packet.frontmatter.repo, "/tmp/repo");
    assert.strictEqual(result.packet.frontmatter.base, "main");
    assert.strictEqual(result.packet.frontmatter.outcomes.length, 2);
    assert.strictEqual(result.packet.body, "body text here\n");
  }
});

test("parse: valid packet without runId still returns ok", () => {
  const raw = `---
repo: /tmp/repo
base: main
outcomes:
  - id: feature-a
    description: Adds feature A
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body
`;
  const result = parsePacketShape(raw);
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.packet.runId, "");
    assert.strictEqual(result.packet.frontmatter.outcomes.length, 1);
    assert.strictEqual(result.packet.frontmatter.promoted, false);
  }
});

test("parse: missing frontmatter returns error", () => {
  const raw = "no frontmatter at all";
  const result = parsePacketShape(raw, "20260618-030000-test");
  assert.strictEqual(result.ok, false);
  assert(!result.ok);
  assert.strictEqual(result.problems.length, 1);
  assert(result.problems[0].includes("no YAML frontmatter block"));
});

test("parse: invalid YAML in frontmatter returns error", () => {
  const raw = `---
repo: /tmp
base: [invalid yaml
---
body
`;
  const result = parsePacketShape(raw, "20260618-030000-test");
  assert.strictEqual(result.ok, false);
  assert(!result.ok);
  assert(result.problems[0].includes("not valid YAML"));
});

test("parse: schema failure on missing required fields", () => {
  const raw = `---
repo: /tmp/repo
---
body
`;
  const result = parsePacketShape(raw, "20260618-030000-test");
  assert.strictEqual(result.ok, false);
  assert(!result.ok);
  assert(result.problems.some((p) => p.startsWith("frontmatter.")));
});

test("parse: duplicate outcome ids returns error", () => {
  const raw = `---
repo: /tmp/repo
base: main
outcomes:
  - id: feature-a
    description: First
  - id: feature-a
    description: Duplicate
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body
`;
  const result = parsePacketShape(raw, "20260618-030000-test");
  assert.strictEqual(result.ok, false);
  assert(!result.ok);
  assert(result.problems.some((p) => p === "outcome ids are not unique"));
});

test("parse: bad runId format returns error", () => {
  const raw = `---
repo: /tmp/repo
base: main
outcomes:
  - id: feature-a
    description: Adds fe
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body
`;
  const result = parsePacketShape(raw, "bad-run-id");
  assert.strictEqual(result.ok, false);
  assert(!result.ok);
  assert(result.problems.some((p) => p.includes("packet filename must be")));
});

test("parse: valid runId format passes", () => {
  const raw = `---
repo: /tmp/repo
base: main
outcomes:
  - id: feature-a
    description: Adds feature
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body
`;
  const result = parsePacketShape(raw, "20260101-120000-my-run-slug");
  assert.strictEqual(result.ok, true);
});

test("parse: promoted defaults false, explicit true round-trips", () => {
  const rawWithoutPromoted = `---
repo: /tmp/repo
base: main
outcomes:
  - id: feature-a
    description: Adds feature A
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body
`;
  const result1 = parsePacketShape(rawWithoutPromoted);
  assert.strictEqual(result1.ok, true);
  if (result1.ok) {
    assert.strictEqual(result1.packet.frontmatter.promoted, false);
  }

  const rawWithPromoted = `---
repo: /tmp/repo
base: main
outcomes:
  - id: feature-a
    description: Adds feature A
expected_surface:
  - src/**
verification:
  - command: pnpm test
promoted: true
---
body
`;
  const result2 = parsePacketShape(rawWithPromoted);
  assert.strictEqual(result2.ok, true);
  if (result2.ok) {
    assert.strictEqual(result2.packet.frontmatter.promoted, true);
  }
});

test("parse: negative outcomes count rejected by schema", () => {
  const raw = `---
repo: /tmp/repo
base: main
outcomes: []
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body
`;
  const result = parsePacketShape(raw, "20260618-030000-test");
  assert.strictEqual(result.ok, false);
});

// ---- redactPacketInfra ----

test("redact: strips all six infra keys", () => {
  const raw = `---
repo: /home/user/proj
base: main
campaign_id: my-campaign
parent_run_id: 20260617-010000-parent
pass: 2
promoted: true
summary: test packet
outcomes:
  - id: feature-a
    description: Does things
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body content
`;
  const result = redactPacketInfra(raw);
  assert(!result.includes("repo:"));
  assert(!result.includes("base:"));
  assert(!result.includes("campaign_id:"));
  assert(!result.includes("parent_run_id:"));
  assert(!result.includes("pass:"));
  assert(!result.includes("promoted:"));
  assert(result.includes("summary:"));
  assert(result.includes("outcomes:"));
  assert(result.includes("expected_surface:"));
  assert(result.includes("verification:"));
  assert(result.includes("body content"));
});

test("redact: parsed packet carries promoted=true; redaction strips the key (two independent paths)", () => {
  const raw = `---
repo: /tmp/repo
base: main
outcomes:
  - id: feature-a
    description: Adds feature A
expected_surface:
  - src/**
verification:
  - command: pnpm test
promoted: true
---
body
`;
  // Path 1: parse the original raw — promoted is read as true.
  const parsed = parsePacketShape(raw);
  assert.strictEqual(parsed.ok, true);
  if (parsed.ok) {
    assert.strictEqual(parsed.packet.frontmatter.promoted, true);
  }
  // Path 2: redaction strips ALL infra keys (including repo/base) from the raw,
  // so re-parsing would fail for missing required fields — that is the point:
  // the parsed object is decoupled from the redacted raw text.
  const redacted = redactPacketInfra(raw);
  assert(!redacted.includes("promoted:"));
  // Confirm infra keys are stripped (repo/base gone → re-parse fails, proving
  // the parsed object was built from the original raw, not the redacted one).
  assert(!redacted.includes("repo:"));
  assert(!redacted.includes("base:"));
});

test("redact: preserves forbidden infra keys in other contexts", () => {
  const raw = `---
summary: contains repo-like text but not infra key
outcomes:
  - id: feature-a
    description: Does things
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body
`;
  const result = redactPacketInfra(raw);
  assert(result.includes("repo-like"));
});

test("redact: returns raw when no frontmatter", () => {
  const raw = "just some text\nno yaml delimiters";
  const result = redactPacketInfra(raw);
  assert.strictEqual(result, raw);
});

// ---- stampBase ----

test("stampBase: stamps base when absent and repo present", () => {
  const raw = `---
repo: /tmp/repo
summary: test packet
outcomes:
  - id: feature-a
    description: Does things
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body
`;
  const result = stampBase(raw, "main");
  assert(result.startsWith("---\nbase: main\nrepo:"));
  assert(result.includes("body"));
});

test("stampBase: honors explicit base override", () => {
  const raw = `---
repo: /tmp/repo
base: feature/x
outcomes:
  - id: feature-a
    description: Does things
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body
`;
  const result = stampBase(raw, "main");
  assert(result.includes("base: feature/x"));
  assert(!result.includes("base: main"));
});

test("stampBase: returns raw when detached HEAD (headBranch === HEAD)", () => {
  const raw = `---
repo: /tmp/repo
outcomes:
  - id: feature-a
    description: Does things
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body
`;
  const result = stampBase(raw, "HEAD");
  assert.strictEqual(result, raw);
});

test("stampBase: returns raw on empty headBranch", () => {
  const raw = `---
repo: /tmp/repo
outcomes:
  - id: feature-a
    description: Does things
expected_surface:
  - src/**
verification:
  - command: pnpm test
---
body
`;
  const result = stampBase(raw, "");
  assert.strictEqual(result, raw);
});

test("stampBase: returns raw when no frontmatter", () => {
  const raw = "no frontmatter here";
  const result = stampBase(raw, "main");
  assert.strictEqual(result, raw);
});

// ---- tolerant frontmatter extraction (the followup-authoring robustness fix) ----

const BARE = `---
repo: /tmp/repo
base: main
outcomes:
  - id: feature-a
    description: Adds feature A
expected_surface:
  - src/**
verification:
  - command: pnpm test
---

# body

Repair it.
`;

// The parse a clean packet produces — every tolerant variant must match this.
const parseBare = () => {
  const r = parsePacketShape(BARE, "20260618-030000-test");
  assert.ok(r.ok);
  return r.ok ? r.packet : undefined;
};

test("tolerant: a code fence wrapping the whole document parses like the bare packet", () => {
  const wrapped = "```markdown\n" + BARE + "```\n";
  const got = parsePacketShape(wrapped, "20260618-030000-test");
  const bare = parseBare();
  assert.ok(got.ok, got.ok ? "" : got.problems.join("; "));
  if (got.ok && bare) {
    assert.deepEqual(got.packet.frontmatter, bare.frontmatter);
    // Body content matches; fence-stripping may drop the trailing newline.
    assert.equal(got.packet.body.trim(), bare.body.trim());
    assert.ok(!got.packet.body.includes("```"));
  }
});

test("tolerant: narration before the first --- (multi-message harvest) is skipped", () => {
  const narrated = "Let me inspect the tree.\n\nHere is the packet:\n\n" + BARE;
  const got = parsePacketShape(narrated, "20260618-030000-test");
  const bare = parseBare();
  assert.ok(got.ok, got.ok ? "" : got.problems.join("; "));
  if (got.ok && bare) {
    assert.deepEqual(got.packet.frontmatter, bare.frontmatter);
    assert.equal(got.packet.body, bare.body);
  }
});

test("tolerant: trailing whitespace on the --- delimiter lines parses", () => {
  const dirty = BARE.replace("---\nrepo:", "---  \nrepo:").replace(
    "\n---\n\n# body",
    "\n---\t\n\n# body",
  );
  const got = parsePacketShape(dirty, "20260618-030000-test");
  assert.ok(got.ok, got.ok ? "" : got.problems.join("; "));
});

test("tolerant: CRLF line endings parse", () => {
  const crlf = BARE.replace(/\n/g, "\r\n");
  const got = parsePacketShape(crlf, "20260618-030000-test");
  const bare = parseBare();
  assert.ok(got.ok, got.ok ? "" : got.problems.join("; "));
  if (got.ok && bare) {
    assert.deepEqual(got.packet.frontmatter, bare.frontmatter);
  }
});

test("tolerant: a reply with no frontmatter still fails closed (never invents one)", () => {
  assert.equal(extractFrontmatter("I could not write a packet."), undefined);
  const got = parsePacketShape("just prose, no packet", "20260618-030000-test");
  assert.equal(got.ok, false);
});

test("tolerant: normalizeForFrontmatter is a no-op on an already-clean packet", () => {
  assert.equal(normalizeForFrontmatter(BARE), BARE);
});
