# Meridian v3 — architecture spec

Status: **design**. Derived purely from `CONTRACT.v3.md`. This is a clean-room
build, not a refactor of `src/`. The current `src/` is a reference for WHAT must
be true (the invariants and their scars), never a template for HOW to arrange the
code. Baby builds each piece from the contract clause it satisfies, not by copying
an existing file.

The target tier is Max's full Clean Architecture / ports-&-adapters tier (per
CLAUDE.md): plumb has crossed the line that justifies it — convergence, stall
recovery, reorient, and the eleven-branch turn evaluation are real decision logic;
opencode/MCP/git/fs/the gate-plugin are five genuine I/O boundaries; the
liveness + convergence state machine is worth protecting.

---

## 0. Where v3 lives

v3 is built in its **own fresh repo, `lathe`** (`repo: ~/Sites/lathe`, surface
`src/**`). The new code lives under `src/`, with `package.json`/`tsconfig.json` at
the repo root — an ordinary TypeScript package from line one, no nesting, no
cutover dance. The running `meridian` (built from the `plumb` repo) is a separate
codebase, so the live driver safely runs the very packets that build its
successor; when v3 is whole, Max switches over by building/linking `lathe`.

The repo is seeded before the chain runs:

- **`CONTRACT.v3.md`, `ARCHITECTURE.v3.md`** at the root — the specs Baby builds
  FROM (the contract is the source of truth).
- **`reference/`** — a **read-only** snapshot of the v2 implementation
  (`reference/src`, `reference/plugin`, `reference/tests`, plus the v2
  `package.json`/`tsconfig.json`). The packets cite it for the concrete logic and
  the live "scars". It is **outside every packet's `expected_surface`** (so the
  gate flags any edit to it) and **excluded from the build** (`tsconfig` includes
  only `src/**`). It shows WHAT must be true, never HOW to arrange v3.

The gate plugin's own runtime is rebuilt inside `src/` (the infrastructure layer)
so v3 is self-contained; `reference/plugin/` is only a reading aid.

---

## 1. The dependency rule

```
domain  ──depends on──▶  nothing
application  ──▶  domain + its own ports (interfaces only)
infrastructure  ──▶  implements application ports (depends on domain types)
interfaces  ──▶  application only
```

Nothing depends on `infrastructure` directly. The composition root (the CLI entry)
is the only place adapters are constructed and injected into use cases. The gate
**plugin** is its own opencode runtime with its own tsconfig and the single-export
constraint (G7) — it is not part of this dependency graph; it shares only the pure
`domain/gate` logic by copy-free import-of-pure-functions (the plugin file imports
pure helpers, exports only the factory).

```
v3/
  domain/            pure; no fs, no child_process, no sdk, no clock, no env
  application/       use cases + narrow ports
    ports/
  infrastructure/    adapters implementing the ports
  interfaces/        cli + tui (call application only)
  config/            the one validated config boundary
  plugin/            gate plugin runtime (own tsconfig; G7)
```

---

## 2. Doctrine for the shape (how, in Max's idiom)

1. **Pure decision functions, not strategy objects.** Every "baby check" — gate
   trigger, ladder action, stall recovery, reorient bound, convergence decision,
   checkpoint/outcome validation, the turn evaluation itself — is a pure function
   `(facts) → typed decision` (a discriminated union) plus an exhaustive switch at
   the call site. No GoF strategy classes, no polymorphic hierarchy: that is the
   object-ceremony Max's doctrine rejects. The functions ARE the isolation; the
   unions ARE the contract.
2. **The turn decision is pure (the keystone).** Today's tangle is a mutable
   `RunContext` god-bag the bridge writes as a side-effect during `sendMessage`
   (park request, accepted report, final review, rejection problems, checkpoint,
   pending consult, pending final review), read back by an eleven-branch loop doing
   I/O inline. v3 kills the side-channel: the bridge records **typed intents** into
   a per-turn channel the turn loop reads explicitly after the send returns;
   `evaluateTurn(facts) → TurnDecision` is pure and exhaustively unit-tested (the
   tests ARE the encoded branch order, L1); the loop body shrinks to *gather facts →
   evaluate → execute the decision's effect*.
