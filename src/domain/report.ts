import { z } from "zod";
import { OutcomeStatus } from "./outcomes.js";
import type { FinalReview } from "./review.js";
import { BlockedReason } from "./run.js";

// ---------------------------------------------------------------------------
// Report (CONTRACT §11, V4)

export const FileClassification = z.enum([
  "expected",
  "acceptable-but-not-predeclared",
  "suspicious",
  "forbidden",
]);
export type FileClassification = z.infer<typeof FileClassification>;

export const ReportFile = z.object({
  path: z.string(),
  classification: FileClassification,
  reason: z.string(),
  action: z.enum(["kept", "reverted", "split", "needs-approval"]),
});
export type ReportFile = z.infer<typeof ReportFile>;

export const SubmitReport = z.object({
  status: z.enum(["ready_for_review", "blocked", "failed"]),
  blockedReason: BlockedReason.optional(),
  blockedQuestion: z.string().optional(),
  summary: z.string().min(1),
  filesChanged: z.array(ReportFile).default([]),
  behaviourChanged: z.array(z.string()).default([]),
  sourceOfTruthFollowed: z.array(z.string()).default([]),
  outcomeClaims: z.array(z.object({ id: z.string(), status: OutcomeStatus })).min(1),
  verificationClaims: z
    .array(
      z.object({
        command: z.string(),
        result: z.enum(["passed", "failed", "not_run"]),
        notes: z.string().optional(),
      }),
    )
    .default([]),
  escalations: z.array(z.string()).default([]),
  remainingUncertainty: z.array(z.string()).default([]),
});
export type SubmitReport = z.infer<typeof SubmitReport>;

// ---------------------------------------------------------------------------
// Report markdown rendering (CONTRACT §11, V4)

export const renderReportMarkdown = (
  report: SubmitReport,
  runId: string,
  finalReview?: FinalReview,
): string => {
  const lines: string[] = [
    `# Implementation Report — ${runId}`,
    "",
    `Status: **${report.status}**${report.blockedReason ? ` (${report.blockedReason})` : ""}`,
    "",
  ];
  if (report.blockedQuestion) lines.push(`## Decision needed`, "", report.blockedQuestion, "");
  lines.push(`## Summary`, "", report.summary, "");
  if (report.filesChanged.length > 0) {
    lines.push(
      `## Files changed`,
      "",
      "| File | Classification | Reason | Action |",
      "|---|---|---|---|",
    );
    for (const f of report.filesChanged)
      lines.push(`| \`${f.path}\` | ${f.classification} | ${f.reason} | ${f.action} |`);
    lines.push("");
  }
  if (report.behaviourChanged.length > 0)
    lines.push(`## Behaviour changed`, "", ...report.behaviourChanged.map((b) => `- ${b}`), "");
  if (report.sourceOfTruthFollowed.length > 0)
    lines.push(
      `## Source of truth followed`,
      "",
      ...report.sourceOfTruthFollowed.map((s) => `- ${s}`),
      "",
    );
  lines.push(`## Outcomes`, "", ...report.outcomeClaims.map((o) => `- ${o.id}: ${o.status}`), "");
  if (report.verificationClaims.length > 0) {
    lines.push(`## Verification`, "", "| Command | Result | Notes |", "|---|---|---|");
    for (const v of report.verificationClaims)
      lines.push(`| \`${v.command}\` | ${v.result} | ${v.notes ?? ""} |`);
    lines.push("");
  }
  if (report.escalations.length > 0)
    lines.push(`## Escalations`, "", ...report.escalations.map((e) => `- ${e}`), "");
  if (report.remainingUncertainty.length > 0)
    lines.push(
      `## Remaining uncertainty`,
      "",
      ...report.remainingUncertainty.map((u) => `- ${u}`),
      "",
    );
  if (finalReview) {
    lines.push(
      `## Final review (Daddy)`,
      "",
      `Verdict: **${finalReview.verdict}**${finalReview.notes ? ` — ${finalReview.notes}` : ""}`,
      "",
      ...finalReview.findings.map((f) => `- ${f}`),
      "",
    );
  }
  return lines.join("\n");
};
