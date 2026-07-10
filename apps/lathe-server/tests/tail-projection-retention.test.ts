import { deepStrictEqual } from "node:assert";
import { test } from "node:test";

import { createTailProjectionRetention } from "../src/tail-projection-retention.js";

test("tail projection retention evicts the oldest inactive run and preserves pinned runs", () => {
  const evicted: string[] = [];
  const retention = createTailProjectionRetention(2, () => false, (runId) => evicted.push(runId));
  retention.pin("active");
  retention.touch("one");
  retention.touch("two");
  retention.touch("three");

  deepStrictEqual(evicted, ["one"]);
  deepStrictEqual(retention.cachedRunIds(), ["two", "three"]);
  retention.unpin("active");
  deepStrictEqual(evicted, ["one", "two"]);
});

test("tail projection retention defers eviction while a projection is busy", () => {
  const busy = new Set(["one"]);
  const evicted: string[] = [];
  const retention = createTailProjectionRetention(1, (runId) => busy.has(runId), (runId) => evicted.push(runId));
  retention.touch("one");
  retention.touch("two");
  deepStrictEqual(evicted, ["two"]);
  busy.clear();
  retention.touch("three");
  deepStrictEqual(evicted, ["two", "one"]);
});

test("tail projection retention enforces its limit when busy work settles", () => {
  const busy = new Set(["one", "two"]);
  const evicted: string[] = [];
  const retention = createTailProjectionRetention(1, (runId) => busy.has(runId), (runId) => evicted.push(runId));
  retention.touch("one");
  retention.touch("two");

  busy.clear();
  retention.enforce();

  deepStrictEqual(evicted, ["one"]);
  deepStrictEqual(retention.cachedRunIds(), ["two"]);
});
