# Fable Review — Meridian Skill vs CaseBridge & SpeechScribe-Azure

Review date: 2026-06-10. Sources: full read of SKILL.md + all six references, deep
sweeps of `~/Sites/medway/casebridge` and `~/Sites/medway/speechscribe-azure`, with
spot-verification of contested facts (contract locations, `Invoke` usage, file
naming, `unwrap` usage).

## Overall

The skill is in good shape — the philosophy files are crisp and the frontend PA/VSA
doc is genuinely excellent. The gaps are almost all of one kind: **the two codebases
have quietly forked on conventions the skill never arbitrates**. An agent reading the
skill and then either repo would not know which variant is house style. Since the
whole point is explicit doctrine, those unresolved forks are the highest-value fixes.

---

## Rivet (`references/rivet.md`) — the biggest gaps are here

### 1. Contract file location is forked and the skill is silent
CaseBridge colocates contracts with modules (`Modules/Forms/FormsContract.cs` — 20+
of them); SpeechScribe puts them all in a top-level `Contracts/{Module}/` folder with
DTOs alongside. rivet.md says "keep request/response DTOs near the module that owns
them", which CaseBridge follows and SpeechScribe arguably violates. Pick one (or
state when each applies) and name the loser explicitly as non-default.

### 2. The route-constant pattern is undocumented
SpeechScribe defines `public const string CreateRoute = "/api/transcriptions"` in the
contract, references it in both `Define.Post(CreateRoute)` and the controller
attribute `[HttpPost(TranscriptionsContract.CreateRoute)]`. rivet.md only says "use
`Contract.Endpoint.Route` when mapping" for minimal APIs — it never covers how
controllers should source routes from contracts.

### 3. Generated-output placement and consumption is forked
- CaseBridge: `ui/generated/rivet/`, imported via `~~/generated/rivet/client`.
- SpeechScribe: workspace package `packages/contracts` with an `exports` map,
  consumed as `@speechscribe/contracts/client`, plus `build.transpile` in
  nuxt.config.

The skill never says where generated code lives or when to promote it to a workspace
package (sensible rule: workspace package when multiple consumers exist — web +
desktop — otherwise `ui/generated/`). Also worth stating:

- generated code is read-only and must be excluded from lint
  (`packages/contracts/generated/**` in `.oxlintrc.json`)
- the regen command convention (`pnpm rivet` →
  `dotnet rivet --project ... --output ...`) and when to run it

### 4. `unwrap: false` vs unwrap-and-throw — the biggest undocumented frontend-Rivet nuance
SpeechScribe pervasively calls clients with `{ unwrap: false }` and narrows on
`.isOk()` / `.isNotFound()` — status codes as values, no exceptions. CaseBridge
mostly unwraps and uses try/catch with `RivetError` + error-code extraction. The
frontend doc's "Rivet Rules" section says nothing about result-handling style. Decide
the default (the `unwrap: false` discriminated-union style looks like the direction
of travel) and say when try/catch + `getApiErrorCode()` is the right shape instead.

### 5. The error-code contract is undocumented end-to-end
CaseBridge has a full pipeline the skill never mentions:

1. use case throws a `DomainException` subclass
2. middleware maps it to `ErrorResponse(Code, Message, Errors)`
3. frontend `app/api/errors.ts` defines `API_ERROR_CODES` and
   `getApiErrorCode(error)`

Meanwhile SpeechScribe uses a different error DTO entirely (`ValidationErrorDto` with
`IReadOnlyDictionary<string, string[]>`). Two things to write down: the canonical
error response shape (currently two competing ones), and the
DomainException→middleware→code-matching pattern.

### 6. Auth-wrapped fetch wiring deserves a section
CaseBridge's `lib/api.ts` `createAuthFetch` (cookie auth, deduped 401→refresh→retry)
injected via `configureRivet({ fetch: ... })` in `plugins/1.rivet.client.ts` (note
the `1.` ordering prefix — also undocumented) is a load-bearing pattern. The doctrine
rule it implies: *customize transport by injecting fetch into Rivet config, never by
editing or wrapping generated code*.

### 7. An enforcement rule worth canonizing
CaseBridge's eslint `no-restricted-imports` ban on importing `rivetFetch` directly
from `~~/generated/rivet/rivet` ("use generated clients instead"). This belongs in
rivet.md or tools.md as a standard guardrail, like the architecture tests are for the
backend.

