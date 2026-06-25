import { equal, strictEqual, ok, match, rejects } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Clock } from "../src/application/ports/clock.js";
import type { Repo } from "../src/application/ports/repo.js";
import type { ConvergenceLogEntry } from "../src/application/ports/store.js";
import { makePaths } from "../src/config/paths.js";
import type { Packet } from "../src/domain/packet.js";
import { SqliteStoreAdapter } from "../src/infrastructure/sqlite-store.js";
import { StoreAdapter } from "../src/infrastructure/store.js";

// ---------------------------------------------------------------------------
// Test helpers

const TS_COUNTER = { n: 0 };
const fixedClock = (): Clock => ({
  now: () => 1700000000000 + TS_COUNTER.n++,
  nowIso: () => `2026-01-01T00:00:${String(TS_COUNTER.n++).padStart(2, "0")}.000Z`,
});

const fakeRepo = (opts?: {
  headBranch?: string;
  branchExists?: boolean;
  headBranchThrows?: boolean;
  repoValid?: boolean;
}): Repo => {
  let headBranchCallCount = 0;
  return {
    get headBranchCallCount() {
      return headBranchCallCount;
    },
    createSandbox: () => {
      throw new Error("unimplemented");
    },
    wipCommit: () => undefined,
    amendCommit: () => "",
    worktreeIsDirty: () => false,
    diffStat: () => "",
    readDiffStats: () => ({ added: 0, removed: 0 }),
    reviewableDiff: () => "",
    reviewableDiffAgainst: () => "",
    fetchBranchFromClone: () => {
      throw new Error("unimplemented");
    },
    removeSandbox: () => {
      throw new Error("unimplemented");
    },
    headBranch: (_w: string) => {
      headBranchCallCount++;
      if (opts?.headBranchThrows) {
        throw new Error("not a repo");
      }
      return opts?.headBranch ?? "main";
    },
    branchExists: (_w: string, _b: string) => opts?.branchExists ?? true,
    repoValid: () => opts?.repoValid ?? true,
    isCloneSandbox: () => false,
    mergeAccept: () => {
      throw new Error("unimplemented");
    },
  };
};

const makeTestPacket = (override?: Record<string, unknown>): Packet => {
  const raw = `---
repo: /tmp/test-repo
base: main
summary: test packet
outcomes:
  - id: test-outcome
    description: A test outcome
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---

body
`;
  const fm = {
    repo: "/tmp/test-repo",
    base: "main",
    summary: "test packet",
    outcomes: [{ id: "test-outcome", description: "A test outcome" }],
    expected_surface: ["src/index.ts"],
    verification: [{ command: "echo ok" }],
    constraints: [],
    ...override,
  };
  return { runId: "20260101-000000-test", frontmatter: fm as any, body: "body\n", raw };
};

const makeValidConvergenceEntry = (
  overrides?: Partial<ConvergenceLogEntry>,
): ConvergenceLogEntry => {
  const at = fixedClock().nowIso();
  return {
    at,
    runId: "20260101-000000-test",
    campaignId: "test-campaign",
    pass: 1,
    maxPasses: 5,
    verification: { green: true, commands: [{ command: "echo ok", exitCode: 0, outputTail: "" }] },
    decision: { action: "stop" },
    amendedCommitSha: null,
    primary: {
      verdict: "accept" as const,
      findings: [],
      convergence: { recommend_stop: true, profile: { p0: 0, p1: 0, p2: 0, p3: 0 }, rationale: "" },
      commit_message: null,
      notes: "",
      human_decision_needed: null,
    },
    primaryRaw: `{"verdict":"accept"}`,
    ...overrides,
  };
};

const cleanTemp = async (dir: string) => {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
};

// ---------------------------------------------------------------------------
// Meta

test("store: meta round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-meta-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const meta = {
    runId: "20260101-000000-meta",
    status: "queued" as const,
    attempt: 1,
    repo: "/tmp/repo",
    base: "main",
    branch: "meridian/20260101-000000-meta",
    worktree: join(tmp, "worktree"),
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  const read = store.readMeta(meta.runId);
  equal(read.runId, meta.runId);
  equal(read.status, "queued");
  equal(read.attempt, 1);
  await cleanTemp(tmp);
});

test("store: readMetaIfExists returns undefined for absent run", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-meta-if-"));
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  equal(store.readMetaIfExists("20990101-000000-absent"), undefined);
  await cleanTemp(tmp);
});

