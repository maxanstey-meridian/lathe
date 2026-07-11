import { randomUUID } from "node:crypto";
import type { AcceptanceOperation } from "../../domain/operations.js";
import type { Clock } from "../ports/clock.js";
import type { Repo } from "../ports/repo.js";
import type { RepositoryLease, Store } from "../ports/store.js";
import { keepRepositoryLease } from "./repository-lease-keeper.js";

type CleanupPorts = {
  store: Store;
  repo: Repo;
  clock: Clock;
  runsDir: string;
};

export const cleanAcceptedOperation = (
  initial: AcceptanceOperation,
  lease: RepositoryLease,
  ports: CleanupPorts,
): AcceptanceOperation => {
  let operation = initial;
  const keeper = keepRepositoryLease(ports.store, lease);

  for (const run of operation.members) {
    if (!operation.cleanedSandboxes.includes(run.runId)) {
      try {
        keeper.effect(() => ports.repo.removeSandbox(run.worktree, ports.runsDir));
        operation = {
          ...operation,
          cleanedSandboxes: [...operation.cleanedSandboxes, run.runId],
          updatedAt: ports.clock.nowIso(),
        };
        ports.store.persistAcceptanceOperation(operation, keeper.current());
      } catch (error) {
        keeper.renew();
        console.error(`warning: failed to remove sandbox for ${run.runId}: ${error}`);
      }
    }

    if (run.runId !== operation.tipRunId && !operation.cleanedBranches.includes(run.runId)) {
      try {
        keeper.effect(() => ports.repo.deleteBranch(run.repo, run.branch));
        operation = {
          ...operation,
          cleanedBranches: [...operation.cleanedBranches, run.runId],
          updatedAt: ports.clock.nowIso(),
        };
        ports.store.persistAcceptanceOperation(operation, keeper.current());
      } catch (error) {
        keeper.renew();
        console.error(`warning: failed to delete branch for ${run.runId}: ${error}`);
      }
    }
  }

  const expectedSandboxes = new Set(operation.members.map((member) => member.runId));
  const expectedBranches = new Set(
    operation.members
      .filter((member) => member.runId !== operation.tipRunId)
      .map((member) => member.runId),
  );
  const hasExpected = (actual: string[], expected: Set<string>): boolean =>
    actual.length === expected.size && actual.every((runId) => expected.has(runId));
  if (
    hasExpected(operation.cleanedSandboxes, expectedSandboxes) &&
    hasExpected(operation.cleanedBranches, expectedBranches)
  ) {
    operation = { ...operation, phase: "cleaned", updatedAt: ports.clock.nowIso() };
    keeper.renew();
    ports.store.persistAcceptanceOperation(operation, keeper.current());
  }

  return operation;
};

export const recoverAcceptedCleanup = (ports: CleanupPorts): void => {
  const campaignIds = new Set(
    ports.store
      .listMeta()
      .filter((meta) => meta.status === "accepted")
      .map((meta) => meta.campaignId ?? meta.runId),
  );

  for (const campaignId of campaignIds) {
    const operation = ports.store.readAcceptanceOperation(campaignId);
    if (!operation || operation.phase !== "accepted") {
      continue;
    }

    const operationRepo = operation.members.at(0)?.repo;
    if (!operationRepo) {
      throw new Error(`acceptance cleanup ${campaignId} has no repository snapshot`);
    }
    const ownerId = `accept-recovery:${randomUUID()}`;
    const lease = ports.store.acquireRepositoryLease(
      operationRepo,
      ownerId,
      operation.tipRunId,
      "accept",
    );
    if (!lease) {
      ports.store.appendJournal(operation.tipRunId, {
        at: ports.clock.nowIso(),
        turn: 0,
        event: "driver_note",
        note: `Post-acceptance cleanup for ${campaignId} is pending because the repository is busy; startup continued and cleanup will retry later.`,
      });
      continue;
    }

    try {
      const recovered = cleanAcceptedOperation(operation, lease, ports);
      if (recovered.phase !== "cleaned") {
        ports.store.appendJournal(operation.tipRunId, {
          at: ports.clock.nowIso(),
          turn: 0,
          event: "driver_note",
          note: `Post-acceptance cleanup for ${campaignId} remains incomplete; startup continued and cleanup will retry later.`,
        });
      }
    } finally {
      ports.store.releaseRepositoryLease(lease);
    }
  }
};
