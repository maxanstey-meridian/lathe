import { equal, match } from "node:assert";
import { test } from "node:test";
import type { Executor, ModelConfig } from "../src/application/ports/executor.js";
import type { TurnResponse } from "../src/domain/agent-response.js";
import type { SuperReviewInput } from "../src/domain/prompts.js";
import { createReviewer } from "../src/infrastructure/opencode/reviewer.js";

const model: ModelConfig = { providerId: "openai", modelId: "gpt-5.5", agent: "superdaddy" };

const ACCEPT_JSON =
  '{"verdict":"accept","findings":[],"convergence":{"recommend_stop":true,"profile":{"p0":0,"p1":0,"p2":0,"p3":0},"rationale":"ok"},"notes":"","human_decision_needed":null}';

const textResponse = (text: string): TurnResponse => ({
  info: { id: "m", sessionID: "s", role: "assistant", modelID: "test" },
  parts: [{ type: "text", text }],
});

// Build an executor whose sendMessage runs a scripted behaviour per attempt and
// counts the calls. listMessages returns [] so harvestReview falls back to the
// sendMessage response text.
const makeExecutor = (
  onSend: (attempt: number) => Promise<TurnResponse>,
): { executor: Executor; sends: () => number } => {
  let sends = 0;
  const executor: Executor = {
    createSession: async () => "session-1",
    sendMessage: async () => {
      const n = sends++;
      return onSend(n);
    },
    listMessages: async () => [],
    deleteSession: async () => {},
    abortSession: async () => {},
  };
  return { executor, sends: () => sends };
};

const input = (): SuperReviewInput => ({
  packet: {
    runId: "20260101-000000-test",
    frontmatter: {
      repo: "/tmp",
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
  worktree: "/wt/run-a",
  reportText: "",
  skillText: "rubric",
  pass: 1,
  maxPasses: 3,
  campaignId: "campaign-a",
});

test("reviewer: a successful call returns a reviewed outcome", async () => {
  const { executor, sends } = makeExecutor(async () => textResponse(ACCEPT_JSON));
  const reviewer = createReviewer(executor, model, 5000);

  const outcome = await reviewer.superReview(input());

  equal(outcome.kind, "reviewed");
  if (outcome.kind === "reviewed") {
    equal(outcome.review.verdict, "accept");
  }
  equal(sends(), 1);
});

test("reviewer: session creation failure returns unreachable", async () => {
  const { executor, sends } = makeExecutor(async () => textResponse(ACCEPT_JSON));
  executor.createSession = async () => {
    throw new Error("session service unavailable");
  };
  const reviewer = createReviewer(executor, model, 5000);

  const review = await reviewer.superReview(input());
  const authoring = await reviewer.authorFollowup({
    worktree: input().worktree,
    packetSkillText: "skill",
    blockers: [],
    priorOutcomes: [],
    pass: 2,
    campaignId: "campaign-a",
  });

  equal(review.kind, "unreachable");
  equal(authoring.kind, "unreachable");
  equal(sends(), 0);
});

test("reviewer: an empty current exchange does not reuse a stale verdict", async () => {
  const old = {
    ...textResponse(ACCEPT_JSON),
    info: { ...textResponse(ACCEPT_JSON).info, id: "old" },
  };
  const current = textResponse("");
  current.info.id = "current";
  let sent = false;
  const executor: Executor = {
    createSession: async () => "session-1",
    sendMessage: async () => {
      sent = true;
      return current;
    },
    listMessages: async () => (sent ? [old, current] : [old]),
    deleteSession: async () => {},
    abortSession: async () => {},
  };
  const reviewer = createReviewer(executor, model, 5000);

  const outcome = await reviewer.superReview(input());

  equal(outcome.kind, "reviewed");
  if (outcome.kind === "reviewed") {
    equal(outcome.review.verdict, "escalate");
  }
});

test("reviewer: a transient drop returns unreachable after one attempt", async () => {
  const { executor, sends } = makeExecutor(async () => {
    throw new Error("socket hang up");
  });
  const reviewer = createReviewer(executor, model, 5000);

  const outcome = await reviewer.superReview(input());

  equal(outcome.kind, "unreachable");
  if (outcome.kind === "unreachable") {
    match(outcome.detail, /Connection dropped: socket hang up/);
  }
  equal(sends(), 1);
});

test("reviewer: a fatal error returns unreachable WITHOUT retrying", async () => {
  const { executor, sends } = makeExecutor(async () => {
    throw new Error("APIError (HTTP 400): bad request");
  });
  const reviewer = createReviewer(executor, model, 5000);

  const outcome = await reviewer.superReview(input());

  equal(outcome.kind, "unreachable");
  equal(sends(), 1, "a fatal error is not retried");
});

test("reviewer: does not hide a transient drop by retrying the turn", async () => {
  const { executor, sends } = makeExecutor(async (attempt) => {
    if (attempt === 0) {
      throw new Error("ECONNRESET");
    }
    return textResponse(ACCEPT_JSON);
  });
  const reviewer = createReviewer(executor, model, 5000);

  const outcome = await reviewer.superReview(input());

  equal(outcome.kind, "unreachable");
  equal(sends(), 1);
});

test("reviewer: a provider error is returned after one attempt", async () => {
  // The provider failure rides on the turn's info.error, not a thrown reject.
  const { executor, sends } = makeExecutor(async () => ({
    info: {
      id: "m",
      sessionID: "s",
      role: "assistant",
      error: { name: "APIError", data: { statusCode: 503, message: "upstream" } },
    },
    parts: [],
  }));
  const reviewer = createReviewer(executor, model, 5000);

  const outcome = await reviewer.superReview(input());

  equal(outcome.kind, "unreachable");
  equal(sends(), 1);
});

test("reviewer: authorFollowup uses the latest assistant reply, not stale history", async () => {
  const latestPacket = `---\nsummary: fresh attempt\noutcomes:\n  - id: fix-a\n    description: fresh\n---\n\n# fresh packet`;
  const { executor } = makeExecutor(async () => textResponse("fallback"));
  let listCall = 0;
  const stale = {
    info: { id: "old", sessionID: "s", role: "assistant", model: "test" as unknown as string },
    parts: [{ type: "text", text: "---\nsummary: stale attempt\n---\n\n# stale packet" }],
  };
  const latest = {
    info: { id: "new", sessionID: "s", role: "assistant", model: "test" as unknown as string },
    parts: [{ type: "text", text: latestPacket }],
  };
  executor.listMessages = async () => (listCall++ === 0 ? [stale] : [stale, latest]);
  const reviewer = createReviewer(executor, model, 5000);

  const outcome = await reviewer.authorFollowup({
    worktree: "/wt",
    packetSkillText: "skill",
    blockers: [],
    priorOutcomes: [],
    pass: 2,
    campaignId: "campaign-a",
    priorProblems: ["frontmatter.summary: Required"],
    priorRawSnippet: "---\nsummary: stale attempt\n---\n\n# stale packet",
  });

  equal(outcome.kind, "authored");
  if (outcome.kind === "authored") {
    equal(outcome.content, latestPacket);
    equal(outcome.content.includes("stale attempt"), false);
  }
});
