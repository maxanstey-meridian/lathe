// ---------------------------------------------------------------------------
// Converge-run orchestration (CONTRACT §18)
//
// Application-layer use case that runs the convergence loop: verification,
// super-daddy review, the pure decision, and the act (stop / author / escalate)
// with all bookkeeping. This is the always-on post-run step the run loop calls.
// ---------------------------------------------------------------------------

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expandHome } from "../../config/paths.js";
import type { Config } from "../../config/schemas.js";
import {
  campaignIdForRun,
  upsertPass,
  alreadyReviewed,
  type CampaignPass,
} from "../../domain/campaign.js";
import {
  decideConvergence,
  stampFollowupLineage,
  assembleCommitMessage,
  renderNits,
  type ConvergeDecision,
  type ConvergenceOperation,
} from "../../domain/convergence.js";
import { parsePacketShape } from "../../domain/packet.js";
import type { OutcomeDef, Packet } from "../../domain/packet.js";
import { RepositoryLeaseLostError } from "../errors/repository-lease-lost.js";
import { RunTransitionConflictError } from "../errors/run-transition-conflict.js";
import type { Clock } from "../ports/clock.js";
import { noopDriverOutput, type DriverOutput } from "../ports/driver-output.js";
import type { Repo } from "../ports/repo.js";
import type { Reviewer, SuperReviewResult } from "../ports/reviewer.js";
import type { Store, ConvergenceLogEntry, RepositoryLease, RunTransition } from "../ports/store.js";
import type { Verify, VerificationResult } from "../ports/verify.js";
import { keepRepositoryLease } from "./repository-lease-keeper.js";

// ---------------------------------------------------------------------------
// Dependencies

export type ConvergeDeps = {
  store: Store;
  repo: Repo;
  reviewer: Reviewer;
  verify: Verify;
  driverOutput?: DriverOutput;
  clock: Clock;
  config: Config;
};

// ---------------------------------------------------------------------------
// Pure helpers

const allGreen = (results: VerificationResult[]): boolean => results.every((r) => r.exitCode === 0);

const isoToTimestamp = (iso: string): string =>
  iso.slice(0, 10).replace(/-/g, "") + "-" + iso.slice(11, 19).replace(/:/g, "");

const campaignPassOf = (
  runId: string,
  attempt: number,
  pass: number,
  review: SuperReviewResult,
  decision: ConvergeDecision,
  atIso: string,
): CampaignPass => ({
  runId,
  attempt,
  pass,
  verdict:
    decision.action === "stop"
      ? "accept"
      : decision.action === "author"
        ? "request_changes"
        : "escalate",
  proposedVerdict: review.review.verdict,
  groundedBlockers: review.review.findings.filter((f) => f.grounding.kind !== "none").length,
  atIso,
});

const makeConvergenceEntry = (
  runId: string,
  campaignId: string,
  pass: number,
  maxPasses: number,
  verification: VerificationResult[],
  decision: ConvergeDecision,
  review: SuperReviewResult,
  amendedSha: string | null,
  atIso: string,
): ConvergenceLogEntry => ({
  kind: "reviewed",
  at: atIso,
  runId,
  campaignId,
  pass,
  maxPasses,
  verification: { green: allGreen(verification), commands: verification },
  decision,
  amendedCommitSha: amendedSha,
  primary: review.review,
  primaryRaw: review.raw,
});

const slugFromRunId = (runId: string, pass: number): string => {
  const parts = runId.split("-").slice(2);
  // Strip any prior -fixN suffix before appending the new one.
  while (parts.length > 0) {
    const last = parts[parts.length - 1];
    if (last === undefined || !last.startsWith("fix")) {
      break;
    }
    parts.pop();
  }
  const base = parts.join("-");
  return `${base}-fix${pass}`;
};

type DecidedOperation = Extract<
  ConvergenceOperation,
  { phase: "decided" | "amend_started" | "effect_applied" | "published" }