### 8. Minor authoring-style additions
`.Summary("...")` and `.Returns<T>(422, "description")` overloads appear in
SpeechScribe contracts but not in rivet.md's authoring examples.

---

## Backend (`references/backend-pa-vsa.md`)

### 9. Command/Result placement is forked
SpeechScribe nests them inside the use case class
(`CreateTranscriptionUseCase.Command`); CaseBridge uses top-level colocated records
(`CreateFormCommand`). rivet.md's own examples mix both styles. "Colocate" is too
loose — pick nested or sibling.

### 10. Validation placement is forked and unaddressed
- CaseBridge: FluentValidation `IValidator<TRequest>` + global
  `ValidationActionFilter` at the transport edge.
- SpeechScribe: inline validation in use cases returning `Result.Validation(errors)`
  via factory methods (`Result.Success()` / `Result.Validation()` /
  `HasValidationErrors`).

The Result-factory pattern is implicitly assumed by rivet.md's examples but defined
nowhere. Needs its own short section: what validates where, and the canonical Result
shape.

### 11. Persistence doctrine contradicts one repo
tools.md says "EF Core when persistence is relational", but SpeechScribe is raw
Npgsql with triple-quoted SQL and explicit transactions, clearly deliberate. Document
the fork condition (e.g. raw Npgsql when you need explicit multi-step transactional
control / event-append patterns; EF for conventional aggregate persistence) — and the
adapter-naming consequence: `Ef*Repository` vs `Postgres*Repository`, named after the
implementation tech, which matches the TS adapter rule but is never stated for .NET.

### 12. Three small DI patterns worth one bullet each
All real, all undocumented:

- dual registration (`AddScoped<EfFormRepository>()` then
  `AddScoped<IFormRepository>(sp => sp.GetRequiredService<EfFormRepository>())`) for
  one implementation serving multiple ports
- `TryAddScoped` null-object fallbacks for optional cross-module ports
  (`NullSubmissionCountProvider`)
- fail-fast options pattern at module registration
  (`Options.FromConfiguration(config).Validate()`)

### 13. Background work has zero doctrine
SpeechScribe's pattern — `IBackgroundTranscriptionDispatcher` port, Service Bus
consumer in infrastructure, `InlineBackgroundTranscriptionDispatcher` for tests,
persisted lifecycle events appended alongside state — is one of the most
doctrine-worthy things in either repo and the skill doesn't touch async/eventing at
all. Even a short "Background Work and Events" section would cover it.

### 14. CQRS-lite (SKILL.md) may be aspirational
CaseBridge repositories carry read-shaped methods (`FindStatusInfoAsync`, `ListAsync`
returning `FormListItemSnapshot`) and no named `*Query` classes were found. Either
the section should acknowledge "trivial reads may hydrate through the repository"
more loudly as the *current* norm, or note CaseBridge predates the doctrine —
otherwise an agent will flag the golden repo as a violation. Relatedly, the
input/output record naming conventions (`Create*Data` / `*Snapshot` in CaseBridge,
`New*` / `Stored*` in SpeechScribe) are forked and unnamed.

---

## Frontend (`references/frontend-pa-vsa.md`)

