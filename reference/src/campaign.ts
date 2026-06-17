// Campaign state (SUPER-DADDY §10): the chain of runs converging one original
// intent. Lives at ~/.meridian/v2/campaigns/<campaignId>/campaign.json. The
// orchestrator (converge.ts) is the only writer; `meridian status` reads it.
//
// The campaign ledger — NOT run status — is what makes the convergence trigger
// fire once per run (§11/§12, resolved): a run recorded here as a reviewed pass
// is never re-reviewed. That keeps a converged run on `ready_for_review` so Max
// can still `meridian accept` (merge) it, instead of falsely marking it accepted.

import { mkdirSync, writeFileSync, readdirSync, existsSync } from "fs"
import { Campaign, type CampaignStatus, type FinalReviewVerdict, type Packet } from "./schemas.js"
import { readValidatedIfExists } from "./fsio.js"
import type { Paths } from "./paths.js"

// A first-pass run mints its campaign id from its own runId; a follow-up carries
// the id forward via packet frontmatter (renderFollowupPacket sets campaign_id).
export const campaignIdForRun = (packet: Packet, runId: string): string =>
  packet.frontmatter.campaign_id ?? runId

export const readCampaign = (paths: Paths, campaignId: string): Campaign | undefined =>
  readValidatedIfExists(paths.campaignFile(campaignId), Campaign)

export const writeCampaign = (paths: Paths, campaign: Campaign): void => {
  mkdirSync(paths.campaignDir(campaign.campaignId), { recursive: true })
  writeFileSync(paths.campaignFile(campaign.campaignId), JSON.stringify(campaign, null, 2), "utf-8")
}

export const alreadyReviewed = (campaign: Campaign | undefined, runId: string): boolean =>
  campaign?.passes.some((p) => p.runId === runId) ?? false

// Every campaign on disk, lexical by id — what `meridian status` reads to show
// the convergence picture. A directory whose campaign.json is missing or invalid
// is skipped rather than throwing (a half-written dir mid-write, say).
export const listCampaigns = (paths: Paths): Campaign[] =>
  existsSync(paths.campaignsDir)
    ? readdirSync(paths.campaignsDir)
        .sort()
        .flatMap((id) => {
          const c = readCampaign(paths, id)
          return c ? [c] : []
        })
    : []

export type PassRecord = {
  runId: string
  pass: number
  verdict: FinalReviewVerdict
  groundedBlockers: number
  atIso: string
}

export type CampaignInit = {
  campaignId: string
  originalRunId: string
  originalIntent: string
  maxPasses: number
}

// Pure: fold a reviewed pass into the campaign, creating it on the first pass.
// Re-recording the same runId replaces its prior entry, so a re-converge is
// idempotent rather than duplicating the pass.
export const upsertPass = (
  existing: Campaign | undefined,
  init: CampaignInit,
  pass: PassRecord,
  status: CampaignStatus,
): Campaign => {
  const base: Campaign = existing ?? { ...init, status: "open", passes: [], updatedAt: pass.atIso }
  return {
    ...base,
    status,
    passes: [...base.passes.filter((p) => p.runId !== pass.runId), pass],
    updatedAt: pass.atIso,
  }
}