test("store: listRunIds returns sorted ids", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-list-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  strictEqual(store.listRunIds().length, 0);
  const meta1 = {
    runId: "20260101-000000-z",
    status: "queued" as const,
    attempt: 1,
    repo: "/tmp/r",
    base: "main",
    branch: "b",
    worktree: tmp,
    updatedAt: clock.nowIso(),
  };
  const meta2 = {
    runId: "20260101-000000-a",
    status: "queued" as const,
    attempt: 1,
    repo: "/tmp/r",
    base: "main",
    branch: "b",
    worktree: tmp,
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta1);
  store.writeMeta(meta2);
  const ids = store.listRunIds();
  strictEqual(ids.length, 2);
  equal(ids[0], meta2.runId);
  equal(ids[1], meta1.runId);
  await cleanTemp(tmp);
});

test("store: listRunIds excludes dirs without meta", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-list-x-"));
  await mkdir(join(tmp, "20260101-000000-no-meta"), { recursive: true });
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  strictEqual(store.listRunIds().length, 0);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Outcome ledger

test("store: initialLedger creates from packet outcomes", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-ledger-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = makeTestPacket();
  const ledger = store.initialLedger(packet);
  equal(ledger.runId, "20260101-000000-test");
  strictEqual(ledger.outcomes.length, 1);
  equal(ledger.outcomes[0].id, "test-outcome");
  equal(ledger.outcomes[0].status, "not_started");
  await cleanTemp(tmp);
});

test("store: ledger round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-ledger2-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const ledger = {
    runId: "20260101-000000-test",
    outcomes: [
      {
        id: "test-outcome",
        description: "A test outcome",
        status: "done" as const,
        evidence: ["evidence.txt"],
        updatedAt: clock.nowIso(),
      },
    ],
    updatedAt: clock.nowIso(),
  };
  store.writeLedger(ledger);
  const read = store.readLedger(ledger.runId);
  equal(read.runId, ledger.runId);
  equal(read.outcomes[0].status, "done");
  equal(read.outcomes[0].evidence[0], "evidence.txt");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Review state

test("store: review state round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-review-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const initial = store.initialReviewState("20260101-000000-test");
  equal(initial.runId, "20260101-000000-test");
  strictEqual(initial.obligations.length, 0);
  const replaced = store.replaceObligations(initial.runId, ["fix x", "  ", "fix y"]);
  equal(replaced.obligations.length, 2);
  equal(replaced.obligations[0], "fix x");
  equal(replaced.obligations[1], "fix y");
  ok(replaced.lastDecisionAt);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Decisions (jsonl)

test("store: decisions append and read", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-dec-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const d1 = {
    timestamp: "2026-01-01T00:00:00.000Z",
    source: "daddy" as const,
    questionType: "other",
    question: "q1",
    status: "proceed",
    answer: "a1",
    constraints: [],
  };
  const d2 = {
    timestamp: "2026-01-01T00:00:01.000Z",
    source: "max" as const,
    questionType: "other",
    question: "q2",
    status: "proceed",
    answer: "a2",
    constraints: [],
  };
  store.appendDecision("20260101-000000-test", d1);
  store.appendDecision("20260101-000000-test", d2);
  const decisions = store.readDecisions("20260101-000000-test");
  strictEqual(decisions.length, 2);
  equal(decisions[0].question, "q1");
  equal(decisions[1].question, "q2");
  strictEqual(store.readDecisions("nonexistent-run").length, 0);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Checkpoints

test("store: checkpoints", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-ckp-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  equal(store.nextCheckpointNumber("20260101-000000-test"), 1);
  const c1 = {
    number: 1,
    reason: "checkpoint",
    summary: "s1",
    outcomes: [{ id: "o1", status: "done" as const, evidence: [] }],
    writtenAt: clock.nowIso(),
  };
  const c2 = {
    number: 2,
    reason: "checkpoint",
    summary: "s2",
    outcomes: [{ id: "o1", status: "done" as const, evidence: [] }],
    writtenAt: clock.nowIso(),
  };
  store.writeCheckpoint("20260101-000000-test", c1);
  store.writeCheckpoint("20260101-000000-test", c2);
  equal(store.nextCheckpointNumber("20260101-000000-test"), 3);
  const latest = store.latestCheckpoint("20260101-000000-test");
  equal(latest?.number, 2);
  equal(latest?.summary, "s2");
  equal(store.latestCheckpoint("nonexistent"), undefined);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Gate state

test("store: gate state round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-gate-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const state = {
    runId: "20260101-000000-test",
    latched: false,
    firstEditApproved: true,
    reconciliationRequired: false,
    expectedGlobs: ["src/**/*.ts"],
    suspiciousGlobs: [],
    baselineDiffStats: {},
    updatedAt: clock.nowIso(),
    mutationCommandPatterns: [],
  };
  store.writeGateState(state.runId, state);
  const read = store.readGateState(state.runId);
  equal(read.runId, state.runId);
  equal(read.latched, false);
  equal(read.firstEditApproved, true);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Report and Nits (markdown)

test("store: report read/write", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-rep-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const report = {
    status: "ready_for_review" as const,
    summary: "done",
    filesChanged: [],
    behaviourChanged: [],
    sourceOfTruthFollowed: [],
    outcomeClaims: [],
    verificationClaims: [],
    escalations: [],
    remainingUncertainty: [],
  };
  store.writeReport("20260101-000000-test", report, "# Report\n\ndone");
  equal(store.readReport("20260101-000000-test"), "# Report\n\ndone");
  equal(store.readReport("nonexistent"), "");
  await cleanTemp(tmp);
});

test("store: nits read/write", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-nits-"));
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  store.writeNits("20260101-000000-test", "# Nits\n\nnone");
  equal(store.readNits("20260101-000000-test"), "# Nits\n\nnone");
  equal(store.readNits("nonexistent"), "");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Convergence (jsonl)

test("store: convergence round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-conv-"));
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  const entry = makeValidConvergenceEntry();
  store.appendConvergence(entry.runId, entry);
  const entries = store.readConvergence(entry.runId);
  strictEqual(entries.length, 1);
  equal(entries[0].runId, entry.runId);
  equal(entries[0].decision.action, "stop");
  strictEqual(store.readConvergence("nonexistent").length, 0);
  await cleanTemp(tmp);
});

