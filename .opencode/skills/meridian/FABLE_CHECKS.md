# Fable Checks — Mechanical Rule Catalog for `meridian-check`

Derived from: SKILL.md, references/{backend-pa-vsa, frontend-pa-vsa,
testing-philosophy, coding-philosophy, tools, rivet}.md, plus rules inferred from the
doctrine's intent and validated against casebridge / speechscribe-azure.

## Design model

**Convention-triggered, zero config.** Rules only fire where the repo has opted into
the pattern the rule governs. The structure is the config:

| Trigger detected | Rule packs activated |
|---|---|
| `nuxt.config.*` | FE |
| `pages/**/logic\|ports\|adapters/` dirs | FE purity rules for those dirs |
| `*.csproj` + `Modules/` dir | BE |
| `*Contract.cs` or `Rivet.Attributes` reference | RV |
| RV(v1) artifacts: `generated/` (or `generated/rivet/`) dir with `rivet.ts`, `client/`, or `types/` | RV frontend rules, variant v1 |
| RV(v2) artifacts: dir with both `openapi.json` and `schema.d.ts` | RV frontend rules, variant v2 |
| `typed-inject` in package.json, `*.port.ts`, lowercase `application/ports/`, or a layer-shaped TS tree (lowercase `domain/` + `application|app/` siblings) | BE-TS |
| test project / `tests` dir | TE |
| always | TO, CP |

Absence of a convention is never a violation.

**Rivet variant (v8, 2026-06-11).** Rivet v2 replaced the generated TS client with
`openapi.json` + openapi-typescript `schema.d.ts` + a hand-written openapi-fetch
facade. plumb detects the variant per repo (`v1`/`v2`/`both`/`none`, artifact
fingerprints primary, `checks/_lib/rivet-variant.mjs`) and exports it to producers
as `PLUMB_RIVET_VARIANT` (like `PLUMB_CI`). MER-FE-005/006 are v1-pinned
(suppressed under pure v2); MER-FE-007 is v2-pinned; MER-FE-003 covers both
variants' import specifiers. See FABLE_CONTRACT.md §5/§11.9.

**Severity:** `error` (hard doctrine rule) / `warn` (default-with-exceptions) /
`info` (heuristic, advisory).

