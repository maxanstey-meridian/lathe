// ---------------------------------------------------------------------------
// Accept use case (CONTRACT X1): bridge a ready_for_review campaign's tip
// branch into the source repo and tear down all campaign sandboxes — no merge,
// no safety gate, no working-tree mutation. The user owns the merge.
//
// Campaign-aware: resolves to the campaign tip (highest pass), fetches the tip
// branch, removes all sandboxes, deletes intermediate branches best-effort,
// and marks every campaign run accepted with acceptedInto = tip branch.
// ---------------------------------------------------------------------------

import type { Clock } from "../ports/clock.js";
import type { Repo } from "../ports/repo.js";
import type { Store } from "../ports/store.js";

export type AcceptPorts = {
  store: Store;
  repo: Repo;
  clock: Clock;
  runsDir: string;
};

const ACCEPTED_OR_REVIEW = new Set(["accepted", "ready_for_review"]);

export const acceptRun = (runId: string, ports: AcceptPorts): number => {
  const { store, repo, clock, runsDir } = ports;

  // 1. Validate — must exist and be ready_for_review.
  const meta = store.readMetaIfExists(runId);
  if (!meta || meta.status !== "ready_for_review") {
    console.error(`run ${runId} is not ready_for_review (status: ${meta?.status ?? "unknown"})`);
    return 1;
  }

  // 1b. Warn (not block) if convergence never produced an accept verdict for
  // this run — the work is mergeable but was not reviewed by super-daddy, or
  // super-daddy was unreachable.
  const convergence = store.readConvergence(runId);
  const converged = convergence.some(
    (e) => e.kind === "reviewed" && e.primary.verdict === "accept",
  );
  if (!converged) {
    const hasUnreachable = convergence.some((e) => e.kind === "unreachable");
    console.warn(
      `warning: ${runId} has no convergence accept verdict` +
        (hasUnreachable ? " (super-daddy was unreachable)" : " (never reviewed)"),
    );
  }

  // 2. Campaign resolution.
  const campaignId = meta.campaignId ?? runId;
  const allRuns = meta.campaignId ? store.listRunsByCampaign(campaignId) : [meta];

  // Defensive: ensure the accepting run is in the campaign list.
  if (!allRuns.some((r) => r.runId === runId)) {
    allRuns.push(meta);
  }

  // 3. Campaign completeness check — refuse if any campaign run is still running.
  const blocking = allRuns.find((r) => !ACCEPTED_OR_REVIEW.has(r.status));
  if (blocking) {
    console.error(
      `campaign ${campaignId}: run ${blocking.runId} is ${blocking.status} — not ready for accept`,
    );
    return 1;
  }

  // Resolve tip: the run with the highest pass.
  const tip = allRuns.reduce((a, b) => ((b.pass ?? 1) > (a.pass ?? 1) ? b : a));
  if (runId !== tip.runId) {
    console.log(`resolving ${runId} to campaign tip ${tip.runId}`);
  }

  // 4. Repo affinity guard — refuse if another active run or convergence
  // (outside this campaign) is on meta.repo.
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

  const campaignRunIds = new Set(allRuns.map((r) => r.runId));
  const reposOutsideCampaign = [
    ...new Set(activeRepos.filter((e) => !campaignRunIds.has(e.runId)).map((e) => e.repo)),
  ];

  if (reposOutsideCampaign.includes(meta.repo)) {
    console.error(`repo ${meta.repo} has an active run or convergence — refuse accept`);
    return 1;
  }

  // 5. Fetch tip branch into source repo. Force-fetch to always pull the
  // sandbox tip, avoiding a stale local ref from a prior convergence fetch.
  repo.fetchBranchFromClone(tip.repo, tip.worktree, tip.branch, true);

  // 6. Compute diff stats from tip sandbox (before teardown).
  let diffStatsLine = "";
  try {
    const stats = repo.readDiffStats(tip.worktree, tip.base);
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

  // 7. For each run in the campaign: remove sandbox, delete intermediate
  // branches, mark accepted.
  for (const run of allRuns) {
    // Remove sandbox (idempotent — already cleaned up runs are skipped).
    try {
      repo.removeSandbox(run.worktree, runsDir);
    } catch (err) {
      console.error(`warning: failed to remove sandbox for ${run.runId}: ${err}`);
    }

    // Delete intermediate branches (best-effort, swallow missing-branch errors).
    if (run.runId !== tip.runId) {
      repo.deleteBranch(run.repo, run.branch);
    }

    // Mark accepted with acceptedInto = tip branch name.
    store.writeMeta({
      ...run,
      status: "accepted",
      acceptedInto: tip.branch,
      updatedAt: clock.nowIso(),
    });
  }

  // 8. Print result.
  console.log(
    `accepted ${campaignId} — branch ${tip.branch} ready${diffStatsLine ? ` ${diffStatsLine}` : ""}`,
  );
  return 0;
};
