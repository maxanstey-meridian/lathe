// ---------------------------------------------------------------------------
// Accept use case (CONTRACT X1): bridge a ready_for_review campaign's tip
// branch into the source repo and tear down all campaign sandboxes — no merge,
// no safety gate, no working-tree mutation. The user owns the merge.
//
// Campaign-aware: resolves to the campaign tip (highest pass), fetches the tip
// branch, removes all sandboxes, deletes intermediate branches best-effort,
// and marks every campaign run accepted with acceptedInto = tip branch.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { RepositoryLeaseLostError } from "../errors/repository-lease-lost.js";
import type { Clock } from "../ports/clock.js";
import type { Repo } from "../ports/repo.js";
import type { Store } from "../ports/store.js";
import { cleanAcceptedOperation } from "./recover-acceptance-cleanup.js";
import { keepRepositoryLease } from "./repository-lease-keeper.js";

export type AcceptPorts = {
  store: Store;
  repo: Repo;
  clock: Clock;
  runsDir: string;
};

const ACCEPTED_OR_REVIEW = new Set(["accepted", "ready_for_review"]);

export const acceptRun = (runId: string, ports: AcceptPorts): number => {
  const { store, repo } = ports;
  if (!repo.resolveRevision) {
    throw new Error("acceptRun requires exact revision resolution");
  }
  const resolveRevision = repo.resolveRevision;

  // 1. Validate — an accepted entry may still own incomplete cleanup.
  const meta = store.readMetaIfExists(runId);
  const campaignId = meta?.campaignId ?? runId;
  let operation = store.readAcceptanceOperation(campaignId);
  if (
    !meta ||
    (meta.status !== "ready_for_review" &&
      !(meta.status === "accepted" && operation && operation.phase !== "cleaned"))
  ) {
    console.error(`run ${runId} is not ready_for_review (status: ${meta?.status ?? "unknown"})`);
    return 1;
  }

  const leaseRepo = operation?.members[0]?.repo ?? meta.repo;
  const lease = store.acquireRepositoryLease(leaseRepo, `accept:${randomUUID()}`, runId, "accept");
  if (!lease) {
    console.error(`repo ${meta.repo} is leased by an active worker — refuse accept`);
    return 1;
  }

  try {
    const keeper = keepRepositoryLease(store, lease);
    // 2. Campaign resolution.
    const campaign = store.readCampaign(campaignId);
    if (!campaign && !operation) {
      console.error(`campaign ${campaignId} has not passed acceptance review`);
      return 1;
    }
    const campaignRunIds = operation?.members.map((member) => member.runId) ?? [
      campaign!.originalRunId,
      ...campaign!.passes.map((pass) => pass.runId),
    ];
    const allRuns = [...new Set(campaignRunIds)].map((memberRunId) =>
      store.readMetaIfExists(memberRunId),
    );
    const missingRunId = campaignRunIds.find(
      (memberRunId) => !allRuns.some((member) => member?.runId === memberRunId),
    );
    if (missingRunId) {
      console.error(`campaign ${campaignId}: run ${missingRunId} metadata is missing`);
      return 1;
    }
    const completeRuns = allRuns.filter((member): member is NonNullable<typeof member> => !!member);

    // 3. Campaign completeness check — refuse if any campaign run is still running.
    const blocking = completeRuns.find((r) => !ACCEPTED_OR_REVIEW.has(r.status));
    if (blocking) {
      console.error(
        `campaign ${campaignId}: run ${blocking.runId} is ${blocking.status} — not ready for accept`,
      );
      return 1;
    }

    // Resolve tip: the run with the highest pass.
    const tip = completeRuns.reduce((a, b) => ((b.pass ?? 1) > (a.pass ?? 1) ? b : a));
    const acceptedPass = campaign?.passes.some(
      (pass) =>
        pass.runId === tip.runId && pass.attempt === tip.attempt && pass.verdict === "accept",
    );
    if (!operation && (campaign?.status !== "converged" || !acceptedPass)) {
      console.error(`campaign ${campaignId} has not passed acceptance review`);
      return 1;
    }
    if (runId !== tip.runId) {
      console.log(`resolving ${runId} to campaign tip ${tip.runId}`);
    }

    // 4. Retain the pointer check for stores created before lease acquisition and as
    // a defensive consistency check for stale/incomplete state.
    const activeRepos = [
      ...store.listActiveRuns().map((r) => ({
        runId: r.runId,
        repo: store.readMetaIfExists(r.runId)?.repo,
      })),
      ...store.listActiveConvergences().map((c) => ({
        runId: c.runId,
        repo: store.readMetaIfExists(c.runId)?.repo,
      })),
    ].filter((e): e is { runId: string; repo: string } => e.repo !== undefined);

    const campaignRunIdSet = new Set(completeRuns.map((r) => r.runId));
    const reposOutsideCampaign = [
      ...new Set(activeRepos.filter((e) => !campaignRunIdSet.has(e.runId)).map((e) => e.repo)),
    ];

    if (reposOutsideCampaign.includes(meta.repo)) {
      console.error(`repo ${meta.repo} has an active run or convergence — refuse accept`);
      return 1;
    }

    if (!operation) {
      const expectedTipSha = resolveRevision(tip.worktree, "HEAD");
      operation = {
        campaignId,
        phase: "prepared",
        tipRunId: tip.runId,
        acceptedInto: tip.branch,
        expectedTipSha,
        members: completeRuns.map((run) => ({
          runId: run.runId,
          revision: run.revision ?? 0,
          status: run.status === "accepted" ? "accepted" : "ready_for_review",
          repo: run.repo,
          branch: run.branch,
          worktree: run.worktree,
          base: run.base,
          pass: run.pass ?? 1,
        })),
        cleanedSandboxes: [],
        cleanedBranches: [],
        updatedAt: ports.clock.nowIso(),
      };
      keeper.renew();
      store.persistAcceptanceOperation(operation, keeper.current());
    }
    if (!operation) {
      throw new Error(`acceptance operation ${campaignId} was not prepared`);
    }

    const tipRunId = operation.tipRunId;
    const operationTip = operation.members.find((member) => member.runId === tipRunId);
    if (!operationTip) {
      throw new Error(`acceptance operation ${campaignId} has no tip snapshot`);
    }

    const ensureAcceptedRef = (): boolean => {
      let sourceSha: string | undefined;
      try {
        sourceSha = resolveRevision(operationTip.repo, operation!.acceptedInto);
      } catch {
        // A missing ref is a valid expected-old value for the guarded creation.
      }
      if (sourceSha === operation!.expectedTipSha) {
        return true;
      }
      const sandboxSha = resolveRevision(operationTip.worktree, "HEAD");
      if (sandboxSha !== operation!.expectedTipSha) {
        console.error(
          `campaign ${campaignId}: sandbox tip changed from expected ${operation!.expectedTipSha} to ${sandboxSha}`,
        );
        return false;
      }
      try {
        keeper.effect(() =>
          repo.fetchBranchFromClone(
            operationTip.repo,
            operationTip.worktree,
            operation!.acceptedInto,
            sourceSha ?? null,
            operation!.expectedTipSha,
          ),
        );
      } catch (error) {
        if (error instanceof RepositoryLeaseLostError) {
          throw error;
        }
        console.error(
          `campaign ${campaignId}: accepted ref changed during guarded publication; preserving acceptance evidence and sandboxes: ${error}`,
        );
        return false;
      }
      try {
        return (
          resolveRevision(operationTip.repo, operation!.acceptedInto) === operation!.expectedTipSha
        );
      } catch {
        return false;
      }
    };

    // 5. Prove the immutable sandbox tip is the exact source ref before acceptance.
    if (operation.phase === "prepared" || operation.phase === "fetched") {
      if (!ensureAcceptedRef()) {
        console.error(
          `campaign ${campaignId}: source ref ${operation.acceptedInto} does not resolve to expected tip ${operation.expectedTipSha}`,
        );
        return 1;
      }
    }
    if (operation.phase === "prepared") {
      operation = { ...operation, phase: "fetched", updatedAt: ports.clock.nowIso() };
      store.persistAcceptanceOperation(operation, keeper.current());
    }

    // 6. Compute diff stats from tip sandbox (before teardown).
    let diffStatsLine = "";
    try {
      const stats = repo.readDiffStats(operationTip.worktree, operationTip.base);
      const fileCount = Object.keys(stats).length;
      let added = 0;
      let removed = 0;
      for (const s of Object.values(stats)) {
        added += s.added;
        removed += s.removed;
      }
      diffStatsLine = `. ${fileCount} files changed, ${added} insertions, ${removed} deletions`;
    } catch {
      // Diff stats are informational — don't block if they fail.
    }

    // 7. Reserve the exact campaign snapshot atomically before destructive cleanup.
    try {
      if (operation.phase === "fetched") {
        const sourceSha = resolveRevision(operationTip.repo, operation.acceptedInto);
        if (sourceSha !== operation.expectedTipSha) {
          console.error(
            `campaign ${campaignId}: source ref ${operation.acceptedInto} changed before acceptance`,
          );
          return 1;
        }
        keeper.renew();
        store.commitAcceptanceOperation(operation, keeper.current());
        const committed = store.readAcceptanceOperation(campaignId);
        if (!committed) {
          throw new Error(`acceptance operation ${campaignId} disappeared after commit`);
        }
        operation = committed;
      }
    } catch (error) {
      console.error(`campaign ${campaignId} changed during accept: ${error}`);
      return 1;
    }

    if (!ensureAcceptedRef()) {
      console.error(
        `campaign ${campaignId}: source ref ${operation.acceptedInto} is not valid after durable acceptance; preserving repair evidence and sandboxes`,
      );
      return 1;
    }

    // 8. Cleanup is best-effort after durable acceptance.
    operation = cleanAcceptedOperation(operation, keeper.current(), ports);

    // 9. Print result.
    console.log(
      `accepted ${campaignId} — branch ${operation.acceptedInto} ready${diffStatsLine ? ` ${diffStatsLine}` : ""}`,
    );
    return 0;
  } finally {
    store.releaseRepositoryLease(lease);
  }
};
