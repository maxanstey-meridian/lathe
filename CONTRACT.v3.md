# Meridian — golden harness contract

Golden draft, extracted from the implementation as it stands on **2026-06-17**
(`src/**`, `plugin/**`, `tests/core.test.mjs`). This is the authoritative
behavioural spec the v3 rebuild is built from. It supersedes `CONTRACT.md`
(draft 2, 2026-06-15): where draft 2 and the code disagree, **the code is ground
truth** and this document follows the code. Every such disagreement is flagged
explicitly in §21.

Rules of this document:

- Every lettered clause is an invariant: testable, falsifiable, load-bearing.
  It describes BEHAVIOUR and INVARIANTS only — never code structure. The v3
  architecture (`ARCHITECTURE.v3.md`) maps each clause to where it lives; the
  packets build to the clauses, not to any file layout.
- If an implementation diff changes behaviour, it MUST amend this file in the
  same change. An implementation diff with no contract diff is either a pure
  refactor or a bug.
- §17 carries the scar table forward. Each scar is a real failure found in a
  live overnight run that the system now guards against. A guard whose scar you
  have not read must not be removed.

Meridian runs human-written implementation specs unattended. Max writes handoff
packets by day; a sequential queue drains them by night; mornings are review.
One executor at a time, no plan decomposition, no agentic parallelism. The size
of plan a packet can carry is bounded by the executor's intelligence on purpose
— this is companion-coding on a timer, not a hype harness.

---

## 1. Doctrine

- **D1. The driver is plumbing, not a brain.** It owns lifecycle and enforces
  mechanical invariants (file state, counters, exit codes, schemas). It never
  makes a semantic judgment: those belong to Daddy (the planner), super-daddy
  (the convergence reviewer), or Max (the human). Any driver decision must be
  expressible as a pure function of durable files and config.
- **D2. Sessions are disposable; files are the truth.** Every executor session
  is reconstructible from durable state alone. There is no summarizer, no
  compaction (`compaction.auto = false` in the generated config), no "you were
  compacted" baton-pass. Rotation replaces compaction (§8). Conversation memory
  is never trusted over the files.
- **D3. One writer per fact.** The driver writes ALL run state (it contains the
  bridge in-process). The gate plugin writes nothing — it reads driver-written
  state and throws. Max writes packets and answers. Baby writes only through
  bridge tools, i.e. through the driver. The orchestrator writes only the
  campaign ledger, follow-up packets, `nits.md`, `convergence.jsonl`, and the
  converged commit message — never a live run's work.
- **D4. Files are the API.** The queue is a directory. A run is a directory.
  Every read-only view (`status`, `tail`, `review`) is a stateless renderer over
  those files and works identically on a live run and a finished one.
- **D5. Fail closed.** Anything load-bearing that fails to parse or validate is
  rejected at admission or halts the run with a parked status, never silently
  disabled. Every durable *state* file (meta, outcomes, gate, review-state,
  checkpoint, campaign) is schema-validated on read and throws on failure; the
  caller decides whether that parks a run or rejects an admission. (The journal
  is the one exception — see J3.)
- **D6. Typed at the boundary.** Every file the system reads is validated with a
  Zod schema at read time, and at write time. Machine-consumed fields live in
  packet frontmatter; prose for the models lives in the markdown body. No
  load-bearing value is ever regex-extracted from prose.
- **D7. The executor supplies belief; the driver assembles structure.** Baby
  emits only three things: code (gated file edits), a free-text account (its
  prose summary, what it believes it did, what it is unsure of), and routed
  questions. It is NEVER asked to author a load-bearing structured artifact.
  Every such artifact — the checkpoint's outcome block and changed-file list,
  the report's files-changed table, the report's per-outcome claims, the
  verification block — is ASSEMBLED by the driver from durable state it already
  holds (`outcomes.json`, the worktree diff, its own verification runs). A
  structure built from its own source of truth cannot diverge from it, so the
  whole class of "weak model emitted a malformed structured artifact and wedged
  the run" is designed out. The executor's one remaining structured act is
  `update_outcomes` — it owns its own ledger; the driver only ever reads it.

---

## 2. Cast and topology

| Part | Where | Role |
|---|---|---|
| Max | daytime | Writes packets, answers parked questions, reviews/merges branches |
| Daddy (planner) | one opencode session per run; `zai-coding-plan`/`glm-5.1` (config) | Authors packets via the `/packet` skill, answers `ask_planner`, does per-run final review; read-only repo tools, **no bash** |
| Baby (executor) | opencode sessions, rotated; `omlx`/`Qwen3.6-35B-A3B-UD-MLX-4bit` (config) | Implements one packet; gated, never trusted with lifecycle |
| Driver | the `meridian` CLI process | Queue, run lifecycle, turn loop, bridge (MCP), journal, git, verification, convergence step — all writes |
| Gate plugin | inside Baby's opencode runtime | Synchronous DENY of unsafe actions; non-blocking checkpoint NOTICE on the allow path. Writes nothing |
| opencode server | spawned and supervised by the driver | Session host for all models, hermetic config |
| Super-daddy | one opencode session per convergence pass; `openai`/`gpt-5.5-pro` (config) | Convergence reviewer (§20): **bash-enabled and MUST execute**, anchors to the ORIGINAL packet + the full meridian skill |

- **T1.** Everything runs locally except inference: Baby's at an oMLX endpoint,
  Daddy's/super-daddy's at their providers' APIs resolved through opencode's
  global auth. All endpoints, models, and agents are config, never code.
- **T2.** A repo named by a packet must be present and a git repo, or the packet
  fails admission (D5/K3).
- **T3.** `meridian run` holds a power assertion (`caffeinate -i` child bound to
  the driver pid) for its lifetime on macOS.
- **T4.** The driver spawns and supervises `opencode serve` itself. Max never
  manages the server, sees a session id, or ends a session by hand.