>;

const assertDecidedOperation: (
  operation: ConvergenceOperation,
) => asserts operation is DecidedOperation = (operation) => {
  if (operation.phase === "autofix_started" || operation.phase === "autofix_applied") {
    throw new Error(
      `convergence operation ${operation.runId}/${operation.attempt} did not reach a decision`,
    );
  }
};

// ---------------------------------------------------------------------------
// Main entry point — matches `ConvergeCallback`.

export const convergeRun = (
  deps: ConvergeDeps,
): ((runId: string, signal?: AbortSignal, lease?: RepositoryLease) => Promise<void>) => {
  const { store, repo, reviewer, verify, driverOutput = noopDriverOutput, clock, config } = deps;
  const resolveRevision = (worktree: string, ref: string): string => {
    if (!repo.resolveRevision) {
      throw new Error("convergeRun requires exact revision resolution");
    }
    return repo.resolveRevision(worktree, ref);
  };

  return async (runId: string, signal?: AbortSignal, lease?: RepositoryLease): Promise<void> => {
    const initialMeta = store.readMeta(runId);
    const ownedLease = lease
      ? undefined
      : store.acquireRepositoryLease(
          initialMeta.repo,
          `converge:${randomUUID()}`,
          runId,
          "execute",
        );
    const activeLease = lease ?? ownedLease;
    if (!activeLease) {
      throw new Error(`convergeRun: repository ${initialMeta.repo} is leased`);
    }
    const keeper = keepRepositoryLease(store, activeLease, signal);
    let convergenceRegistered = false;
    try {
      store.addActiveConvergence({ runId, startedAt: clock.nowIso() });
      convergenceRegistered = true;
      let meta = initialMeta;

      // --- Load packet --------------------------------------------------------
      const queueRaw = store.readQueuePacket(runId);
      if (!queueRaw) {
        throw new Error(`convergeRun: no queue packet for ${runId}`);
      }
      const parsed = parsePacketShape(queueRaw, runId);
      if (!parsed.ok) {
        throw new Error(`convergeRun: cannot parse queue packet: ${parsed.problems.join("; ")}`);
      }
      const packet: Packet = parsed.packet;

      const campaignId = campaignIdForRun(packet, runId);
      const campaign = store.readCampaign(campaignId);
      const maxPasses = config.thresholds.maxPasses;

      // S10: pass already recorded → pure early return, zero side effects.
      if (alreadyReviewed(campaign, runId, meta.attempt)) {
        return;
      }

      const pass = packet.frontmatter.pass;
      const atIso = clock.nowIso();
      const autofixFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            commands: packet.frontmatter.autofix_commands,
            expectedSurface: packet.frontmatter.expected_surface,
          }),
        )
        .digest("hex");

      // Record super-daddy's session into meta the instant the reviewer binds it,
      // so `lathe tail` can route the reviewer's live tool calls (pnpm test, git
      // diff, reads) to its pane DURING the review. Re-reads meta on each bind to
      // avoid clobbering concurrent fields (single-driver, but stay additive).
      const recordReviewerSession = (sessionId: string): void => {
        const current = store.readMeta(runId);
        if (current.reviewerSessionId !== sessionId) {
          meta = store.transitionRun({
            runId,
            expectedRevision: current.revision ?? 0,
            expectedStatuses: [current.status],
            meta: { ...current, reviewerSessionId: sessionId, updatedAt: clock.nowIso() },
            lease: keeper.current(),
          });
        }
      };

      const transitionConvergenceMeta = (update: (current: typeof meta) => typeof meta): void => {
        const current = store.readMeta(runId);
        const mayConverge =
          current.status === "ready_for_review" ||
          (current.status === "blocked" && current.blockedReason === "human_decision");
        if (!mayConverge) {
          throw new Error(`run ${runId} changed to ${current.status} during convergence`);
        }
        meta = store.transitionRun({
          runId,
          expectedRevision: current.revision ?? 0,
          expectedStatuses: [current.status],
          meta: update(current),
          lease: keeper.current(),
        });
      };

      // A decided operation is the durable replay boundary. Verification and
      // acceptance review are deliberately outside the replayable effects below.
      let operation = store.readConvergenceOperation(runId, meta.attempt);
      let reviewStarted = false;
      let reviewFinished = operation !== undefined && !operation.phase.startsWith("autofix_");
      let cancellationRecorded = false;
      const stopIfCancelled = (): boolean => {
        if (!signal?.aborted) {
          return false;
        }
        if (!cancellationRecorded) {
          store.appendJournal(runId, {
            at: clock.nowIso(),
            event: "super_review_status",
            pass,
            status: "cancelled",
          });
          cancellationRecorded = true;
        }
        reviewFinished = true;
        return true;
      };
      try {
        if (!operation) {
          keeper.renew();
          operation = {
            runId,
            attempt: meta.attempt,
            phase: "autofix_started",
            autofixFingerprint,
          };
          store.persistConvergenceOperation(operation, keeper.current());
          await verify.runAutoFix(
            packet.frontmatter.autofix_commands,
            packet.frontmatter.expected_surface,
            meta.worktree,
            config.thresholds.verificationTimeoutMs,
            {
              signal,
              onEvent: (event) => driverOutput.verification(runId, "autofix", event),
              onResult: (result) =>
                store.appendJournal(runId, {
                  event: "verification_run",
                  command: result.command,
                  exitCode: result.exitCode,
                  turn: 0,
                  at: clock.nowIso(),
                }),
            },
          );
          if (signal?.aborted) {
            return;
          }
          keeper.renew();
          operation = { ...operation, phase: "autofix_applied" };
          store.persistConvergenceOperation(operation, keeper.current());
        } else if (operation.autofixFingerprint !== autofixFingerprint) {
          throw new Error(`convergence autofix fingerprint changed for ${runId}/${meta.attempt}`);
        } else if (operation.phase === "autofix_started") {
          // The command may have applied fully, partially, or not at all. There is
          // no durable command-level evidence, so neither replay nor promotion is safe.
          keeper.renew();
          transitionConvergenceMeta((current) => ({
            ...current,
            status: "blocked",
            blockedReason: "human_decision",
            blockedQuestion:
              "Autofix recovery is ambiguous: autofix_started has no durable completion evidence. Inspect the preserved sandbox and start a new attempt rather than replaying or assuming the commands applied.",
            updatedAt: clock.nowIso(),
          }));
          store.appendJournal(runId, {
            at: clock.nowIso(),
            event: "driver_note",
            note: "parked convergence because autofix_started has no durable completion evidence; sandbox preserved",
          });
          return;
        }

        if (operation.phase === "autofix_applied") {
          keeper.renew();
          const verification = await verify.run(
            packet.frontmatter.verification,
            meta.worktree,
            config.thresholds.verificationTimeoutMs,
            {
              signal,
              onEvent: (event) => driverOutput.verification(runId, "convergence", event),
            },
          );
          for (const result of verification) {
            store.appendJournal(runId, {
              event: "verification_run",
              command: result.command,
              exitCode: result.exitCode,
              turn: 0,
              at: clock.nowIso(),
            });
          }
          if (signal?.aborted) {
            return;
          }
          keeper.renew();
          const skillText = readFileSync(expandHome(config.superdaddy.skillPath), "utf-8");
          store.appendJournal(runId, {
            at: clock.nowIso(),
            event: "super_review_status",
            pass,
            status: "started",
          });
          reviewStarted = true;
          const outcome = await reviewer.superReview(
            {
              packet,
              worktree: meta.worktree,
              reportText: store.readReport(runId),
              skillText,
              pass,
              maxPasses,
              campaignId,
            },
            recordReviewerSession,
            signal,
          );
          if (stopIfCancelled()) {
            return;
          }
          keeper.renew();
          if (outcome.kind === "unreachable") {
            transitionConvergenceMeta((current) => ({
              ...current,
              status: "blocked",
              blockedReason: "human_decision",
              blockedQuestion: `Super-daddy unreachable: ${outcome.detail}. Check the reviewer connection, then answer the run to retry.`,
              updatedAt: atIso,
            }));
            store.appendJournal(runId, {
              at: clock.nowIso(),
              event: "super_review_status",
              pass,
              status: "failed",
              detail: outcome.detail,
            });
            reviewFinished = true;
            return;
          }
          const result: SuperReviewResult = outcome;
          meta = store.readMeta(runId);
          const decision = decideConvergence(
            result.review,
            allGreen(verification),
            pass,
            maxPasses,
            {
              promoteAtCap: config.thresholds.promoteAtCap,
              alreadyPromoted: packet.frontmatter.promoted,
            },
          );
          operation = {
            runId,
            attempt: meta.attempt,
            phase: "decided",
            autofixFingerprint,
            campaignId,
            pass,
            maxPasses,
            decidedAt: atIso,
            verification,
            review: result.review,
            reviewRaw: result.raw,
            decision,
          };
          keeper.renew();
          store.persistConvergenceOperation(operation, keeper.current());
          if (stopIfCancelled()) {
            return;
          }
          reviewFinished = true;
        }

        if (operation.phase === "published") {
          return;
        }
        assertDecidedOperation(operation);
        if (stopIfCancelled()) {
          return;
        }
        const result: SuperReviewResult = { review: operation.review, raw: operation.reviewRaw };
        let effectiveDecision = operation.effectiveDecision ?? operation.decision;
        let amendedSha = operation.amendedCommitSha ?? null;

        if (operation.phase === "amend_started") {
          const current = repo.reconciliationGitState(meta.worktree);
          const amendMessage = operation.amendMessage!;
          if (current.head === operation.amendExpectedHead) {
            amendedSha = keeper.effect(() => repo.amendCommit(meta.worktree, amendMessage));
          } else if (
            current.tree === operation.amendExpectedTree &&
            current.commitMessage === amendMessage
          ) {
            amendedSha = current.head;
          } else {
            throw new Error(
              "cannot reconcile interrupted commit amendment: HEAD does not match the intended message and tree",
            );
          }
        } else if (operation.phase === "decided") {
          switch (operation.decision.action) {
            case "stop": {
              if (result.review.commit_message) {
                const amendMessage = assembleCommitMessage(result.review.commit_message);
                const beforeAmend = repo.reconciliationGitState(meta.worktree);
                if (!beforeAmend.tree) {
                  throw new Error("cannot begin commit amendment without the current commit tree");
                }
                operation = {
                  ...operation,
                  phase: "amend_started",
                  amendExpectedHead: beforeAmend.head,
                  amendExpectedTree: beforeAmend.tree,
                  amendMessage,
                };
                keeper.renew();
                store.persistConvergenceOperation(operation, keeper.current());
                amendedSha = keeper.effect(() => repo.amendCommit(meta.worktree, amendMessage));
              }
              break;
            }

            case "author": {
              const priorOutcomes: OutcomeDef[] = [
                ...new Map(
                  packet.frontmatter.outcomes
                    .concat(packet.frontmatter.regression_outcomes)
                    .map((o) => [o.id, o]),
                ).values(),
              ];

              const followupRunId =
                operation.followup?.runId ??
                `${isoToTimestamp(operation.decidedAt)}-${slugFromRunId(runId, pass + 1)}`;
              const lineage = {
                repo: packet.frontmatter.repo,
                baseBranch: meta.branch,
                compareCommit: packet.frontmatter.compare_commit,
                campaignId,
                parentRunId: runId,
                pass: pass + 1,
                priorOutcomes,
                promoted: operation.decision.promote,
              };

              // Make the cap escape hatch visible in the tail: this follow-up is the
              // one promoted attempt on Daddy's model before convergence would give up.
              if (operation.decision.promote) {
                store.appendJournal(runId, {
                  at: atIso,
                  event: "driver_note",
                  note: `convergence cap reached (${pass}/${maxPasses}) — authoring a PROMOTED repair pass (Baby's harness on Daddy's model) as run ${followupRunId}`,
                });
              }

              // Super-daddy AUTHORS the follow-up packet — the same session that just
              // reviewed, a bigger author with final authority, picking its own
              // outcomes/surface/verification to fix the blockers it raised. The engine
              // stamps the lineage and validates on admission. ONE retry feeding back
              // the admission problems (the packet skill's "fix and re-run until it
              // admits"); then escalate rather than loop or stall.
              let problems: string[] | null = null;
              if (!operation.followup) {
                const packetSkillText = readFileSync(
                  expandHome(config.superdaddy.packetSkillPath),
                  "utf-8",
                );
                let priorRawSnippet: string | undefined;
                for (let attempt = 0; attempt < 2; attempt++) {
                  keeper.renew();
                  const authored = await reviewer.authorFollowup(
                    {
                      worktree: meta.worktree,
                      packetSkillText,
                      blockers: operation.decision.blockers,
                      priorOutcomes,
                      pass: pass + 1,
                      campaignId,
                      priorProblems: problems ?? undefined,
                      priorRawSnippet,
                    },
                    recordReviewerSession,
                    signal,
                  );
                  if (stopIfCancelled()) {
                    return;
                  }
                  keeper.renew();

                  if (authored.kind === "unreachable") {
                    transitionConvergenceMeta((current) => ({
                      ...current,
                      status: "blocked",
                      blockedReason: "human_decision",
                      blockedQuestion: `Super-daddy follow-up authoring unreachable: ${authored.detail}. Check the reviewer connection, then answer the run to retry.`,
                      updatedAt: clock.nowIso(),
                    }));
                    store.appendJournal(runId, {
                      at: clock.nowIso(),
                      event: "super_review_status",
                      pass,
                      status: "failed",
                      detail: authored.detail,
                    });
                    reviewFinished = true;
                    return;
                  }

                  // Stamp + admission-check this attempt, collecting any problems.
                  let stamped: string | null = null;
                  let attemptProblems: string[] | null = null;
                  try {
                    stamped = stampFollowupLineage(authored.content, lineage);
                    const shape = parsePacketShape(stamped, followupRunId);
                    if (!shape.ok) {
                      attemptProblems = shape.problems;
                    }
                  } catch (err) {
                    attemptProblems = [err instanceof Error ? err.message : String(err)];
                  }

                  // Persist the raw reply for EVERY attempt (success or failure) so an
                  // authoring failure is diagnosable post-hoc — the raw is otherwise lost.
                  store.appendJournal(runId, {
                    at: atIso,
                    event: "authoring_attempt",
                    attempt: attempt + 1,
                    ok: attemptProblems === null,
                    problems: attemptProblems ?? [],
                    authoredRaw: authored.content,
                  });

                  if (attemptProblems === null && stamped !== null) {
                    operation = {
                      ...operation,
                      followup: { runId: followupRunId, packet: stamped },
                    };
                    keeper.renew();
                    store.persistConvergenceOperation(operation, keeper.current());
                    if (stopIfCancelled()) {
                      return;
                    }
                    problems = null;
                    break;
                  }
                  // Feed the problems AND a snippet of what was emitted into the retry,
                  // so the model can see and fix its own malformed output.
                  problems = attemptProblems;
                  priorRawSnippet = authored.content.slice(0, 800);
                }
              }

              if (problems) {
                // Two tries, still unadmittable — park for Max with the exact problems
                // rather than dropping the pass. Handled as an escalate below.
                const authoringFailure = `Super-daddy could not author an admittable follow-up packet (2 attempts): ${problems.join("; ")}. Review the run manually, then retry convergence.`;
                effectiveDecision = { action: "escalate", reason: authoringFailure };
              } else {
                try {
                  if (!operation.followupPublication) {
                    const expectedNewSha = resolveRevision(meta.worktree, "HEAD");
                    let expectedOldSha: string | null = null;
                    try {
                      expectedOldSha = resolveRevision(packet.frontmatter.repo, meta.branch);
                    } catch {
                      // Missing is an exact expected-old state for CAS creation.
                    }
                    operation = {
                      ...operation,
                      followupPublication: { branch: meta.branch, expectedOldSha, expectedNewSha },
                    };
                    keeper.renew();
                    store.persistConvergenceOperation(operation, keeper.current());
                  }
                  const publication = operation.followupPublication;
                  if (!publication) {
                    throw new Error("follow-up publication intent was not persisted");
                  }
                  const sandboxHead = resolveRevision(meta.worktree, "HEAD");
                  if (sandboxHead !== publication.expectedNewSha) {
                    throw new Error(
                      `follow-up sandbox HEAD changed from ${publication.expectedNewSha} to ${sandboxHead}`,
                    );
                  }
                  let publishedHead: string | null = null;
                  try {
                    publishedHead = resolveRevision(packet.frontmatter.repo, publication.branch);
                  } catch {
                    // Missing may still match the durable CAS snapshot.
                  }
                  if (publishedHead !== publication.expectedNewSha) {
                    if (publishedHead !== publication.expectedOldSha) {
                      throw new Error(
                        `follow-up base ${publication.branch} changed from expected ${publication.expectedOldSha ?? "missing"} to ${publishedHead ?? "missing"}`,
                      );
                    }
                    keeper.effect(() =>
                      repo.fetchBranchFromClone(
                        packet.frontmatter.repo,
                        meta.worktree,
                        publication.branch,
                        publication.expectedOldSha,
                        publication.expectedNewSha,
                      ),
                    );
                    publishedHead = resolveRevision(packet.frontmatter.repo, publication.branch);
                  }
                  if (publishedHead !== publication.expectedNewSha) {
                    throw new Error(
                      `follow-up base ${publication.branch} resolved to ${publishedHead}, expected sandbox HEAD ${publication.expectedNewSha}`,
                    );
                  }
                } catch (error) {
                  keeper.renew();
                  throw error;
                }
              }
              break;
            }
            case "escalate":
              break;
          }
        }

        if (operation.phase === "decided" || operation.phase === "amend_started") {
          operation = {
            ...operation,
            phase: "effect_applied",
            effectiveDecision,
            amendedCommitSha: amendedSha,
          };
          keeper.renew();
          store.persistConvergenceOperation(operation, keeper.current());
          if (stopIfCancelled()) {
            return;
          }
        } else {
          effectiveDecision = operation.effectiveDecision ?? operation.decision;
          amendedSha = operation.amendedCommitSha ?? null;
        }

        const admittedVerdict =
          effectiveDecision.action === "stop"
            ? "accept"
            : effectiveDecision.action === "author"
              ? "request_changes"
              : "escalate";
        // 5. Campaign ledger — upsert the pass.
        const campaignPass = campaignPassOf(
          runId,
          meta.attempt,
          pass,
          result,
          effectiveDecision,
          atIso,
        );
        const campaignStatus: "open" | "converged" | "needs_max" = (() => {
          switch (effectiveDecision.action) {
            case "stop":
              return "converged";
            case "author":
              // A follow-up was admitted → open; authoring failed → parked for Max.
              return "open";
            case "escalate":
              return "needs_max";
          }
        })();

        const updated = upsertPass(
          campaign,
          {
            campaignId,
            originalRunId: campaign?.originalRunId ?? runId,
            originalIntent: packet.frontmatter.outcomes[0]?.description.slice(0, 160) ?? runId,
            maxPasses,
          },
          campaignPass,
          campaignStatus,
        );
        const entry = makeConvergenceEntry(
          runId,
          campaignId,
          pass,
          maxPasses,
          operation.verification,
          effectiveDecision,
          result,
          amendedSha,
          atIso,
        );
        const currentMeta = store.readMeta(runId);
        let runTransition: RunTransition | undefined;
        if (effectiveDecision.action === "stop" && currentMeta.status !== "ready_for_review") {
          const { blockedReason: _br, blockedQuestion: _bq, ...rest } = currentMeta;
          runTransition = {
            runId,
            expectedRevision: currentMeta.revision ?? 0,
            expectedStatuses: [currentMeta.status],
            meta: { ...rest, status: "ready_for_review", updatedAt: atIso },
          };
        } else if (
          effectiveDecision.action === "escalate" &&
          (currentMeta.status !== "blocked" || currentMeta.blockedReason !== "human_decision")
        ) {
          runTransition = {
            runId,
            expectedRevision: currentMeta.revision ?? 0,
            expectedStatuses: [currentMeta.status],
            meta: {
              ...currentMeta,
              status: "blocked",
              blockedReason: "human_decision",
              blockedQuestion: effectiveDecision.reason,
              updatedAt: atIso,
            },
          };
        }
        const published: ConvergenceOperation = { ...operation, phase: "published" };
        keeper.renew();
        meta =
          store.publishConvergence({
            operation: published,
            campaign: updated,
            entry,
            event: {
              at: atIso,
              event: "super_review",
              pass,
              verdict: admittedVerdict,
              proposedVerdict: result.review.verdict,
              findings: result.review.findings.map(
                (f) =>
                  `[${f.severity}] ${f.title}${f.grounding.kind !== "none" ? ` ⟨${f.grounding.kind}⟩` : ""}`,
              ),
            },
            ...(effectiveDecision.action !== "author" && renderNits(runId, result.review)
              ? { nits: renderNits(runId, result.review) }
              : {}),
            ...(runTransition ? { runTransition } : {}),
            ...(effectiveDecision.action === "author" && operation.followup
              ? { followup: { runId: operation.followup.runId, raw: operation.followup.packet } }
              : {}),
            lease: keeper.current(),
          }) ?? meta;
        reviewFinished = true;
      } catch (error) {
        if (reviewStarted && !reviewFinished) {
          try {
            store.appendJournal(runId, {
              at: clock.nowIso(),
              event: "super_review_status",
              pass,
              status: signal?.aborted ? "cancelled" : "failed",
              ...(signal?.aborted
                ? {}
                : { detail: error instanceof Error ? error.message : String(error) }),
            });
          } catch {
            // Preserve the orchestration failure if observability persistence is also unavailable.
          }
        }
        // Preserve the last durable state. In particular, never reopen a run after
        // a human-owned escalation merely because a later ledger write failed.
        try {
          const currentMeta = store.readMeta(runId);
          if (currentMeta.status === "running") {
            store.transitionRun({
              runId,
              expectedRevision: currentMeta.revision ?? 0,
              expectedStatuses: ["running"],
              meta: {
                ...currentMeta,
                status: "ready_for_review",
                updatedAt: clock.nowIso(),
              },
              lease: keeper.current(),
            });
          }
        } catch {
          // The original failure remains authoritative when recovery cannot persist.
        }
        const isAbortError =
          signal?.aborted && error instanceof Error && error.name === "AbortError";
        if (
          error instanceof RunTransitionConflictError ||
          error instanceof RepositoryLeaseLostError ||
          !isAbortError
        ) {
          throw error;
        }
      }
    } finally {
      try {
        if (convergenceRegistered) {
          store.removeActiveConvergence(runId);
        }
      } finally {
        if (ownedLease) {
          store.releaseRepositoryLease(keeper.current());
        }
      }
    }
  };
};