test("store: convergence rejects bad schema", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-conv-bad"));
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  // Override primary to a non-object (string) which will fail the SuperReview schema.
  const reallyBad = makeValidConvergenceEntry({ primary: "not-a-review" as any });
  await rejects(async () => store.appendConvergence("20260101-000000-test", reallyBad), {
    message: /refusing to append/,
  });
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Packet freeze

test("store: packet freeze round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-freeze-"));
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  store.freezePacket("20260101-000000-test", "---\nfrontmatter\n---\n\nfrozen body");
  equal(store.readFrozenPacket("20260101-000000-test"), "---\nfrontmatter\n---\n\nfrozen body");
  equal(store.readFrozenPacket("nonexistent"), "");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Active run

test("store: active run lifecycle", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-active-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  equal(store.readActiveRun(), undefined);
  const run = {
    runId: "20260101-000000-test",
    runDir: join(tmp, "runs/20260101-000000-test"),
    worktree: join(tmp, "worktree"),
    babySessionId: "sess1",
    startedAt: clock.nowIso(),
  };
  store.writeActiveRun(run);
  const read = store.readActiveRun();
  ok(read);
  equal(read!.runId, run.runId);
  store.clearActiveRun();
  equal(store.readActiveRun(), undefined);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Campaign

test("store: campaign round-trip", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-camp-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  equal(store.readCampaign("test-campaign"), undefined);
  const campaign = {
    campaignId: "test-campaign",
    originalRunId: "20260101-000000-test",
    originalIntent: "do a thing",
    status: "open" as const,
    maxPasses: 5,
    passes: [],
    updatedAt: clock.nowIso(),
  };
  store.writeCampaign(campaign);
  const read = store.readCampaign("test-campaign");
  ok(read);
  equal(read!.campaignId, "test-campaign");
  equal(read!.originalIntent, "do a thing");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Queue — list

test("store: listQueue empty", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-qlist-"));
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  strictEqual(store.listQueue().length, 0);
  await cleanTemp(tmp);
});

test("store: listQueue returns fresh packets", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-qlist2-"));
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  const packet1 = `---
repo: /tmp/repo
base: main
summary: p1
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  const packet2 = `---
repo: /tmp/repo
base: main
summary: p2
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  await mkdir(join(tmp, "queue"), { recursive: true });
  await writeFile(join(tmp, "queue", "20260101-000000-b.md"), packet2);
  await writeFile(join(tmp, "queue", "20260101-000000-a.md"), packet1);
  const entries = store.listQueue();
  strictEqual(entries.length, 2);
  equal(entries[0].runId, "20260101-000000-a");
  equal(entries[1].runId, "20260101-000000-b");
  await cleanTemp(tmp);
});

test("store: listQueue requeued runs come before fresh", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-qlist3-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  // Create a run dir with meta.status = "queued"
  const runId = "20260101-000000-requeued";
  const meta = {
    runId,
    status: "queued" as const,
    attempt: 1,
    repo: "/tmp/r",
    base: "main",
    branch: "b",
    worktree: join(tmp, "w"),
    updatedAt: clock.nowIso(),
  };
  store.writeMeta(meta);
  await mkdir(join(tmp, "queue"), { recursive: true });
  // Write a fresh packet too
  const packet = `---
repo: /tmp/repo
base: main
summary: fresh
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  await writeFile(join(tmp, "queue", "20260101-000000-fresh.md"), packet);
  const entries = store.listQueue();
  strictEqual(entries.length, 2);
  equal(entries[0].runId, runId);
  ok(entries[0].admittedAt);
  equal(entries[1].runId, "20260101-000000-fresh");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Queue — admit (constraint 1: explicit base vs no base split)

test("store: admitQueue rejects packet with no repo in frontmatter", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-no-repo-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = `---
base: main
summary: no repo
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  // Should be archived with .problems.txt sidecar
  ok(existsSync(join(tmp, "rejected", "20260101-000000-test.md")), "archived packet should exist");
  const problems = readFileSync(
    join(tmp, "rejected", "20260101-000000-test.md.problems.txt"),
    "utf-8",
  );
  match(problems, /no repo/);
  // Nothing in queue
  const queueFiles = await readdir(join(tmp, "queue"));
  strictEqual(queueFiles.length, 0);
  await cleanTemp(tmp);
});

