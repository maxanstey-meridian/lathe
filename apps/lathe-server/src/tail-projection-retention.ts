export type TailProjectionRetention = {
  pin(runId: string): void;
  unpin(runId: string): void;
  touch(runId: string): void;
  enforce(): void;
  cachedRunIds(): string[];
};

export const createTailProjectionRetention = (
  maxInactiveRuns: number,
  isBusy: (runId: string) => boolean,
  evict: (runId: string) => void,
): TailProjectionRetention => {
  const pinned = new Set<string>();
  const inactive: string[] = [];

  const removeInactive = (runId: string): void => {
    const index = inactive.indexOf(runId);
    if (index >= 0) inactive.splice(index, 1);
  };

  const enforceLimit = (): void => {
    let attempts = inactive.length;
    while (inactive.length > maxInactiveRuns && attempts > 0) {
      attempts -= 1;
      const runId = inactive.shift();
      if (!runId) break;
      if (pinned.has(runId) || isBusy(runId)) {
        inactive.push(runId);
        continue;
      }
      evict(runId);
    }
  };

  const touch = (runId: string): void => {
    if (pinned.has(runId)) return;
    removeInactive(runId);
    inactive.push(runId);
    enforceLimit();
  };

  return {
    pin: (runId) => {
      pinned.add(runId);
      removeInactive(runId);
    },
    unpin: (runId) => {
      pinned.delete(runId);
      touch(runId);
    },
    touch,
    enforce: enforceLimit,
    cachedRunIds: () => [...inactive],
  };
};
