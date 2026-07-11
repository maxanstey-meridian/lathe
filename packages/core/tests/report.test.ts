import { match } from "node:assert";
import { describe, it } from "node:test";
import type { SubmitReport } from "../src/domain/report.js";
import type { FinalReview } from "../src/domain/review.js";
import { renderReportMarkdown } from "../src/domain/report.js";

const minReport = (): SubmitReport => ({
  status: "ready_for_review",
  summary: "implemented X",
  outcomeClaims: [{ id: "test-outcome", status: "done" }],
  filesChanged: [],
  behaviourChanged: [],
  sourceOfTruthFollowed: [],
  verificationClaims: [],
  escalations: [],
  remainingUncertainty: [],
  regressionGuard: { tests: [] },
});

const minFinalReview = (
  verdict: "accept" | "request_changes" | "escalate" = "accept",
): FinalReview => ({
  verdict,
  findings: ["test-outcome: delivered at src/domain/prompts.ts — all renderers present"],
  notes: "clean diff",
  human_decision_needed: null,
});

describe("report-render — renderReportMarkdown", () => {
  it("includes the ## Outcomes section with outcome claims", () => {
    const report = minReport();
    const output = renderReportMarkdown(report, "20260618-070000-test");
    match(output, /## Outcomes/);
    match(output, /- test-outcome: done/);
  });

  it("includes summary and status lines", () => {
    const report = minReport();
    const output = renderReportMarkdown(report, "20260618-070000-test");
    match(output, /# Implementation Report — 20260618-070000-test/);
    match(output, /Status: \*\*ready_for_review\*\*/);
    match(output, /## Summary/);
    match(output, /implemented X/);
  });

  it("appends FinalReview section when provided", () => {
    const report = minReport();
    const review = minFinalReview("accept");
    const output = renderReportMarkdown(report, "20260618-070000-test", review);
    match(output, /## Final review \(Daddy\)/);
    match(output, /Verdict: \*\*accept\*\*/);
    match(output, /test-outcome: delivered at src\/domain\/prompts\.ts/);
  });

  it("appends FinalReview notes when present", () => {
    const report = minReport();
    const review: FinalReview = { ...minFinalReview("request_changes"), notes: "needs fixes" };
    const output = renderReportMarkdown(report, "20260618-070000-test", review);
    match(output, /Verdict: \*\*request_changes\*\* — needs fixes/);
  });

  it("omits FinalReview section when not provided", () => {
    const report = minReport();
    const output = renderReportMarkdown(report, "20260618-070000-test");
    match(output, /## Outcomes/);
    if (output.indexOf("## Final review (Daddy)") !== -1) {
      throw new Error("Final review section should not be present when no FinalReview is passed");
    }
  });

  it("renders files-changed table", () => {
    const report: SubmitReport = {
      ...minReport(),
      filesChanged: [
        {
          path: "src/main.ts",
          classification: "expected",
          reason: "part of scope",
          action: "kept",
        },
      ],
    };
    const output = renderReportMarkdown(report, "20260618-070000-test");
    match(output, /## Files changed/);
    match(output, /`src\/main\.ts`/);
    match(output, /expected/);
  });

  it("renders regression guard section when tests are present", () => {
    const report: SubmitReport = {
      ...minReport(),
      regressionGuard: {
        tests: [{ name: "test-foo", file: "tests/foo.test.ts", covers: "foo was broken" }],
      },
    };
    const output = renderReportMarkdown(report, "20260618-070000-test");
    match(output, /## Regression guard/);
    match(output, /test-foo/);
    match(output, /tests\/foo\.test\.ts/);
    match(output, /foo was broken/);
  });

  it("renders regression guard section when justification is present", () => {
    const report: SubmitReport = {
      ...minReport(),
      regressionGuard: { tests: [], noTestJustification: "The fix is a config change only." },
    };
    const output = renderReportMarkdown(report, "20260618-070000-test");
    match(output, /## Regression guard/);
    match(output, /No regression test \(justification\)/);
    match(output, /config change only/);
  });

  it("omits regression guard section when empty", () => {
    const report = minReport();
    const output = renderReportMarkdown(report, "20260618-070000-test");
    if (output.indexOf("## Regression guard") !== -1) {
      throw new Error("Regresion guard section should not be present when empty");
    }
  });

  it("renders blocked reason in status line", () => {
    const report: SubmitReport = {
      ...minReport(),
      status: "blocked",
      blockedReason: "wedged",
    };
    const output = renderReportMarkdown(report, "20260618-070000-test");
    match(output, /Status: \*\*blocked\*\* \(wedged\)/);
  });
});
