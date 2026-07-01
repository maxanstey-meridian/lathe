import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  frontmatterReaskNudge,
  jsonReaskNudge,
  tryParseFinalReview,
  tryParsePlannerResponse,
} from "../src/domain/review.js";
import { balancedObjects, jsonCandidates } from "../src/domain/structured-extraction.js";

describe("balancedObjects (the single shared scanner)", () => {
  it("finds every top-level object, ignoring braces inside strings", () => {
    assert.deepEqual(balancedObjects('a {"x":1} b {"y":"}{"} c'), ['{"x":1}', '{"y":"}{"}']);
  });

  it("ignores an unbalanced trailing brace", () => {
    assert.deepEqual(balancedObjects("{a:1} {oops"), ["{a:1}"]);
  });
});

describe("jsonCandidates (the shared best-first builder)", () => {
  it("orders fenced blocks and balanced objects last-first, then raw fallbacks", () => {
    const raw = 'noise {"first":1} more {"second":2} tail';
    const cands = jsonCandidates(raw);
    // Balanced objects come reversed (the real verdict trails the prose).
    assert.ok(cands.indexOf('{"second":2}') < cands.indexOf('{"first":1}'));
  });
});

describe("the fail-closed parsers reach the same verdict through the shared scanner", () => {
  it("planner response: picks the trailing verdict over an earlier prose example", () => {
    const raw = `Example: {"status":"stop"}
Final: {"status":"proceed","answer":"go","safe_next_action":"do it"}`;
    assert.equal(tryParsePlannerResponse(raw)?.status, "proceed");
  });

  it("final review: recovers a fenced verdict", () => {
    const raw = '```json\n{"verdict":"request_changes","findings":["x"],"notes":"n"}\n```';
    assert.equal(tryParseFinalReview(raw)?.verdict, "request_changes");
  });
});

describe("the re-ask family — one shape, two formats", () => {
  it("jsonReaskNudge carries the reason and the emit-only-the-block instruction", () => {
    const out = jsonReaskNudge("missing status field");
    assert.match(out, /could not be accepted: missing status field/);
    assert.match(out, /ONLY the JSON verdict object/);
  });

  it("frontmatterReaskNudge mirrors it, specialised for the packet frontmatter", () => {
    const out = frontmatterReaskNudge("invalid YAML escape");
    assert.match(out, /could not be accepted: invalid YAML escape/);
    assert.match(out, /ONLY the corrected packet/);
    assert.match(out, /opening `---`/);
  });
});
