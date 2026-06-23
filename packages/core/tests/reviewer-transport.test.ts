import { equal } from "node:assert";
import { test } from "node:test";
import { classifyReviewerError, describeUnreachable } from "../src/domain/reviewer-transport.js";

test("classifyReviewerError: socket hang up is transient", () => {
  equal(classifyReviewerError("socket hang up"), "transient");
});

test("classifyReviewerError: Node socket errnos are transient", () => {
  for (const e of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"]) {
    equal(classifyReviewerError(`request failed: ${e}`), "transient", e);
  }
});

test("classifyReviewerError: undici 'terminated' / 'other side closed' are transient", () => {
  equal(classifyReviewerError("TypeError: terminated"), "transient");
  equal(classifyReviewerError("other side closed"), "transient");
});

test("classifyReviewerError: 5xx and 429/408 statuses are transient", () => {
  for (const s of [500, 502, 503, 504, 429, 408, 425]) {
    equal(classifyReviewerError(`APIError (HTTP ${s}): upstream`), "transient", String(s));
  }
});

test("classifyReviewerError: auth/bad-request statuses are fatal", () => {
  for (const s of [400, 401, 403, 404, 422]) {
    equal(classifyReviewerError(`APIError (HTTP ${s}): bad`), "fatal", String(s));
  }
});

test("classifyReviewerError: a status code overrides a transient-looking message", () => {
  // A 400 whose message mentions "timeout" is still a fatal bad request.
  equal(classifyReviewerError("APIError (HTTP 400): invalid timeout param"), "fatal");
});

test("classifyReviewerError: unrecognised errors default to fatal (not blindly retried)", () => {
  equal(classifyReviewerError("something completely unexpected"), "fatal");
});

test("describeUnreachable: keeps the Connection dropped framing", () => {
  equal(describeUnreachable("socket hang up"), "Connection dropped: socket hang up");
});
