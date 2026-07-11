import { z } from "zod";

const RunStartupOperationBase = {
  runId: z.string().min(1),
  attempt: z.number().int().positive(),
  updatedAt: z.string(),
};
export const RunStartupOperation = z.discriminatedUnion("phase", [
  z.object({
    ...RunStartupOperationBase,
    phase: z.enum([
      "claimed",
      "state_initialized",
      "sandbox_ready",
      "setup_started",
      "setup_completed",
      "planner_session_started",
    ]),
  }),
  z.object({
    ...RunStartupOperationBase,
    phase: z.literal("planner_session_created"),
    plannerSessionId: z.string().min(1),
  }),
  z.object({
    ...RunStartupOperationBase,
    phase: z.literal("executor_session_started"),
    plannerSessionId: z.string().min(1),
  }),
  z.object({
    ...RunStartupOperationBase,
    phase: z.enum(["executor_session_created", "active"]),
    plannerSessionId: z.string().min(1),
    executorSessionId: z.string().min(1),
  }),
]);
export type RunStartupOperation = z.infer<typeof RunStartupOperation>;

export const AcceptanceMember = z.object({
  runId: z.string().min(1),
  revision: z.number().int().min(0),
  status: z.enum(["ready_for_review", "accepted"]),
  repo: z.string(),
  branch: z.string(),
  worktree: z.string(),
  base: z.string(),
  pass: z.number().int().positive(),
});
export type AcceptanceMember = z.infer<typeof AcceptanceMember>;

export const AcceptanceOperation = z
  .object({
    campaignId: z.string().min(1),
    phase: z.enum(["prepared", "fetched", "accepted", "cleaned"]),
    tipRunId: z.string().min(1),
    acceptedInto: z.string().min(1),
    expectedTipSha: z.string().min(1),
    members: z.array(AcceptanceMember).min(1),
    cleanedSandboxes: z.array(z.string()).default([]),
    cleanedBranches: z.array(z.string()).default([]),
    updatedAt: z.string(),
  })
  .superRefine((operation, context) => {
    const runIds = operation.members.map((member) => member.runId);
    if (new Set(runIds).size !== runIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["members"],
        message: "members must have unique run ids",
      });
    }
    if (runIds.filter((runId) => runId === operation.tipRunId).length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tipRunId"],
        message: "tip must be present exactly once",
      });
    }
    if (new Set(operation.members.map((member) => member.repo)).size !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["members"],
        message: "members must belong to one repository",
      });
    }
    for (const [field, cleaned, allowTip] of [
      ["cleanedSandboxes", operation.cleanedSandboxes, true],
      ["cleanedBranches", operation.cleanedBranches, false],
    ] as const) {
      if (new Set(cleaned).size !== cleaned.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must be unique`,
        });
      }
      if (cleaned.some((runId) => !runIds.includes(runId))) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} must contain only members`,
        });
      }
      if (!allowTip && cleaned.includes(operation.tipRunId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: "cleanedBranches must exclude the tip branch",
        });
      }
    }
  });
export type AcceptanceOperation = z.infer<typeof AcceptanceOperation>;
