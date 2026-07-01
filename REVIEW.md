# Super-Daddy Review Scope Fix

## Problem

Super-daddy currently reviews the current run/repair packet too narrowly. In a chained campaign, `base` is the execution base for the current packet, often the previous packet tip, not the commit before the whole work item started. That lets earlier defects in the cumulative branch become effectively sealed once a later repair packet passes.

This is a fix to the existing convergence review protocol, not a new feature.

## Checked Facts

- `PacketFrontmatter` has `base`, `campaign_id`, `parent_run_id`, `pass`, `regression_outcomes`, and `promoted`; it does not have a cumulative review base.
- `base` is used as the sandbox execution base.
- Staged chain promotion stamps child `base` from the parent campaign tip or accepted target.
- Super-daddy is not passed a diff. It gets the worktree and is expected to inspect directly.
- `renderSuperReview` currently contains packet-local language, including "judge only what THIS run added or touched" and "pre-existing untested code is not your remit".
- `renderFollowupAuthoring` currently treats prior outcomes as "sealed, do NOT touch".
- Follow-up packet frontmatter is not solely model-authored. `stampFollowupLineage` overwrites infra fields such as `repo`, `base`, `campaign_id`, `parent_run_id`, `pass`, `regression_outcomes`, and `promoted`.
- There is no separate campaign-final audit hook today. `convergeRun` marks a campaign `converged` immediately on an `accept` verdict from the same super-daddy pass.

## Required Model

- `base`: execution base for this packet/run.
- `compare_commit`: cumulative review base for the whole work item.
- Everything changed after `compare_commit` is fair game for super-daddy correctness, integration, and test-quality review.
- Prior outcomes are regression obligations, not protected files, during convergence review.
- Net-new wishlist work remains out of scope unless required to fix a grounded defect in the post-`compare_commit` diff.

## Implementation Plan

### A. Add `compare_commit` field

1. Add `compare_commit: z.string().min(1)` to `PacketFrontmatter` (`domain/packet.ts:26`), right after `base`. Required — author must provide it explicitly. Do NOT add to `INFRA_KEYS_RE` (L78); models need to see it.
2. No changes to `StagedFrontmatter` (`domain/chain.ts:19`). It extends `PacketFrontmatter` and only relaxes `base` to optional. `compare_commit` is inherited as required — staged packets must include it even when `base` is omitted.
3. Add `compareCommit: string` to `FollowupLineage` (`domain/convergence.ts:232-240`).
4. Add `compare_commit: lineage.compareCommit` to the stamped frontmatter in `stampFollowupLineage` (`domain/convergence.ts:298-310`).
5. Add `compareCommit: packet.frontmatter.compare_commit` to the lineage object in `convergeRun` (`converge-run.ts:367-375`).

### B. Remove freeze/snapshot mechanism

The queue directory is the single live source of truth. If a dev Ctrl+C's and edits the packet, they get the edit on resume. No snapshot, no diff detection.

1. **`execute-run.ts:94-124`** — Remove `readFrozenPacket` call. Simplify packet selection to `const raw = queuePacket ?? "";`. Remove `store.freezePacket(runId, packet.raw)`.
2. **`domain/run.ts:162-197`** — Simplify `decideRunStart`: drop `frozenPacket` and `queuePacket` params. Resume decision is just: priorMeta + babySessionId exists? Delete all frozen-vs-queue diff detection (L179-193).
3. **`converge-run.ts:145-178`** — Replace `readFrozenPacket` with `readQueuePacket`. Delete the `if (frozenRaw) {} else {}` split and synthetic degraded packet entirely. Parse queue packet directly; throw if missing.
4. **`interfaces/cli/composition.ts:328`** — Replace `readFrozenPacket` with `readQueuePacket`.
5. **`application/ports/store.ts:99-100`** — Remove `freezePacket` and `readFrozenPacket` from port interface.
6. **`infrastructure/sqlite-store.ts:363-377`** — Delete `freezePacket` and `readFrozenPacket`.
7. **`infrastructure/store.ts:340-350`** — Delete same (legacy store, kept in lockstep).
8. **`config/paths.ts:22,59`** — Remove `packetFile` from interface and default impl (dead after freeze removal).

### C. Prompt changes

1. **`domain/prompts.ts` reviewBody (~L631)** — Add after "Original packet" section:
   ```
   ## Review scope
   Inspect everything changed after `compare_commit` ({fm.compare_commit}). All of it
   is fair game for correctness, integration, and test-quality review.
   ```
2. **`domain/prompts.ts:661-664`** — Delete "Stay in scope: judge only what THIS run added or touched; pre-existing untested code is not your remit."
3. **`domain/prompts.ts:901-910`** — Replace sealed block with just:
   ```
   ## Prior outcomes — regression obligations
   {prior outcome list}
   ```
4. **`domain/prompts.ts:926-930`** — Add `compare_commit` to the "do NOT author" list.
5. **`domain/prompts.ts` `renderFinalReview` (~L752-837)** — Leave alone. Daddy's per-run review IS per-run by design.

### D. Tests

1. Schema/parsing: valid fixtures include `compare_commit`; missing field rejects. Staged packets require `compare_commit` even when `base` omitted.
2. Freeze removal: delete all `store.freezePacket(...)` calls and `readFrozenPacket` assertions. Execute-run tests rely on `readQueuePacket`. Converge-run tests' `readFrozenPacket` mock changes to `readQueuePacket`.
3. Lineage: `stampFollowupLineage` output includes `compare_commit`; authored values overwritten.
4. Prompts: super-review contains `compare_commit` cumulative wording, no "not your remit"; follow-up no "sealed".

### E. Docs/skills (separate PR)

- Packet examples must include both `base` and `compare_commit`.
- For single packets, `compare_commit` is the same as `base`'s parent. For chained campaigns, it stays fixed at the original work-item base while `base` advances to each packet's execution tip.

## What does NOT change

- `readQueuePacket` — already exists, already returns the live queue file.
- `stampBase` — queue-packet stamping, not freeze-related.
- `INFRA_KEYS_RE` — `compare_commit` intentionally excluded (models see it).

## Risks

- Existing queued/staged packets without `compare_commit` will reject once the schema is enforced.
- Freeze removal changes resume semantics: a packet edited mid-run between crash and resume now takes effect. This is intended — the queue dir is live.
- Cumulative review can broaden repair packets beyond the immediate parent packet surface. That is intended for correctness, but it changes convergence dynamics.
