---
name: packet
description: Use when authoring a Lathe overnight packet. Converts human design intent plus bounded repo recon into an admittable packet for `lathe queue add` / `lathe run`.
---

# /packet

Author a Lathe packet: one markdown file with typed YAML frontmatter for the
driver and prose for the models. The human designs the work with this skill; the
packet is the durable handoff Lathe executes overnight. Do not freehand a vague
prompt and call it a packet.

Lathe used to be called Meridian. Some current runtime names still say
`meridian`, including the state/config root `~/.meridian/v3` and the in-run
bridge tool namespace. That is legacy naming, not v2. Use the public CLI command
`lathe`.

## Before Writing

1. Apply the active user and project engineering instructions from the current
   opencode session.
2. Recon the target repo with read-only tools. Scale recon to the task: a small
   local change needs a compact packet; an architectural split needs enough Known
   context that Baby is not forced into broad discovery at 2am.
3. Identify the target repo and branch. Normal packets omit `base`; `lathe queue
   add` stamps it from the repo's current branch. Only author `base` when the
   user deliberately wants the run to fork from a different existing branch.
4. Classify every unknown:
   - repo-discoverable: Baby can resolve it by bounded inspection of files named
     in the packet or directly referenced by those files.
   - daddy-discoverable: Baby must ask the planner via `ask_planner` because it
     is architecture, repo procedure, generated-code workflow, broad discovery,
     verification strategy, or scope interpretation.
   - human-required: product, UX, business, security, permission, tenancy,
     data-retention, billing, legal, compliance, or migration-policy decisions.
   - blocking: do not write a packet until the user supplies the missing decision.

Hard-reject the request instead of writing a packet when the desired behaviour is
not observable, the target repo/branch cannot be identified, or a human-required
decision is needed before implementation can start.

## File

Write a markdown file named:

```text
YYYYMMDD-HHMMSS-<short-kebab-slug>.md
```

The filename is machine-checked and becomes the run id. Lexical order is queue
order.

Prefer writing outside the live queue dir, then admit it:

```sh
lathe queue add <the-packet-file>
```

`lathe queue add` validates YAML, stamps missing `base`, verifies that `repo` is
a git repo, verifies that `base` exists, and writes the admitted copy to the
current queue under `~/.meridian/v3/queue`. It prints `admitted: <runId>` on
success. If it rejects, fix the packet and re-run until it admits. Do not hand
the user an unvalidated packet.

If `lathe plan` told you to write into `~/.meridian/v3/queue`, still run
`lathe queue add` immediately. A file dropped into the queue dir is not a proper
admission step by itself, especially when `base` was omitted.

## Frontmatter

Normal `/packet` invocations author these fields:

```yaml
---
repo: "/absolute/path/to/repo"
summary: "short tail label"
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
- `outcomes` is the progress ledger. Every outcome needs a unique kebab-case id
  and an independently observable description.
- `expected_surface` is required. It is not a hard in-worktree edit fence anymore;
  Lathe uses it for final changed-file classification, repair-packet surface
  selection, and autofix scoping. Make it accurate and complete.
- `suspicious_surface` is optional. Use it for files that may legitimately move
  but should be called out in review if touched.
- `verification` is required. Commands run from the run sandbox root with
  `/bin/zsh`; use exact repo-root-relative commands. No placeholders, no separate
  cwd field, no absolute source-repo paths.
- `constraints` is optional. Use it for implementation constraints the executor
  must preserve, not for generic good practice.
- `autofix_commands` is optional. Each command is best-effort and Lathe appends
  every `expected_surface` entry as shell-escaped arguments. Only use commands
  that accept file/glob arguments at the end.
- `parent_run_id` is only for explicitly staged chain packets. Do not author
  `campaign_id`, `pass`, `regression_outcomes`, or `promoted`; Lathe owns those
  infra fields.

Quote every string that may contain punctuation. YAML colons in unquoted strings
are a common admission failure.

## Body

Use only sections that earn their keep. Good packet bodies usually include:

- `# Task` - one sentence naming the implementation task.
- `## Known context` - facts from the user's request and your recon. No guesses.
- `## Inspect first` - exact files, globs, symbols, routes, or commands Baby must
  inspect before editing. Baby's initial seed tells it to inspect only this list.
- `## Unknowns and routes` - every meaningful unknown tagged
  repo-discoverable, daddy-discoverable, human-required, or blocking.
- `## Stop conditions` - when Baby must park the run for the user, beyond the
  always-on human-required categories.
- `## Implementation constraints` - the smallest safe shape of the change, nearby
  patterns to follow, and any prohibited broadening/refactor.
- `## Verification notes` - why the chosen commands are sufficient, or what manual
  evidence would remain if a command cannot cover the behaviour.

The body should bound Baby's first inspection and give Daddy enough context to
review the first-edit plan. Baby's first edit is gated until Daddy accepts a
planner question with the actual approach and evidence.

## What Not To Write

- Do not write report format instructions, final-review protocol, convergence
  routing, or bridge-tool tutorials. Lathe injects that runtime contract itself.
- Do not tell Baby to ask the user directly. During a run the user is only reached by
  parking via the driver.
- Do not ask Baby to commit, push, merge, reset, checkout, stash, or clean. The
  driver owns git.
- Do not include speculative implementation details as facts. Put uncertainty in
  `Unknowns and routes`.
- Do not broaden `expected_surface` to the whole repo unless the packet is truly
  repo-wide and the verification justifies that.

## Follow-Up Authoring Context

Super-daddy also receives this skill when Lathe asks it to author an automatic
repair packet after a convergence review. In that context, the surrounding prompt
overrides file/admission details: it replies with packet markdown instead of
writing a file, and Lathe stamps repo/base/campaign lineage. Follow those explicit
adaptations when present.

## Finish

After the packet admits, finish with the admitted path/run id and the operator
commands:

```sh
lathe run
lathe tail
```