test("store: admitQueue with explicit base — headBranch NOT called", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-explicit-"));
  const clock = fixedClock();
  const repo = fakeRepo({ headBranch: "develop", branchExists: true });
  const store = StoreAdapter.create(makePaths(tmp), repo, clock);
  const packet = `---
repo: ${tmp}/test-repo
base: stable-branch
summary: explicit base
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  strictEqual(repo.headBranchCallCount, 0, "headBranch should not be called when base is explicit");
  const queueFiles = await readdir(join(tmp, "queue"));
  strictEqual(queueFiles.length, 1);
  const admittedRaw = readFileSync(join(tmp, "queue", "20260101-000000-test.md"), "utf-8");
  match(admittedRaw, /base: stable-branch/);
  await cleanTemp(tmp);
});

test("store: admitQueue without base — headBranch called and stamped", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-nobase-"));
  const clock = fixedClock();
  const repo = fakeRepo({ headBranch: "develop", branchExists: true });
  const store = StoreAdapter.create(makePaths(tmp), repo, clock);
  const packet = `---
repo: ${tmp}/test-repo
summary: no explicit base
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  strictEqual(repo.headBranchCallCount, 1, "headBranch should be called when base is absent");
  const queueFiles = await readdir(join(tmp, "queue"));
  strictEqual(queueFiles.length, 1);
  const admittedRaw = readFileSync(join(tmp, "queue", "20260101-000000-test.md"), "utf-8");
  match(admittedRaw, /base: develop/);
  await cleanTemp(tmp);
});

test("store: admitQueue rejects when headBranch throws", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-throw-"));
  const clock = fixedClock();
  const repo = fakeRepo({ headBranchThrows: true });
  const store = StoreAdapter.create(makePaths(tmp), repo, clock);
  const packet = `---
repo: /tmp/nowhere
summary: headBranch fails
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  strictEqual(repo.headBranchCallCount, 1, "headBranch should have been called");
  ok(existsSync(join(tmp, "rejected", "20260101-000000-test.md")), "archived packet should exist");
  const problems = readFileSync(
    join(tmp, "rejected", "20260101-000000-test.md.problems.txt"),
    "utf-8",
  );
  match(problems, /headBranch failed/);
  await cleanTemp(tmp);
});

test("store: admitQueue rejects invalid packet shape", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-badfm-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = `---
repo: /tmp/test-repo
base: main
summary: missing outcomes
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  ok(existsSync(join(tmp, "rejected", "20260101-000000-test.md")), "archived packet should exist");
  const problems = readFileSync(
    join(tmp, "rejected", "20260101-000000-test.md.problems.txt"),
    "utf-8",
  );
  match(problems, /outcomes/);
  await cleanTemp(tmp);
});

test("store: admitQueue rejects when repoValid returns false", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-adm-repoval-"));
  const clock = fixedClock();
  const repo = fakeRepo({ repoValid: false });
  const store = StoreAdapter.create(makePaths(tmp), repo, clock);
  const packet = `---
repo: ${tmp}/test-repo
base: main
summary: repoValid fails
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  store.admitQueue("20260101-000000-test", packet);
  ok(existsSync(join(tmp, "rejected", "20260101-000000-test.md")), "archived packet should exist");
  const problems = readFileSync(
    join(tmp, "rejected", "20260101-000000-test.md.problems.txt"),
    "utf-8",
  );
  match(problems, /not a valid git repository/);
  const queueFiles = await readdir(join(tmp, "queue"));
  strictEqual(queueFiles.length, 0);
  await cleanTemp(tmp);
});

test("store: archiveQueue moves packet to rejected", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-arch-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const packet = `---
repo: /tmp/test-repo
base: main
summary: archive me
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  await mkdir(join(tmp, "queue"), { recursive: true });
  await writeFile(join(tmp, "queue", "20260101-000000-test.md"), packet);
  store.archiveQueue("20260101-000000-test");
  strictEqual((await readdir(join(tmp, "queue"))).length, 0);
  ok(existsSync(join(tmp, "rejected", "20260101-000000-test.md")), "should be in rejected/");
  await cleanTemp(tmp);
});

