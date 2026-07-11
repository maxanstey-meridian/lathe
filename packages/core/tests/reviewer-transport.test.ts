import { equal } from "node:assert";
import { test } from "node:test";
import { describeUnreachable } from "../src/domain/reviewer-transport.js";

test("describeUnreachable: keeps the connection-dropped framing", () => {
  equal(describeUnreachable("socket hang up"), "Connection dropped: socket hang up");
});
