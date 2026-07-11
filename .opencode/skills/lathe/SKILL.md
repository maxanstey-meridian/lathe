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
- Config is loaded from `config.json` inside the state root.
- Structured state lives in SQLite (`lathe.db`): runs (meta, queue, rejected), staged registry, campaigns, decisions, checkpoints, gate state, review state, outcome ledger, convergence log, reports, nits, journal/events, and active run/convergence pointers.
- Only `runs/<runId>/packet.md` (the live editable packet) is file-backed.
- Always inspect the actual state root before making claims.

## Packet Invariants

- A packet is markdown with YAML frontmatter.
- Required frontmatter includes `repo`, `base`, `compare_commit`, `outcomes`, `expected_surface`, and `verification`.
- Run id filenames must match `YYYYMMDD-HHMMSS-<slug>.md`.
- If `base` is absent during admission, Lathe stamps it from the repo's current branch.
- Packet admission validates shape, repo existence, and base branch existence.
- Bad packets are stored in the SQLite `rejected` table; packet files are not silently deleted.
- Models should not own infra lineage fields. The engine stamps lineage for follow-up packets.

### Editing Packet Verification Commands

- The live packet at `runs/<runId>/packet.md` is the single source of truth for a run's packet content. There is no frozen copy or snapshot.
- To change verification commands for a parked/requeued run, edit `runs/<runId>/packet.md` directly.
- On resume, `decideRunStart(priorMeta)` checks for a prior `babySessionId`. If one exists, the run resumes; otherwise it starts fresh. There is no packet-diff comparison.

## Queue Invariants

- The queue is a SQLite query: runs with `status: "queued"` in the runs table. There is no `queue/` directory.
- Requeued runs are existing run rows with `status: "queued"`.
- Queue order is requeued runs first, then fresh runs sorted by run id.
- Admission writes the queued run metadata directly from the validated packet.

## Run Invariants

- Run statuses are `queued`, `running`, `ready_for_review`, `blocked`, `failed`, `accepted`, and `stopped`.
- A run branch is `meridian/<runId>`.
- A run sandbox is a self-rooted local clone, not a git worktree.
- The Executor works inside the sandbox clone.
- The driver owns commits; the Executor's direct git mutation is constrained by the gate/bridge.
- Terminal or parked runs are WIP-committed when appropriate.
- `ready_for_review` means the Executor finished and review/convergence may proceed. It does not mean the work has been fetched or merged.
- `accepted` means the campaign tip was fetched into the source repo and recorded as ready for the Human Operator. It does not mean Lathe merged it.

## Sandbox And Git Invariants

- Sandboxes use real `.git` directories so tools root inside the run clone, not the source repo.
- Clone branches live in the sandbox until fetched into the source repo.
- The Acceptance Reviewer reviews all work after `compare_commit` and authors the permanent commit message. The driver replaces the throwaway WIP message, and `lathe prepare` later fetches the reviewed tip. `accepted` therefore means reviewed work was fetched for the Human Operator, not merged.
- `lathe prepare` is fetch-only: it force-fetches the campaign tip branch into the source repo, removes campaign sandboxes, deletes intermediate branches best-effort, and records `acceptedInto` as the fetched tip branch. `lathe accept` remains a compatibility alias.
- Accept does not merge, run a safety gate, require a clean source working tree, or modify the source working tree. The Human Operator owns final inspection and merge.
- After accept, a child may base from the fetched `acceptedInto` branch because the sandbox and intermediate run branches may be gone.

## Campaign Invariants

- A campaign is a chain of convergence passes for one original intent.
- Campaign statuses are `open`, `converged`, and `needs_max`.
- A first-pass run mints its campaign id from its own run id unless `campaign_id` is present.
- A campaign pass records `runId`, `pass`, final review verdict, grounded blocker count, and timestamp.
- Recording the same run id replaces the prior pass, making re-converge idempotent.
- A campaign is only safely converged when it has a pass with verdict `accept`.