test("store: archiveQueue is no-op when file absent", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-arch-noop-"));
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  store.archiveQueue("nonexistent");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Staged-chain registry

test("store: staged write/read/list/remove", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-staged-"));
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  const packet = `---
repo: /tmp/test-repo
summary: staged child
parent_run_id: 20260101-000000-parent
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
  strictEqual(store.listStaged().length, 0);
  strictEqual(store.readStaged("20260101-000000-child"), undefined);
  store.writeStaged("20260101-000000-child", packet);
  equal(store.readStaged("20260101-000000-child"), packet);
  const staged = store.listStaged();
  strictEqual(staged.length, 1);
  equal(staged[0].runId, "20260101-000000-child");
  equal(staged[0].parentRunId, "20260101-000000-parent");
  equal(staged[0].repo, "/tmp/test-repo");
  store.removeStaged("20260101-000000-child");
  strictEqual(store.readStaged("20260101-000000-child"), undefined);
  strictEqual(store.listStaged().length, 0);
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Journal (J3: lenient read)

test("store: journal append and read", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-jrnl-"));
  const clock = fixedClock();
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), clock);
  const event = {
    at: clock.nowIso(),
    event: "run_started" as const,
    runId: "20260101-000000-test",
    attempt: 1,
  };
  store.appendJournal("20260101-000000-test", event);
  const events = store.readJournal("20260101-000000-test");
  strictEqual(events.length, 1);
  equal(events[0].event, "run_started");
  strictEqual(store.readJournal("nonexistent").length, 0);
  await cleanTemp(tmp);
});

test("store: journal skips invalid lines (J3)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-jrnl-bad-"));
  const journalPath = join(tmp, "runs/20260101-000000-test/journal.jsonl");
  await mkdir(join(tmp, "runs/20260101-000000-test"), { recursive: true });
  // Plant a valid line, then a bad line, then another valid line
  const valid1 =
    JSON.stringify({
      at: "2026-01-01T00:00:00.000Z",
      event: "run_started",
      runId: "20260101-000000-test",
      attempt: 1,
    }) + "\n";
  const badLine = "this is not json\n";
  const valid2 =
    JSON.stringify({
      at: "2026-01-01T00:00:01.000Z",
      event: "turn_ended",
      messageId: "m1",
      tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      contextTokens: 150,
      text: "hello",
    }) + "\n";
  await writeFile(journalPath, valid1 + badLine + valid2);
  const store = StoreAdapter.create(makePaths(tmp), fakeRepo(), fixedClock());
  const events = store.readJournal("20260101-000000-test");
  strictEqual(events.length, 2);
  equal(events[0].event, "run_started");
  equal(events[1].event, "turn_ended");
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// Parity: contract tests over both adapters
// ---------------------------------------------------------------------------

const runContractTests = async (
  label: string,
  createStore: (tmp: string, repo: Repo, clock: Clock) => typeof StoreAdapter,
) => {
  // Meta round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-meta-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const meta = {
      runId: "20260101-000000-meta",
      status: "queued" as const,
      attempt: 1,
      repo: "/tmp/repo",
      base: "main",
      branch: "meridian/20260101-000000-meta",
      worktree: join(tmp, "worktree"),
      updatedAt: clock.nowIso(),
    };
    store.writeMeta(meta);
    const read = store.readMeta(meta.runId);
    equal(read.runId, meta.runId);
    equal(read.status, "queued");
    equal(read.attempt, 1);
    await cleanTemp(tmp);
  }

  // readMetaIfExists returns undefined for absent run
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-meta-if-`));
    const store = createStore(tmp, fakeRepo(), fixedClock());
    equal(store.readMetaIfExists("20990101-000000-absent"), undefined);
    await cleanTemp(tmp);
  }

  // Outcome ledger round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-ledger-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const ledger = {
      runId: "20260101-000000-test",
      outcomes: [
        {
          id: "test-outcome",
          description: "A test outcome",
          status: "done" as const,
          evidence: ["evidence.txt"],
          updatedAt: clock.nowIso(),
        },
      ],
      updatedAt: clock.nowIso(),
    };
    store.writeLedger(ledger);
    const read = store.readLedger(ledger.runId);
    equal(read.runId, ledger.runId);
    equal(read.outcomes[0].status, "done");
    equal(read.outcomes[0].evidence[0], "evidence.txt");
    await cleanTemp(tmp);
  }

  // Review state round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-review-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const initial = store.initialReviewState("20260101-000000-test");
    equal(initial.runId, "20260101-000000-test");
    strictEqual(initial.obligations.length, 0);
    const replaced = store.replaceObligations(initial.runId, ["fix x", "  ", "fix y"]);
    equal(replaced.obligations.length, 2);
    equal(replaced.obligations[0], "fix x");
    equal(replaced.obligations[1], "fix y");
    ok(replaced.lastDecisionAt);
    await cleanTemp(tmp);
  }

  // Decisions append and read
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-dec-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const d1 = {
      timestamp: "2026-01-01T00:00:00.000Z",
      source: "daddy" as const,
      questionType: "other",
      question: "q1",
      status: "proceed",
      answer: "a1",
      constraints: [],
    };
    store.appendDecision("20260101-000000-test", d1);
    const decisions = store.readDecisions("20260101-000000-test");
    strictEqual(decisions.length, 1);
    equal(decisions[0].question, "q1");
    await cleanTemp(tmp);
  }

  // Checkpoints
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-ckp-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    equal(store.nextCheckpointNumber("20260101-000000-test"), 1);
    const c1 = {
      number: 1,
      reason: "checkpoint",
      summary: "s1",
      outcomes: [{ id: "o1", status: "done" as const, evidence: [] }],
      writtenAt: clock.nowIso(),
    };
    const c2 = {
      number: 2,
      reason: "checkpoint",
      summary: "s2",
      outcomes: [{ id: "o1", status: "done" as const, evidence: [] }],
      writtenAt: clock.nowIso(),
    };
    store.writeCheckpoint("20260101-000000-test", c1);
    store.writeCheckpoint("20260101-000000-test", c2);
    equal(store.nextCheckpointNumber("20260101-000000-test"), 3);
    const latest = store.latestCheckpoint("20260101-000000-test");
    equal(latest?.number, 2);
    equal(latest?.summary, "s2");
    equal(store.latestCheckpoint("nonexistent"), undefined);
    await cleanTemp(tmp);
  }

  // Gate state round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-gate-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const state = {
      runId: "20260101-000000-test",
      latched: false,
      firstEditApproved: true,
      reconciliationRequired: false,
      expectedGlobs: ["src/**/*.ts"],
      suspiciousGlobs: [],
      baselineDiffStats: {},
      updatedAt: clock.nowIso(),
      mutationCommandPatterns: [],
    };
    store.writeGateState(state.runId, state);
    const read = store.readGateState(state.runId);
    equal(read.runId, state.runId);
    equal(read.latched, false);
    equal(read.firstEditApproved, true);
    await cleanTemp(tmp);
  }

  // Report read/write
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-rep-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const report = {
      status: "ready_for_review" as const,
      summary: "done",
      filesChanged: [],
      behaviourChanged: [],
      sourceOfTruthFollowed: [],
      outcomeClaims: [],
      verificationClaims: [],
      escalations: [],
      remainingUncertainty: [],
    };
    store.writeReport("20260101-000000-test", report, "# Report\n\ndone");
    equal(store.readReport("20260101-000000-test"), "# Report\n\ndone");
    equal(store.readReport("nonexistent"), "");
    await cleanTemp(tmp);
  }

  // Nits read/write
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-nits-`));
    const store = createStore(tmp, fakeRepo(), fixedClock());
    store.writeNits("20260101-000000-test", "# Nits\n\nnone");
    equal(store.readNits("20260101-000000-test"), "# Nits\n\nnone");
    equal(store.readNits("nonexistent"), "");
    await cleanTemp(tmp);
  }

  // Convergence round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-conv-`));
    const store = createStore(tmp, fakeRepo(), fixedClock());
    const entry = makeValidConvergenceEntry();
    store.appendConvergence(entry.runId, entry);
    const entries = store.readConvergence(entry.runId);
    strictEqual(entries.length, 1);
    equal(entries[0].runId, entry.runId);
    equal(entries[0].decision.action, "stop");
    await cleanTemp(tmp);
  }

  // Packet freeze round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-freeze-`));
    const store = createStore(tmp, fakeRepo(), fixedClock());
    store.freezePacket("20260101-000000-test", "---\nfrontmatter\n---\n\nfrozen body");
    equal(store.readFrozenPacket("20260101-000000-test"), "---\nfrontmatter\n---\n\nfrozen body");
    equal(store.readFrozenPacket("nonexistent"), "");
    await cleanTemp(tmp);
  }

  // Active run lifecycle
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-active-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    equal(store.readActiveRun(), undefined);
    const run = {
      runId: "20260101-000000-test",
      runDir: join(tmp, "runs/20260101-000000-test"),
      worktree: join(tmp, "worktree"),
      babySessionId: "sess1",
      startedAt: clock.nowIso(),
    };
    store.writeActiveRun(run);
    const read = store.readActiveRun();
    ok(read);
    equal(read!.runId, run.runId);
    store.clearActiveRun();
    equal(store.readActiveRun(), undefined);
    await cleanTemp(tmp);
  }

  // Campaign round-trip
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-camp-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    equal(store.readCampaign("test-campaign"), undefined);
    const campaign = {
      campaignId: "test-campaign",
      originalRunId: "20260101-000000-test",
      originalIntent: "do a thing",
      status: "open" as const,
      maxPasses: 5,
      passes: [],
      updatedAt: clock.nowIso(),
    };
    store.writeCampaign(campaign);
    const read = store.readCampaign("test-campaign");
    ok(read);
    equal(read!.campaignId, "test-campaign");
    equal(read!.originalIntent, "do a thing");
    await cleanTemp(tmp);
  }

  // Queue — list empty
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-qlist-`));
    const store = createStore(tmp, fakeRepo(), fixedClock());
    strictEqual(store.listQueue().length, 0);
    await cleanTemp(tmp);
  }

  // Queue — multi-requeued ordering: requeued runs first in lexical order, then fresh
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-qlist2-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const packet = `---
repo: /tmp/test-repo
base: main
summary: packet
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
    // Write 3 requeued run metas in non-lexical order (z, a, b)
    // The file adapter sorts requeued lexically via listRunIds().sort()
    const zMeta = {
      runId: "20260101-000000-z",
      status: "queued" as const,
      attempt: 1,
      repo: "/tmp/r",
      base: "main",
      branch: "b",
      worktree: join(tmp, "w"),
      updatedAt: clock.nowIso(),
    };
    const aMeta = {
      runId: "20260101-000000-a",
      status: "queued" as const,
      attempt: 1,
      repo: "/tmp/r",
      base: "main",
      branch: "b",
      worktree: join(tmp, "w"),
      updatedAt: clock.nowIso(),
    };
    const bMeta = {
      runId: "20260101-000000-b",
      status: "queued" as const,
      attempt: 1,
      repo: "/tmp/r",
      base: "main",
      branch: "b",
      worktree: join(tmp, "w"),
      updatedAt: clock.nowIso(),
    };
    store.writeMeta(zMeta);
    store.writeMeta(aMeta);
    store.writeMeta(bMeta);
    await mkdir(join(tmp, "queue"), { recursive: true });
    // Write a fresh packet (not consumed into a run dir)
    await writeFile(join(tmp, "queue", "20260101-000000-fresh.md"), packet);
    const entries = store.listQueue();
    strictEqual(entries.length, 4);
    // Requeued runs come first, in lexical order: a, b, z
    equal(entries[0].runId, "20260101-000000-a");
    equal(entries[1].runId, "20260101-000000-b");
    equal(entries[2].runId, "20260101-000000-z");
    // Fresh packets come after requeued
    equal(entries[3].runId, "20260101-000000-fresh");
    await cleanTemp(tmp);
  }

  // Queue — admit
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-adm-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const packet = `---
repo: /tmp/test-repo
base: main
summary: admit me
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
    store.admitQueue("20260101-000000-test", packet);
    const queueFiles = await readdir(join(tmp, "queue"));
    strictEqual(queueFiles.length, 1);
    await cleanTemp(tmp);
  }

  // Queue — archive
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-arch-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const packet = `---
repo: /tmp/test-repo
base: main
summary: archive me
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
    await mkdir(join(tmp, "queue"), { recursive: true });
    await writeFile(join(tmp, "queue", "20260101-000000-test.md"), packet);
    store.archiveQueue("20260101-000000-test");
    strictEqual((await readdir(join(tmp, "queue"))).length, 0);
    ok(existsSync(join(tmp, "rejected", "20260101-000000-test.md")));
    await cleanTemp(tmp);
  }

  // Staged write/read/list/remove
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-staged-`));
    const store = createStore(tmp, fakeRepo(), fixedClock());
    const packet = `---
