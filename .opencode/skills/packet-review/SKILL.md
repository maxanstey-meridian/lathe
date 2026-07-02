---
name: packet-review
description: Use when reviewing, hardening, fixing, sanity-checking, validating, or preflighting existing Lathe packet markdown files before `lathe queue add`.
---

# /packet-review

Review and repair existing Lathe packet markdown files before queue admission.
This is an interactive pre-queue hardening pass between Max and the reviewer,
not an unattended packet authoring workflow.

Treat the packet as proposed execution scaffolding for Baby, not as an accepted
spec. Be adversarial about Baby failure modes: ambiguity, overconstraint, broad
recon, fake strictness, weak verification, missing stop routes, and hidden scope
expansion. Preserve Max's product intent; harden the handoff.

Lathe used to be called Meridian. Some current runtime names still say
`meridian`, including the state/config root `~/.meridian/v3` and the in-run
bridge tool namespace. That is legacy naming, not v2. Use the public CLI command
`lathe`.

## Operating Model

- The human is present. Ask Max directly when intent is unclear.
- Patch mechanical packet issues immediately when the safe fix is evident.
- Do not queue, admit, or run a packet unless Max explicitly asks.
- Do not turn the packet into a different feature.
- Do not optimize for reassurance. Conclusions first, evidence second.
- If confidence is below about 95%, say what is unknown and what would firm it
  up.

## Workflow

1. Locate packet markdown files from the file or directory path Max gave you.
2. Read each full packet, including frontmatter and body.
3. Inspect enough target repo context to validate packet claims:
   - `repo` exists and is the intended target repository.
   - package scripts or verification commands named by the packet exist.
   - `expected_surface` matches the likely implementation surface.
   - `Inspect first` files/globs exist and are bounded.
   - `Known context` is supported by files or by Max's stated facts.
4. Review against the `/packet` authoring doctrine when available.
5. Classify issues as:
   - mechanical: safe to patch in place without changing intent.
   - intent question: ask Max before changing.
   - do-not-queue blocker: unsafe until redesigned.
   - non-issue: explicitly ignore if it may look suspicious but is acceptable.
6. Patch mechanical fixes immediately.
7. Report what changed and what still blocks queueing.
8. If Max explicitly asks for admission, run `lathe queue add <packet>` after
   fixes and report the result.

## Mechanical Fixes Allowed

- Fix YAML quoting, punctuation, indentation, and obvious frontmatter shape
  issues.
- Normalize section names to the packet skill's expected structure.
- Add missing useful sections when intent is already clear.
- Add missing `compare_commit` when the intended ref is obvious (typically the
  same as `base`).
- Convert vague outcome descriptions into observable descriptions.
- Split obviously bundled outcomes without changing scope.
- Tighten bloated `Inspect first` lists.
- Remove tests from `Inspect first` unless the packet is test infrastructure, a
  known failing-test repair, coverage-only work, or explicitly TDD/test-first.
- Add missing owner files or entry points to `Inspect first` when repo evidence
  is clear.
- Rewrite generic "do good work" constraints into local, testable constraints,
  or remove them if they add no execution value.
- Add explicit stop conditions for obvious repo, generated-code, contract, or
  harness ambiguity.
- Adjust `expected_surface` when the required files are clearly implied by the
  task and repo evidence.
- Fix verification commands when package scripts or repo tooling clearly reveal
  the intended command.

## Must Ask Before Changing

Ask Max before changing the packet when a safe repair depends on:

- product behaviour.
- UX decisions.
- security, permission, data, tenancy, migration, legal, or compliance decisions.
- target repo or branch ambiguity.
- scope expansion into another subsystem.
- conflicting priorities, especially "minimal change" versus cleanup/refactor.
- changing the intended feature rather than hardening the packet.
- verification strategy when no obvious local command proves the outcomes.

## Do-Not-Queue Blockers

Say `DO NOT QUEUE` when any of these remain after mechanical fixes:

- Desired behaviour is not observable.
- Outcomes are too broad for one overnight run.
- Packet requires Baby to infer product scope.
- `Inspect first` forces broad discovery before first-edit planning.
- Constraints contradict each other.
- Verification does not cover the outcomes and no local evidence path exists.
- `expected_surface` excludes files that must change.
- Packet asks Baby to prove broad negatives.
- Packet includes runtime protocol instructions that Lathe owns.
- Packet tells Baby to commit, push, merge, stash, reset, checkout, or clean.
- A human-required decision is needed before implementation can start.

## Review Checklist

- Single clear task.
- 3-6-ish independently observable outcomes.
- Known context is evidence, not speculation.
- `Inspect first` is short, owner-file-oriented, and excludes tests by default.
- Unknowns are classified and routed.
- Stop conditions are exact.
- Constraints are compatible and locally testable.
- Expected and suspicious surfaces are realistic.
- `compare_commit` is present and points to the right integration ref.
- Verification commands exist and run from the sandbox root.
- No contradictory strictness.
- No broad negatives without verification.
- No product decisions delegated to Baby.
- No Lathe bridge or tool tutorials in the packet body.

## Reporting

Use this shape after inspection and any safe patches:

- `Result: PASS | PATCHED | BLOCKED`
- `Packets reviewed: ...`
- `Files changed: ...`
- `Mechanical fixes applied: ...`
- `Questions for Max: ...`
- `Do-not-queue blockers: ...`
- `Queue/admission status: not run | passed | failed`

Keep the report concise. Include evidence from packet and repo files for any
non-trivial claim. If nothing blocks queueing, say that directly. If something
blocks queueing, say `DO NOT QUEUE` and name the smallest next decision or edit.
