import { equal, ok } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import { makePaths } from "../src/config/paths.js";
import { Config } from "../src/config/schemas.js";
import { initialGateState } from "../src/domain/gate.js";
import { StoreAdapter } from "../src/infrastructure/store.js";
import { dispatch, type CliDeps } from "../src/interfaces/cli/dispatch.js";

const PACKET_RAW = `---
repo: /tmp/test-repo
base: main
summary: smoke packet
outcomes:
  - id: o1
    description: do the thing
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
body
`;

const RUN_ID = "20260101-000000-iface";

const fixedClock = (): Clock => ({
  now: () => 1_700_000_000_000,
  nowIso: () => "2026-01-01T00:00:00.000Z",
});

const fakeRepo = (): Repo => ({
  createSandbox: () => {},
  wipCommit: () => "sha000",
  amendCommit: () => "sha000",
  worktreeIsDirty: () => false,
  diffStat: () => "",
  readDiffStats: () => ({}),
  reviewableDiff: () => "diff",
  reviewableDiffAgainst: () => "diff",
  fetchBranchFromClone: () => {},
  removeSandbox: () => {},
  headBranch: () => "main",
  branchExists: () => true,
  isCloneSandbox: () => true,
  mergeAccept: () => {},
  repoValid: () => true,
});

type Harness = {
  deps: CliDeps;
  calls: { ran: boolean; converged: string[]; superReviewed: string[]; planned: boolean };
  cleanup: () => Promise<void>;
};

const makeHarness = async (): Promise<Harness> => {
  const tmp = await mkdtemp(join(tmpdir(), "iface-"));
  const clock = fixedClock();
  const repo = fakeRepo();
  const paths = makePaths(tmp);
  const store = StoreAdapter.create(paths, repo, clock);

  // Seed a finished run + its ledger, journal, and a campaign so the renderers
  // have something to walk.
  store.writeMeta({
    runId: RUN_ID,
    status: "ready_for_review",
    attempt: 1,
    repo: "/tmp/test-repo",
    base: "main",
    branch: `meridian/${RUN_ID}`,
    worktree: join(tmp, "wt"),
    summary: "a finished run",
    stallRetries: 0,
    reorientRetries: 0,
    updatedAt: clock.nowIso(),
  });
  store.writeLedger({
    runId: RUN_ID,
    outcomes: [
      {
        id: "o1",
        description: "do it",
        status: "done",
        evidence: ["did"],
        updatedAt: clock.nowIso(),
      },
    ],
    updatedAt: clock.nowIso(),
  });
  store.appendJournal(RUN_ID, {
    at: clock.nowIso(),
    event: "run_started",
    runId: RUN_ID,
    attempt: 1,
  });
  store.writeCampaign({
    campaignId: RUN_ID,
    originalRunId: RUN_ID,
    originalIntent: "converge one intent",
    status: "converged",
    maxPasses: 3,
    passes: [
      { runId: RUN_ID, pass: 1, verdict: "accept", groundedBlockers: 0, atIso: clock.nowIso() },
    ],
    updatedAt: clock.nowIso(),
  });

  const calls = {
    ran: false,
    converged: [] as string[],
    superReviewed: [] as string[],
    planned: false,
    tailed: [] as string[],
  };
  const deps: CliDeps = {
    config: Config.parse({}),
    paths,
    store,
    repo,
    clock,
    openPlanner: () => {
      calls.planned = true;
      return 0;
    },
    runDriver: async () => {
      calls.ran = true;
    },
    convergeOnce: async (runId) => {
      calls.converged.push(runId);
      return 0;
    },
    superReviewOnce: async (runId) => {
      calls.superReviewed.push(runId);
      return 0;
    },
    openTail: (runId) => {
      calls.tailed.push(runId);
      return -1;
    },
  };

  return { deps, calls, cleanup: () => rm(tmp, { recursive: true, force: true }) };
};

test("dispatch: read commands render and exit 0", async () => {
  const h = await makeHarness();
  equal(await dispatch(["status"], h.deps), 0);
  equal(await dispatch(["review"], h.deps), 0);
  equal(await dispatch(["queue"], h.deps), 0);
  equal(await dispatch(["tail", RUN_ID, "--no-follow"], h.deps), 0);
  await h.cleanup();
});

