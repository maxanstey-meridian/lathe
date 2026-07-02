import { createHash } from "node:crypto";
import type { DiffStats } from "./gate-classification.js";
import { classifyChangedFiles } from "./gate-classification.js";
import type { OutcomeLedger } from "./outcomes.js";
import type { Packet } from "./packet.js";
import { ACCEPTED_STATUSES } from "./review.js";
import type { ReviewState, Decision } from "./run.js";

type FileClassification = ReturnType<typeof classifyChangedFiles>[number];

export type ReconciliationGitState = {
  head: string;
  status: string[];
  diffHash: string;
  untracked: Array<{ path: string; hash: string }>;
  changedFiles: string[];
};

export type ReconciliationFingerprint = {
  value: string;
  head: string;
  statusHash: string;
  diffHash: string;
  untrackedHash: string;
  ledgerHash: string;
  reviewHash: string;
  surfaceHash: string;
};

export type ReconciliationDeltaKind =
  | "unchanged"
  | "test-only"
  | "expected-source"
  | "acceptable-but-not-predeclared"
  | "suspicious";

export type ReconciliationEvidence = {
  fingerprint: ReconciliationFingerprint;
  changedFiles: FileClassification[];
  deltaKind: ReconciliationDeltaKind;
  ledgerSummary: string;
  reviewSummary: string;
  recentDecisions: string[];
  diffSummary: string;
  priorAccepted?: {
    fingerprint: string;
    answer: string;
    constraints: string[];
    safeNextAction?: string;
  };
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const hash = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

export const summarizeLedger = (ledger: OutcomeLedger): string =>
  ledger.outcomes
    .map((o) => {
      const state = o.state ? `; state=${o.state}` : "";
      const next = o.nextAction ? `; next=${o.nextAction}` : "";
      const evidence = o.evidence.length > 0 ? `; evidence=${o.evidence.join(" | ")}` : "";
      return `${o.id}: ${o.status}${state}${next}${evidence}`;
    })
    .join("\n");

const summarizeReview = (review: ReviewState): string =>
  review.obligations.length > 0 ? review.obligations.map((o) => `- ${o}`).join("\n") : "- None";

const recentDecisionLines = (decisions: Decision[]): string[] =>
  decisions.slice(-6).map((d) => `[${d.status}] ${d.questionType}: ${d.question.slice(0, 180)}`);

export const lastAcceptedReconciliation = (decisions: Decision[]): Decision | undefined =>
  [...decisions]
    .reverse()
    .find(
      (d) =>
        d.questionType === "reconciliation" &&
        ACCEPTED_STATUSES.includes(d.status as (typeof ACCEPTED_STATUSES)[number]) &&
        typeof d.reconciliation?.fingerprint === "string",
    );

export const buildReconciliationFingerprint = (
  git: ReconciliationGitState,
  packet: Packet,
  ledger: OutcomeLedger,
  review: ReviewState,
): ReconciliationFingerprint => {
  const ledgerPayload = ledger.outcomes.map((o) => ({
    id: o.id,
    status: o.status,
    evidence: [...o.evidence].sort(),
    state: o.state ?? null,
    nextAction: o.nextAction ?? null,
  }));
  const reviewPayload = [...review.obligations].sort();
  const surfacePayload = {
    expected: [...packet.frontmatter.expected_surface].sort(),
    suspicious: [...(packet.frontmatter.suspicious_surface ?? [])].sort(),
  };
  const statusHash = hash([...git.status].sort());
  const untrackedHash = hash([...git.untracked].sort((a, b) => a.path.localeCompare(b.path)));
  const ledgerHash = hash(ledgerPayload);
  const reviewHash = hash(reviewPayload);
  const surfaceHash = hash(surfacePayload);
  const value = hash({
    head: git.head,
    statusHash,
    diffHash: git.diffHash,
    untrackedHash,
    ledgerHash,
    reviewHash,
    surfaceHash,
  });
  return {
    value,
    head: git.head,
    statusHash,
    diffHash: git.diffHash,
    untrackedHash,
    ledgerHash,
    reviewHash,
    surfaceHash,
  };
};

const classifyDeltaKind = (files: FileClassification[]): ReconciliationDeltaKind => {
  if (files.length === 0) {
    return "unchanged";
  }
  if (files.some((f) => f.classification === "suspicious")) {
    return "suspicious";
  }
  if (files.every((f) => f.path.endsWith(".test.ts") || f.path.includes("/tests/"))) {
    return "test-only";
  }
  if (files.every((f) => f.classification === "expected")) {
    return "expected-source";
  }
  return "acceptable-but-not-predeclared";
};

export const buildReconciliationEvidence = (input: {
  git: ReconciliationGitState;
  packet: Packet;
  ledger: OutcomeLedger;
  review: ReviewState;
  decisions: Decision[];
  diffStats: DiffStats;
  diffSummary: string;
}): ReconciliationEvidence => {
  const fingerprint = buildReconciliationFingerprint(
    input.git,
    input.packet,
    input.ledger,
    input.review,
  );
  const filesFromStats = Object.keys(input.diffStats);
  const changedFiles = classifyChangedFiles(
    [...new Set([...input.git.changedFiles, ...filesFromStats])].sort(),
    input.packet.frontmatter.expected_surface,
    input.packet.frontmatter.suspicious_surface ?? [],
  );
  const prior = lastAcceptedReconciliation(input.decisions);
  return {
    fingerprint,
    changedFiles,
    deltaKind: classifyDeltaKind(changedFiles),
    ledgerSummary: summarizeLedger(input.ledger),
    reviewSummary: summarizeReview(input.review),
    recentDecisions: recentDecisionLines(input.decisions),
    diffSummary: input.diffSummary,
    ...(prior?.reconciliation?.fingerprint
      ? {
          priorAccepted: {
            fingerprint: prior.reconciliation.fingerprint,
            answer: prior.answer,
            constraints: prior.constraints,
            safeNextAction: prior.safeNextAction,
          },
        }
      : {}),
  };
};

export const renderReconciliationEvidence = (evidence: ReconciliationEvidence): string[] => {
  const changed =
    evidence.changedFiles.length > 0
      ? evidence.changedFiles
          .map((f) => `${f.path} [${f.classification}; action=${f.action}]`)
          .join("\n")
      : "(no changed files detected)";
  return [
    `current fingerprint: ${evidence.fingerprint.value}`,
    `git head: ${evidence.fingerprint.head}`,
    `delta kind: ${evidence.deltaKind}`,
    `changed files:\n${changed}`,
    `outcome ledger:\n${evidence.ledgerSummary || "(empty)"}`,
    `review obligations:\n${evidence.reviewSummary}`,
    `recent decisions:\n${evidence.recentDecisions.join("\n") || "- None"}`,
    `reviewable diff/stat:\n${evidence.diffSummary || "(no diff)"}`,
    evidence.priorAccepted
      ? `prior accepted reconciliation fingerprint: ${evidence.priorAccepted.fingerprint}\nprior answer: ${evidence.priorAccepted.answer}\nprior constraints: ${evidence.priorAccepted.constraints.join("; ") || "none"}`
      : "prior accepted reconciliation: none",
  ];
};