### 15. File-name casing is forked
CaseBridge: `useFormPersistence.ts` (camelCase). SpeechScribe:
`use-recording-activity.ts` (kebab, matching the doc's examples). One sentence
settles it.

### 16. `useState()` is unaddressed
CaseBridge's `useAuth` uses Nuxt `useState("auth-session")` — ambient app-wide keyed
state, which sits in tension with "no ambient global soup". Either bless it for the
narrow SSR-session case or mark it legacy; right now an agent can't tell.

### 17. Cross-capability wiring via constructor callback
`provideAudioRecording(usePlatformRecorder(() => { void recordingActivity.load(); }))`
is a subtle, recurring SpeechScribe pattern: capability A notifies capability B
through a callback passed at the composition root, not via events or injected ports.
Worth a short example under "Pages As Composition Roots".

### 18. Multi-runtime/platform ports
SKILL.md name-drops `useTauriRecorder`, but the actual pattern — one `Desktop` port,
runtime detection at the plugin (`isTauri()` → Tauri impl, else Photino RPC),
`usePlatform*` composables selecting implementations — has no reference content. A
"Platform Ports" subsection would capture it.

---

## Testing & tools (`references/testing-philosophy.md`, `references/tools.md`)

### 19. Test-double doctrine and CaseBridge disagree
testing-philosophy prefers fakes; SpeechScribe walks the talk (`TestSupport/{Module}/`
with `FakeTimeProvider`, `InMemoryRecordingUploadSessionRepository`, etc.); CaseBridge
unit tests are `Substitute.For<>` everywhere. Either note CaseBridge as the legacy
style, or codify the SpeechScribe conventions the doc currently lacks:

- the `TestSupport/{Module}/` folder
- `Fake*` / `InMemory*` / `Inline*` naming
- the private `CreateUseCase()` factory in test classes
- injecting `TimeProvider`

### 20. Frontend test location is forked
Colocated `__tests__/*.spec.ts` (CaseBridge) vs top-level `tests/**/*.spec.ts`
(SpeechScribe). Also worth documenting the `vi.hoisted()` mock-factory idiom and the
`setup.ts` Nuxt-UI-stubbing approach if that's now house style.

### 21. tools.md small fixes
- SpeechScribe uses bare xUnit `Assert.*`, not FluentAssertions — given
  FluentAssertions v8's licensing change, decide whether it's still the default.
- The .NET analyzer claim ("analyzers should be enabled in project files") isn't true
  of SpeechScribe's csproj.

---

## Structural notes on the skill itself

- **Duplication risk**: the provide/inject naming rules live in full in both SKILL.md
  and frontend-pa-vsa.md, and CQRS-lite lives only in SKILL.md while everything else
  backend lives in the reference. Move CQRS-lite into backend-pa-vsa.md and shrink
  SKILL.md's copies to one-line pointers — duplicated doctrine drifts.
- **"Context Discipline"** is about handoff-packet behavior, not Meridian
  architecture — it likely belongs in the handoff/handon skill, where it'll also load
  in the sessions that actually need it.
- The golden-example absolute paths all checked out for CaseBridge (contracts and
  `Invoke` usage verified to exist), so those are fine — but a one-line "verify
  golden paths still exist before citing them" note wouldn't hurt since several point
  at fast-moving repos.

---

## Fork decisions — SETTLED 2026-06-10

Decided by Max 2026-06-10 (validation, error DTO, generated output, and test
doubles delegated to the model's judgment; rationale recorded in plumb
FABLE_CONTRACT.md §12). Persistence stays a free choice — it blocks no rule.

| Fork | CaseBridge | SpeechScribe | **Winner** |
|---|---|---|---|
| Contract location | module-colocated | top-level `Contracts/` | **top-level `Contracts/`** |
| Result handling (FE) | unwrap + try/catch | `unwrap: false` + `.isOk()` | **`unwrap: false` + `.isOk()`** |
| Validation placement | FluentValidation at edge | inline `Result.Validation` | **FluentValidation at edge** (use cases keep domain invariants only; BE-012 keeps registration explicit) |
| Command/Result | sibling records | nested in use case | **sibling records** |
| Error DTO | `ErrorResponse(Code, Message, Errors)` | `ValidationErrorDto(dict)` | **`ErrorResponse`** (general envelope, no `Dto` suffix, one type for `.Returns<>(4xx)` + one edge conversion) |
| Persistence | EF Core | raw Npgsql | free choice — not doctrine |
| Test doubles | NSubstitute mocks | hand-rolled fakes | **hand-rolled fakes default**; NSubstitute legal at narrow seams — density is the smell, not presence |
| Composable file names | camelCase | kebab-case | **camelCase `useX.ts`** |
| Frontend test location | colocated `__tests__/` | top-level `tests/` | **top-level `tests/`** |
| Generated output | `ui/generated/rivet/` | workspace `packages/contracts` | **workspace `packages/contracts`** (package boundary makes read-only structural) |

`useState()` policy (settled 2026-06-10, the last open fork): **blessed, behind
composables** — `useState(` may appear only inside `composables/` files; every
other layer (components, pages, plugins, logic, adapters) consumes the owning
composable (`useAuthStore()`), never the string key. The skill defines no
`state/` dir and needs none — composables are the state home in the existing
taxonomy. Real target exists: casebridge couples a plugin and app.vue through
the bare `"app-booted"` key; speechscribe already complies.
