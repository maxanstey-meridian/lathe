import { basename } from "path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type Campaign } from "./campaign.js";
import { PacketFrontmatter, extractFrontmatter } from "./packet.js";
import { type RunMeta } from "./run.js";

// ---------------------------------------------------------------------------
// Inter-campaign chaining (CONTRACT §19). Pure helpers — no I/O.

const RUN_ID_RE = /^\d{8}-\d{6}-[a-z0-9-]+$/;

// A run's branch, derived the same way executeRun derives them — the
// converged tip lives only in its own self-rooted clone until preparation fetches it.
const branchOf = (runId: string): string => `meridian/${runId}`;

// Relaxed schema for staged child frontmatter: base is optional (stamped at
// promotion), everything else is the same as PacketFrontmatter.
const StagedFrontmatter = PacketFrontmatter.extend({ base: z.string().min(1).optional() });

export type StagedInfo = { runId: string; parentRunId: string | undefined; repo: string };

export type StageParse = { ok: true; info: StagedInfo } | { ok: false; problems: string[] };

// Relaxed parse for a staged child (CONTRACT §19): frontmatter must parse and the
// runId must be well-formed, but `base` is optional and no filesystem check runs
// here — full admission (parsePacket) happens at promotion, once base is stamped.
export const parseStaged = (raw: string, fileName: string): StageParse => {
  const fileNameBase = basename(fileName).replace(/\.md$/, "");
  if (!RUN_ID_RE.test(fileNameBase)) {
    return {
      ok: false,
      problems: [`packet filename must be YYYYMMDD-HHMMSS-<slug>.md, got: ${fileName}`],
    };
  }
  const parts = extractFrontmatter(raw);
  if (!parts) {
    return { ok: false, problems: ["no YAML frontmatter block (--- ... ---) at top of packet"] };
  }
  let yamlValue: unknown;
  try {
    yamlValue = parseYaml(parts.yaml);
  } catch (err) {
    return {
      ok: false,
      problems: [
        `frontmatter is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
  const fm = StagedFrontmatter.safeParse(yamlValue);
  if (!fm.success) {
    return {
      ok: false,
      problems: fm.error.issues.map((i) => `frontmatter.${i.path.join(".")}: ${i.message}`),
    };
  }
  return {
    ok: true,
    info: { runId: fileNameBase, parentRunId: fm.data.parent_run_id, repo: fm.data.repo },
  };
};

// The converged tip of a campaign is the run whose pass `accept`ed — the branch
// `lathe prepare` would fetch. An Acceptance Reviewer repair pass can be the tip, so a
// child bases off the LATEST accepted pass, not necessarily parent_run_id itself.
export const convergedTip = (campaign: Campaign): string | undefined =>
  [...campaign.passes].reverse().find((p) => p.verdict === "accept")?.runId;

export type PromotionDecision =
  | { action: "promote-now" } // no parent → admit straight away (base stamped from HEAD)
  | { action: "promote-with-base"; tipRunId: string; base: string } // parent converged → base = tip
  | { action: "hold"; reason: string } // parent needs Max — never build on unblessed work
  | { action: "wait"; reason: string }; // parent not converged yet

// Pure (CONTRACT §19): a staged child + its parent campaign → what to do. No I/O.
export const decidePromotion = (
  parentRunId: string | undefined,
  parentCampaign: Campaign | undefined,
): PromotionDecision => {
  if (!parentRunId) {
    return { action: "promote-now" };
  }
  if (!parentCampaign) {
    return { action: "wait", reason: `parent campaign ${parentRunId} has not started` };
  }
  if (parentCampaign.status === "needs_max") {
    return {
      action: "hold",
      reason: `parent campaign ${parentRunId} is parked for Max (needs_max)`,
    };
  }
  if (parentCampaign.status !== "converged") {
    return { action: "wait", reason: `parent campaign ${parentRunId} is still open` };
  }
  const tip = convergedTip(parentCampaign);
  // Stop condition (CONTRACT §19): a campaign marked converged with no accepted
  // pass is incoherent — hold, never invent a tip, so a stuck chain is visible.
  if (!tip) {
    return {
      action: "hold",
      reason: `parent campaign ${parentRunId} is converged but has no accepted pass`,
    };
  }
  return { action: "promote-with-base", tipRunId: tip, base: branchOf(tip) };
};

// How a staged child actually bases off its converged tip, given the tip's LIVE
// run meta. decidePromotion is pure over the campaign and so can only name the
// tip's nominal branch (meridian/<tip>, legacy prefix); whether that branch still exists depends
// on the tip's status, which is I/O. This refines the decision with that fact:
//
//   - tip NOT yet accepted: the campaign converged but `lathe accept` hasn't run,
//     so the tip's work lives only in its self-rooted clone sandbox. Base off the
//     tip branch and fetch it from the clone first (fetchFromClone = clone path).
//   - tip ALREADY accepted: accept fetched the tip branch into the source repo
//     and destroyed the clone. The meridian branch is preserved in the source repo
//     for manual merge, so base off it and do NOT fetch (fetchFromClone undefined).
//     Fall back to the run's own base for metas predating the acceptedInto field.
//
// This is the fix for the strand: without it, an accepted tip still routes through
// the fetch path, the fetch throws every sweep (branch + clone gone), and the
// child stays staged forever.
export type ChildBase = { base: string; fetchFromClone: string | undefined };

export const childBaseFromTip = (tip: RunMeta): ChildBase =>
  tip.status === "accepted"
    ? { base: tip.acceptedInto ?? tip.base, fetchFromClone: undefined }
    : { base: branchOf(tip.runId), fetchFromClone: tip.worktree };
