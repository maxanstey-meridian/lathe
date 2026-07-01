---
name: meridian
description: Meridian house doctrine for backend/frontend architecture, testing, coding decisions, and tool defaults. Use when designing or reviewing module boundaries, ports and adapters, page composition roots, testing strategy, TypeScript defaults, generated-code boundaries, or repo tool choices.
---

# Meridian

Use this skill for Meridian-style engineering doctrine across backend, frontend, testing, and tooling.

## When to Use This Skill

- designing a new backend or frontend app
- reviewing whether an abstraction or seam is earned
- checking ports-and-adapters / VSA boundaries
- deciding page composition root vs component/composable ownership
- choosing testing strategy
- deciding whether generated code should be wrapped
- checking whether a repo matches Meridian tool defaults

## How to Use It

Read only the reference files needed for the task:

- backend structure, module boundaries, ports/adapters:
  - `references/backend-pa-vsa.md`
- frontend structure, page composition roots, provide/inject, dumb views:
  - `references/frontend-pa-vsa.md`
- testing defaults and mock/fake bias:
  - `references/testing-philosophy.md`
- cross-cutting coding doctrine, TypeScript defaults, seam discipline:
  - `references/coding-philosophy.md`
- tool choices and config defaults for TS and .NET:
  - `references/tools.md`
- Rivet backend doctrine for `.NET` contracts, minimal APIs, controllers, and transport-edge patterns:
  - `references/rivet.md`

## Core Rules

- prefer explicit, honest boundaries
- seams must be earned
- keep things local until genuinely shared
- generated code is already a seam
- composition happens at the edge
- Vue/Nuxt page and layout roots provide capabilities with `provideX`; consumers inject them with `injectX`
- tests should default to real behaviour over mock soup
- tooling should stay boring and explicit
- declared failures are results (FluentResults — furniture, allowed in domain); undeclared failures are exceptions
- no type-tag suffixes in TS file names (`.port.ts`, `.service.ts`, `.use-case.ts` — banned; dirs carry the role; `<feature>.module.ts` exempt)
- frontends are SPAs (`ssr: false` assumed)
- integration tests run on a real database engine — EF InMemory is banned; fake the port, never the database

## Frontend Runtime Wiring Default

For Vue/Nuxt frontend ports, use a typed local provide/inject pair:

```ts
export const [injectAuth, provideAuth] = useProvideInject<Auth>("Auth");
```

The naming is deliberate:

- `provideX` belongs in the page/layout composition root that wires the concrete capability.
- `injectX` belongs in components or composables that consume that already-wired capability.
- `useX` is reserved for real implementation composables such as `useRivetAuth`, `usePlatformAuth`, or `useTauriRecorder`.
- Components should normally import `injectX` from `ports/`, not concrete implementation composables from `composables/`.
- The helper should throw when injected outside a provider; missing providers are wiring errors, not nullable runtime states.

## Backend CQRS-Lite Default

Prefer CQRS-lite over repository-as-everything.

Repositories are primarily write-side / consistency-side ports. They load the state needed to perform a business operation and persist the result. A repository method should usually answer: "what state do I need to safely perform this mutation?"

Queries own read shapes. A query should answer: "what shape does this read operation need to return?" Read-side DTOs, list rows, dropdown options, exports, dashboards, and API response projections should be owned by named queries/read services, not piled onto repositories.

For trivial reads, a query may hydrate through a repository and map to a DTO locally. That is an implementation detail of the query. If the read becomes wider, slower, or more UI-specific, replace the query implementation with direct projection without changing the repository contract.

Avoid repositories becoming `GetEverythingForEveryone` abstractions:

- do not add repository methods just because a screen needs a shape
- do not put profile DTOs, dropdown rows, admin search rows, export rows, or dashboard projections on the write repository
- prefer named queries such as `UserProfileQuery`, `UserDropdownQuery`, or `UserAdminSearchQuery`

Use cases/commands orchestrate mutations. Policies make decisions. Transitions transform state. Repositories load/save write-side state. Queries return read-shaped data.

Do not introduce a mediator, bus, or ambient dispatcher just to call these. CQRS-lite is about separating write orchestration from read projection, not forcing every operation through `IMediator`.

Prefer explicit calls and explicit dependencies:

- `changeUserEmail.Handle(command, ct)`
- `userProfileQuery.Execute(userId, ct)`

Avoid using a global mediator as the primary design shape:

- `mediator.Send(new GetUserProfileQuery(...))`
- `mediator.Send(new CheckPermissionQuery(...))`
- `mediator.Send(new SaveUserCommand(...))`

The goal is responsibility honesty: write-side consistency and read-side projection stay separate, named, and locally changeable.

## Planner-mediated execution

When executing a handoff that includes a `## Planner escalation` section:

- The small executor model is a bounded implementer. It does not make architectural, product, or business decisions.
- The planner model is an escalation authority for scoped questions the executor cannot resolve from the handoff or bounded repo inspection alone.
- `ask_planner` is for scoped, specific questions — not broad implementation guidance or general "what next?" queries.
- Planner statuses are binding. The executor must not ignore or reinterpret them.
- `human_required` means hard stop. The executor must stop and report.
- `stop` means hard stop. The executor must stop and report.
- The executor must not continue by making assumptions after a hard stop status.

## Context Discipline

When reading a handoff packet or being asked to digest information, read only the files the user names, or files permitted by bounded repo inspection when executing a handoff, and summarise only what those files contain.

Repo-discoverable unknowns may be resolved by bounded inspection of:

```text
files/globs named by the handoff
Taskfile.yml
package.json
pnpm-workspace.yaml
*.sln
*.csproj
nearest module test files
nearest package/app package.json files
contract source files clearly named or implied by the handoff
nearest existing implementation pattern when specifically requested by the handoff
```

Rules:

- If a handoff lists "Unknowns to resolve before editing", classify them per the taxonomy and resolve only repo-discoverable unknowns through bounded inspection.
- Everything else is out of bounds: uninvited codebase inspection, whole-repo reads, broadening beyond the handoff target area, and resolving human/product/business/security/permission/tenancy/data-retention/billing/legal/compliance/migration-policy decisions by repo searching.
- Every file read adds tokens to context. On local inference with limited context windows, recursive repo inspection exhausts context and crashes the session.
- When in doubt, do less. Answer from what you were given, not from what you could discover.

## Tool Order for Bounded Repo Inspection

Inside an allowed inspection surface, prefer GitNexus before text search:

- Use GitNexus first for code structure, symbol context, route impact, consumers, execution flows, and blast radius.
- Use targeted `rg` second for literal text: labels, comments, config keys, error strings, or generated output.
- Use globs last to discover candidate files only after the target is narrowed.
- Do not start with broad grepping or globbing for code structure questions.

## Mechanical Checking

After completing changes in a Meridian repo, run the mechanical checker and fix all error-level findings:

```sh
~/Sites/plumb/plumb . --json
```

Each finding includes a doc-ref naming the doctrine section it enforces. Fix `error` findings unprompted. For `warn` findings, fix them or state the exception that applies. Do not re-run plumb in a loop on a repo you have not changed.

## Notes

- For backend/frontend structure, do not restate generic clean architecture from scratch; use the Meridian references directly.
- For testing and coding questions, prefer the doctrine here over generic framework advice.
