import { z } from "zod";
import { FinalReviewVerdict } from "./review.js";

// ---------------------------------------------------------------------------
// Campaign (CONTRACT §18 S10 — a chain of runs converging one original intent)

export const CampaignStatus = z.enum(["open", "converged", "needs_max"]);
export type CampaignStatus = z.infer<typeof CampaignStatus>;

export const CampaignPass = z.object({
  runId: z.string(),
  // A run id can be resumed after Max answers a park. The same run id then
  // represents a fresh execution attempt and must be reviewed again.
  attempt: z.number().int().min(1).default(1),
  pass: z.number().int().min(1),
  verdict: FinalReviewVerdict,
  groundedBlockers: z.number().int(),
  atIso: z.string(),
});
export type CampaignPass = z.infer<typeof CampaignPass>;

export const Campaign = z.object({
  campaignId: z.string(),
  originalRunId: z.string(),
  originalIntent: z.string(),
  status: CampaignStatus,
  maxPasses: z.number().int().min(1),
  passes: z.array(CampaignPass).default([]),
  updatedAt: z.string(),
});
export type Campaign = z.infer<typeof Campaign>;

// ---------------------------------------------------------------------------
// Pure campaign helpers (CONTRACT §18 S10 / §19)
// A first-pass run mints its campaign id from its own runId; a follow-up carries
// the id forward via packet frontmatter (renderFollowupPacket sets campaign_id).

export type PassRecord = CampaignPass;

export type CampaignInit = {
  campaignId: string;
  originalRunId: string;
  originalIntent: string;
  maxPasses: number;
};

export const campaignIdForRun = (
  packet: { frontmatter: { campaign_id?: string } },
  runId: string,
): string => packet.frontmatter.campaign_id ?? runId;

export const alreadyReviewed = (
  campaign: Campaign | undefined,
  runId: string,
  attempt: number,
): boolean => campaign?.passes?.some((p) => p.runId === runId && p.attempt === attempt) ?? false;

// Pure: fold a reviewed pass into the campaign, creating it on the first pass.
// Re-recording the same runId replaces its prior entry, so a re-converge is
// idempotent rather than duplicating the pass.
export const upsertPass = (
  existing: Campaign | undefined,
  init: CampaignInit,
  pass: PassRecord,
  status: CampaignStatus,
): Campaign => {
  const base: Campaign = existing ?? {
    ...init,
    status: "open" as const,
    passes: [],
    updatedAt: pass.atIso,
  };
  return {
    ...base,
    status,
    passes: [...base.passes.filter((p) => p.runId !== pass.runId), pass],
    updatedAt: pass.atIso,
  };
};
