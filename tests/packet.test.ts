import assert from "node:assert";
import { test } from "node:test";
import { parsePacketShape, redactPacketInfra, stampBase } from "../src/domain/index.ts";

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

test("redact: parsed packet still carries promoted after redaction", () => {
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
  const parsed = parsePacketShape(raw);
  assert.strictEqual(parsed.ok, true);
  if (parsed.ok) {
    assert.strictEqual(parsed.packet.frontmatter.promoted, true);
  }
  const redacted = redactPacketInfra(raw);
  assert(!redacted.includes("promoted:"));
  const reParsed = parsePacketShape(redacted);
  assert.strictEqual(reParsed.ok, true);
  if (reParsed.ok) {
    // After redaction, promoted is absent → defaults to false
    assert.strictEqual(reParsed.packet.frontmatter.promoted, false);
  }
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