3. **Narrow, one-capability ports.** Each side effect the contract names becomes a
   port with exactly the methods the use cases call — no fat "infrastructure"
   interface. Adapters satisfy them structurally.
4. **A clock seam, lightweight.** `now()` is an injected function on the ports
   bag, not a ceremony interface — so the watchdog (R10), the checkpoint nudge
   (L1/G10), and every `*At` timestamp are testable without sleeping.
5. **Procedural use cases.** The run loop, turn loop, rotation, and convergence
   read top-to-bottom as the lifecycle they own (D1) — pure functions for the
   decisions, ports for the effects, no event-driven state machine outside the gate
   plugin.
6. **Validate at every boundary (D5/D6).** Zod schemas own read AND write; an
   invalid durable read throws; the journal alone tolerates a bad line (J3).

---

## 3. The layers in detail

### 3.1 `domain/` — pure, depends on nothing

Types and pure transforms. No I/O, no clock, no env. Everything here is
unit-testable against literals.

- **`packet`** — `Packet`, `PacketFrontmatter`, `OutcomeDef`, `VerificationCommand`
  types; the pure parse/validate-shape transforms (frontmatter extraction, schema
  parse, kebab/uniqueness checks, runId format, infra redaction K4). The
  *filesystem* checks of K3 (repo exists, base resolves) live in the application
  admission use case — they need a port. (K1–K4, D6)
- **`outcomes`** — ledger types + transitions; `checkpointProblems`,
  `outcomeProblems` (O1/O2/V3). Pure.
- **`gate`** — gate-state type; `globToRegExp`; `gateTriggerReason`,
  `mutationDenyReason`, tool classification (`isEditTool`/`isMutation`/
  `isForbiddenGit`/`isQuestionTool`/`isSubagentTool`), `editTargetOutOfSurface`,
  `rotationGateState`, `checkpointNudgeDue`, `volumeCheckpointReason`,
  `volumeNoticeReason`, `denyMessage` + the fixed deny strings, `classifyChangedFiles`.
  (§10, V6) Pure. **Shared with the plugin** — the plugin imports these and adds only
  the factory (G7).
- **`liveness`** — `stallAction` (park/rotate/nudge, L3), `decideStallRecovery`
  (requeue/escalate/none, R10), the reorient bound check (R11). Pure unions.
- **`turn`** — ★ the keystone. `TurnFacts` (everything observable at turn end:
  bridge intents, gate state, context tokens, progress signal, ladder height,
  rotation-pending, deadline, send-failure count) and `TurnDecision` (a
  discriminated union mirroring §6 L1 exactly: `park | terminal | reject-report |
  run-consult | run-final-review | rotate-teardown | demand-checkpoint |
  demand-teardown | gate-checkpoint | rotate-no-progress | nudge | report-properly |
  continue`). `evaluateTurn(facts): TurnDecision` encodes the first-match-wins
  precedence; the watchdog and send-failure short-circuits are inputs in `facts`.
  Pure, exhaustively tested.
- **`convergence`** — `SuperReview`/`Finding`/`ConvergenceSignal`/`CommitMessage`
  types; `decideConvergence` (the six-branch union, S5); `parseSuperReview`
  (balanced-object, last-valid-wins, fail-closed S11); `renderFollowupPacket`
  (deterministic, fail-closed S8); `assembleCommitMessage`; `renderNits`. Pure.
- **`review`** — `FinalReview`/`PlannerResponse` types; `parseFinalReview`,
  `parsePlannerResponse` (fenced/braces, fail-closed); the accepted-status set.
- **`campaign`** — `Campaign` type; `upsertPass`, `alreadyReviewed`,
  `campaignIdForRun` (S10). Pure folds. Plus the v3 **chain** logic: `promotable`
  (given a converged campaign + its passes, the converged tip branch) and the
  staged-child match. (§19)