## Convergence Invariants

- Convergence is separate from accept.
- The Acceptance Reviewer reviews a finished run after driver verification and after the Implementation Reviewer has accepted the run.
- Clean path is: the Executor submits `ready_for_review`, verification is green, the Implementation Reviewer accepts the delivered run, the Acceptance Reviewer accepts the cumulative campaign diff and authors its permanent commit message, the driver applies that message, the campaign becomes `converged`, the run remains `ready_for_review`, then the Human Operator uses `lathe prepare` to fetch the tip and may merge it manually.
- `accept` verdict plus red verification escalates instead of converging.
- `request_changes` authors a follow-up packet when below the cap and findings exist.
- At the cap, Lathe may spend one promoted repair pass on the stronger model before escalating.
- `escalate` or a human decision need parks the campaign/run for the Human Operator.
- Acceptance Reviewer transport failure is not a verdict and must not be recorded as a campaign pass.

## Staged Chain Invariants

- Staged child packets live in the SQLite `staged` table (no `staged/` directory).
- Staged packets may omit `base`; promotion stamps it.
- A child without `parent_run_id` promotes immediately.
- A child with a parent waits for the parent campaign to converge.
- If the parent campaign needs the Human Operator, the child is held.
- If a parent campaign is marked converged but has no accepted pass, hold rather than inventing a base.
- If the parent tip is not yet accepted, fetch/base from the tip run's sandbox branch.
- If the parent tip is already accepted, base from `acceptedInto` and do not fetch from the deleted sandbox.

## Bridge And Responsibility Invariants

- The Executor implements the packet in the sandbox and reports evidence; it does not own architecture, acceptance, or git lifecycle decisions.
- The Planner answers scoped implementation and architecture questions and gates the first-edit approach.
- The Implementation Reviewer uses the same runtime session/configuration as the Planner but has a distinct responsibility: after mechanical verification, it checks that each outcome is delivered and the run is sane.
- The Acceptance Reviewer independently reviews the cumulative work item after `compare_commit`, decides convergence, authors the permanent commit message, and may author a follow-up packet. The driver owns the corresponding git mutation.
- The Human Operator supplies product/policy decisions, handles escalations, chooses whether to fetch an accepted tip, inspects it, and owns the manual merge.
- Legacy runtime/config names map `baby` to Executor, `daddy` to the shared Planner/Implementation Reviewer session, `superdaddy` to Acceptance Reviewer, and `Max` to Human Operator. Preserve those names only where required by the current wire format, config schema, state path, branch prefix, or MCP namespace.
- The bridge exposes `meridian-bridge_ask_planner`, `meridian-bridge_update_outcomes`, `meridian-bridge_write_checkpoint`, `meridian-bridge_submit_report`, `meridian-bridge_get_decisions`, `meridian-bridge_write_handoff`, and `meridian-bridge_verify_handoff`.
- Bridge tool calls record typed intents; the turn loop evaluates those intents.
- `meridian-bridge_submit_report` is the only Executor path to a terminal run status.
- Accepted Planner decisions can clear the gate synchronously.

## Daemon/API Invariants

- The daemon does not replace the lifecycle.
- HTTP handlers delegate to `Supervisor`.
- `Supervisor` delegates to existing use cases such as admission, staged promotion, run driver, and accept.
- SSE/event streaming is an observation surface over journals/events, not the state machine.
- CLI commands `enqueue`, `chain add`, `cancel`, `resolve`, `prepare`, `request-changes`, `status`, `review`, `queue`, `plan`, `get`, and `tail` go through the daemon over HTTP. Legacy names `stop`, `answer`, `accept`, and `reject` remain compatibility aliases. The daemon is the single owner of run state. The exception is `lathe db`, which reads `lathe.db` directly (read-only, daemon-independent) for debugging.
- `lathe serve` starts the daemon with host/port config, single-instance lock, Hono request listener, and graceful shutdown.
- The Human Operator's interactive shell defines `lathe()` in `~/.zshrc` as `tsx /Users/max/Sites/lathe/apps/lathe-cli/src/index.ts "$@"`. Non-interactive agent shells do not source that function; use `pnpm exec tsx apps/lathe-cli/src/index.ts <args>` from the Lathe repo root.

