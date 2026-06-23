// ---------------------------------------------------------------------------
// Chain promotion (CONTRACT §19)
//
// Application-layer use case that promotes staged children whose parent
// campaign has converged. Depends only on Store + Repo ports and the pure
// domain decision (decidePromotion). No infrastructure imports.
// ---------------------------------------------------------------------------

import { decidePromotion } from "../../domain/chain.js";
import { stampBase } from "../../domain/packet.js";
import type { Repo } from "../ports/repo.js";
import type { Store } from "../ports/store.js";

export const promoteStaged = (store: Store, repo: Repo): void => {
  const staged = store.listStaged();

  for (const child of staged) {
    const parentCampaign = child.parentRunId ? store.readCampaign(child.parentRunId) : undefined;
    const decision = decidePromotion(child.parentRunId, parentCampaign);

    switch (decision.action) {
      case "promote-now": {
        // No parent → admit straight away. Stamp base from HEAD if absent.
        try {
          const raw = store.readStaged(child.runId);
          if (raw === undefined) {
            continue;
          }
          const headBranch = repo.headBranch(child.repo);
          const stamped = stampBase(raw, headBranch);
          store.admitQueue(child.runId, stamped);
          store.removeStaged(child.runId);
        } catch {
          // Transient error (e.g. repo unavailable) — leave staged, retry next sweep.
          continue;
        }
        break;
      }

      case "promote-with-base": {
        // Parent converged → fetch tip branch into source repo, stamp base, admit.
        try {
          const raw = store.readStaged(child.runId);
          if (raw === undefined) {
            continue;
          }
          const tipMeta = store.readMetaIfExists(decision.tipRunId);
          if (!tipMeta) {
            // Tip run meta not found — leave staged, retry next sweep.
            continue;
          }
          repo.fetchBranchFromClone(child.repo, tipMeta.worktree, decision.base);
          const stamped = stampBase(raw, decision.base);
          store.admitQueue(child.runId, stamped);
          store.removeStaged(child.runId);
        } catch {
          // Transient error (e.g. fetchBranchFromClone, repo unavailable) — leave staged, retry next sweep.
          continue;
        }
        break;
      }

      case "hold":
      case "wait":
        // Parent needs Max or not converged yet — leave staged.
        break;
    }
  }
};
