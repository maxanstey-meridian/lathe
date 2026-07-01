---
name: lathe
description: Use when reasoning about Lathe packet admission, queue/run/campaign lifecycle, convergence, accept, staged chains, daemon/API surfaces, or persisted state invariants.
---

# Lathe Invariants And Lifecycle Map

Use this skill when reasoning about Lathe's packet/run/campaign lifecycle. Do not infer lifecycle state from the CLI, daemon, current branch name, or packet intent alone. Inspect the persisted state and the implementation files first.

## Core Rule

Lathe's lifecycle is owned by domain/application use cases and persisted state. CLI, daemon, HTTP API, and SSE are transport/host surfaces over that lifecycle.

## State Root

- Default state root is `~/.meridian/v3`.
- Config is loaded from the default state root first, then `stateRoot` inside config relocates paths.
- Important directories are `queue/`, `rejected/`, `staged/`, `runs/`, and `campaigns/`.
- Important run files are `packet.md`, `meta.json`, `journal.jsonl`, `decisions.jsonl`, `outcomes.json`, `gate-state.json`, `review-state.json`, `checkpoints/`, `report.md`, `nits.md`, `convergence.jsonl`, and `handoff.json`.
- Root-level pointers `active-run.json` and `active-convergence.json` mark the in-flight run/convergence (driver-written, plugin-read).
- Always inspect the actual state root before making claims.

## Packet Invariants

- A packet is markdown with YAML frontmatter.
- Required frontmatter includes `repo`, `base`, `outcomes`, `expected_surface`, and `verification`.
- Run id filenames must match `YYYYMMDD-HHMMSS-<slug>.md`.
- If `base` is absent during admission, Lathe stamps it from the repo's current branch.
- Packet admission validates shape, repo existence, and base branch existence.
- Bad packets are archived to `rejected/`; packet files are not silently deleted.
- Models should not own infra lineage fields. The engine stamps lineage for follow-up packets.

### Editing Packet Verification Commands

- A run's frozen packet lives at `runs/<runId>/packet.md`.
- The queue packet lives at `queue/<runId>.md`.
- On resume, `decideRunStart` compares the queue packet against the frozen packet. If they differ, the run is treated as fresh and `store.freezePacket` **overwrites** the frozen packet from the queue copy.
- **To change verification commands for a parked/requeued run, you must edit BOTH the queue packet and the frozen packet.** Editing only the frozen packet will be silently reverted on the next resume.
- Both `StoreAdapter` and `SqliteStoreAdapter` read/write the frozen packet from the same file path (`paths.packetFile(runId)` = `runs/<runId>/packet.md`). There is no separate SQLite blob for packet content.

## Queue Invariants

- Fresh packets live in `queue/`.
- Requeued runs are represented by existing run meta with `status: "queued"`.
- Queue order is requeued runs first, then fresh packet files sorted lexically.
- A fresh queued packet may not have `meta.json` yet.
- `initMetaFromQueue` derives initial run meta from the queued packet.

## Run Invariants

- Run statuses are `queued`, `running`, `interrupted`, `ready_for_review`, `blocked`, `failed`, `accepted`, and `aborted`.
- A run branch is `meridian/<runId>`.
- A run sandbox is a self-rooted local clone, not a git worktree.
- Baby works inside the sandbox clone.
- The driver owns commits; Baby's direct git mutation is constrained by the gate/bridge.
- Terminal or parked runs are WIP-committed when appropriate.
- `ready_for_review` means Baby finished and convergence may review it. It does not mean the work has been merged.
- `accepted` means guarded accept merged the run branch and recorded where it landed.

## Sandbox And Git Invariants

- Sandboxes use real `.git` directories so tools root inside the run clone, not the source repo.
- Clone branches live in the sandbox until fetched into the source repo.
- Accept fetches the run branch from the clone when needed, merges it into the target branch, deletes the run branch, removes the sandbox, and records `acceptedInto`.
- Source repo must be clean and checked out to the target branch before accept.
- Do not invent or assume the accept target. It is explicit or defaults to the run meta `base`.
- After accept, a child must base from `acceptedInto` because the sandbox and nominal run branch may be gone.

## Campaign Invariants

- A campaign is a chain of convergence passes for one original intent.
- Campaign statuses are `open`, `converged`, and `needs_max`.
- A first-pass run mints its campaign id from its own run id unless `campaign_id` is present.
- A campaign pass records `runId`, `pass`, final review verdict, grounded blocker count, and timestamp.
- Recording the same run id replaces the prior pass, making re-converge idempotent.
- A campaign is only safely converged when it has a pass with verdict `accept`.

## Convergence Invariants

