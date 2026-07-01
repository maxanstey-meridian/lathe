---
name: packet
description: Use when authoring a Lathe overnight packet. Converts human design intent plus bounded repo recon into an admittable packet for `lathe queue add` / `lathe run`.
---

# /packet

Author a Lathe packet: one markdown file with typed YAML frontmatter for the
driver and prose for the models. The human designs the work with this skill; the
packet is the durable handoff Lathe executes overnight. Do not freehand a vague
prompt and call it a packet.

A packet is not a spec dump. It is an execution scaffold for Baby under bounded
context, bounded reasoning, checkpoint interruptions, and Daddy gates. Optimize
for an unambiguous success path with explicit stop routes, not maximal precision
or exhaustive prohibitions.

Lathe used to be called Meridian. Some current runtime names still say
`meridian`, including the state/config root `~/.meridian/v3` and the in-run
bridge tool namespace. That is legacy naming, not v2. Use the public CLI command
`lathe`.

## Before Writing

1. Read `.opencode/skills/meridian/SKILL.md` for Max's engineering
   doctrine. Read `AGENTS.md` in the target repo for codebase-specific
   conventions.
2. Recon the target repo with read-only tools. Scale recon to the task: a small
   local change needs a compact packet; an architectural split needs enough Known
   context that Baby is not forced into broad discovery at 2am.
3. Identify the target repo and branch. Normal packets omit `base`; `lathe queue
   add` stamps it from the repo's current branch. Only author `base` when Max
   deliberately wants the run to fork from a different existing branch.
4. Classify every unknown:
   - repo-discoverable: Baby can resolve it by bounded inspection of files named
     in the packet or directly referenced by those files.
   - daddy-discoverable: Baby must ask the planner via `ask_planner` because it
     is architecture, repo procedure, generated-code workflow, broad discovery,
     verification strategy, or scope interpretation.
   - human-required: product, UX, business, security, permission, tenancy,
     data-retention, billing, legal, compliance, or migration-policy decisions.
   - blocking: do not write a packet until Max supplies the missing decision.
5. Run the Baby-fit check before drafting:
   - Can Baby inspect the listed files and form a first-edit plan without broad
     repo search?
   - Are the outcomes small enough to complete and verify independently?
   - Are constraints compatible, or do they chain Baby into fake compliance or
     repeated planner calls?
   - Does every non-local ambiguity have a clear Daddy or human stop route?
   - Would a competent but literal junior executor know what not to solve?

Hard-reject the request instead of writing a packet when the desired behaviour is
not observable, the target repo/branch cannot be identified, or a human-required
decision is needed before implementation can start.

## File

Write a markdown file named:

```text
YYYYMMDD-HHMMSS-<short-kebab-slug>.md
```

The filename is machine-checked and becomes the run id.

Write the draft anywhere convenient, then admit it:

```sh
lathe queue add <the-packet-file>
```

`lathe queue add` validates YAML, stamps missing `base`, verifies that `repo` is
a git repo, verifies that `base` exists, creates a queued run in SQLite, and
writes the live packet to `runs/<runId>/packet.md`. It prints `enqueued: <runId>`
on success. If it rejects, fix the packet and re-run until it admits. Do not
hand Max an unvalidated packet.

Do not drop files into `~/.meridian/v3/queue`; the queue is SQLite-backed and a
packet file by itself is not an admission step, especially when `base` was
omitted.

## Frontmatter

Normal `/packet` invocations author these fields:

```yaml
---
repo: "/absolute/path/to/repo"
summary: "short tail label"
compare_commit: "main"
outcomes:
  - id: short-stable-id
    description: "observable behaviour that must be true after completion"
expected_surface:
  - "src/feature/**"
suspicious_surface: []
verification:
  - command: "npm run check"
constraints: []
---
```

Field rules:

- `repo` must name the target git repo. Prefer an absolute path.
- `summary` is optional to the parser but required by this skill. Keep it short:
  a tail status label, not a sentence.
- `base` is normally omitted. Admission stamps the repo's current branch. Add it
  only for an intentional branch override, and only if the branch exists.
- `compare_commit` is required. It sets the cumulative review scope: super-daddy
  diffs the run's final state against this ref (branch, tag, or SHA). Use the
  integration branch the run should be measured against, typically the same as
  `base`. For staged chain children, Lathe inherits it from the parent.
- `outcomes` is the progress ledger. Every outcome needs a unique kebab-case id
  and an independently observable description. Prefer 3-6 outcomes. If there are
  more than about 6, split the packet unless the outcomes are mechanical
  siblings. Avoid bundling implementation, testing, refactoring, and preservation
  requirements into one outcome; use the body for sequencing and constraints.
