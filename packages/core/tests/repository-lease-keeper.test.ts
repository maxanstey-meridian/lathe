import { equal, throws } from "node:assert";
import { test } from "node:test";
import type { Store } from "../src/application/ports/store.js";
import { keepRepositoryLease } from "../src/application/use-cases/repository-lease-keeper.js";

test("repository lease keeper checks before effects and never presents a post-effect check as fencing", () => {
  const lease = {
    repo: "/repo",
    ownerId: "owner",
    runId: "run",
    purpose: "execute" as const,
    epoch: 1,
    acquiredAt: "now",
    heartbeatAt: "now",
    expiresAt: "later",
  };
  let heartbeats = 0;
  let effects = 0;
  const store = {
    heartbeatRepositoryLease: () => (++heartbeats === 1 ? lease : undefined),
  } as unknown as Store;
  const keeper = keepRepositoryLease(store, lease);

  equal(
    keeper.effect(() => ++effects),
    1,
  );
  equal(heartbeats, 1);
  throws(() => keeper.effect(() => ++effects), /repository lease lost/);
  equal(effects, 1);
});