### Re-running convergence manually

- `lathe converge <runId>` is not a CLI command.
- To re-run Acceptance Reviewer convergence, invoke the use case directly from the Lathe repo root:
  ```
  pnpm --filter @lathe/core exec tsx -e "import {createConvergeRun} from './src/application/use-cases/converge-run.ts'; ..."
  ```
  or write a small script against the `Store` port. Inspect `converge-run.ts` for the exact entry signature.
- This is needed when the Acceptance Reviewer failed to author a follow-up packet (e.g. `stampFollowupLineage` parsing error) and parked the run for `human_decision`. Re-converging gives it another attempt at authoring valid frontmatter.

## Store Invariants

- `SqliteStoreAdapter` is the sole `Store` implementation. The file-based store has been removed.
- The live packet (`runs/<runId>/packet.md`) remains file-backed. Everything else — meta, queue, rejected, staged, campaigns, decisions, checkpoints, gate state, review state, outcome ledger, convergence log, reports, nits, journal/events, and active pointers — is in `lathe.db`.
- The daemon is the single owner of run state. CLI commands proxy to it over HTTP.

### `lathe db` — direct SQLite inspector

- `lathe db` opens `lathe.db` directly in read-only mode (WAL = safe concurrent reads). It does NOT go through the daemon. This is deliberate: when the daemon is broken, you still need to inspect state.
- Subcommands that take `[runId]` default to the active run when omitted.
- Subcommands: `run`, `events`, `gate`, `decisions`, `convergence`, `campaign`, `queue`, `active`, `query <sql>`.
- `--json` on any subcommand for raw JSON output.
- Implementation: `apps/lathe-cli/src/db.ts`.

## Inspection Checklist

- Check branch with `git status --short --branch`.
- Check config/state root in `packages/core/src/config/config.ts`, `packages/core/src/config/schemas.ts`, and `packages/core/src/config/paths.ts`.
- Check packet rules in `packages/core/src/domain/packet.ts`.
- Check run meta/status in `packages/core/src/domain/run.ts`.
- Check campaign ledger in `packages/core/src/domain/campaign.ts`.
- Check staged chain rules in `packages/core/src/domain/chain.ts` and `packages/core/src/application/use-cases/chain-promotion.ts`.
- Check queue/store behavior in `packages/core/src/infrastructure/sqlite-store.ts` and `packages/core/src/application/ports/store.ts`.
- Check run loop in `packages/core/src/application/use-cases/run-loop.ts`.
- Check run execution in `packages/core/src/application/use-cases/execute-run.ts`.
- Check convergence in `packages/core/src/application/use-cases/converge-run.ts` and `packages/core/src/domain/convergence.ts`.
- Check accept semantics in `packages/core/src/application/use-cases/accept-run.ts`.
- Check git sandbox behavior in `packages/core/src/infrastructure/git.ts`.
- Check daemon/API surface in `apps/lathe-server/src/app.ts`, `apps/lathe-server/src/supervisor.ts`, and `apps/lathe-cli/src/serve.ts`.

## Never Infer

- Do not infer active base from the current checkout branch.
- Do not infer campaign convergence from run status alone.
- Do not infer fetch or merge from `ready_for_review`, and do not infer merge from `accepted`.
- Do not infer child packet readiness from the presence of a staged file.
- Do not infer daemon behavior from packet intent; inspect the branch.
- Do not manually move staged packets into queue unless reproducing `promoteStaged` semantics.
- Do not mark a run/campaign accepted without preserving the convergence and accept invariants.