- **`prompts`** — the Q-table: every prompt renderer (Q1–Q9, Qreorient, Qp/Qp-fail,
  ladder, soft-nudge, the super-review body, the final-review/planner prompts) as
  pure string functions over durable-state snapshots. (§15)
- **`report`** — `renderReportMarkdown` (V4). Pure.
- **`journal`** — `JournalEvent` discriminated union + the render-to-line function
  for the views. Pure.

### 3.2 `application/` — use cases + ports

Ports (interfaces only, in `application/ports/`), one capability each:

- **`Executor`** — the opencode session host: `createSession`, `sendMessage`,
  `listMessages`, `deleteSession`. The part/text extraction helpers stay pure
  free functions over the response shape (domain), not port methods. (T4, M3, L2)
- **`Planner`** — Daddy: `consult(question) → PlannerResponse`,
  `finalReview(packet, diff, ledger, report) → FinalReview`, plus the session
  handshake. (§9, V7)
- **`Reviewer`** — super-daddy: `superReview(input) → {review, raw}`. (§20)
- **`Repo`** — git: `createSandbox`, `wipCommit`, `amendCommit`, `worktreeIsDirty`,
  `diffStat`, `readDiffStats`, `reviewableDiff(Against)`, `fetchBranchFromClone`,
  `removeSandbox`, `headBranch`, `branchExists`, `mergeAccept`. (R2–R4, V6/V7, X1, §19)
- **`Store`** — durable run state IO: typed read/write of meta, ledger, review-state,
  gate-state, checkpoints, decisions, campaign, active-run, packet freeze, report,
  nits, convergence log; queue list/admit/archive; staged-chain registry. Every
  method validates (D5/D6). (§3)
- **`Clock`** — `now(): number` / `nowIso(): string`. (R10, L1/G10)
- **`Caffeinate`** / process-power — `holdPowerAssertion()`. (T3) (trivial; may fold
  into the run-loop adapter.)

Use cases (procedural, depend on domain + ports):

- **`admit-packet`** — stamp base from HEAD, validate (K3 incl. the port-backed repo/
  base checks), archive on failure. (K3/F3)
- **`run-loop`** — bind the bridge port (the lock, R1), recover orphans (R8) and
  stranded wedges (R10), hold power (T3), drain the queue strictly-sequentially,
  run the convergence step on each finished run, recover stalls (R10), promote
  chained children on convergence (§19), then wait-for-work; ^C lifecycle (X2).
- **`execute-run`** — one run (R2): freeze, sandbox, Daddy handshake (M6), Baby seed
  choice (Q1/Q2/Q8), gate-state init/refresh, the watchdog deadline, the turn loop,
  finalize.
- **`turn-loop`** — gather `TurnFacts` (read bridge intents, gate, tokens, progress)
  → `evaluateTurn` → execute the decision: send, run the deferred consult/final
  review off-MCP (M3/V7), rotate, demand checkpoint/teardown, nudge, park, terminate.
- **`rotation`** — rotate-session (O5/O6): delete + recreate Baby, re-latch gate,
  reseed.
- **`converge-run`** — the convergence orchestration (S1–S11): driver-run
  verification (ground truth), super-daddy review, `decideConvergence`, act
  (stop/author/escalate), campaign ledger, nits, convergence log, commit amend.
- **`answer` / `accept`** — Max's morning use cases (R7, X1).

### 3.3 `infrastructure/` — adapters

- **`opencode/`** — `Executor`, `Planner`, `Reviewer` adapters over the opencode
  SDK + the hermetic-config generation (XDG isolation, agent definitions incl.
  baby/daddy/superdaddy tool sets, the `node_modules` trio seed G9a, version-drift
  warning, `compaction.auto = false`, the plugin path + G9 missing-plugin refusal,
  the http-not-fetch transport for >300s turns, the `thinkingBudget` forwarding).