**Tiers (implementation cost):**
- **T1** — grep/glob/file-existence. An afternoon.
- **T2** — import/dependency graph (dependency-cruiser for TS; namespace-using scan
  for C#). Days.
- **T3** — AST/Roslyn-level. Build later, only where T1 precision is too low.
- **T4** — pipeline checks (run a command, diff output).

Every rule carries an ID that maps back to a skill section, so a small model can be
handed `MER-FE-001 file:line` plus the doctrine paragraph and fix it without holistic
understanding.

`✗ CONFIRMED` = the probe on 2026-06-10 found real violations of this rule in the
gold-standard repos.

---

## FE — Frontend layer rules (frontend-pa-vsa.md)

### Layer purity

- **MER-FE-001** `error` T1 — Files in `**/logic/**` must not import `vue`, `nuxt`,
  `#imports`, `#app`, `@vueuse/*`, `pinia`, or any framework package.
  (§Logic — "hard rule") ✗ CONFIRMED in both repos (`recording-status.ts` imports
  `onUnmounted, reactive`; `public-payment-flow.ts` imports `ref`).
- **MER-FE-002** `error` T1 — Files in `**/adapters/**` must not import vue/nuxt
  framework code. "If it needs `ref`, `computed`, `watch`, or lifecycle hooks, it is
  not an adapter." (§Adapters)
- **MER-FE-003** `error` T1 — Components (`**/components/**`) must not import
  generated Rivet clients. Variant-neutral: v1 path specs (`generated/rivet/client`,
  `*/contracts/client`) AND the v2 bare workspace contracts-package import (package
  name derived from the package.json nearest each detected artifact dir, never
  hardcoded). `import type`-only lines exempt — a DTO type is not a client call.
  (§Components — "should not call generated clients directly")
  ✗ CONFIRMED — 6+ casebridge components.
- **MER-FE-004** `error` T2 — Layer import ordering: `logic ← ports ← adapters ←
  composables ← pages`; components consume composed capabilities only. Concretely:
  logic imports nothing framework; ports import only types + the provide/inject
  helper; adapters import only logic/ports; components never import adapters.
  (§Dependency Rule)
- **MER-FE-005** `error` T1 — No direct import of `rivetFetch` / the generated
  `rivet.ts` runtime outside the generated dir and the bootstrap plugin. (Inferred
  from casebridge's eslint guardrail + §Rivet Rules) **v1-pinned (v8):** Rivet v2
  has no `rivetFetch` runtime — suppressed under pure variant v2; no v2 analogue
  (the facade's `client` is the intended import).
- **MER-FE-006** `warn` T3 — No try/catch around awaited generated-client calls;
  result handling is `{ unwrap: false }` + `.isOk()` narrowing. Encoded
  exceptions: calls already passing `unwrap: false` (try/catch there is network
  handling, legal) and sync client helpers (URL builders — nothing to narrow).
  (rivet.md §Frontend Result Handling; fork settled 2026-06-10) ✗ CONFIRMED 76×
  casebridge, 4× speechscribe. **v1-pinned (v8):** `unwrap: false` is
  unsatisfiable under v2's openapi-fetch (never throws on HTTP errors) —
  suppressed under pure variant v2; bare `@scope/contracts` imports count as
  client imports only under confirmed v1. MER-FE-007 is the v2 analogue.
- **MER-FE-007** `warn` T3 — **v2-pinned (v8):** awaited contracts-client
  `.GET/.POST/...` calls must not discard openapi-fetch's error channel — flag
  destructuring that binds `data` but not `error`, and direct `.data` access on
  the awaited call expression. Compliant (golden exemplar): capture the result,
  narrow on `result?.data` truthiness (data/error are mutually exclusive),
  `.catch(() => null)` for transport failure. General "must handle error" flow
  analysis and `.then()`-chaining deliberately not mechanized (below the §7
  precision bar — FABLE_CONTRACT.md §11.9). (rivet.md §Frontend Result Handling)

### Ports

- **MER-FE-010** `error` T1/T3 — Port files contain only type/interface definitions
  plus the `useProvideInject` tuple export. No fetch calls, no client imports, no
  business logic. (§Ports — "port files contain only the type and the injection
  helper") T1 heuristic: flag any non-type import or function declaration; T3 for
  precision.
- **MER-FE-011** `error` T1 — The provide/inject pair must be exported as
  `[injectX, provideX]` — inject first, names prefixed `inject`/`provide`.
  (§Provide/Inject Pattern)
- **MER-FE-012** `error` T1 — Ports must not export `useX`-named bindings for the
  provided port. `useX` is reserved for implementation composables.
  (SKILL.md §Frontend Runtime Wiring; §Naming)
- **MER-FE-013** `warn` T1 — Port type names must be capability-shaped: flag exports
  in `ports/` ending in `Service`, `Manager`, `Helper`, `DataService`, or containing
  `Dto` in the port name. (§Ports good/bad lists)
- **MER-FE-014** `warn` T1 — The canonical `useProvideInject` helper must throw on
  missing provider (grep helper body for `throw`). "Missing providers are wiring
  errors, not nullable runtime states." (SKILL.md)
- **MER-FE-015** `warn` T2 — A port that mirrors a generated client one-for-one
  (port method names ⊆ generated client function names for the same module) is a
  fake API abstraction. (§Rivet Rules bad examples) T3 for precision; ship as
  `info` first. **v1-only — explicitly not ported to v2** (2026-06-11): the v2
  facade is hand-authored, so "mirroring" it isn't mechanically
  distinguishable from legitimately wrapping it.

### Composition roots

- **MER-FE-020** `error` T1 — `provideX(` calls may appear only in `pages/**/*.vue`,
  `layouts/**/*.vue`, and `app.vue` — never in `components/`. (§Pages As Composition
  Roots, §Components — "reach around the page composition root")
- **MER-FE-021** `warn` T2 — Components importing implementation composables
  (`from "../composables/use*"`) **when a port for the same capability exists** in a
  sibling/ancestor `ports/`. Qualifier is required — component-local composables with
  no port are legitimate. (SKILL.md — "Components should normally import `injectX`
  from `ports/`")
- **MER-FE-022** `warn` T2 — A composable that implements a shared port
  (`app/shared/ports/X`) must live at its composition root, not in
  `shared/composables/` — flag shared composables imported by exactly one
  layout/page. (§Promotion — "Composables stay at their composition root")

### Promotion & provenance

- **MER-FE-030** `error` T1 — No re-export shims: `export { X } from` /
  `export * from` pass-through files in `shared/`, `ports/`, or page-local dirs
  (generated barrels exempt). (§Promotion, §Failure Modes)
- **MER-FE-031** `warn` T2 — Items in `app/shared/` must have consumers in ≥2
  composition-root subtrees. Single-consumer shared code was promoted prematurely.
  (§Promotion; coding-philosophy §Local Before Shared)
- **MER-FE-032** `error` T2 — No cross-subtree imports: a page/layout subtree must
  never import from another page's local dirs. "Never cross; always Common" — the
  fix is always promotion to `app/shared/` (amendment 2026-06-10, plumb
  FABLE_CONTRACT.md §9; hardens §Promotion from guidance to absolute rule).
- **MER-FE-033** `error` T1 — No `app/features/` directory. Page-local colocation is
  the structure. (§Default Recommendation, §Failure Modes)

### Naming & hygiene

- **MER-FE-040** `warn` T1 — Composable files export a `use*` function whose name
  matches the filename. (Convention throughout)
- **MER-FE-041** `info` T1 — Composable filenames are camelCase `useX.ts`; flag
  kebab-case `use-*.ts` in `composables/` dirs. (§Composables — File naming; fork
  settled 2026-06-10) ✗ CONFIRMED 23× speechscribe.
- **MER-FE-042** `info` T1 — Composables over ~150 lines with zero imports from
  `logic/` → suggest extracting pure logic. (§Composables — "If a composable gets too
  large, pull pure logic down into `logic/`") Heuristic; ship as info.
- **MER-FE-043** `warn` T1 — `useState(` may appear only inside `composables/`
  files; every other layer consumes the owning composable, never the string key.
  (§Composables — Framework state; fork settled 2026-06-10) ✗ CONFIRMED —
  casebridge's plugin↔app.vue `"app-booted"` coupling.

---

## RV — Rivet rules (rivet.md)

### Backend authoring

- **MER-RV-001** `warn` T1 — Prefer `[RivetContract]`; flag `[RivetClient]` as the
  non-default shortcut mode ("not the house-style default for serious APIs").
  (§RivetClient vs RivetContract)
- **MER-RV-002** `error` T1 — Routes must come from the contract: flag string-literal
  routes in `Map{Get,Post,Put,Delete,Patch}(` and `[Http*("...")]` anywhere in a
  contract-bearing repo (repo-level trigger since contracts moved to top-level
  `Contracts/`). Encoded exception: `Program.cs` — bootstrap ops endpoints
  (health, root) have no contract to come from. (§Practical Rules; re-escalated
  error 2026-06-10 with the contract-location fork — casebridge's 79 literal
  routes are migration backlog.)
- **MER-RV-010** `error` T1 — `*Contract.cs` files live in top-level
  `Contracts/{Module}/`, never inside `Modules/`. (§Contract Location; fork
  settled 2026-06-10) ✗ CONFIRMED 22× casebridge.
- **MER-RV-003** `warn` T1 — Controller/endpoint handler methods in contract-bearing
  modules should delegate through `Contract.X.Invoke<...>` — flag handler methods
  with no `.Invoke` call. (§Wrap the full handler body in the Rivet lambda)
- **MER-RV-004** `warn` T3 — Outer ASP.NET endpoint lambda must be expression-bodied;
  flag `=> { ... return await ...Invoke` block bodies. (§Minimal API rules) T1
  approximation possible but noisy.
- **MER-RV-005** `info` T1 — Route definitions with no `.Returns<...>(4xx)` →
  expected error responses should be declared explicitly. (§Contract-first rules)
- **MER-RV-006** `warn` T1 — Contract classes contain only `RouteDefinition` fields
  and route constants — no methods, no logic. ("keep host-specific details out of the
  contract"; anti-pattern: "mixing domain/application concerns into the contract")
- **MER-RV-007** `warn` T1 — Exactly one `ToResult`/`ToActionResult` conversion
  extension per app ("transport edge converts once"). Flag duplicates. (§Transport
  edge converts once)
- **MER-RV-008** `warn` T1 — `Program.cs` composes endpoint groups
  (`MapXEndpoints()`); flag inline `Map*(` handler bodies in `Program.cs`.
  (§Minimal API rules)
- **MER-RV-009** `warn` T1 — Minimal API endpoint files named `*Endpoints.cs`
  exposing `MapXEndpoints(this IEndpointRouteBuilder ...)` — flag `WebApplication`
  as the extension target. (§Controllers vs Minimal APIs)

### Frontend / generated code

- **MER-RV-020** `error` T1 — No hand-written files inside generated output dirs;
  every file there carries the generated header. Generated code is read-only.
  Variant-aware since 2026-06-11 (shared v8 fingerprints): v1 dirs keep the
  header rule; v2 artifact dirs may contain ONLY `openapi.json` +
  `schema.d.ts` (facade lives in `src/`), and `schema.d.ts` must carry its
  openapi-typescript header. (coding-philosophy §Generated Code)
- **MER-RV-021** `error` T1 — Exactly one `configureRivet(` call, located in a
  plugin. ("bootstrap Rivet once at the app boundary")
- **MER-RV-022** `warn` T1 — Transport customization (auth, retry) happens by
  injecting `fetch` into `configureRivet`, never by wrapping/patching generated
  code — flag wrappers that re-implement generated client functions. (Inferred from
  casebridge `createAuthFetch` pattern; §Rivet Rules)
- **MER-RV-023** `warn` T1 — Lint config must exclude generated dirs, and the
  `no-restricted-imports` guardrail banning raw `rivetFetch` must be present
  (meta-check: the guardrail itself is installed). (Inferred from casebridge)
- **MER-RV-024** `info` T4 — Generated output is stale: re-run
  `dotnet rivet --project ... --output <tmp>` and diff against checked-in output.
  CI-tier check.
- **MER-RV-025** `warn` T1 — Generated Rivet output lives in a workspace
  `packages/contracts` package, not an in-app dir (`ui/generated/rivet/`). One
  repo-level finding per offending generated dir. Variant-aware since
  2026-06-11: placement enforced from the v8 fingerprints for BOTH variants —
  a v2 artifact dir named anything, anywhere outside `packages/`, fires.
  (§Generated Output; fork settled 2026-06-10) ✗ CONFIRMED casebridge.
- **MER-RV-026** `warn` T1 — Rivet v1 detector. A declared Rivet below the v2
  generation floor (`Rivet.Attributes` < 0.35.0 in `*.csproj`, or `rivet-ts`
  < 0.11.0 in package.json dependency blocks) should migrate to the v2
  (openapi-typescript) generation. Anything at or above the floor is supported —
  minor bumps within v2 (0.36, 0.37, …) are never a finding. Unparseable specs
  (`*`, `file:`, `workspace:`, ranges) never a finding. (rivet.md#generated-output)
  ✗ CONFIRMED golden (rivet-v2 branch, `Rivet.Attributes` 0.34.3).

---

## BE — .NET backend rules (backend-pa-vsa.md, SKILL.md)

### Dependency direction (the non-negotiables)

- **MER-BE-001** `error` T1/T2 — `Domain/` files: no `using` of any
  `*.Application.*` or `*.Infrastructure.*` namespace; no framework/SDK usings
  (`Microsoft.AspNetCore.*`, `Microsoft.EntityFrameworkCore*`, `Npgsql`, `Azure.*`,
  HTTP clients). (§Non-Negotiable Dependency Rules)
- **MER-BE-002** `error` T1/T2 — `Application/` files: no `using` of sibling
  `*.Infrastructure.*` namespaces or infrastructure packages. (same)
- **MER-BE-003** `error` T2 — Auto-discover modules from `Modules/<X>/`; flag
  `Modules.X` code using `Modules.Y.Domain`. (§Across modules)
- **MER-BE-004** `error` T2 — Flag `Modules.X` using `Modules.Y.Infrastructure`.
- **MER-BE-005** `error` T1/T2 — Flag ANY `Modules.X` using of `Modules.Y.*`.
  "Never cross; always Common": cross-module ports live in `Common/Ports` only —
  the sibling-`Application/Ports` exposure path is abolished (amendment 2026-06-10,
  see plumb FABLE_CONTRACT.md §9; supersedes §Across modules / §Cross-module ports).
  Subsumes MER-BE-003/004, which remain as distinct IDs for sharper messages.
- **MER-BE-006** `warn` T2 — Types in `Common/` referenced by only one module are
  secretly owned by that module — Common is not a dumping ground. (§Shared/common
  rule; §Decision Heuristics)

### Structure & registration

- **MER-BE-010** `error` T1 — Each `Modules/<X>/` has `<X>Module.cs` exposing
  `Add<X>Module(this IServiceCollection ...)`, and `Program.cs`/top-level composer
  calls it. (§Standard Module Shape)
- **MER-BE-011** `warn` T1 — Controllers live at the module root; no `Interface/`
  folder. (§Standard Module Shape rules)
- **MER-BE-012** `error` T1 — No DI auto-scanning: flag Scrutor `.Scan(`,
  `.FromAssemblies`, `AddClassesFromAssembly`, reflection-based registration.
  (§.NET coding style — "no DI auto-scanning"; coding-philosophy §Anti-Magic)
- **MER-BE-013** `error` T1 — No MediatR: flag package reference, `using MediatR`,
  `IMediator`, `ISender`, `mediator.Send(`. (§.NET style; SKILL.md §CQRS-Lite)
- **MER-BE-014** `error` T1 — No AutoMapper: flag package reference and
  `CreateMap<`. (§.NET style)

### Types & naming

- **MER-BE-020** `warn` T1 — Concrete classes in `Modules/` are `sealed`.
  Exceptions list (encode, don't special-case ad hoc): Temporal workflow classes,
  open-generic validators, `BackgroundService` subclasses where the framework
  requires otherwise. (§.NET style) ✗ CONFIRMED 4 hits in casebridge (2 legitimate
  exceptions → proves the exception list is needed).
- **MER-BE-021** `warn` T1 — Types named `*Command`, `*Result`, `*Request`,
  `*Response`, `*Dto`, `*Data`, `*Snapshot` declared as `class` instead of `record`.
  EF entities (`*Entity`) exempt. (§.NET style — "records for DTOs, commands,
  results, value objects")
- **MER-BE-022** `error` T1 — Use cases named `*UseCase` with
  `ExecuteAsync(Command, CancellationToken)`; flag `ExecuteAsync` overloads missing
  a `CancellationToken` parameter. (§.NET style + recommended signature)
- **MER-BE-023** `warn` T1 — No vague type names in `Modules/`: `*Manager`,
  `*Helper`, `Default*`, `Base*`; `*Service` flagged unless framework-required.
  (coding-philosophy §Provenance; backend-pa-vsa naming)

### Transport edge

- **MER-BE-030** `error` T1 — Controllers/endpoint classes must not take
  `I*Repository` or `DbContext` constructor/handler parameters — transport calls use
  cases/queries only. (§Inside a module — "controllers call application services or
  use cases only"; §Failure Modes #4)
- **MER-BE-031** `error` T1 — No `Microsoft.EntityFrameworkCore` / `Npgsql` usings
  in controller or `*Endpoints.cs` files. (same)

### CQRS-lite (SKILL.md)

- **MER-BE-040** `warn` T1 — Repository port interfaces (`Application/Ports/I*Repository.cs`)
  with methods returning `*Dto` types — read shapes belong to named queries, not
  write repositories. (SKILL.md §Backend CQRS-Lite — "do not put profile DTOs,
  dropdown rows … on the write repository")
- **MER-BE-041** `info` T1 — Repository interfaces exceeding ~10 methods →
  "GetEverythingForEveryone" smell. Heuristic, advisory only. (same)

### Validation, records & errors (fork winners, settled 2026-06-10)

- **MER-BE-050** `warn` T1 — No `Result.Validation(` in `Application/` code —
  shape validation is FluentValidation at the transport edge; use cases keep
  domain invariants only. (§Validation) ✗ CONFIRMED 2× speechscribe.
- **MER-BE-051** `warn` T3 — Command/Result records are siblings of the use
  case, never nested inside another type (brace-depth scan; strings/comments
  blanked). (§Commands and Results) ✗ CONFIRMED 39× speechscribe.
- **MER-BE-052** `warn` T1 — No `*ErrorDto` type declarations — the canonical
  envelope is `ErrorResponse(Code, Message, Errors)`. (§Error Envelope)
  ✗ CONFIRMED 3× speechscribe.
- **MER-BE-053** `warn` T1 — A use case's `Execute`/`ExecuteAsync` must not return a
  transport-shaped `*Response`/`*Dto` — application speaks Commands in / Results out;
  return a domain type or `*Result` and map at the edge (or drop the use case if it only
  maps). (§Commands and Results) ✗ CONFIRMED 1× casebridge (`GetCurrentUserUseCase` →
  `AuthUserDto`); speechscribe clean (27 UCs).
- **MER-BE-060** `warn` — entity-config ownership: `IEntityTypeConfiguration<T>`
  lives in the owning module's `Infrastructure/`; a config in module X for an
  entity declared in module Y's `Domain/`, or a config outside any module
  (centralised persistence dir), is a finding. (§Persistence; settled
  2026-06-10) SHIPPED v7. Fires nowhere live — casebridge's
  `Modules/<X>/Infrastructure/Persistence/` layout is already the golden
  shape; fixtures prove the mechanism.

## BE-TS — TypeScript backend rules (backend-pa-vsa.md §TS/Nest) — SHIPPED v5 2026-06-10

Pack trigger: `typed-inject` in package.json, `*.port.ts` files, lowercase
`application/ports/` dirs (lowercase keeps C#'s `Application/Ports` out), or a
layer-shaped TS tree. File naming per §9.1 as RE-RULED by Max 2026-06-11: **no
type-tag suffixes at all** — `.port.ts` is itself a finding now (BT-003), along
with `.service.ts`/`.provider.ts`/`.use-case.ts`/`.interface.ts`/`.handler.ts`
(last added 2026-06-11, scaffolder-plan D1); dirs carry
the role (`application/ports/clock.ts`), `<feature>.module.ts` is the sole
exception. (A `*.port.ts` file still works as a pack *marker* — it indicates a
TS backend while also being a naming finding.)

- **MER-BT-001** `error` T3 — Every exported class in a port file is `abstract`
  with an empty `private constructor()` and only abstract methods — no fields,
  no non-abstract methods, no statics. (§TS/Nest port convention) ✗ CONFIRMED
  3× rivet-ts (`protected constructor()` ports).
- **MER-BT-002** `error` T3 — Adapters `implements` ports; a class `extends` a
  name imported from a `/ports/` path is a finding. ✗ CONFIRMED 3× rivet-ts
  (the coupled half of its BT-001 hits).
- **MER-BT-003** `warn` T1 — File-naming: vagueness (`default-*.ts`,
  `base-*.ts`, `*-interface.ts`) AND the type-tag suffix family (`.port.ts`,
  `.service.ts`, `.provider.ts`, `.use-case.ts`, `.interface.ts`, `.handler.ts`) in
  `src/`/`modules/` trees — dirs carry the role, files are named after the
  thing (`<feature>.module.ts` exempt; `.spec/.test/.d.ts` are not tags).
  (§9.1 v2, Max 2026-06-11) ✗ CONFIRMED 39× across confer (10 `.use-case.ts`),
  perch/perch-next (25 `.port.ts`/`.service.ts`), rivet-ts sample (2),
  glyphantics (2 `.service.ts`).
- **MER-BT-004** `warn` T3 — typed-inject classes carry
  `public static inject = [...] as const`; injected deps are `private readonly`
  constructor-promoted. Self-gated on typed-inject in package.json — inversify/
  Nest idioms are never findings. ✗ CONFIRMED perch-next (manual field
  assignment of a constructor arg).
- **MER-BT-005** `warn` T1 — No `*Service` / `*Interface` / `Default*` / `Base*`
  class names in `modules/` trees (`*.module.ts` Nest classes exempt). (§TS
  naming conventions) ✗ CONFIRMED 9× across perch/perch-next/glyphantics/
  coingroup (`PetStateMachineService`, `BitcoinApiService implements
  BitcoinApiServiceInterface`).
- **MER-BT-010** `error` — TS domain purity: `domain/` imports only its own
  module's `domain/`; known backend framework packages (`@nestjs/*`, express,
  fastify, vue, typed-inject, inversify, prisma, typeorm) in domain are
  findings. Relative imports only — aliases skipped for precision.
  (§Non-negotiable dependency rules) SHIPPED v7. ✗ CONFIRMED 5× glyphantics
  (`domain/game/game.service.ts` importing `@nestjs/common` + infrastructure).
- **MER-BT-011** `error` — TS `application|app/` must not import
  `infrastructure|infra/` — depend on the port, DI wires the adapter.
  (§Non-negotiable dependency rules) SHIPPED v7. Fires nowhere live (confer +
  rivet-ts clean); fixtures prove the mechanism.
- **MER-BT-012** `error` — never cross; always common in TS: `modules/<X>`
  must not import `modules/<Y>`; `modules/common` is the shared location.
  Encoded exception: `*.module.ts` files are composition roots — Nest module
  classes importing sibling modules is framework wiring (earned by
  glyphantics `game.module.ts`). (§Across modules) SHIPPED v7.

---

## TE — Testing rules (testing-philosophy.md)

- **MER-TE-001** `warn` T1 — Architecture tests (or the Meridian arch-rules package)
  present in any repo with `Modules/` — "if the boundary matters enough to talk
  about repeatedly, it matters enough to test." (§Architecture boundaries)
- **MER-TE-002** `info` T1 — Mock-density heuristic: test files with >5
  `Substitute.For` / `vi.mock` instances → mock-soup warning. (§Mocks, §Smell
  Checks) Advisory only — density is the smell, not presence (fork settled
  2026-06-10: NSubstitute presence alone is never a finding). SHIPPED v4.
  ✗ CONFIRMED 17× casebridge.
- **MER-TE-003** `warn` T1 — No call-order/choreography assertions:
  `Received.InOrder`, ordered-verify patterns. ("Do not over-specify internal call
  choreography") Exempt when the choreography is itself the behaviour — ship as warn.
- **MER-TE-004** `info` T1 — Every `logic/` module has a corresponding spec file —
  pure logic is "the cheapest and most stable tests in the codebase"; its absence is
  the notable case. (Inferred from §Pure logic + frontend §Testing Bias)
- **MER-TE-005** `warn` T1 — Test-double vocabulary: hand-rolled doubles are
  `Fake*`/`InMemory*`/`Inline*` — flag `class Mock*`/`Stub*` declarations in test
  code. (§Test Doubles; codified 2026-06-10) SHIPPED v4. ✗ CONFIRMED 8×
  casebridge, 3× speechscribe.
- **MER-TE-006** `warn` T1 — Frontend tests live in top-level `tests/`; flag
  colocated `__tests__/` dirs and specs inside app source subtrees. Encoded
  exception: only app-tree paths (app/pages/components/…) are scanned — sibling
  workspace packages' test dirs are BE-TS territory (earned by confer).
  (§Test Location; fork settled 2026-06-10) SHIPPED v4. ✗ CONFIRMED 15×
  casebridge.
- **MER-TE-007** `warn` — EF InMemory provider banned for integration tests
  (validates neither SQL nor relational behavior); Testcontainers or
  SQLite-in-memory. One finding per file. (§Test Substrate; settled
  2026-06-10) SHIPPED v7. ✗ CONFIRMED 5 files in cohort; casebridge already
  on PostgresFixture (Testcontainers).

---

## TO — Tooling/config rules (tools.md)

- **MER-TO-001** `error` T1 — pnpm is the package manager: `packageManager` field
  present; no `package-lock.json` / `yarn.lock`.
- **MER-TO-002** `warn` — TS toolchain sanitation: `.oxlintrc.json` +
  `.oxfmtrc.json` present and each a SUPERSET of the golden base in
  `~/Sites/plumb/configs/` (repos extend, never contradict; scalar golden
  severity matches a repo `[severity, options]` tuple); competing configs
  (`.prettierrc*`, `biome.json`) are findings. Self-gates on package.json +
  TS/Vue source. SHIPPED v6. ✗ CONFIRMED: confer's empty oxfmtrc (7 gaps),
  glyphantics/acquire prettier, 6 repos missing configs.
- **MER-TO-003** `warn` T1 — Lint config ignores generated output dirs.
- **MER-TO-004** `warn` T1 — Typecheck script uses `vue-tsc`; tests use `vitest` +
  `happy-dom`.
- **MER-TO-005** `warn` — eslint is the Vue layer only: apps with `.vue` files
  need an eslint config referencing `@nuxt/eslint`/`eslint-plugin-vue`/`withNuxt`
  (oxlint can't lint Vue templates yet — oxc RFC, verified 2026-06-10); an eslint
  config whose own subtree has no `.vue` files is a finding. Vue-ness judged per
  config subtree (§7, coingroup). SHIPPED v6. ✗ CONFIRMED: speechscribe, confer,
  perch-next, rehd, glyphantics missing the layer; coinwatcher-api's stray eslint.
- **MER-TO-010** `error` T1 — `global.json` present, pins .NET 10,
  `rollForward: latestFeature`.
- **MER-TO-011** `error` T1 — csproj: `<Nullable>enable</Nullable>` +
  `<ImplicitUsings>enable</ImplicitUsings>`.
- **MER-TO-012** `warn` — `.editorconfig` is the .NET style authority: present and
  containing every golden section/key=value (`configs/editorconfig.dotnet` — the
  canonical 116-liner); analyzers on (`EnforceCodeStyleInBuild`/`AnalysisLevel`
  in csproj or Directory.Build.props). Severity-TIGHTENING is compliant (§7,
  reel: error ≥ warning). SHIPPED v6. ✗ CONFIRMED: casebridge + speechscribe +
  reel analyzers off; lagon/HPA editorconfigs missing 7 naming-rule lines.
- **MER-TO-013** `info` T1 — `Taskfile.yml` present once the repo has real workflow
  commands; `turbo` for real monorepos.
- **MER-TO-014** `warn` — CSharpier wired in csproj repos: `CSharpier.MsBuild` in
  a csproj/`Directory.*.props`, or a dotnet tool manifest entry. CSharpier is
  config-free — plumb checks wiring only, never a style file. SHIPPED v6.
  ✗ CONFIRMED: speechscribe, cohort, lagon, HPA (casebridge already wired ✓).

## CP — Cross-cutting (coding-philosophy.md)

- **MER-CP-001** `warn` T1 — Count of non-null assertions (`!` postfix) and
  `as any` per file above threshold → "fix the type or the model, not the symptom".
  (Strict-mode meta-check + grep; the type-checker handles the rest.)
- **MER-CP-002** — vague names: covered by MER-BE-023 / MER-FE-013 / MER-BT-005.
- **MER-CP-003** — re-export provenance hiding: covered by MER-FE-030; apply the
  same rule to TS backend `src/`.
- **MER-CP-004** — one-for-one generated wrappers: covered by MER-FE-015 /
  MER-RV-022.

---

## Fork decisions — settled 2026-06-10 (see FABLE_REVIEW.md decision table)

Winners picked 2026-06-10; each unblocked a rule. **v4 SHIPPED 2026-06-10** —
all winners are enforced and synced into the reference prose:

- contract location → **top-level `Contracts/`**: new placement rule; RV-002
  re-escalates to `error` (casebridge's 78 relative-literal attribute routes
  become migration backlog, like the BE-005 amendment).
- frontend result handling → **`unwrap: false` + `.isOk()`**: flag unwrap+try/catch
  around generated client calls.
- validation placement → **FluentValidation at the edge**: flag inline
  `Result.Validation` in use cases; use cases keep domain invariants only.
- Command/Result nesting → **sibling records**: flag `record Command/Result`
  nested inside `*UseCase` classes.
- canonical error DTO → **`ErrorResponse(Code, Message, Errors)`**: flag
  `ValidationErrorDto`-style validation-only envelopes.
- composable file casing → **camelCase `useX.ts`**: MER-FE-041 unblocked — flag
  kebab-case `use-*.ts`.
- frontend test location → **top-level `tests/`**: flag colocated `__tests__/`
  dirs; sharpens MER-TE-004's spec lookup. (Supersedes the open question about
  FE-001's `__tests__` exemption inside `logic/` — colocated tests are now
  themselves findings.)
- generated output location → **workspace `packages/contracts`**: placement rule;
  sharpens FE-003/005 and RV-020 trigger globs.
- test-double default → **hand-rolled fakes** (`Fake*`/`InMemory*` in TestSupport,
  MER-TE-005 at warn); NSubstitute stays legal at narrow seams — MER-TE-002
  (density) stays info, presence alone is never a finding.

- `useState()` policy → **blessed, behind composables** (settled 2026-06-10):
  `useState(` may appear only inside `composables/` files; everything else
  consumes the owning composable, never the string key. New rule (warn, T1) —
  casebridge's plugin↔app.vue `"app-booted"` key coupling is the confirmed
  target; speechscribe already complies. No `state/` dir exists or is needed —
  composables are the state home in the layer taxonomy.

No forks remain open.

## Explicitly NOT mechanizable — stays with the model

For honesty about what a green tick means: pass = "no boundary/naming/hygiene
drift", **not** "Meridian compliant". The checker cannot see:

- whether a seam is *earned* (the central doctrine judgment)
- whether a port is wider than the actual capability
- whether logic that *should* have been extracted to `logic/` exists at all
  (absent files don't trigger rules; MER-FE-042 is only a weak proxy)
- use case vs direct service judgment calls
- whether a module deserves to exist (bounded-context judgment)
- best-architecture vs best-migration-step distinctions
- domain logic hiding as inline `if/else` in use cases

## Rollout order

1. **v1 (T1 grep pack)** — MER-FE-001/002/003/005/011/012/020/030/033,
   MER-RV-001/002/020/021, MER-BE-012/013/014/020/022/030/031, MER-TO-001/010/011.
   High precision, confirmed-real targets, an afternoon of work.
2. **v2 (T2 graph pack) — SHIPPED 2026-06-10.** FE: dependency-cruiser (wrapped
   per FABLE_CONTRACT.md §2.3, plus a .vue import extractor — dependency-cruiser
   does not parse SFCs) powers MER-FE-004/021/022/031; MER-FE-032 kept its own v1
   resolver. BE: namespace-using scan powers MER-BE-001/002; Common type-reference
   counting powers MER-BE-006 (interface-only candidates in port files — signature
   DTOs undercount via `var`; `*Exception` exempt as doctrine-legal Common error
   types).
3. **v3 (deeper-integration tier) — SHIPPED 2026-06-10.** v3a: `Meridian.Analyzers`
   NuGet (Roslyn analyzers MERBE001/002/005 mirroring MER-BE-001/002/005 at build
   time; plumb stays source of truth — FABLE_CONTRACT.md §11.4, source under
   `~/Sites/plumb/dotnet/`). v3b: AST-tier MER-FE-010 (port-file shape, error;
   ambient `declare` statements and hand-written `injectX` helpers exempt) and
   MER-FE-015 (port mirroring a generated Rivet client, ships at `info` as
   specified). v3c: MER-RV-024 regenerate-and-diff staleness check, CI-tier behind
   `plumb --ci` (contract §5) — snapshots and restores the generated dir, never
   mutates the tree.
4. Calibrate against casebridge + speechscribe after each tier; every false positive
   becomes either an encoded exception or a deleted rule.
5. **v4 (fork-decision pack) — SHIPPED 2026-06-10.** Ten new rules
   (RV-010/025, FE-006/041/043, BE-050/051/052, TE-005/006) plus TE-002, the
   RV-002 warn→error re-escalation, and the runner's TE-pack detection (the §5
   marker existed in the contract table but was never implemented — TE findings
   were silently pack-filtered). All fork winners synced into the reference
   prose (rivet.md §Contract Location/§Generated Output/§Frontend Result
   Handling; backend-pa-vsa.md §Commands and Results/§Validation/§Error
   Envelope; frontend-pa-vsa.md §File naming/§Framework state;
   testing-philosophy.md §Test Doubles/§Test Location). Post-v4 baselines:
   casebridge 224e/111w/17i, speechscribe 6e/55w/23i (detail in plumb
   FABLE_CONTRACT.md §12).
6. **v5 (BE-TS pack) — SHIPPED 2026-06-10.** MER-BT-001..005 per the section
   above, plus the runner's BT pack trigger. TS port naming settled dir-based
   (FABLE_CONTRACT.md §9.1; prose synced). Calibration: confer `packages/api`
   fully clean (the newest TS backend is doctrine-perfect); real findings in
   rivet-ts (6), perch-next (5), perch/glyphantics/coingroup (BT-005s); both
   .NET baselines unaffected.
7. **v6 (config-sanitation pack) — SHIPPED 2026-06-10.** Golden base configs
   live in `~/Sites/plumb/configs/` (oxlintrc.json, oxfmtrc.json,
   editorconfig.dotnet); MER-TO-002/005/012/014 verify presence + golden
   superset per FABLE_CONTRACT.md §11.7. Two §7 exceptions encoded in
   calibration: severity-tightening compliant (reel), Vue-ness per config
   subtree (coingroup). tools.md's golden-example links pointed at waduno,
   which no longer exists on disk — plumb's configs/ is the durable home now.
8. **v7 (TS layer rules + delegated-ruling slices) — SHIPPED 2026-06-10.**
   v7a: MER-BT-010/011/012 (.NET parity for TS backends — domain purity,
   application↛infrastructure, never-cross-always-common) plus the §5 BT
   marker extension for layer-shaped trees (glyphantics had 5 real domain
   violations invisible until the marker caught its `app`/`infra` layout).
   v7b: MER-BE-060 (entity-config ownership) + MER-TE-007 (no EF InMemory),
   the mechanical slices of contract §9.3–9.6 (results-vs-exceptions,
   persistence ownership, one-transaction/no-bus, real-DB test substrate —
   all model-delegated, veto-able; prose synced into backend-pa-vsa.md and
   testing-philosophy.md the same change).
9. **v8 (Rivet variant awareness) — SHIPPED 2026-06-11.** Variant detection
   (v1/v2/both/none, artifact fingerprints, `PLUMB_RIVET_VARIANT`,
   `checks/_lib/rivet-variant.mjs`); MER-FE-005/006 v1-gated; MER-FE-003
   rewritten variant-neutral (v2 workspace-package specifier derived from the
   repo's manifests, `import type` exempt); new MER-FE-007 (v2 result shape)
   and MER-RV-026 (SUPPORTED_RIVET tripwire). Verified: golden (rivet-v2) =
   exactly the RV-026 artifact/version mismatch warn + pre-existing TO warns;
   minimal v1 repo still fires FE-003/005/006; casebridge/speechscribe
   baselines byte-stable. Detail in plumb FABLE_CONTRACT.md §11.9/§12.