- `expected_surface` is required. It is not a hard in-worktree edit fence anymore;
  Lathe uses it for final changed-file classification, repair-packet surface
  selection, and autofix scoping. Make it accurate and complete.
- `suspicious_surface` is optional. Use it for files that may legitimately move
  but should be called out in review if touched.
- `verification` is required. Commands run from the run sandbox root with
  `/bin/zsh`; use exact repo-root-relative commands. No placeholders, no separate
  cwd field, no absolute source-repo paths.
- `constraints` is optional. Use it for implementation constraints the executor
  must preserve, not for generic good practice. Strict packets are not always
  safer: stacked unrelated absolutes make Baby overfit, hide work behind fake
  compliance, or park repeatedly.
- `autofix_commands` is optional. Each command is best-effort and Lathe appends
  every `expected_surface` entry as shell-escaped arguments. Only use commands
  that accept file/glob arguments at the end.
- `parent_run_id` is only for explicitly staged chain packets. Do not author
  `campaign_id`, `pass`, `compare_commit` (children inherit it), `regression_outcomes`,
  or `promoted`; Lathe owns those infra fields.

Quote every string that may contain punctuation. YAML colons in unquoted strings
are a common admission failure.

## Body

Use only sections that earn their keep. Good packet bodies usually include:

- `# Task` - one sentence naming the implementation task.
- `## Known context` - facts from Max's request and your recon. No guesses.
- `## Inspect first` - exact implementation files, globs, symbols, routes, or
  commands Baby must inspect before editing. Baby's initial seed tells it to
  inspect only this list. Do not include tests by default; put tests in
  verification notes or let Baby inspect them after implementation/failure.
  Include test files only when the task is test infrastructure, a known failing
  test repair, coverage-only work, or explicitly TDD/test-first. Keep the list
  short enough that Baby can actually digest it before first-edit gating. Prefer
  owner files and entry points over every possibly related file. If the list is
  long, split it into files that must be inspected before planning and files to
  inspect only if touched or if verification fails.
- `## Unknowns and routes` - every meaningful unknown tagged
  repo-discoverable, daddy-discoverable, human-required, or blocking.
- `## Stop conditions` - when Baby must park the run for Max, beyond the always-on
  human-required categories. Good stop conditions prevent invention by naming the
  exact missing fact, contract gap, or policy decision. Bad stop conditions are
  vague, such as "if anything seems wrong".
- `## Implementation constraints` - the smallest safe shape of the change, nearby
  patterns to follow, and any prohibited broadening/refactor. Separate must-keep
  invariants from nice-to-clean nearby drift. Name what Baby should not solve.
  If a requirement is important but hard to verify locally, provide the evidence
  path or route it to Daddy/human; do not leave Baby to infer what counts as
  enough.
- `## Verification notes` - why the chosen commands are sufficient, or what manual
  evidence would remain if a command cannot cover the behaviour.

The body should bound Baby's first inspection and give Daddy enough context to
review the first-edit plan. Baby's first edit is gated until Daddy accepts a
planner question with the actual approach and evidence.

Write for the executor Baby actually is, not for an idealized SOTA model. A good
packet reduces cognitive load without weakening correctness: narrow recon,
observable outcomes, compatible constraints, and explicit escalation paths. When
you need strictness, make it local and testable rather than global and
interpretive.

## What Not To Write

- Do not write report format instructions, final-review protocol, convergence
  routing, or bridge-tool tutorials. Lathe injects that runtime contract itself.
- Do not tell Baby to ask Max directly. During a run Max is only reached by
  parking via the driver.
- Do not ask Baby to commit, push, merge, reset, checkout, stash, or clean. The
  driver owns git.
- Do not include speculative implementation details as facts. Put uncertainty in
  `Unknowns and routes`.
- Do not broaden `expected_surface` to the whole repo unless the packet is truly
  repo-wide and the verification justifies that.
- Do not write packets that are "strict" by stacking unrelated absolutes. Prefer
  a narrow success path plus stop conditions.
- Do not require Baby to prove broad negatives unless verification can prove
  them.
- Do not contradict yourself, such as saying "minimal change" and also "clean up
  all related drift". If both matter, state the priority and stop route.
- Do not make Daddy or Baby infer priority between conflicting constraints.

## Follow-Up Authoring Context

Super-daddy also receives this skill when Lathe asks it to author an automatic
repair packet after a convergence review. In that context, the surrounding prompt
overrides file/admission details: it replies with packet markdown instead of
writing a file, and Lathe stamps repo/base/compare_commit/campaign lineage.
adaptations when present.

## Finish

After the packet admits, finish with the admitted path/run id and the operator
commands:

```sh
lathe run
lathe tail
```
