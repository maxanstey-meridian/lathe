/**
 * Maps domain RunMeta → wire RunSummaryDto / RunDetailDto.
 *
 * Constraints:
 * - status: exhaustive domain→wire switch, no silent default.
 * - isChainTip: supplied by the handler via supervisor.isChainTip() — RunMeta
 *   has no parentRunId field.
 * - campaignId, turn, contextTokens, parentRunId, expectedSurface, lastVerdict:
 *   NO source in RunMeta. Uses transparent placeholders ("" / 0 / null) and
 *   must be reported as contract gaps — never a value implying real data.
 * - contextWindow: supplied via supervisor.config.baby.contextWindow.
 */
import type { RunMeta } from "@lathe/core";
import type { RunDetailDto, RunStatus, RunSummaryDto } from "@lathe/contract";

// ---------------------------------------------------------------------------
// Domain → Wire status mapping (exhaustive)
// ---------------------------------------------------------------------------

const DOMAIN_TO_WIRE: Record<RunMeta["status"], RunStatus> = {
  queued: "queued",
  running: "running",
  interrupted: "paused",
  ready_for_review: "converged",
  blocked: "paused",
  failed: "failed",
  accepted: "accepted",
  aborted: "aborted",
} as const satisfies Record<RunMeta["status"], RunStatus>;

/**
 * Map domain status → wire RunStatus. Exhaustive — every domain state
 * has a wire case, no fallthrough default.
 *
 * Note: both `interrupted` and `blocked` map to `"paused"` (recoverable
 * state). Multiple domain states share one wire value; the wire union
 * has no unreachable values.
 */
export const mapStatus = (domain: RunMeta["status"]): RunStatus =>
  DOMAIN_TO_WIRE[domain];

// ---------------------------------------------------------------------------
// DTO mappers
// ---------------------------------------------------------------------------

export interface RunDtoCtx {
  isChainTip: boolean;
  contextWindow: number;
  lastVerdict: string | null;
  outcomes: string;
}

/**
 * Map a domain RunMeta + runtime context → wire RunSummaryDto.
 */
export const runToSummary = (
  meta: RunMeta,
  ctx: RunDtoCtx,
): RunSummaryDto => ({
  runId: meta.runId,
  campaignId: "", // GAP: RunMeta has no campaignId
  packet: meta.runId, // fallback: runId is the slug when packet field absent
  status: mapStatus(meta.status),
  pass: meta.attempt,
  turn: 0, // GAP: RunMeta has no turn field
  contextTokens: 0, // GAP: RunMeta has no contextTokens field
  contextWindow: ctx.contextWindow,
  isChainTip: ctx.isChainTip,
  startedAt: meta.startedAt ?? "",
  updatedAt: meta.updatedAt,
});

/**
 * Map a domain RunMeta + runtime context → wire RunDetailDto.
 */
export const runToDetail = (
  meta: RunMeta,
  ctx: RunDtoCtx,
): RunDetailDto => ({
  ...runToSummary(meta, ctx),
  base: meta.base,
  branch: meta.branch,
  worktreePath: meta.worktree,
  parentRunId: null, // GAP: RunMeta has no parentRunId field
  expectedSurface: [], // GAP: RunMeta has no expectedSurface field
  lastVerdict: ctx.lastVerdict,
  outcomes: ctx.outcomes,
  blockedReason: meta.blockedReason ?? null,
  blockedQuestion: meta.blockedQuestion ?? null,
});
