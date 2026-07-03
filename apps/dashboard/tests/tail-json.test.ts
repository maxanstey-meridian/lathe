import { strict as assert } from "node:assert";
import { test } from "node:test";

import { classifyLine } from "../app/pages/index/logic/tail-json";

const longObject = JSON.stringify({ name: "test", value: 42, items: [1, 2, 3], nested: { a: true, b: "hello" }, extra: "padding to exceed eighty characters total here yes" });
const longArray = JSON.stringify(Array.from({ length: 12 }, (_, i) => ({ id: i, label: `item-${i}`, active: i % 2 === 0 })));

test("plain text stays text", () => {
  assert.equal(classifyLine("hello world").kind, "text");
  assert.equal(classifyLine("This is a longer line of plain text that definitely exceeds eighty chars yes").kind, "text");
});

test("short valid JSON stays text", () => {
  assert.equal(classifyLine('{"ok":true}').kind, "text");
  assert.equal(classifyLine('[1,2,3]').kind, "text");
});

test("valid object longer than 80 chars becomes JSON with key count", () => {
  const result = classifyLine(longObject);
  assert.equal(result.kind, "json");
  if (result.kind === "json") {
    assert.equal(result.label, "{5 keys}");
    assert.ok(result.formatted.includes("\"name\""));
    assert.ok(result.formatted.includes("\n"));
  }
});

test("valid array longer than 80 chars becomes JSON with item count", () => {
  const result = classifyLine(longArray);
  assert.equal(result.kind, "json");
  if (result.kind === "json") {
    assert.equal(result.label, "[12 items]");
  }
});

test("incomplete JSON stays text", () => {
  const partial = '{"status":"ok","data":[1,2,3],"nested":{"deep":true';
  assert.equal(classifyLine(partial).kind, "text");
});

test("JSON primitive stays text", () => {
  assert.equal(classifyLine('"hello world this string is long enough to exceed the threshold limit yes"').kind, "text");
  assert.equal(classifyLine("42".padStart(81, "0")).kind, "text");
  assert.equal(classifyLine("true".padStart(81, " ")).kind, "text");
});

test("minified object pretty-prints correctly", () => {
  const minified = '{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6,"g":7,"h":8,"i":9,"j":10,"k":11,"l":12,"m":13}';
  const result = classifyLine(minified);
  assert.equal(result.kind, "json");
  if (result.kind === "json") {
    assert.ok(result.formatted.includes('  "a": 1'));
    assert.ok(result.formatted.includes('  "j": 10'));
  }
});

test("prefixed Daddy sync JSON becomes JSON", () => {
  const line = `DADDY_SYNC_OK${JSON.stringify({
    status: "ok",
    answer: "continue",
    constraints: ["preserve state"],
    evidence_used: ["run meta", "journal"],
    safe_next_action: "resume",
    human_decision_needed: false,
  })}`;

  const result = classifyLine(line);
  assert.equal(result.kind, "json");
  if (result.kind === "json") {
    assert.equal(result.label, "{6 keys}");
    assert.equal(result.payloads.length, 1);
    assert.deepEqual(result.segments.map((segment) => segment.kind), ["text", "json"]);
    assert.equal(result.segments[0]?.kind === "text" ? result.segments[0].text : undefined, "DADDY_SYNC_OK");
    assert.ok(result.formatted.includes('  "status": "ok"'));
  }
});

test("multiple JSON payloads are extracted independently", () => {
  const first = JSON.stringify({ status: "ok", answer: "yes", padding: "x".repeat(20) });
  const second = JSON.stringify({ status: "next", answer: "no", padding: "y".repeat(20) });
  const result = classifyLine(`prefix ${first} middle ${second} suffix`);

  assert.equal(result.kind, "json");
  if (result.kind === "json") {
    assert.equal(result.payloads.length, 2);
    assert.deepEqual(result.segments.map((segment) => segment.kind), ["text", "json", "text", "json", "text"]);
    assert.equal(result.segments[0]?.kind === "text" ? result.segments[0].text : undefined, "prefix ");
    assert.equal(result.segments[2]?.kind === "text" ? result.segments[2].text : undefined, " middle ");
    assert.equal(result.segments[4]?.kind === "text" ? result.segments[4].text : undefined, " suffix");
    assert.equal(result.payloads[0]?.label, "{3 keys}");
    assert.equal(result.payloads[1]?.label, "{3 keys}");
    assert.ok(result.payloads[0]?.formatted.includes('"status": "ok"'));
    assert.ok(result.payloads[1]?.formatted.includes('"status": "next"'));
  }
});

test("null is text even if long enough", () => {
  const padded = `${" ".repeat(80)}null`;
  assert.equal(classifyLine(padded).kind, "text");
});
