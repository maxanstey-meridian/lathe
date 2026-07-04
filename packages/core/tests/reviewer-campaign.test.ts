import { equal, ok } from "node:assert";
import { test } from "node:test";
import type { Executor, ModelConfig } from "../src/application/ports/executor.js";
import type { SuperReviewInput } from "../src/domain/prompts.js";
import { createReviewer } from "../src/infrastructure/opencode/reviewer.js";

// ---------------------------------------------------------------------------
// Fixture: mock executor

const makeMockExecutor = (
  createSessionCb?: (title: string, dir: string) => Promise<string>,
  deleteSessionCb?: (sessionId: string) => Promise<void>,
): {
  executor: Executor;
  sessionsCreated: { title: string; directory: string }[];
  sessionsDeleted: string[];
} => {
  const sessionsCreated: { title: string; directory: string }[] = [];
  const sessionsDeleted: string[] = [];
  let sessionCounter = 0;

  const executor: Executor = {
    createSession: async (title, directory) => {
      const id = `session-${++sessionCounter}`;
      sessionsCreated.push({ title, directory });
      // Call the callback if provided, allowing tests to override behavior
      if (createSessionCb) {
        // If callback returns a string, use that instead
        const custom = await createSessionCb(title, directory);
        return custom;
      }
      return id;
    },
    sendMessage: async () => ({
      info: { id: "m", sessionID: "test", role: "assistant", modelID: "test" },
      parts: [
        {
          type: "text" as const,
          text: '{"verdict":"accept","findings":[],"convergence":{"recommend_stop":true,"profile":{"p0":0,"p1":0,"p2":0,"p3":0},"rationale":"ok"},"notes":"","human_decision_needed":null}',
        },
      ],
    }),
    listMessages: async () => [],
    deleteSession: async (sessionId) => {
      sessionsDeleted.push(sessionId);
      if (deleteSessionCb) {
        await deleteSessionCb(sessionId);
      }
    },
    abortSession: async () => {},
  };

  return { executor, sessionsCreated, sessionsDeleted };
};

// ---------------------------------------------------------------------------
// Shared input helper

// The session rebinds on WORKTREE change (each run/pass has its own worktree, and
// the session cwd is fixed at creation). campaignId still rides along for context
// but no longer drives the session lifecycle.
const makeInput = (worktree: string, campaignId = "campaign-a"): SuperReviewInput => ({
  packet: {
    runId: "20260101-000000-test",
    frontmatter: {
      repo: "/tmp/test",
      base: "main",
      compare_commit: "main",
      outcomes: [],
      expected_surface: [],
      suspicious_surface: [],
      verification: [],
      constraints: [],
      pass: 1,
      promoted: false,
      autofix_commands: [],
      regression_outcomes: [],
    },
    body: "",
    raw: "",
  },
  worktree,
  reportText: "",
  skillText: "rubric",
  pass: 1,
  maxPasses: 3,
  campaignId,
});

const model: ModelConfig = { providerId: "openai", modelId: "gpt-5.5", agent: "superdaddy" };

// ---------------------------------------------------------------------------
// Test: same worktree — session created once (scoped to the worktree), reused

test("reviewer: same worktree reuses session scoped to it", async () => {
  const { executor, sessionsCreated, sessionsDeleted } = makeMockExecutor();
  const reviewer = createReviewer(executor, model, 5000);

  await reviewer.superReview(makeInput("/wt/run-a"));
  await reviewer.superReview(makeInput("/wt/run-a"));
  await reviewer.superReview(makeInput("/wt/run-a"));

  equal(sessionsCreated.length, 1, "session should be created only once for a worktree");
  equal(sessionsCreated[0]!.title, "lathe-superdaddy");
  equal(
    sessionsCreated[0]!.directory,
    "/wt/run-a",
    "session cwd is the run's worktree, not paths.root",
  );
  equal(sessionsDeleted.length, 0, "no sessions deleted while the worktree is unchanged");
});

// ---------------------------------------------------------------------------
// Test: different worktree (next pass/run) — prior session deleted, new one created

test("reviewer: new worktree resets session", async () => {
  const { executor, sessionsCreated, sessionsDeleted } = makeMockExecutor();
  const reviewer = createReviewer(executor, model, 5000);

  await reviewer.superReview(makeInput("/wt/run-a"));
  await reviewer.superReview(makeInput("/wt/run-b"));

  equal(sessionsCreated.length, 2, "new session created when the worktree changes");
  equal(sessionsCreated[1]!.directory, "/wt/run-b", "new session scoped to the new worktree");
  ok(sessionsDeleted.length >= 1, "prior worktree's session was deleted");
});

// ---------------------------------------------------------------------------
// Test: run-a, run-b, run-a — each worktree switch triggers a rebind

test("reviewer: repeated worktree switches rebind each time", async () => {
  const { executor, sessionsCreated, sessionsDeleted } = makeMockExecutor();
  const reviewer = createReviewer(executor, model, 5000);

  await reviewer.superReview(makeInput("/wt/run-1"));
  await reviewer.superReview(makeInput("/wt/run-2"));
  await reviewer.superReview(makeInput("/wt/run-1"));
  await reviewer.superReview(makeInput("/wt/run-3"));

  equal(sessionsCreated.length, 4, "session recreated on every worktree switch");
  equal(sessionsDeleted.length, 3, "prior session deleted on every switch");
});

// ---------------------------------------------------------------------------
// Test: first call with no prior session — no deleteSession(undefined) guard

test("reviewer: first call does not call deleteSession", async () => {
  const { executor, sessionsCreated, sessionsDeleted } = makeMockExecutor();
  const reviewer = createReviewer(executor, model, 5000);

  await reviewer.superReview(makeInput("/wt/run-x"));

  equal(sessionsDeleted.length, 0, "deleteSession not called on first review");
  equal(sessionsCreated.length, 1);
});