- Convergence is separate from accept.
- Super-daddy reviews a finished run after driver verification.
- Clean path is: Baby submits `ready_for_review`, verification is green, super-daddy verdict is `accept`, campaign becomes `converged`, run remains `ready_for_review`, then accept later merges it.
- `accept` verdict plus red verification escalates instead of converging.
- `request_changes` authors a follow-up packet when below the cap and findings exist.
- At the cap, Lathe may spend one promoted repair pass on the stronger model before escalating.
- `escalate` or human decision need parks the campaign/run for Max.
- Super-daddy transport failure is not a verdict and must not be recorded as a campaign pass.

## Staged Chain Invariants

- Staged child packets live in `staged/`.
- Staged packets may omit `base`; promotion stamps it.
- A child without `parent_run_id` promotes immediately.
- A child with a parent waits for the parent campaign to converge.
- If the parent campaign needs Max, the child is held.
- If a parent campaign is marked converged but has no accepted pass, hold rather than inventing a base.
- If the parent tip is not yet accepted, fetch/base from the tip run's sandbox branch.
- If the parent tip is already accepted, base from `acceptedInto` and do not fetch from the deleted sandbox.

## Bridge And Agent Role Invariants

- Baby executes the work in the sandbox.
- Daddy is the planner/reviewer session for the run.
- Super-daddy is the convergence reviewer and follow-up packet author.
- Max is the human escalation point.
- The bridge exposes tools like `ask_planner`, `update_outcomes`, `write_checkpoint`, `submit_report`, `get_decisions`, `write_handoff`, and `verify_handoff`.
- Bridge tool calls record typed intents; the turn loop evaluates those intents.
- `submit_report` is the only Baby path to a terminal run status.
- Accepted Daddy decisions can clear the gate synchronously.

## Daemon/API Invariants

- The daemon does not replace the lifecycle.
- HTTP handlers delegate to `Supervisor`.
- `Supervisor` delegates to existing use cases such as admission, staged promotion, run driver, and accept.
- SSE/event streaming is an observation surface over journals/events, not the state machine.
- On current `main`, `apps/lathe-cli` only wires `serve`; run-driving commands still live through core CLI until cutover.
- On accepted daemon-cutover branches, `lathe serve` may add host/port config, single-instance lock, Hono request listener, and graceful shutdown.
- Treat exact command surface, DTO names, lock behavior, and daemon config as branch-sensitive.

### Re-running convergence manually

- `lathe converge <runId>` does **not** exist in the daemon CLI (`apps/lathe-cli`).
- To re-run super-daddy convergence on a parked/blocked run, invoke the core CLI directly from the Lathe repo root:
  ```
  pnpm --filter @lathe/core exec tsx src/interfaces/cli/index.ts converge <runId>
  ```
- This is needed when super-daddy failed to author a follow-up packet (e.g. `stampFollowupLineage` parsing error) and parked the run for human_decision. Re-converging gives it another attempt at authoring valid frontmatter.

## Store Invariants

- File store is the baseline durable state adapter.
- SQLite store implements the same `Store` port.
- In the inspected SQLite adapter, queue packets, the staged registry, checkpoints, and markdown blobs (`report.md`, `nits.md`, frozen `packet.md`) remain file-backed — only structured state moves into the DB.
- Do not assume SQLite means every state artifact moved into the DB.
- Store parity matters because daemon/API paths and CLI paths must observe the same lifecycle.

## Inspection Checklist

- Check branch with `git status --short --branch`.
- Check config/state root in `packages/core/src/config/config.ts`, `packages/core/src/config/schemas.ts`, and `packages/core/src/config/paths.ts`.
- Check packet rules in `packages/core/src/domain/packet.ts`.
- Check run meta/status in `packages/core/src/domain/run.ts`.
- Check campaign ledger in `packages/core/src/domain/campaign.ts`.
- Check staged chain rules in `packages/core/src/domain/chain.ts` and `packages/core/src/application/use-cases/chain-promotion.ts`.
- Check queue/store behavior in `packages/core/src/infrastructure/store.ts` and `packages/core/src/infrastructure/sqlite-store.ts`.
- Check run loop in `packages/core/src/application/use-cases/run-loop.ts`.
- Check run execution in `packages/core/src/application/use-cases/execute-run.ts`.
- Check convergence in `packages/core/src/application/use-cases/converge-run.ts` and `packages/core/src/domain/convergence.ts`.
- Check accept semantics in `packages/core/src/application/use-cases/accept-run.ts`.
- Check git sandbox behavior in `packages/core/src/infrastructure/git.ts`.
- Check daemon/API surface in `apps/lathe-server/src/app.ts`, `apps/lathe-server/src/supervisor.ts`, and `apps/lathe-cli/src/serve.ts`.

## Never Infer

- Do not infer active base from the current checkout branch.
- Do not infer campaign convergence from run status alone.
- Do not infer accept/merge from `ready_for_review`.
- Do not infer child packet readiness from the presence of a staged file.
- Do not infer daemon behavior from packet intent; inspect the branch.
- Do not manually move staged packets into queue unless reproducing `promoteStaged` semantics.
- Do not mark a run/campaign accepted without preserving the convergence and accept invariants.
