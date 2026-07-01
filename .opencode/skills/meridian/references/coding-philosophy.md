# Coding Philosophy

## Purpose

Use this when making design decisions, choosing abstractions, reviewing trade-offs, or deciding whether a refactor or seam is justified.

This is the Meridian cross-cutting default.

For concrete structural patterns, see:

- `backend-pa-vsa.md`
- `frontend-pa-vsa.md`

## Core Rule

Prefer explicit, honest code over clever, magical, or abstraction-heavy code.

The job is to make:

- ownership obvious
- provenance obvious
- dependency direction obvious

## Decision Rule

When asked what is right, better, best, default, or proper:

- answer from principles first
- assume greenfield unless constrained otherwise
- separate best architecture from best migration step

Do not confuse:

- “consistent with the current codebase”

with:

- “the right default”

## Seams

Seams must be earned.

Introduce a seam only when there is real:

- variability
- runtime boundary
- ownership boundary
- testability need
- cross-module dependency concern

Do not introduce seams just because the pattern exists.

Fake abstractions are worse than direct code.

## Root Cause

Fix root causes before adding shims.

Prefer fixing:

- the real boundary
- the real model
- the real config
- the real dependency direction

Use shims only as deliberate, temporary last resorts.

## Local Before Shared

Keep things local until they are genuinely shared.

Promote something only when it has:

- more than one real consumer
- stable enough ownership
- clearer shared value than local duplication

Do not create shared dumping grounds.

## Provenance

Names and file boundaries should reveal what a thing really is.

Prefer:

- capability names
- concrete implementation names
- direct imports from the real owner
- explicit registration and wiring

Avoid:

- vague names like `manager`, `helper`, `service`, `provider`
- wrapper layers that hide the real dependency
- re-export structures that hide provenance

## TypeScript Defaults

Treat TypeScript as a design tool.

Defaults:

- prefer `const` functions
- strict typing
- explicit state modelling
- fix the type or the code, not the symptom

Avoid:

- `any` as convenience
- non-null assertions as convenience
- optional-chaining away modelling problems
- nullish-coalescing away unclear state

Where runtime DI identity is needed, prefer abstract-class tokens with interface-like shape.

## Furniture Dependencies

(Settled 2026-06-11.) A small blessed set of libraries is **furniture** — part
of the language as practiced, allowed everywhere including domain and
application: **Zod** (TS) and **FluentResults** (.NET). The
minimal-dependencies bias does not apply to furniture; hand-rolling a Result
type or a schema validator to keep a layer "pure" is worse dogma than a
stable, boring dependency. The furniture list grows only by explicit ruling,
never by precedent-creep.

## Generated Code

Generated code is already a boundary.

Do not wrap generated clients/contracts one-for-one unless there is real capability abstraction to add.

Good reasons to add a layer:

- combine multiple generated calls into one capability
- add non-trivial policy/orchestration
- hide a genuinely unstable external boundary

Bad reasons:

- “we always wrap APIs”
- renaming generated methods without adding meaning

## Composition

Prefer composition at the edge.

That means:

- pages compose frontend capabilities
- modules compose backend capabilities
- wiring is explicit
- assembly happens where ownership is clear

Avoid ambient dependency soup.

## Anti-Magic Bias

Prefer explicit registration and orchestration over framework magic.

Be suspicious of:

- auto-scanning
- hidden container behaviour
- reflection-heavy conventions
- smart wrappers that hide where work really happens

## Smell Checks

The code is probably drifting if:

- provenance is hard to trace
- generated code is wrapped for sport
- tiny features are buried under heavy ceremony
- real complexity is hidden behind bland names
- the fix is local but the cause is systemic

## Summary

The intended coding style is:

- principle-first decisions
- explicit seams only where earned
- local-first structure
- root-cause fixes over shims
- strict, honest TypeScript
- obvious provenance
- explicit composition at the edge