- **`git/`** — the `Repo` adapter (`child_process`), including the self-rooted-clone
  vs worktree discrimination and the guarded `removeSandbox`.
- **`store/`** — the `Store` adapter over validated file IO (atomic temp+rename
  writes, jsonl append, the path layout §3, the staged-chain registry).
- **`bridge/`** — the MCP server. **Records typed `BridgeIntent`s** into the
  current-run channel, never mutates a shared ctx (the keystone, §2.2). Binding its
  port is the single-driver lock (R1). Houses the five tools (M1) and their
  synchronous validation + persistence (it IS the driver, so it writes through
  `Store` and clears the gate synchronously).
- **`clock/`** — the system clock.

### 3.4 `interfaces/` — CLI + TUI

- **`cli`** — the command surface (X1) and the composition root: construct adapters,
  inject into use cases. `plan/queue/run/status/tail/review/answer/accept/
  super-review/converge` + the v3 `chain add` (§19).
- **`tui/`** — stateless renderers over the files (D4): the Ink `tail` split-pane +
  the plain stream, `status`, `review`. They read through `Store` and the SSE feed;
  they never write run state.

---

## 4. The keystone change, concretely

Today (the tangle to NOT reproduce): `RunContext` carries seven fields the bridge
writes behind the loop's back during `sendMessage` (`parkRequest`,
`acceptedReport`, `finalReview`, `reportRejectionProblems`,
`checkpointWrittenThisTurn`, `pendingConsult`, `pendingFinalReview`), and the loop
is a ~300-line `for(;;)` reading those mutated flags and doing I/O inline.

v3:

1. **The bridge records intents, it doesn't mutate.** Each tool handler appends a
   typed `BridgeIntent` (`park | consult-requested | final-review-requested |
   report-rejected | checkpoint-written | report-accepted | outcomes-updated`) to a
   per-turn channel keyed to the live run. The turn loop reads and drains that
   channel after the send returns. No field is written "behind the loop's back".
2. **`evaluateTurn(facts) → TurnDecision`** is pure: `facts` is the drained intents
   + gate state + context tokens + progress signal + ladder height + rotation-pending
   + deadline + send-failure count. The eleven-branch precedence (§6 L1) lives in this
   one function. Its unit tests are the encoded branch order.
3. **The loop executes the decision.** `sendMessage`, the off-MCP consult/final
   review, `rotate`, the checkpoint/teardown demands, nudges, parks, terminals — the
   only things left in the loop body are the *effects*; the *decisions* are pure.

This is the one change that earns the rebuild; everything else is the contract's
invariants placed in the right layer.

---

## 5. Clause → location map

Every contract clause, mapped to where it lives. (Reads as the build checklist.)

