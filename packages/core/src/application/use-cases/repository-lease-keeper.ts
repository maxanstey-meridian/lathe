import { RepositoryLeaseLostError } from "../errors/repository-lease-lost.js";
import type { RepositoryLease, Store } from "../ports/store.js";

export type RepositoryLeaseKeeper = {
  current(): RepositoryLease;
  renew(): void;
  effect<T>(run: () => T): T;
};

export const keepRepositoryLease = (
  store: Store,
  initial: RepositoryLease,
  signal?: AbortSignal,
): RepositoryLeaseKeeper => {
  let lease = initial;

  const renew = (): void => {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("aborted", "AbortError");
    }
    const renewed = store.heartbeatRepositoryLease(lease);
    if (!renewed) {
      throw new RepositoryLeaseLostError(`repository lease lost for ${lease.repo}`);
    }
    lease = renewed;
  };

  return {
    current: () => lease,
    renew,
    effect: <T>(run: () => T): T => {
      renew();
      return run();
    },
  };
};
