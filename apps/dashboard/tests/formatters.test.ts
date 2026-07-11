import { describe, expect, test } from "vitest";

import { campaignStatusLabel, runStatusLabel } from "../app/pages/index/logic/formatters";

describe("operator status labels", () => {
  test.each([
    ["running", "Implementation in progress"],
    ["ready_for_review", "Awaiting acceptance review"],
    ["blocked", "Needs input"],
    ["accepted", "Prepared for merge"],
  ])("maps run status %s", (status, expected) => {
    expect(runStatusLabel(status)).toBe(expected);
  });

  test.each([
    ["open", "Repair sequence in progress"],
    ["converged", "Review passed"],
    ["needs_max", "Needs operator decision"],
  ])("maps campaign status %s", (status, expected) => {
    expect(campaignStatusLabel(status)).toBe(expected);
  });
});
