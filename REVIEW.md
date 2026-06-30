# Super-Daddy Review Scope Fix

## Problem

Super-daddy currently reviews the current run/repair packet too narrowly. In a chained campaign, `base` is the execution base for the current packet, often the previous packet tip, not the commit before the whole work item started. That lets earlier defects in the cumulative branch become effectively sealed once a later repair packet passes.

This is a fix to the existing convergence review protocol, not a new feature.

## Checked Facts

- `PacketFrontmatter` has `base`, `campaign_id`, `parent_run_id`, `pass`, `regression_outcomes`, and `promoted`; it does not have a cumulative review base.
- `base` is used as the sandbox execution base.
- Staged chain promotion stamps child `base` from the parent campaign tip or accepted target.
- Super-daddy is not passed a diff. It gets the worktree and is expected to inspect directly.
- `renderSuperReview` currently contains packet-local language, including “judge only what THIS run added or touched” and “pre-existing untested code is not your remit”.
- `renderFollowupAuthoring` currently treats prior outcomes as “sealed, do NOT touch”.
- Follow-up packet frontmatter is not solely model-authored. `stampFollowupLineage` overwrites infra fields such as `repo`, `base`, `campaign_id`, `parent_run_id`, `pass`, `regression_outcomes`, and `promoted`.
- There is no separate campaign-final audit hook today. `convergeRun` marks a campaign `converged` immediately on an `accept` verdict from the same super-daddy pass.

## Required Model

- `base`: execution base for this packet/run.
- `compare_commit`: cumulative review base for the whole work item.
- Everything changed after `compare_commit` is fair game for super-daddy correctness, integration, and test-quality review.
- Prior outcomes are regression obligations, not protected files, during convergence review.
- Net-new wishlist work remains out of scope unless required to fix a grounded defect in the post-`compare_commit` diff.

## Implementation Plan

1. Add `compare_commit` to packet frontmatter.
   - Require `compare_commit: z.string().min(1)` in `PacketFrontmatter`.
   - Keep `base` required.
   - Do not redact `compare_commit`; models need to see it.
   - For synthetic degraded packet construction in convergence fallback paths, use `meta.base` as a fallback value.

2. Enforce it for authored/staged packets.
   - Keep staged packets allowed to omit `base` only.
   - Staged packets must include `compare_commit`.
   - Missing `compare_commit` should reject at admission/parse time.

3. Stamp it for super-daddy follow-up packets.
   - Add `compareCommit` to `FollowupLineage`.
   - Pass `packet.frontmatter.compare_commit` into lineage from `convergeRun`.
   - Have `stampFollowupLineage` stamp `compare_commit` over any model-authored value.
   - Update follow-up authoring prompt so super-daddy does not author `compare_commit`; the engine stamps it with the rest of lineage.

4. Fix super-daddy review prompt scope.
   - Add a review-base section explaining `base` vs `compare_commit`.
   - State that convergence review must inspect the cumulative work after `compare_commit`.
   - Remove or replace packet-local exemptions such as “pre-existing untested code is not your remit”.
   - Keep scope bounded by original intent and doctrine; do not invite unrelated wishlist work.

5. Fix follow-up authoring prompt scope.
   - Replace “sealed, do NOT touch” with “prior outcomes are regression obligations”.
   - Say repair packets may touch any file changed after `compare_commit` when needed to fix a grounded finding.
   - Tell super-daddy to choose `expected_surface` from the real files needed for the fix, not from the parent packet surface.

6. Update packet authoring docs/skills.
   - Packet examples must include both `base` and `compare_commit`.
   - Document that chained packets may have `base` equal to a prior packet tip while `compare_commit` remains the original work-item comparison ref.

7. Update tests.
   - Schema tests: valid packets include `compare_commit`; missing field rejects.
   - Packet parsing tests: valid fixtures include `compare_commit`; redaction preserves it.
   - Staged parsing tests: staged packets require `compare_commit` even when `base` is omitted.
   - Follow-up lineage tests: stamped output includes `compare_commit`; authored values are overwritten.
   - Prompt tests: super-daddy prompt contains cumulative fair-game wording; follow-up authoring no longer says prior files are untouchable.

## Open Design Choice

Current code has no separate final audit stage. Changing `renderSuperReview` makes every convergence review cumulative when `compare_commit` exists. That is the smaller fix and directly addresses the miss, but it may make repair loops more expensive and cause old defects to be repeatedly rediscovered until fixed.

A larger alternative is to add an explicit final campaign audit before marking a campaign `converged`, while keeping repair-loop reviews packet-local. That requires lifecycle changes beyond the prompt/schema fix.

## Risks

- Existing queued/staged packets without `compare_commit` will reject once the schema is enforced.
- Follow-up authoring will fail unless the engine stamps `compare_commit`; prompt-only propagation conflicts with the current lineage-stamping model.
- Cumulative review can broaden repair packets beyond the immediate parent packet surface. That is intended for correctness, but it changes convergence dynamics.