repo: /tmp/test-repo
summary: staged child
parent_run_id: 20260101-000000-parent
outcomes:
  - id: o1
    description: outcome 1
expected_surface:
  - src/index.ts
verification:
  - command: echo ok
---
`;
    strictEqual(store.listStaged().length, 0);
    strictEqual(store.readStaged("20260101-000000-child"), undefined);
    store.writeStaged("20260101-000000-child", packet);
    equal(store.readStaged("20260101-000000-child"), packet);
    const staged = store.listStaged();
    strictEqual(staged.length, 1);
    equal(staged[0].runId, "20260101-000000-child");
    equal(staged[0].parentRunId, "20260101-000000-parent");
    equal(staged[0].repo, "/tmp/test-repo");
    store.removeStaged("20260101-000000-child");
    strictEqual(store.readStaged("20260101-000000-child"), undefined);
    strictEqual(store.listStaged().length, 0);
    await cleanTemp(tmp);
  }

  // Journal append and read
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-jrnl-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    const event = {
      at: clock.nowIso(),
      event: "run_started" as const,
      runId: "20260101-000000-test",
      attempt: 1,
    };
    store.appendJournal("20260101-000000-test", event);
    const events = store.readJournal("20260101-000000-test");
    strictEqual(events.length, 1);
    equal(events[0].event, "run_started");
    strictEqual(store.readJournal("nonexistent").length, 0);
    await cleanTemp(tmp);
  }

  // readJournalSince returns empty when no events
  {
    const tmp = await mkdtemp(join(tmpdir(), `${label}-jrs-`));
    const clock = fixedClock();
    const store = createStore(tmp, fakeRepo(), clock);
    strictEqual(store.readJournalSince(0).length, 0);
    strictEqual(store.readJournalSince(999).length, 0);
    await cleanTemp(tmp);
  }
};

// Run contract tests against file adapter
test("store: parity — file adapter", async () => {
  await runContractTests("file", (tmp, repo, clock) =>
    StoreAdapter.create(makePaths(tmp), repo, clock),
  );
});

// Run contract tests against SQLite adapter
test("store: parity — sqlite adapter", async () => {
  await runContractTests("sqlite", (tmp, repo, clock) =>
    SqliteStoreAdapter.create(makePaths(tmp), repo, clock),
  );
});

// ---------------------------------------------------------------------------
// SQLite-specific: WAL snapshot isolation
// ---------------------------------------------------------------------------

test("store: sqlite — WAL snapshot isolation", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-sqlite-wal-"));
  const dbPath = join(tmp, "data.db");

  // Connection A: writer
  const connA = new DatabaseSync(dbPath);
  connA.exec("PRAGMA journal_mode=WAL;");
  connA.exec("PRAGMA synchronous=NORMAL;");

  // Connection B: reader
  const connB = new DatabaseSync(dbPath);
  connB.exec("PRAGMA journal_mode=WAL;");
  connB.exec("PRAGMA synchronous=NORMAL;");

  // Create table and insert initial row (committed)
  connA.exec(`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  connA.prepare("INSERT INTO items (id, value) VALUES (?, ?)").run("1", "initial");

  // Writer begins a transaction and inserts a new row WITHOUT committing
  connA.exec("BEGIN");
  connA.prepare("INSERT INTO items (id, value) VALUES (?, ?)").run("2", "uncommitted");

  // Reader should NOT see the uncommitted row (WAL snapshot isolation)
  const beforeCommit = connB.prepare("SELECT id, value FROM items ORDER BY id").all();
  strictEqual(beforeCommit.length, 1);
  equal(beforeCommit[0].id, "1");
  equal(beforeCommit[0].value, "initial");

  // Commit the write
  connA.exec("COMMIT");

  // Reader should now see both rows
  const afterCommit = connB.prepare("SELECT id, value FROM items ORDER BY id").all();
  strictEqual(afterCommit.length, 2);
  equal(afterCommit[0].id, "1");
  equal(afterCommit[1].id, "2");
  equal(afterCommit[1].value, "uncommitted");

  connA.close();
  connB.close();
  await cleanTemp(tmp);
});

