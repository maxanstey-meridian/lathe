// ---------------------------------------------------------------------------
// Chain promotion (CONTRACT §19)
//
// Application-layer use case that promotes staged children whose parent
// campaign has converged. Depends only on Store + Repo ports and the pure
// domain decision (decidePromotion). No infrastructure imports.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { childBaseFromTip, decidePromotion } from "../../domain/chain.js";
import { stampBase } from "../../domain/packet.js";
import type { Repo } from "../ports/repo.js";
import type { RepositoryLease, Store } from "../ports/store.js";

export const promoteStaged = (store: Store, repo: Repo, heldLease?: RepositoryLease): void => {
  const staged = store.listStaged();

  for (const child of staged) {
    const lease =
      heldLease?.repo === child.repo
        ? heldLease
        : store.acquireRepositoryLease(
            child.repo,
            `promotion:${randomUUID()}`,
            child.runId,
            "execute",
          );
    if (!lease) {
      continue;
    }
    const releaseLease = lease !== heldLease;
    const parentCampaign = child.parentRunId ? store.readCampaign(child.parentRunId) : undefined;
    const decision = decidePromotion(child.parentRunId, parentCampaign);

    try {
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
          // Parent converged → base the child on the tip. If the tip is NOT yet
          // accepted, its work lives only in its clone sandbox, so fetch the tip
          // branch into the source repo first. If it IS accepted, accept already
          // fetched the tip branch into the source repo (the clone is destroyed),
          // so skip the fetch and base off the preserved meridian branch.
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
            const resolveRevision = repo.resolveRevision;
            if (!resolveRevision) {
              continue;
            }
            const childBase = childBaseFromTip(tipMeta);
            if (childBase.fetchFromClone !== undefined) {
              const expectedNewSha = resolveRevision(childBase.fetchFromClone, "HEAD");
              let expectedOldSha: string | null = null;
              try {
                expectedOldSha = resolveRevision(child.repo, childBase.base);
              } catch {
                // Missing is safe to create; a differing existing ref is not safe to replace.
              }
              if (expectedOldSha !== null && expectedOldSha !== expectedNewSha) {
                continue;
              }
              repo.fetchBranchFromClone(
                child.repo,
                childBase.fetchFromClone,
                childBase.base,
                expectedOldSha,
                expectedNewSha,
              );
              if (resolveRevision(child.repo, childBase.base) !== expectedNewSha) {
                continue;
              }
            } else {
              const acceptance = store.readAcceptanceOperation(
                tipMeta.campaignId ?? parentCampaign!.campaignId,
              );
              if (
                !acceptance ||
                acceptance.tipRunId !== tipMeta.runId ||
                (acceptance.phase !== "accepted" && acceptance.phase !== "cleaned") ||
                resolveRevision(child.repo, childBase.base) !== acceptance.expectedTipSha
              ) {
                continue;
              }
            }
            const stamped = stampBase(raw, childBase.base);
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
    } finally {
      if (releaseLease) {
        store.releaseRepositoryLease(lease);
      }
    }
  }
};