| Clause | Lives in |
|---|---|
| D1 driver = plumbing | `application/*` use cases (procedural); no judgement in domain |
| D2 no compaction; rotation | `infrastructure/opencode` (`compaction.auto=false`); `application/rotation` |
| D3 one writer per fact | only `infrastructure/store` + `infrastructure/bridge` write run state |
| D4 files are the API | `interfaces/tui` + read-only use cases over `Store` |
| D5/D6 fail closed, typed | `domain/*` schemas; `infrastructure/store` validated IO |
| D7 driver assembles structure | `domain/outcomes`+`report`+`prompts`; bridge assembles from `Store` |
| K1–K4 packet + redaction | `domain/packet`; FS checks in `application/admit-packet` via `Repo` |
| K5 plan / producers | `interfaces/cli` (`plan`); admission is the only gate |
| R1 single driver | `infrastructure/bridge` port bind = lock; `application/run-loop` |
| R2 run sequence | `application/execute-run` (uses `Repo.createSandbox`, `Planner`, `Executor`) |
| R3 one WIP commit / amend | `application/execute-run` finalize + `converge-run` (amend) via `Repo` |
| R4 Baby no git | `plugin/` (forbidden git verbs) + `domain/gate` |
| R5 terminal statuses | `domain` `RunStatus`/`BlockedReason`; `application/execute-run` |
| R6 park & move on | `application/run-loop` |
| R7 answer/requeue | `application/answer` use case |
| R8 crash recovery | `application/run-loop` (orphan reclaim) |
| R9 converge finished | `application/run-loop` → `converge-run` |
| R10 liveness/watchdog/stall | `domain/liveness` (`decideStallRecovery`); `application/turn-loop` (watchdog) + `run-loop` (recover/sweep) |
| R11 reorient | `domain/liveness` (bound) + `application/turn-loop` (act) + `Qreorient` |
| L0–L5 turn loop | `domain/turn` (`evaluateTurn`); `application/turn-loop` (effects) |
| L2 progress signal | `domain/turn` consumes facts; `Executor.listMessages` feeds the full-history part collect |
| L3 ladder | `domain/liveness.stallAction` |
| B1–B3 seed & surface | `domain/prompts` (Q1); `infrastructure/opencode` (agent tools); `plugin` |
| O1–O6 ledger & rotation | `domain/outcomes` + `domain/prompts` (Q2/Q5/Q8); `application/rotation`; bridge assembles checkpoint |
| M1–M9 bridge | `infrastructure/bridge` + `domain/review` (parse) + `domain/prompts` |
| G1–G10 gate | `domain/gate` (pure) + `plugin/` (factory only, G7) |
| V1–V7 verification | `application` verify (via a `Verify` capability on `Repo`/`Store`) + `domain/outcomes` + `Planner.finalReview` |
| X1–X5 CLI/TUI | `interfaces/cli` + `interfaces/tui` |
| J1–J3 journal | `domain/journal` + `infrastructure/store` (jsonl, lenient read) |
| C1–C3 config | `config/` (the one validated env-free boundary) |
| §18 S1–S11 convergence | `domain/convergence` (decide/parse/render) + `application/converge-run` + `Reviewer` |
| §19 C1–C4 chaining | `domain/campaign` (promotable/match) + `application/run-loop` (promote) + `Store` (staged registry) + `interfaces/cli` (`chain add`) |

---

## 6. Build order (waves) — drives the packet decomposition

The packets (`§7` of the packet set) follow this order; each wave is a campaign that
the next chains onto.

1. **Wave 0 — chain support (bootstrap).** Modifies the LIVE meridian (`src/`) to add
   `meridian chain add <dir>`, the staged-chain registry, and the
   promote-on-convergence step (§19). Runs off `main`, accepted first, so the
   machinery exists before the v3 build. (This is the only packet that touches `src/`.)
2. **Wave 1 — v3 domain.** The pure core, no I/O: packet/outcomes/gate/liveness/
   turn/convergence/review/campaign/prompts/report/journal + their tests. Buildable
   and testable with zero adapters — the highest-leverage, lowest-risk wave.
3. **Wave 2 — config + ports + store/git adapters.** The validated config boundary,
   the port interfaces, and the two pure-ish adapters (`Store` over fs, `Repo` over
   git) — both unit-testable against temp dirs, as the current tests already prove.
4. **Wave 3 — opencode + bridge adapters.** The `Executor`/`Planner`/`Reviewer`
   adapters and the intent-recording MCP bridge. The first wave that needs a live
   server; verified by a smoke run, not just types.
5. **Wave 4 — application use cases.** admit / run-loop / execute-run / turn-loop /
   rotation / converge-run / answer / accept, wired to the ports.
6. **Wave 5 — interfaces.** CLI composition root + the TUI renderers.
7. **Wave 6 — cutover (Max, manual).** Repoint `bin`/build at `v3/`, retire `src/`.

Each wave's packets carry the previous wave's campaign as `parent_run_id`, so a wave
only begins once the prior wave has CONVERGED (§19 C3). Within a wave, independent
slices (e.g. the domain modules, or the four ports) are separate packets that share
one `parent_run_id` and run in queue order off the same converged base.