// ---------------------------------------------------------------------------
// SQLite-specific: readJournalSince global seq ordering/resumption
// ---------------------------------------------------------------------------

test("store: sqlite — readJournalSince ordering across runIds", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "store-sqlite-jrs-"));
  const clock = fixedClock();
  const repo = fakeRepo();
  const store = SqliteStoreAdapter.create(makePaths(tmp), repo, clock);

  // Append events to two different runs
  const eventA1 = {
    at: "2026-01-01T00:00:01.000Z",
    event: "run_started",
    runId: "run-a",
    attempt: 1,
  };
  const eventB1 = {
    at: "2026-01-01T00:00:02.000Z",
    event: "turn_ended",
    runId: "run-b",
    messageId: "m1",
    tokens: { input: 100, output: 50, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    contextTokens: 150,
    text: "hello",
  };
  const eventA2 = {
    at: "2026-01-01T00:00:03.000Z",
    event: "turn_ended",
    runId: "run-a",
    messageId: "m2",
    tokens: { input: 200, output: 100, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    contextTokens: 250,
    text: "world",
  };

  store.appendJournal("run-a", eventA1);
  store.appendJournal("run-b", eventB1);
  store.appendJournal("run-a", eventA2);

  // readJournalSince(0) returns all events in seq order
  const all = store.readJournalSince(0);
  strictEqual(all.length, 3);
  equal(all[0].seq, 1);
  equal(all[0].runId, "run-a");
  equal(all[0].event.event, "run_started");
  equal(all[1].seq, 2);
  equal(all[1].runId, "run-b");
  equal(all[1].event.event, "turn_ended");
  equal(all[2].seq, 3);
  equal(all[2].runId, "run-a");
  equal(all[2].event.event, "turn_ended");

  // readJournalSince(1) returns events after seq 1 (resumption)
  const resumed = store.readJournalSince(1);
  strictEqual(resumed.length, 2);
  equal(resumed[0].seq, 2);
  equal(resumed[1].seq, 3);

  // readJournalSince(3) returns empty
  strictEqual(store.readJournalSince(3).length, 0);

  await cleanTemp(tmp);
});
