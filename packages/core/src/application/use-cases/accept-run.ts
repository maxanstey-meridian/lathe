// ---------------------------------------------------------------------------
// Accept use case (CONTRACT X1): merge a ready_for_review run's branch into
// the target branch and tear down its sandbox — only when safe, else refuse.
//
// Safety gate: the source repo MUST be on the target branch and clean.
// Never auto-checkout or auto-stash; print manual git commands on refusal.
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

export const acceptRun = (
  runId: string,
  targetBranch: string | undefined,
  ports: AcceptPorts,
): number => {
  const { store, repo, clock, runsDir } = ports;

  // 1. Validate — must exist and be ready_for_review.
  const meta = store.readMetaIfExists(runId);
  if (!meta || meta.status !== "ready_for_review") {
    console.error(`run ${runId} is not ready_for_review (status: ${meta?.status ?? "unknown"})`);
    return 1;
  }

  // 2. Determine target: explicit arg or the run's base.
  const target = targetBranch ?? meta.base;

  // 3. Safety checks in meta.repo: current branch must equal target, and clean.
  let currentBranch: string;
  try {
    currentBranch = repo.headBranch(meta.repo);
  } catch {
    console.error(
      `repo is not on ${target} — switch to ${target} (clean) then re-run, or merge manually:`,
    );
    console.error(
      `  git -C ${meta.repo} checkout ${target} && git -C ${meta.repo} merge ${meta.branch}`,
    );
    return 1;
  }
  const isDirty = repo.worktreeIsDirty(meta.repo);
  if (currentBranch !== target || isDirty) {
    console.error(
      `repo is ${isDirty ? "dirty" : `on ${currentBranch}, not ${target}`} — switch to ${target} (clean) then re-run, or merge manually:`,
    );
    console.error(
      `  git -C ${meta.repo} checkout ${target} && git -C ${meta.repo} merge ${meta.branch}`,
    );
    return 1;
  }

  // 4. Clone discrimination: is the worktree a self-rooted clone or legacy worktree?
  const isClone = repo.isCloneSandbox(meta.worktree);

  // 5. Fetch the run branch into the source repo if it's a clone (its refs are
  // local to the sandbox — the merge can't resolve without fetching).
  if (isClone) {
    repo.fetchBranchFromClone(meta.repo, meta.worktree, meta.branch);
  }

  // 6. Merge the run branch into target.
  repo.mergeAccept(meta.repo, meta.branch);

  // 7. Remove the sandbox (guarded — refuses anything but the run's own sandbox).
  if (isClone) {
    repo.removeSandbox(meta.worktree, runsDir);
  }

  // 8. Mark accepted.
  store.writeMeta({ ...meta, status: "accepted", updatedAt: clock.nowIso() });
  console.log(`accepted ${runId} — merged ${meta.branch} into ${target}, worktree tidied`);
  console.log(`run records kept at ${meta.repo}`);
  return 0;
};
