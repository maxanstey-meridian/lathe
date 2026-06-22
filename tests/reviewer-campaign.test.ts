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
      info: { role: "assistant" as const, sessionId: "test", model: "test" as const },
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
  };

  return { executor, sessionsCreated, sessionsDeleted };
};

// ---------------------------------------------------------------------------
// Shared input helper

const makeInput = (campaignId: string): SuperReviewInput => ({
  packet: {
    runId: "20260101-000000-test",
    frontmatter: {
      repo: "/tmp/test",
      base: "main",
      outcomes: [],
      expected_surface: [],
      suspicious_surface: [],
      verification: [],
      constraints: [],
      pass: 1,
      regression_outcomes: [],
    },
    body: "",
    raw: "",
  },
  diff: "diff",
  reportText: "",
  skillText: "rubric",
  pass: 1,
  maxPasses: 3,
  campaignId,
});

const model: ModelConfig = { providerId: "openai", modelId: "gpt-5.5", agent: "superdaddy" };

// ---------------------------------------------------------------------------
// Test: same campaign — session created once, reused across calls

test("reviewer: same campaign reuses session", async () => {
  const { executor, sessionsCreated, sessionsDeleted } = makeMockExecutor();
  const reviewer = createReviewer(executor, model, 5000, "/tmp/root");

  await reviewer.superReview(makeInput("campaign-a"));
  await reviewer.superReview(makeInput("campaign-a"));
  await reviewer.superReview(makeInput("campaign-a"));

  equal(sessionsCreated.length, 1, "session should be created only once within a campaign");
  equal(sessionsCreated[0].title, "meridian-superdaddy");
  equal(sessionsCreated[0].directory, "/tmp/root");
  equal(sessionsDeleted.length, 0, "no sessions deleted within same campaign");
});

// ---------------------------------------------------------------------------
// Test: different campaign — prior session deleted, new one created

test("reviewer: cross-campaign resets session", async () => {
  const { executor, sessionsCreated, sessionsDeleted } = makeMockExecutor();
  const reviewer = createReviewer(executor, model, 5000, "/tmp/root");

  await reviewer.superReview(makeInput("campaign-a"));
  const sessionAId = sessionsCreated[0].title; // We can't get the actual ID from makeMockExecutor
  // Actually the session ID is returned from createSession. Let's verify deletion happened.

  await reviewer.superReview(makeInput("campaign-b"));

  equal(sessionsCreated.length, 2, "new session created after campaign change");
  ok(sessionsCreated[1].title === sessionsCreated[0].title, "both sessions share the same title");
  ok(sessionsDeleted.length >= 1, "prior campaign session was deleted");
});

// ---------------------------------------------------------------------------
// Test: campaign-a, campaign-b, campaign-a — each switch triggers rebind

test("reviewer: repeated campaign switches rebid each time", async () => {
  const { executor, sessionsCreated, sessionsDeleted } = makeMockExecutor();
  const reviewer = createReviewer(executor, model, 5000, "/tmp/root");

  await reviewer.superReview(makeInput("camp-1"));
  await reviewer.superReview(makeInput("camp-2"));
  await reviewer.superReview(makeInput("camp-1"));
  await reviewer.superReview(makeInput("camp-3"));

  equal(sessionsCreated.length, 4, "session recreated on every campaign switch");
  equal(sessionsDeleted.length, 3, "prior session deleted on every switch");
});

// ---------------------------------------------------------------------------
// Test: first call with no prior session — no deleteSession(undefined) guard

test("reviewer: first call does not call deleteSession", async () => {
  const { executor, sessionsCreated, sessionsDeleted } = makeMockExecutor();
  const reviewer = createReviewer(executor, model, 5000, "/tmp/root");

  await reviewer.superReview(makeInput("camp-x"));

  equal(sessionsDeleted.length, 0, "deleteSession not called on first review");
  equal(sessionsCreated.length, 1);
});