test("dispatch: side-effectful commands route to their injected callbacks", async () => {
  const h = await makeHarness();
  equal(await dispatch(["plan"], h.deps), 0);
  ok(h.calls.planned);
  equal(await dispatch(["run"], h.deps), 0);
  ok(h.calls.ran);
  equal(await dispatch(["converge", "r1"], h.deps), 0);
  equal(await dispatch(["super-review", "r2"], h.deps), 0);
  equal(h.calls.converged[0], "r1");
  equal(h.calls.superReviewed[0], "r2");
  await h.cleanup();
});

test("dispatch: refusals and usage return non-zero without throwing", async () => {
  const h = await makeHarness();
  equal(await dispatch(["accept", "nope"], h.deps), 1); // not ready_for_review / missing
  equal(await dispatch(["answer", "nope", "go ahead"], h.deps), 1); // not parked
  equal(await dispatch(["chain"], h.deps), 1); // missing dir
  equal(await dispatch(["queue", "add"], h.deps), 1); // missing file
  equal(await dispatch(["bogus"], h.deps), 1); // unknown command → usage + 1
  equal(await dispatch([], h.deps), 0); // bare invocation → usage + 0
  await h.cleanup();
});

test("dispatch: accept dispatches acceptRun for a ready_for_review run is refused when repo not on target", async () => {
  // The seeded run IS ready_for_review; acceptRun checks the repo is on target +
  // clean. The fake repo reports headBranch=main and not dirty, base=main → it
  // proceeds through the (fake) merge and marks accepted, exit 0.
  const h = await makeHarness();
  equal(await dispatch(["accept", RUN_ID], h.deps), 0);
  equal(h.deps.store.readMeta(RUN_ID).status, "accepted");
  await h.cleanup();
});

test("dispatch: queue drop reports presence", async () => {
  const h = await makeHarness();
  equal(await dispatch(["queue", "drop", "not-there"], h.deps), 0);
  await h.cleanup();
});

test("dispatch: successful queue add admits a valid packet", async () => {
  const h = await makeHarness();
  const added = "20260101-000000-added";
  const file = join(h.deps.paths.root, `${added}.md`);
  mkdirSync(h.deps.paths.root, { recursive: true });
  writeFileSync(file, PACKET_RAW, "utf-8");
  equal(await dispatch(["queue", "add", file], h.deps), 0);
  // The admitted packet now sits in the queue.
  ok(h.deps.store.listQueue().some((e) => e.runId === added));
  await h.cleanup();
});

test("dispatch: successful chain add stages a runId-named packet", async () => {
  const h = await makeHarness();
  const dir = join(h.deps.paths.root, "chain-src");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "20260101-000000-staged.md"), PACKET_RAW, "utf-8");
  // A parent-less head promotes straight to the queue; exit 0, no rejections.
  equal(await dispatch(["chain", "add", dir], h.deps), 0);
  await h.cleanup();
});

test("dispatch: successful answer requeues a parked run", async () => {
  const h = await makeHarness();
  const parked = "20260101-000000-parked";
  h.deps.store.writeMeta({
    runId: parked,
    status: "blocked",
    blockedReason: "human_decision",
    blockedQuestion: "which way?",
    attempt: 1,
    repo: "/tmp/test-repo",
    base: "main",
    branch: `meridian/${parked}`,
    worktree: join(h.deps.paths.runDir(parked), "worktree"),
    stallRetries: 1,
    reorientRetries: 0,
    updatedAt: h.deps.clock.nowIso(),
  });
  h.deps.store.writeGateState(
    parked,
    initialGateState(
      parked,
      ["src/**"],
      [],
      {
        checkpointNudgeMs: 1,
        checkpointToolCalls: 1,
        checkpointFiles: 1,
        checkpointLoc: 1,
        mutationCommandPatterns: [],
      },
      h.deps.clock.nowIso(),
    ),
  );
  equal(await dispatch(["answer", parked, "go this way"], h.deps), 0);
  const meta = h.deps.store.readMeta(parked);
  equal(meta.status, "queued");
  equal(meta.stallRetries, 0); // R10 retry budget reset on a human answer
  await h.cleanup();
});

test("dispatch: tail on a TTY routes to the Ink UI", async () => {
  const h = await makeHarness();
  const original = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  try {
    // follow (default), not --plain, TTY → the Ink split-pane UI (returns -1).
    equal(await dispatch(["tail", RUN_ID], h.deps), -1);
    equal(h.calls.tailed[0], RUN_ID);
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true });
  }
  await h.cleanup();
});