- **T5. Convergence review is single-reviewer.** Super-daddy is the only
  convergence reviewer; the run drives straight off its verdict. There is no
  second corroborating reviewer. (Max's settled decision: "no triaging, just
  trust super-daddy." This is a deliberate change from draft 2 — see §21.)

---

## 3. Filesystem layout

State root `~/.meridian/v2/` (config `stateRoot`) — namespaced so a v1 watchdog
keying off `~/.meridian/active-session` can never police a v2 session.

```
~/.meridian/v2/
  config.json                     driver config, schema-validated (§15)
  active-run.json                 driver-written pointer {runId, runDir, worktree,
                                  babySessionId}; how the gate plugin recognises the
                                  policed session
  xdg/opencode/opencode.json      generated hermetic opencode config; serve runs with
                                  XDG_CONFIG_HOME=~/.meridian/v2/xdg (opencode MERGES every
                                  config location it finds — isolation, not override)
  xdg/ (package.json, lockfile, node_modules)   seeded real-copy trio (G9a)
  opencode-serve.log              serve stderr; first place to look when a provider hangs
  queue/
    YYYYMMDD-HHMMSS-<slug>.md      admitted packets; lexical filename order = queue order
  rejected/
    <name>.md  <name>.md.problems.txt   packets that failed admission or were dropped —
                                  never deleted, only relocated, with their reasons
  campaigns/<campaignId>/
    campaign.json                 {campaignId, originalRunId, originalIntent,
                                  status, maxPasses, passes[], updatedAt}
  runs/<runId>/                   runId = packet filename stem (YYYYMMDD-HHMMSS-<slug>)
    packet.md                     frozen copy at admission; the run never re-reads the queue
    worktree/                     self-rooted clone (branch meridian/<runId>); a real .git dir
    meta.json                     status, attempt, branch, worktree, session ids, timestamps,
                                  stallRetries, reorientRetries, summary
    journal.jsonl                 append-only typed event log (§13)
    decisions.jsonl               append-only planner + Max verdict ledger
    review-state.json             live review obligations (replacement semantics, §9)
    outcomes.json                 the outcome ledger (§8)
    gate-state.json               driver-written, plugin-read (§10)
    checkpoints/NNNN.json         rotation checkpoints (assembled structures, not prose)
    report.md                     rendered implementation report (driver-rendered)
    nits.md                       ungrounded convergence findings, for Max to skim (§20)
    convergence.jsonl             append-only record of each convergence pass (§20)
```

- **F1.** Queue order is lexical filename order. Packet filenames are
  `YYYYMMDD-HHMMSS-<slug>.md`. Reordering = renaming.
- **F2.** A requeued run (answered park, interrupted, or stall-recovery) re-enters
  at the FRONT of the queue: started work finishes before fresh work starts.
  Mechanically, a run whose `meta.status` is back to `queued` is listed ahead of
  the fresh queue-directory packets.
- **F3.** Run directories and packets are never deleted by the system. A rejected
  or dropped packet is RELOCATED to `rejected/` (with a `.problems.txt` sidecar
  when it failed validation); on a name collision a numeric suffix keeps both.
  Worktree teardown happens only via `accept`, guarded (§12 X1).

---

## 4. The packet

A packet is one markdown file: typed YAML frontmatter for machines, prose body
for the models.

- **K1. Frontmatter** (required unless marked):
  - `repo` — absolute path (`~` expanded).
  - `base` — branch the worktree forks from. *Optional, infra not Daddy's to
    author.* When omitted, admission stamps the repo's CURRENT branch (the one
    Daddy just reconned in) — resolved ONCE at admission and frozen into the
    queue copy, never re-derived at run time. An explicit `base` is honoured as a
    deliberate override (e.g. a follow-up targeting a parent run's branch tip). A
    detached HEAD with no explicit base fails admission.
  - `summary` — optional one-line human description, shown in `tail`'s status
    bar; falls back to the run slug when absent.
  - `outcomes` — list of `{id, description}`; ids stable, unique, kebab-case
    (`^[a-z0-9][a-z0-9-]*$`); each description observable/testable. At least one.
  - `expected_surface` — list of globs, at least one.
  - `suspicious_surface` — list of globs (optional, default `[]`).
  - `verification` — list of `{command}`; the canonical strings the driver runs
    at the worktree root (§11). At least one. No `cwd` — a subdir need goes in the
    command (`cd sub && …`); a stray `cwd:` key on an old packet is stripped and
    ignored.
  - `constraints` — list of strings (optional, default `[]`; merged into Baby's
    seed and Daddy's review obligations).
  - Convergence lineage (all optional/defaulted; existing packets parse
    unchanged): `campaign_id`, `parent_run_id`, `pass` (default 1, ≥1),
    `regression_outcomes` (list of `{id, description}`, default `[]` — prior-pass
    outcomes that must still pass unchanged).
- **K2.** The body keeps the sections that earn their keep: Task, Known context,
  Inspect first, Unknowns (four-tier: repo-discoverable / daddy-discoverable /
  human-required / blocking), Stop conditions, Implementation constraints. The
  body is for the models; nothing in it is machine-parsed (D6).
- **K3. Admission validation** (on `queue add`, and again by `run` before
  starting): frontmatter parses against the schema; outcome ids unique;
  `expected_surface` and `verification` non-empty; `repo` exists and is a git
  repo; `base` exists in the repo (an omitted `base` is first stamped from HEAD,
  then validated); the runId (`<stem>` or the requeue override) matches
  `^\d{8}-\d{6}-[a-z0-9-]+$`. Any failure → packet rejected with reasons, never
  enqueued half-valid (D5), and archived to `rejected/`.
- **K4. Infra redaction.** The absolute `repo`, the `base` branch, and the
  convergence lineage (`campaign_id`, `parent_run_id`, `pass`) are STRIPPED from
  the packet view the models see: the agents work in their cwd, which IS the
  project root, and exposing those invites "is the project here, or at that
  path?" confusion. Work fields and the body stay intact.
- **K5.** `meridian plan` is the default producer, not the only one. Any process
  that writes a packet passing K3 is a legal producer; admission is the gate.
  `plan` opens the opencode TUI in the target repo, where the global `/packet`
  skill authors the packet into the queue. There is no `--long` mode and no
  hand-rolled chat UI: packet richness is the author's judgment scaled by recon.

---

## 5. Run lifecycle

- **R1. One driver, strictly sequential.** Exactly one driver exists at a time,
  enforced by BINDING THE BRIDGE PORT before anything touches run state — the
  bind is the lock (atomic, self-releasing on crash, which a lockfile is not). A
  second `meridian run` exits with a one-liner, having mutated nothing. One Baby
  session exists at a time, system-wide; the queue is between runs, never within
  one.
- **R2. Per run, in order:** re-validate the packet (K3) → freeze a copy into the
  run dir → create a SELF-ROOTED clone (`git clone --local --branch <base>`, then
  `checkout -b meridian/<runId>`) — NOT a `git worktree`, whose `.git` file links
  back to the source and makes opencode root on the wrong tree → create/resume
  the Daddy session (seeded with the frozen packet + doctrine; handshake
  `PLANNER_OK`) → create the Baby session → turn loop → terminal status → WIP
  commit → next packet. `accept` (Max's morning command) merges the run branch.
- **R3. The driver makes exactly one commit per run attempt,** message
  `meridian: WIP <runId> [<status>]`, at terminal status, park, crash recovery,
  or ^C-interrupt. A finished diff is never lost to a 3am crash. The driver NEVER
  merges, pushes, rebases, or touches a branch it did not create — with ONE
  exception: on convergence accept, super-daddy authors a real conventional
  commit message and the driver REWORDS (`git commit --amend`) the run's single
  commit so the throwaway WIP line never reaches Max's integration branch (§20
  S9). A missing message or a git failure there leaves the WIP line rather than
  failing convergence.
- **R4. Baby never runs git mutations.** `git commit/push/reset/checkout/rebase/
  stash/clean/merge/cherry-pick/worktree` from Baby are denied by the gate plugin
  unconditionally (§10). Baby reads git state freely (G1).
- **R5. Terminal statuses** (exactly one per attempt):
  - `ready_for_review` — report accepted: the driver's own verification proved
    green, every outcome is `done`, the gate was clear, and Daddy's final review
    passed (§11).
  - `blocked` — needs Max; carries a typed reason: `human_decision |
    scope_expansion | stop_condition | wedged | crashed`. `wedged` (a
    harness-detected stall) and `crashed` (the driver itself threw) are HARNESS
    failures; the other three are JUDGEMENT parks. Only `wedged` is
    auto-recoverable (R10).
  - `failed` — verification cannot be made to pass within the attempt (the
    bounded report-rejection cap, V1).

  (`RunStatus` also carries `queued`, `running`, `interrupted`, and `accepted` as
  non-terminal/lifecycle states. See §21 on `interrupted`.)
- **R6.** A `blocked` run parks: the question is recorded into `meta.json` and
  `report.md`, a WIP commit is made, and the driver MOVES ON to the next packet.
  No notifications; parked runs surface in `status` and `review`.
- **R7. Answering a parked run** (`meridian answer <runId> "<decision>"`) appends
  a Max decision (`source: max`, `status: proceed`) to `decisions.jsonl`, clears
  the gate, requeues the run at the FRONT (F2), and resets `stallRetries` to 0 (a
  human looking is a fresh start). The resumed attempt seeds from durable state
  like any rotation — it does not start over. Only a `blocked` run is answerable.
- **R8. Crash recovery.** On startup, behind the lock, the driver scans for runs
  whose `meta.status` is `running` (the driver died with them): it WIP-commits any
  dirty worktree and marks the run `queued`, so it re-enters at the front (F2).
  The queue never silently loses a run.
- **R9.** A run that reaches `ready_for_review` is reviewed by the convergence
  step of the run loop (§20) before the next packet is drained. Convergence
  either closes the campaign (run stays `ready_for_review` for Max to merge),
  authors a follow-up packet into the queue, or parks the run
  `blocked`/`human_decision`. It is fail-safe: a convergence error leaves the run
  `ready_for_review` for manual review and never mutates a run that did not finish
  clean.
- **R10. Liveness: a stalled run recovers itself or escalates, bounded.**
  - *Detection.* A per-attempt wall-clock watchdog (`maxRunMs`, default 6h),
    evaluated at the turn boundary, parks a run that never converges (a livelock
    — every turn productive yet endless) as `wedged`. A single hung turn is
    bounded separately by the per-turn transport timeout; per-turn non-progress
    by the ladder (§6 L3); two consecutive failed turn-sends also park `wedged`.
  - *Recovery.* A run parked `wedged` (watchdog, ladder, rotation bounce, or
    consecutive turn-send failures) is auto-requeued (F2, resuming from
    checkpoint) up to `maxStallRetries` (default 2), then escalated to a
    `human_decision` park. `meta.stallRetries` is carried across resumes and reset
    to 0 when Max answers a park (R7). `crashed` is NEVER auto-retried (a driver
    fault would hot-loop); judgement parks are Max's by definition.
  - *Survives restart.* A `wedged` park that outlives its process — not `queued`,
    not `running` — is swept at startup through the same bounded recovery (sibling
    to R8), so an unattended restart resumes or escalates it rather than stranding
    it.
- **R11. Reorient: bounded hallucination recovery.** When Daddy answers an
  `ask_planner` with the `reorient` status — Baby has drifted or confabulated
  (inventing files, paths, or premises that don't exist) but the correct fix is
  clear and needs no human — the driver DISCARDS Baby's session immediately
  (rotation with no checkpoint; a derailed Baby's teardown would be garbage) and
  reseeds a fresh session handed the fix from the planner's `safe_next_action`.
  This is NOT a terminal park. It is bounded by `maxReorientRetries` (default 2)
  CONSECUTIVE reorients without an intervening accepted decision; at the cap the
  driver stops rotating and parks `blocked`/`human_decision`. The counter resets
  to 0 on any accepted planner decision (the reseeded Baby recovered) — so it
  measures consecutive misfires, not a lifetime total.

---

## 6. The driver turn loop

The driver owns the loop. Baby cannot die silently because the entity waiting on
the turn is the entity that sends the next prompt.

- **L0.** Turns are step-capped via the agents' `steps` config (Baby 12, Daddy 8
  agentic iterations before a forced text response). The driver's control —
  rotation, gate evaluation, the ladder — lives at turn boundaries, so an uncapped
  agentic turn would starve it. The per-turn transport timeout is the backstop
  behind the cap.
- **L1. Loop:** send prompt → await turn end (one awaited POST) → collect the
  turn's full message/part history → journal → evaluate → repeat.
  - A failed turn-send is the crash path: rotate to a fresh session via
    reconciliation (O6) once; a SECOND consecutive failed send parks the run
    `wedged`.
  - **Evaluation order, first match wins:**
    1. **watchdog** — past the attempt deadline (`maxRunMs`) → park `wedged`
       (checked at the top of each turn).
    2. **park requested** by the bridge (planner `human_required`/`stop`, M4) →
       park with that reason.
    3. **accepted report** this turn → terminal (`ready_for_review`/`failed`/
       `blocked` per the report).
    4. **report rejected** this turn → bounded retry (Q7); at
       `reportRejectionParkAt` (default 3) → park `failed`.
    5. **pending consult** (an `ask_planner` was submitted this turn) → run the
       Daddy consult OFF the MCP path (§9). Transport error → re-prompt
       `qPlannerUnavailable`. Otherwise reset the ladder to 0 and the volume tally
       to 0, then act on the verdict: `reorient` → R11; `human_required`/`stop` →
       park; else deliver the decision via `qPlannerDecision`.
    6. **pending final review** (a report cleared the mechanical floor) → run
       Daddy's final review OFF the MCP path (V7). `escalate` → park
       `human_decision`; `request_changes` → bounded retry sharing the
       report-rejection cap; `accept` → terminal `ready_for_review`.
    7. **rotation in flight** → if a valid checkpoint was written this turn,
       replace the session (O5) and seed Q2; if the checkpoint bounce limit is
       exceeded → park `wedged`; otherwise the teardown turn made no checkpoint —
       climb the ladder and re-demand Q5, parking `wedged` at the bound.
    8. **context budget reached** (`contextTokens ≥ rotationFraction × window`) →
       demand teardown Q5 (O3).
    9. **gate latched / triggered** at the turn boundary → latch + demand
       checkpoint Q4; this is non-progress, so climb the ladder and park `wedged`
       at the bound.
    10. **no progress this turn** (L2) → the ladder (L3): nudge, rotate, or park.
    11. **otherwise** → neutral continuation Q3, optionally prefixed by a
        non-blocking soft checkpoint reminder once the check-in interval has
        elapsed (L1 below; un-throttled, every turn until Baby checks in).
- **L2. Progress** = an allowed (non-denied, non-error) tool call visible in the
  turn's FULL part history, OR a worktree diff delta this turn, OR a valid
  checkpoint written this turn. The full history matters because a step-capped
  turn's POST response carries only the FINAL message's parts — tool calls from
  earlier steps are invisible to it (a productive turn would read as empty); the
  driver re-fetches the whole session and takes every part since the previous
  turn's final message. The worktree-diff signal is the one a stalling model
  cannot fake. Thinking-only and empty turns are non-progress and flow through the
  same evaluation — never an early return.
- **L3. The ladder is bounded, with a rescue between the nudge and the park.**
  `stallAction(ladder, ladderRotateAt, ladderParkAt)` decides each dead turn,
  precedence **park → rotate → nudge**:
  - reaching `ladderParkAt` (default 10) consecutive dead turns parks the run
    `blocked`/`wedged` with the journal tail as evidence;
  - otherwise every `ladderRotateAt` (default 4) dead turns the driver ROTATES —
    discards the wedged session and reseeds from durable state (checkpoint → Q2,
    none → Q8 reconciliation). A Baby narrating in a loop is rescued by a FRESH
    session far more reliably than by more nudges, and a narration loop keeps
    context too cheap to trip the budget rotation (O3);
  - otherwise the contextual nudge (Q6 report-properly if the turn looks like a
    prose "done", else the ladder nudge).
  The ladder is NOT reset on a no-progress rotation, so a Baby still narrating
  after one marches on to the park (rotation is bounded by the park, never a
  livelock; park is checked first, so a misconfigured `ladderRotateAt ≥
  ladderParkAt` simply never rotates). A gate-latched dead turn and a teardown
  turn that never CALLS `write_checkpoint` climb the same ladder. A cooperative
  turn that produced an accepted decision resets the ladder to 1 (it is not a
  stall).
- **L4. Terminal status is claimed ONLY via the `submit_report` bridge tool** —
  schema-validated, never regex over prose. Prose like "done, ready for review"
  is not terminal; the driver replies with Q6 (submit properly) and it counts
  toward the ladder.
- **L5. Every driver-injected prompt comes from a fixed, named inventory** (§16).
  No ad-hoc prompts exist. The neutral continuation names every legal exit with
  none privileged (continue, `ask_planner`, `submit_report(blocked)`) and states
  that prose questions reach no one: Max is structurally absent mid-run — there is
  no prose route to Max at all.
- **L1 (soft checkpoint reminder).** Once the checkpoint-nudge interval
  (`checkpointNudgeMs`, default 20 min since the last accepted planner decision)
  has elapsed, a NON-BLOCKING soft reminder is prepended to the continuation
  prompt on EVERY turn until Baby checks in (which resets the clock). It never
  latches, never ends the turn: Baby keeps full tool access and may ignore it. The
  repetition is the feature — Baby is an easily-distracted child, so the driver
  keeps shouting. This is the old work/time checkpoint cadence (formerly a
  throwing gate) reborn as a shout, not a wall. The driver also journals a visible
  `checkpoint_volume_nudge` when the volume axis crosses (§10), since the plugin's
  per-call appends to Baby's tool results don't surface in the tail.

---

## 7. Baby's seed and surface

- **B1.** A fresh Baby session is seeded with the frozen packet (infra redacted,
  K4), the bridge tool contract (with tooling guidance: rg over grep,
  smallest-change discipline), the outcome ledger, and — after the first session —
  rotation/resume state per §8. Meridian doctrine reaches BOTH models via the
  generated config's `instructions` pointing at the global `SKILL_SMALL.md` (the
  isolated XDG home cuts off global `AGENTS.md` inheritance, so doctrine is
  re-attached deliberately). Baby never re-reads skill files from disk as a
  protocol step.
- **B2. Baby's tools:** read/grep/glob/LSP, bash (gated), edit/write (gated),
  bridge tools. Question/ask-user tools and subagent/exploration tools are denied
  unconditionally by the gate plugin (`task: false` in the agent definition is a
  second net). Discovery routes through `ask_planner` or bounded in-session
  inspection.
- **B3.** The packet's Inspect-first list bounds initial exploration; broad
  discovery questions go to Daddy even when the answer probably lives in the repo.

---

## 8. Rotation and the outcome ledger

Rotation replaces compaction. The successor is told explicitly how far the
predecessor got; "you were working on something and got compacted" is a contract
violation, not a degraded mode.

- **O1.** `outcomes.json` mirrors the packet's outcome ids. Per outcome:
  `status ∈ not_started | in_progress | done | blocked`, plus `evidence` (files,
  verification results, decision refs) and optional `state`/`nextAction`. Baby
  updates it only via the `update_outcomes` bridge tool; the driver is the writer
  (D3).
- **O2.** `done` requires non-empty evidence. The driver rejects an
  `update_outcomes` marking `done` with no evidence (existing evidence on the
  entry also satisfies it).
- **O3. Rotation triggers** at `rotationFraction` (default 0.65) of Baby's context
  window, measured from opencode's per-message token accounting as `input +
  cacheRead + output` of the last turn, evaluated at the turn boundary —
  proactively, leaving room for a good teardown, never at the limit.
- **O4. Teardown.** The driver demands the checkpoint (Q5). Baby calls
  `write_checkpoint` supplying ONLY prose — a `summary` a successor can act on and
  optional `uncertainties` (D7). The driver ASSEMBLES the durable checkpoint from
  that prose plus durable state: the outcome block from `outcomes.json`, the
  changed-file list from the worktree diff (tracked + untracked, since worktree
  files are uncommitted until finalize). `checkpointProblems` is pure defence
  (every packet outcome present, no phantom ids, `done` implies evidence). An
  invalid checkpoint bounces; past `checkpointBounceLimit` (default 1) the run
  parks `wedged`. If `outcomes.json` is stale at teardown, Q5 tells Baby to fix it
  via `update_outcomes` first — the one structured act still its own.
- **O5. Fresh-session seed after rotation (Q2):** packet + doctrine + latest
  checkpoint + outcome ledger + review-state + recent planner decisions + the diff
  against base, plus a driver-rendered plain statement of which outcomes are done
  (with evidence), in progress, or not started, and what to continue. Rendered
  from files, mechanically. The rotation also RE-LATCHES the first-edit gate: a
  replaced session is a new reasoning context with a plan Daddy has not seen, so it
  must clear its first edit exactly as a fresh run does — even when a valid
  checkpoint exists (the checkpoint proves the worktree trustworthy, not the new
  plan sound). One latch per session, not a cadence.
- **O6. Crash path (no fresh checkpoint).** The successor's seed (Q8) says so
  EXPLICITLY — no valid checkpoint exists; the diff, ledger, and outcome file are
  ground truth; the first task is RECONCILIATION, not implementation — and the gate
  stays latched (`reconciliationRequired`) until Daddy accepts a `reconciliation`
  `ask_planner`. This stacks the reconciliation reason on top of the per-session
  first-edit latch (O5); the one accepted decision clears both.

---

## 9. The bridge (the driver's MCP face)

Baby's only side-effect channel besides gated file edits. The bridge is
in-process with the driver: every verdict is persisted before the tool result
returns, and an accepted decision clears the gate synchronously because the bridge
IS the driver — there is no second process that re-reads anything.

- **M1. Tools exposed to Baby:** `ask_planner`, `update_outcomes`,
  `write_checkpoint`, `submit_report`, `get_decisions`. Nothing else. There is no
  `end_handoff_session` — runs end via `submit_report` or driver action; lifecycle
  is not Baby's to touch.
- **M2. `ask_planner` requires** `questionType`, `currentSlice`, `question`,
  `approach`, `evidence`. Content-level emptiness (not just schema shape) is
  rejected with the specific problem and journaled, never answered unledgered — an
  invisible rejection reads as "planner unreachable" to the executor. Run identity
  is ambient; Baby never handles ids. `questionType ∈ repo_procedure |
  architecture_discoverable | handoff_interpretation | stop_condition | diff_audit
  | reconciliation | other`.
- **M2a. The `approach` field is load-bearing.** The question alone is gameable:
  under pressure the executor asks the safest question while silently deciding the
  interesting ones. `approach` must carry every design decision made or pending;
  the planner prompt instructs Daddy to AUDIT it against the packet's unknowns and
  refuse a blanket proceed when one was decided silently. The decision ledger
  persists `approach` so morning review shows what Baby said it would do.
- **M3. `ask_planner` is async (record-and-defer).** The consult takes minutes,
  but opencode's MCP client cancels a tool-call held open that long (~5 min),
  which surfaced as a spurious "planner unavailable" and crashed runs. So the
  bridge does NOT run the consult in the tool handler: it records the submission
  and returns at once, instructing Baby to STOP and end its turn. The driver runs
  the Daddy call off the MCP request path (on `daddy.timeoutMs`) at the next turn
  boundary and delivers the verdict in Baby's next prompt (`qPlannerDecision`). A
  second `ask_planner` while one is already pending returns an `already_submitted`
  no-op hold, never a stacked turn. The same async treatment applies to the final
  review (V7).
- **M4. Planner statuses:** `proceed | proceed_with_constraints | revise_slice |
  reorient | human_required | stop`. `proceed` and `proceed_with_constraints` are
  the ACCEPTED statuses: they clear the gate and replace the obligation list.
  `revise_slice` changes nothing and tells Baby to narrow and re-ask before
  editing. `reorient` triggers R11. `human_required` and `stop` park the run
  (`human_decision` / `stop_condition`) with the question attached; Baby never
  retries, rephrases, or overrides. One asymmetry: a pending `stop_condition` park
  is SUPERSEDED by a later ACCEPTED decision in the same run (Daddy's stops are
  usually transient "I can't answer yet"; once he proceeds it is moot). A
  `human_decision` park is NEVER auto-cleared — only Max lifts it.
- **M5. Review obligations: replacement semantics.** The `constraints` array of
  each ACCEPTED response replaces the live obligation set wholesale; omission =
  clearance; empty array + accepted = all clear; non-accepted statuses change
  nothing. Constraints are concrete implementation obligations only — never
  protocol reminders.
- **M6. ONE Daddy session per run, literally.** It persists across attempts,
  driver restarts, and executor rotations (opencode sessions live on disk), so the
  planner carries every verdict he has given for the run's life. A resumed attempt
  re-handshakes the existing session (`PLANNER_OK`) and mints a fresh one only if it
  stopped answering. Cross-run memory lives in packets and ledgers, never planner
  sessions.
- **M7. Both models run as custom agents** defined in the generated config.
  `daddy`: read-only inspection tools, no bash, no subagents, NO bridge tools (the
  planner can never answer through its own MCP). `baby`: build tools minus
  subagents (defence in depth alongside the gate). `superdaddy`: bash ENABLED
  (must execute, §20), no write/edit/patch, no bridge tools. Stock agents are
  never used.
- **M8. Driver telemetry on every `ask_planner` prompt** the executor cannot
  editorialize: attempt number, minutes since the run first started, rotation
  count, the raw outcome ledger, and whether driver-run verification has ever
  passed — with the instruction to weigh the executor's optimism against these.
- **M9. The consult fails honestly.** A transport failure on the deferred Daddy
  call is journaled and re-prompts Baby to retry once, then
  `submit_report(blocked)` with the error — never silent. A planner reply that
  does not parse as JSON is re-asked once with the concrete reason before failing
  closed to a `stop` (M4).

---

## 10. The gate plugin

The only in-process component besides the bridge, and deliberately dumb. No
persistence, no prompts, no ladder, no file writes — lifecycle belongs to the
driver. Two synchronous responsibilities:

- **DENY (`tool.execute.before`):** block by THROWING.
- **NOTICE (`tool.execute.after`):** on the allow path, APPEND a non-blocking
  checkpoint reminder to tool results. Never throws.

- **G1.** The gate NEVER blocks reads: read/grep/glob/LSP/git-status/git-diff stay
  open while latched, so the required `ask_planner` carries real evidence.
- **G2.** Bridge tools are never gated — the key cannot be locked behind the gate
  it opens.
- **G3. Deny order (first match wins), all computed from driver-written
  `gate-state.json` + cheap synchronous checks:**
  1. interactive question tools → deny always, and set an in-memory latch so the
     dropped intent blocks the very next mutation mid-turn (without the plugin
     writing a file);
  2. subagent/exploration tools → deny always, same in-memory latch;
  3. bridge tools → allow (G2);
  4. forbidden git verbs (R4) → deny always;
  5. on a MUTATION (edit/write/patch, or a bash command matching the mutation
     patterns or `rm/mv/cp/mkdir/touch/tee`/redirection/`sed -i`):
     - edit target an ABSOLUTE path outside the worktree (escapes onto real disk —
       the only net for it) → deny + report target;
     - gate latched → deny;
     - in-memory question/subagent latch set → deny;
     - first edit unapproved → deny;
     - reconciliation required → deny.
  Reads and non-mutating tools fall through. The in-memory latch clears when
  `gate-state.json` shows an accepted decision newer than the latch.
- **G4. Blocking is by THROWING; arg rewriting is forbidden.** A `permission.ask`
  hook denies the same surface as a second net, and — headless rule — answers
  EVERY ask (deny when gated, allow otherwise), because an unanswered ask hangs the
  turn until timeout.
- **G5. The in-worktree file-surface gate is GONE.** Out-of-surface edits are no
  longer blocked mid-run — Baby reliably touches only files the work needs, and the
  pre-emptive block only sent Daddy into "why am I blocked?" spirals. The only
  surface block that remains is the ABSOLUTE-path-outside-the-worktree escape (a
  hard safety net). `expectedGlobs`/`suspiciousGlobs` are retained in gate-state
  purely for after-the-fact classification in the report and Daddy's final review
  (V6/V7). Likewise the checkpoint CADENCE is no longer a gate trigger: a periodic
  forced checkpoint blocked edits and, post async-consult, ended Baby's turn (the
  live "checkpoint loop" wedge), so it was demoted to the non-blocking NOTICE below
  and the driver's soft nudge (L1). The gate now latches for first-edit approval
  exactly ONCE per session — on a fresh run and again on every rotation — plus the
  crash-path reconciliation latch. It clears ONLY when the driver writes a new
  gate-state after an accepted decision.
- **G6. The surface classification cannot fail open.** Globs arrive via
  `gate-state.json` from validated frontmatter (K3); there is no parse-and-hope
  path.
- **G7. Plugin file shape:** the file under the plugin glob exports ONLY the
  default plugin factory; all pure logic lives outside it.
- **G8. Ordinary tool FAILURES** (build breaks, failing tests, missing files)
  never latch. Failure output is evidence Baby iterates on.
- **G9. The driver REFUSES to start if the gate plugin file is missing** — opencode
  skips absent plugins silently, so an unverified plugin path means an ungated
  executor with no error anywhere. (Scar: a path bug pointed outside the repo and
  early runs executed with no in-process gate; only the driver's turn-boundary
  checks held.)
- **G9a. The hermetic config home must be seeded** with the global config dir's
  `package.json`/lockfile/`node_modules` trio as a REAL copy: opencode auto-installs
  `@opencode-ai/plugin` before loading any plugin, the install fails in a bare dir
  against its pinned registry, and it then skips ALL plugins silently. A symlinked
  `node_modules` is deleted by the installer before it fails — the copy must be
  real.
- **G10. The NOTICE (non-blocking checkpoint reminders),** both axes un-throttled,
  both appending the SAME text a block would show (`denyMessage`), never thrown:
  - TIME: once Baby is past `checkpointNudgeMs` (driver-plumbed via gate-state;
    20 min default) since its last accepted decision, riding every subsequent
    MUTATION result.
  - VOLUME: once Baby has done too much work since its last accepted decision —
    `checkpointToolCalls` tool calls (any tool, an in-memory plugin tally reset
    when the driver records a newer accepted decision), or `checkpointFiles` /
    `checkpointLoc` of diff (checked only on a mutation — a read can't move the
    diff). On EVERY subsequent tool result it appends the reminder. Defaults:
    50 / 6 / 80.
  The driver runs the time reminder per-turn as belt-and-braces (L1) so a Baby that
  has stopped calling tools entirely still hears it.

---

## 11. Verification enforcement

- **V1.** On `submit_report(ready_for_review)`, the DRIVER executes every command
  in the packet's `verification` list ITSELF, in the worktree, through `/bin/zsh`,
  with a per-command timeout (`verificationTimeoutMs`, default 10 min) — and
  accepts only if every one exits 0. Failures reject the report with the command,
  exit code, and output tail; the turn loop continues. Bounded: after
  `reportRejectionParkAt` (default 3) rejected reports the run parks `failed`.
  Staleness is impossible by construction: the run happens at submission time,
  after all mutations.
- **V2.** A verbal claim of verification is worth nothing structurally: the
  driver's own execution is the only acceptance source. Baby running tests itself
  is iteration, not acceptance. `verification_run` journal events are written
  exclusively by the driver.
- **V3.** The driver BUILDS the report's per-outcome block from `outcomes.json`,
  not the executor's claims, so claim-vs-ledger divergence is structurally
  impossible. The surviving gate is completeness: a `ready_for_review` whose ledger
  shows any outcome not `done` is rejected, naming it. (`outcomeProblems` still
  detects hand-built mismatches as defence.)
- **V4. The report is split by ownership** (D7). The executor supplies only its
  terminal DECISION (status, and for `blocked` the reason + exact question) and its
  subjective ACCOUNT (summary, behaviour changed, source-of-truth followed,
  escalations, remaining uncertainty). The driver fills the objective blocks —
  files changed, outcome claims, verification — from the diff, the ledger, and its
  own command runs, then renders the whole to `report.md` (with Daddy's final-review
  verdict appended on accept).
- **V5.** `ready_for_review` requires a CLEAR gate. A latched gate
  (reconciliation, checkpoint, out-of-surface) means an unresolved planner
  obligation, and a report cannot close over it — the submission is rejected naming
  the latch reason. `blocked` and `failed` stay submittable while latched: parking
  must always be possible.
- **V6.** The files-changed table is BUILT by the driver from the worktree diff
  (tracked + untracked, excluding `node_modules`), each path classified by
  mechanical glob-match against the packet surface (expected / suspicious / else
  acceptable-but-not-predeclared). Completeness is structural — the table IS the
  diff. Whether an out-of-surface change is ACCEPTABLE is judgement, and belongs to
  Daddy's final review (V7), not a mechanical reject.
- **V7. Final review.** When the mechanical floor (V1/V3/V5/V6) passes on a
  `ready_for_review` submission, the driver requests one final review from Daddy
  (off the MCP path, M3) against the reviewable diff and the packet's outcomes —
  the one acceptance check that is not mechanical: does the diff actually deliver
  each outcome, and is it sane. Daddy returns `accept` (report accepted, verdict
  rendered into `report.md`), `request_changes` (rejected via the V1 path, findings
  carried as the problems, sharing the bounded retry), or `escalate` (park
  `blocked`/`human_decision`). Daddy is in series with and subordinate to the
  floor: never consulted unless it passed, so he can only withhold or escalate
  acceptance, never confer it on a floor-rejected run. The failure directions are
  all safe: a lenient Daddy degrades to mechanical-only acceptance; a harsh Daddy
  costs a false park; a malformed or unreachable Daddy fails closed to
  `request_changes`. Daddy has full read-only repo access and is told to inspect the
  real tree, not trust the inlined diff.

---

## 12. CLI surface (the DX contract)

- **X1. The surface:** `plan`, `queue` (list/add/drop), `run`, `status`, `tail
  [runId]`, `review`, `answer`, `accept`, plus two debug-only convergence aids
  (`super-review`, `converge`). No command exposes a session id.
  - `accept <runId> [targetBranch]` is the morning "yes": it merges the run's
    branch into `targetBranch` (default the run's `base`) ONLY when the repo
    checkout is on that branch and clean (otherwise it prints the manual merge
    command). For a self-rooted clone it first fetches the run branch into the
    source repo, then merges, then removes the worktree (guarded — it refuses
    anything but the run's own `<runsDir>/<runId>/worktree` sandbox with a real
    `.git`) and deletes the branch; run records are kept and the run is marked
    `accepted`. The explicit `targetBranch` exists because a follow-up's `base` is
    often a throwaway meridian branch, not the integration branch — pass `main` to
    land it there. `accept` and the WIP/amend commits are the only things that
    touch git, and only Max invokes `accept`.
  - `super-review <runId>` (dry-run the reviewer, changes nothing) and `converge
    <runId>` (one manual pass) are debug aids, NOT the production path — convergence
    runs as a step of the run loop (§20 S1).
- **X2. `run` is a foreground, journaled, always-on worker.** It drains the queue,
  runs the convergence step on each finished run (§20), then WAITS (fs.watch on the
  queue and runs dirs + a poll fallback) for new work — a fresh packet, an answered
  park, or a follow-up it authored — rather than exiting. Only ^C stops it: the
  first finishes the current step and tears down cleanly; a second forces. A ^C
  during a run leaves that run RESUMABLE (WIP-committed, marked `queued`), not
  crashed. It is safe to interrupt at any point — crash recovery (R8) makes
  interruption lossless.
- **X3. `tail`** renders the run live for the active run or replays scrollback for
  any finished run — same renderer, same files (D4). On a real TTY an Ink split-pane
  UI takes over (Baby/Daddy panes, context gauge, status strip); `--plain` and
  `--no-follow` give the line stream. The live stream prints the serve SSE feed
  (Baby's reasoning/text, tool calls) and overlays driver-level journal events.
- **X4. `review`** is the morning triage: terminal statuses, outcome ledgers, stop
  questions, report/nits pointers, and per-run diff and accept commands.
- **X5.** Max's artifacts are packets in and branches out. Everything between is the
  driver's, and everything the driver did is replayable from the journal.

---

## 13. The journal

- **J1.** `journal.jsonl` is an append-only sequence of schema'd, discriminated
  events: `run_started`, `prompt_sent`, `turn_ended` (with token counts and
  context tokens), `tool_call` (tool, command/target, status, exit code,
  `gateDenied`), `gate_latched`, `gate_cleared`, `checkpoint_volume_nudge`,
  `planner_exchange`, `outcomes_updated`, `checkpoint_written` (valid + problems),
  `rotation` (teardown_demanded / session_replaced / no_progress),
  `verification_run`, `report_submitted`, `report_rejected`, `report_accepted`,
  `final_review`, `ladder_step`, `parked`, `committed`, `driver_note`,
  `stall_recovery`, `reorient`.
- **J2.** Every gate denial, ladder step, rotation, report rejection, stall
  recovery, and reorient MUST appear in the journal — if the views can't show it,
  the driver didn't do it.
- **J3.** The journal is observability, not durable state: an invalid journal line
  is skipped on read, never fatal — one bad line must not brick replay of the rest.
  Durable STATE files fail closed (D5).

---

## 14. Config

`~/.meridian/v2/config.json`, schema-validated at startup; the process reads no env
directly. All keys are optional with defaults.

- **C1. Contents:** `stateRoot`; `opencode` {binary, port, bridgePort,
  expectedVersion}; `daddy` {providerId, modelId, agent, timeoutMs, turnSteps};
  `baby` {providerId, modelId, baseUrl, apiKey, agent, contextWindow, timeoutMs,
  turnSteps, thinkingBudget}; `superdaddy` {providerId, modelId, agent, timeoutMs,
  baseUrl, headerTimeoutMs, apiKey?, turnSteps, skillPath, diffCapBytes};
  `thresholds` {rotationFraction, ladderParkAt, ladderRotateAt, checkpointNudgeMs,
  checkpointToolCalls, checkpointFiles, checkpointLoc, reportRejectionParkAt,
  checkpointBounceLimit, verificationTimeoutMs, maxPasses, maxStallRetries,
  maxReorientRetries, maxRunMs}; `mutationCommandPatterns`.
- **C2. Key defaults:** rotation 0.65 · ladder rotates every 4 dead turns, parks at
  10 · checkpoint-nudge 20 min · volume 50 tool calls / 6 files / 80 LoC · report
  rejections park at 3 · checkpoint bounce 1 · verification per-command timeout 10
  min · `maxPasses` 3 · `maxStallRetries` 2 · `maxReorientRetries` 2 · `maxRunMs`
  6 h · Baby `thinkingBudget` 6000 tokens · `turnSteps` Baby 12 / Daddy 8 /
  super-daddy 40 · super-daddy `diffCapBytes` 128 KB. There is NO corroborator
  config block (T5).
- **C3. There is no corroborator.** (Draft 2 listed one in §15 C1; the code has a
  single reviewer. See §21.)

---

## 15. Driver prompt inventory

Every prompt the driver can inject, by name. No ad-hoc prompts exist.

| Name | Prompt | When |
|---|---|---|
| Q1 | Initial seed | new run (B1) |
| Q2 | Rotation/resume seed (with checkpoint) | after teardown (O5); resume-with-checkpoint (R7) |
| Q3 | Neutral continuation | progress + gate clear (L1.11) |
| Q4 | Checkpoint demand | gate latched at turn end (L1.9) |
| Q5 | Teardown demand | rotation threshold / rotation-in-flight (O3/O4) |
| Q6 | Report-properly | prose terminal claim (L4) |
| Q7 | Report rejection | mechanical-floor / final-review `request_changes` (V1/V7) |
| Q8 | Reconciliation seed (no checkpoint) | crash path (O6); resume-without-checkpoint; reorient-with-no-checkpoint fallback |
| Qreorient | Reorient seed | planner `reorient` verdict (R11) |
| Qp | Planner decision delivery | accepted/`revise_slice` consult result (M3) |
| Qp-fail | Planner unavailable | consult transport failure (M9) |
| Q9-final | Final review (Daddy-facing) | mechanical floor passed on ready_for_review (V7) |
| ladder | No-progress nudge | ladder nudge when the gate is clear (L3) |
| soft-nudge | Non-blocking checkpoint reminder | past the check-in interval (L1) |

The convergence step (§20) uses one further fixed prompt: the super-daddy review
(rubric + original packet + diff + grounding rule + response contract + commit
message). It is code-fixed, not ad-hoc.

> Naming note for v3: the implementation currently labels the reorient seed `Q9`
> and the final-review prompt `Q9` too. v3 must give them distinct names
> (`Qreorient`, `Q9-final` above) — see §21.

---

## 16. Scars carried forward

Each is a real failure found in a live run; the rule guards against it.

- The second-driver race: a second `meridian run` "recovered" a run the first was
  mid-flight on, then died on the port bind — after mutating. → R1 (bind the bridge
  port as the lock before touching state).
- Wrong-tree review: a `git worktree`'s `.git` file links to the source repo, so
  opencode's tools rooted on and reviewed the SOURCE tree. → R2 (self-rooted
  `--local` clone with a real `.git` dir; a local `<base>` branch so `git diff
  <base>` resolves).
- The productive turn that read as empty: a step-capped POST returns only the
  final message's parts, hiding earlier-step tool calls. → L2 (collect the whole
  turn's parts; worktree diff delta as an unfakeable progress signal). The same
  scar bit super-daddy (verdict text in an earlier step) → harvest text from EVERY
  assistant message.
- The narration loop: stuck Babies only ever recovered on a fresh session, never
  on the Nth nudge. → L3 (rotate before park).
- The checkpoint-as-prose teardown loop: the executor printed the checkpoint as
  prose instead of calling `write_checkpoint`. → L3 (unfulfilled teardown climbs
  the ladder).
- The checkpoint-loop wedge: a periodic forced checkpoint ended Baby's turn (post
  async-consult), so a finished run could never chain verify→submit. → G5 (cadence
  demoted to non-blocking NOTICE + driver soft nudge).
- The surface-gate fail-open: the old surface gate failed open on unparseable prose
  tables. → D5/D6/G6/K3 (typed frontmatter, fail-closed admission; the in-worktree
  surface gate removed entirely, G5).
- `ask_planner` answered unledgered when args were empty. → M2 (content-level
  rejection, journaled).
- The async-consult crash: a multi-minute synchronous Daddy call held in a tool
  result was cancelled by opencode's MCP client at ~5 min and read as "planner
  unavailable". → M3 (record-and-defer; the driver runs the consult off the MCP
  path). Same for final review (V7).
- The stale-stop wedge: a transient `stop` latched a park; Baby recovered and Daddy
  proceeded, yet the run parked on the stale stop at turn end. → M4 (a proceed
  supersedes a pending `stop_condition`; `human_decision` never auto-clears).
- The six-attempt amnesiac planner: a fresh Daddy per attempt reviewed a long run as
  if it had just started. → M6 (one persistent Daddy session) + M8 (driver telemetry
  the executor cannot editorialize).
- The 10-minute tool spiral: stock `plan` + merged global config sent GLM on a tool
  spiral inside one `ask_planner`. → M7 (custom agents only) + hermetic config (G9a).
- `pnpm install` latched the gate on hundreds of `node_modules` files. → diff
  accounting excludes `node_modules`.
- The wrong-tree verification: a per-command `cwd` could point an absolute path out
  of the worktree. → the `cwd` field was removed; verification always runs at the
  worktree root (V1).
- The first-fence parse: super-daddy reasoned in prose, dropped a ` ```csharp `
  block, then emitted the unfenced verdict — the old first-fence parser read an
  `accept` as `escalate` and parked a converged run. → balanced-object parse, last
  valid object wins (§20).
- The converged-run park: a 0-char super-daddy final message fail-closed to
  escalate and parked a fully-converged run. → harvest from every assistant message;
  surface provider errors distinctly from "unparseable".
- The fix-A-break-B oscillation, and the reused-outcome-id collision (an outcome
  both repaired AND a regression guard). → S9 (regression carry-forward; a repaired
  outcome is excluded from the regression set).
- The post-stall manual `try again pls` that recovered a stuck run. → R10 (bounded
  auto-requeue, the automated capped "try again").

---

## 17. Accepted seams (deliberate tradeoffs — not bugs)

- Strictly sequential: one slow run blocks the night's queue. By design.
- Verification command matching is literal string match; packets carry canonical
  commands. Clever shell quoting is the author's problem.
- Mutation classification of bash commands is regex-over-config, best-effort; the
  diff-based out-of-surface check catches escapes one tool call later, and
  `apply_patch`-shaped tools with no single path arg are caught by the diff next
  call.
- `tail`'s context gauge uses a chars/4 estimate for the live token figure.
- Daddy has no cross-run memory; continuity is packets + ledgers.
- Daddy has no bash at all today; the cost shows up as Daddy asking Baby for
  evidence he could have gathered himself. Super-daddy is the deliberate exception
  (it MUST execute).
- opencode version drift: the driver warns at startup when `opencode --version`
  doesn't match the config pin (advisory, not fatal).
- opencode session STORAGE is global; v2 sessions appear in Max's session list.
  Cosmetic — the isolation that matters (the state-root namespace) holds.
- `nits.md` is written to the RUN dir, not the campaign dir (draft 2 §3 said the
  campaign dir). Cosmetic.
- Single-reviewer convergence trusts super-daddy's verdict wholesale (T5/§20). The
  pass cap, not a second reviewer, is the loop bound.

---

## 18. Convergence (super-daddy)

Daddy supervises *a run* ("did Baby do what this packet said?"). Super-daddy
supervises *convergence* ("does the delivered code meet the ORIGINAL packet AND
Max's doctrine — and if not, can it be repaired without waking Max?"). It is the
one loop otherwise routed through a human: read the diff, ask a strong model to
review against doctrine, turn findings into a follow-up packet, re-run.

- **S1. Convergence is a step of the run loop, not a daemon and not a flag.** When
  a run reaches `ready_for_review` (R9), the always-on run loop reviews it inline on
  the live server, then acts. Every finished run is reviewed. `super-review` /
  `converge` are out-of-band debug aids (X1).
- **S2. Super-daddy MUST execute.** The reviewer has bash and MUST run the packet's
  `verification` commands plus the repo's build/typecheck/test itself. The driver
  ALSO runs the suite independently as ground truth (S6); a reviewer's claim never
  substitutes for an exit code the driver observed.
- **S3. The rubric is the live meridian skill.** Super-daddy anchors to the
  ORIGINAL packet (not the slice Daddy approved per-run) and grades the diff against
  the FULL meridian skill text (`superdaddy.skillPath`), injected verbatim and read
  fresh each pass.
- **S4. Findings carry grounding; the verdict is trusted.** Every finding records a
  `severity` (P0–P3) and a `grounding` (`command_fail` with the failing command |
  `clause` with the quoted rule | `none` for a taste call). **Grounding and severity
  are advisory only** — they order findings, supply evidence, decide which failing
  commands to re-run, and shape `nits.md`. They do NOT gate which findings drive a
  follow-up. There is no severity triage and no code-side downgrade: the reviewer is
  told it gets ONE review and to put everything that genuinely matters into the
  verdict; the run trusts that verdict. (This is the settled "trust super-daddy"
  decision; it reverses draft 2's `normalizeSeverity`/grounded-blocker gating — §21.)
- **S5. The loop decision** (`decideConvergence`) is keyed on the reviewer's
  `verdict` and the DRIVER's own verification result, and every branch fails closed
  toward Max:
  1. reviewer `escalate`, or any `human_decision_needed` → **escalate**;
  2. `accept` + suite green → **stop** (the ONLY stop path);
  3. `accept` + suite red → **escalate** (incoherent / under-reported; never stop on
     red);
  4. `request_changes` + no findings → **escalate** (wants changes, named none);
  5. `request_changes` + cap reached (`pass ≥ maxPasses`) → **escalate**
     (convergence failed);
  6. `request_changes` + passes left → **author** a follow-up carrying EVERY finding.
- **S6. Cannot converge on red.** Stopping is forbidden while any verification
  command exits non-zero, enforced against the DRIVER's own run of the suite (ground
  truth), never a reviewer claim.
- **S7. Termination is graceful-exit OR hard-cap, both load-bearing.** Graceful =
  `accept` over a green suite → `accept`, campaign `converged`. Hard cap
  (`maxPasses`, default 3) is the circuit breaker for oscillation; hitting it is
  itself information — convergence FAILED → forced escalate, campaign `needs_max`.
- **S8. Follow-up packets are repairs only, deterministically rendered.** One
  outcome per finding (id = the finding's `suggested_outcome_id` or `id`, deduped —
  two findings mapping to one id collapse to the first); `verification` = the
  original suite ∪ each finding's failing command (`command_fail` grounding), deduped
  — nothing already-green may silently regress; `regression_outcomes` = every prior
  delivered outcome carried forward as "must still pass unchanged", EXCEPT any whose
  id is now a repaired outcome (an outcome can't be both repaired and a regression
  guard); `base` = the parent run's branch tip; constraints add the regression list
  and a "repair only — no net-new features" line. The renderer fails closed: it
  never emits a packet that would not survive its own admission (K3), and the
  follow-up's `repo` stays the source repo so `accept` later merges THERE.
- **S9. Super-daddy authors the converged commit message.** On `accept` only,
  super-daddy returns a `commit_message` {subject, body} — a conventional-commit
  entry based on the diff it just read (no run/packet ids, no Baby/Daddy/meridian
  references) — and the driver amends the run's single WIP commit with it (R3). On
  any other verdict the message is null and the WIP line stands.
- **S10. The orchestrator writes only the campaign ledger + follow-up packets +
  `nits.md` + `convergence.jsonl` + the amended commit — never a live run's work.**
  A campaign (`campaigns/<id>/campaign.json`) is the chain of runs converging one
  original intent: `{campaignId, originalRunId, originalIntent, status:
  open|converged|needs_max, maxPasses, passes:[{runId, pass, verdict,
  groundedBlockers, atIso}], updatedAt}`. The campaign id is the FIRST run's runId,
  carried forward by follow-ups via `campaign_id`. Trigger-once is enforced by the
  LEDGER — a run already recorded as a reviewed pass (`alreadyReviewed`) is never
  re-reviewed — NOT by a status flip; re-recording the same runId replaces its prior
  entry (idempotent). That is why a converged run STAYS `ready_for_review` (so
  `accept` can still merge it) instead of being marked `accepted`, and an authored
  pass also leaves its parent `ready_for_review` (the follow-up supersedes it). An
  escalation parks the run `blocked`/`human_decision`. Ungrounded findings on an
  accept/escalate (not author) are written to the run's `nits.md` for Max; on author
  every finding became a packet outcome, so nothing is left to note. `convergence.jsonl`
  records the full verdict (findings, the driver's ground-truth exit codes, the
  decision, the amended sha, and the raw model text) one line per pass.
- **S11. Parsing fails closed to escalate.** A super-review that cannot produce
  valid JSON, or whose provider errored (HTTP 200 with a provider error and no text,
  distinct from a bad verdict), fails closed to `escalate` — never silently converge,
  never author from no findings. The parser scans every balanced top-level object and
  takes the LAST one that validates (the verdict comes after any reasoning/fenced
  prose).

---

## 19. Chaining (a v3 addition — now live in the code)

Inter-campaign chaining lets a long build accumulate across many nights, each
packet building on the previous one's super-daddy-converged work. It was added to
the live tool directly (the `00-chain-support` work, applied by hand 2026-06-17:
`src/chain.ts` plus a `staged` path, a `chain` CLI subcommand, and two sweep calls
in the run loop). This section is normative.

- **C1. A staged child declares its upstream with `parent_run_id`,** naming the
  campaign to build on (a campaign id = the original run's runId). A staged child
  with no `parent_run_id` is a chain HEAD and admits as soon as it is registered.
- **C2. Staged children are registered explicitly** via `meridian chain add <dir>`
  — never auto-scanned. `chain add` copies every file in `<dir>` whose name matches
  the runId format `YYYYMMDD-HHMMSS-<slug>.md` into the staged registry
  (`<root>/staged/<runId>.md`); any other file (e.g. `_CHAIN.md`, READMEs) is
  skipped, not errored. Registration validates frontmatter SHAPE only — YAML parses,
  runId well-formed, work fields present (outcomes, surface, verification) — and
  deliberately does NOT touch the filesystem: neither `base` NOR the target repo is
  checked at stage time, so a chain targeting a repo that does not exist yet (a
  brand-new build dir) can still be staged. All filesystem validation is deferred to
  promotion, where full admission (`parsePacket`) runs.
- **C3. A child enters the queue only once its parent's campaign reaches `status:
  converged`** — super-daddy satisfied, not merely `ready_for_review`. The promotion
  DECISION is a pure function (`decidePromotion`: parent runId + parent campaign →
  `promote-now` | `promote-with-base` | `hold` | `wait`); the I/O wrapper
  (`promoteStagedChildren`) executes it. On a `promote-with-base`, the driver stamps
  the child's `base` = the campaign's CONVERGED TIP branch (`meridian/<runId of the
  last accepted pass>` — which may be a super-daddy repair follow-up, not the
  original `parent_run_id`'s own branch), fetches that branch out of the tip run's
  self-rooted clone into the source repo (so admission's `git rev-parse --verify
  <base>` resolves, exactly as a convergence follow-up does), admits it, and clears
  the staged copy. The sweep runs at `chain add` time, after every convergence in the
  run loop, and at run-loop startup.
- **C4. If the parent campaign reaches `needs_max`** (cap, contested, or escalation),
  its children stay STAGED and unpromoted — surfaced in `meridian status` as `held`
  (vs `waiting` for a parent still open, `promotable` when ready) — and never build
  on unblessed work. A campaign marked `converged` with no accepted pass is incoherent
  and also holds rather than inventing a tip.
- **C5. A staged packet is never destroyed.** A promotion that fails ADMISSION
  archives the staged copy to `rejected/` with its problems (F3); a transient error
  (e.g. the tip clone is mid-teardown) leaves it staged to retry on the next sweep.

---

## 21. Drift from CONTRACT.md (draft 2) — flagged disagreements

Where draft 2 and the code disagree, the code wins and this contract follows it.
Each disagreement, explicit:

1. **Corroborator removed (major).** Draft 2 §2 (cast), §15 C1 (config), §16
   (prompts), and §20 S7 made a second independent corroborator load-bearing
   ("stopping is a two-party agreement"). The code has NO corroborator: a single
   reviewer (super-daddy) is run and trusted (`convergeRun` runs one review;
   `decideConvergence` takes one `SuperReview`; `Config` has no corroborator block).
   Settled by Max ("no triaging, just trust super-daddy"). → T5, §18 S4/S5, §14 C3.

2. **Grounding no longer gates blockers (major).** Draft 2 S4/S5 said the harness
   DOWNGRADES ungrounded P0/P1 to nits (`normalizeSeverity`) and RECOMPUTES
   `recommend_stop` from grounded-blocker count. The code does neither: grounding
   and severity are advisory; on `request_changes` EVERY finding becomes a follow-up
   outcome regardless of grounding; the stop signal is the reviewer's `verdict`
   crossed with the driver's own verification result, not a grounded-blocker count.
   → §18 S4/S5.

3. **`reorient` planner status + bounded hallucination recovery (new).** Draft 2 §9
   M3 listed five planner statuses; the code adds a sixth, `reorient`, with
   `meta.reorientRetries`, `thresholds.maxReorientRetries`, a `reorient` journal
   event, and the `Qreorient` seed. Not in draft 2 at all. → R11, M4, §15.

4. **Super-daddy commit-message amend (new vs R3).** Draft 2 R3 said "exactly one
   commit per run, message `meridian: WIP <runId>`; the driver NEVER … rebases …".
   The code has super-daddy author a real `commit_message` on accept and the driver
   `git commit --amend` the WIP commit. → R3, §18 S9.

5. **Async record-and-defer consult supersedes the busy-bounce machinery
   (restructured).** Draft 2 §9 M8/M8a and §6 L3a described a synchronous serialized
   consult with an `AbortSignal`-threaded busy lock and a per-turn
   `plannerBusyBounceThisTurn` flag feeding the ladder. The code instead records the
   submission (`pendingConsult`) and returns immediately; the driver runs the consult
   off the MCP path at the next turn boundary; a second ask is an `already_submitted`
   no-op; an answered consult resets the ladder (branch ordering, not a flag). The
   busy-bounce/abort machinery is gone. → M3, §6 L1.5.

6. **`summary` packet/meta field (new).** Not in draft 2 K1; the code adds an
   optional `summary` for the tail status bar. → K1.

7. **Baby `thinkingBudget` config (new).** Not in draft 2 C1; the code adds an oMLX
   `thinking_budget` cap. → C1.

8. **`rejected/` dir + `convergence.jsonl` (new on disk).** Draft 2 §3 listed
   neither; both exist. → §3.

9. **`accept <runId> [targetBranch]` (extended).** Draft 2 X1 merged into `base`;
   the code accepts an explicit target branch (default `base`) because a follow-up's
   `base` is a throwaway branch. → X1.

10. **`nits.md` location.** Draft 2 §3 placed it in the campaign dir; the code writes
    it to the RUN dir. → §17.

11. **Prompt-name collision.** The code labels both the reorient seed and the
    final-review prompt `Q9`. Cosmetic, but v3 should disambiguate (`Qreorient`,
    `Q9-final`). → §15.

12. **`interrupted` RunStatus is effectively vestigial.** The enum carries it, but
    the orphan-recovery path writes `queued` (it appears only as text in a WIP commit
    message). v3 may drop it or wire it deliberately. → R5.
