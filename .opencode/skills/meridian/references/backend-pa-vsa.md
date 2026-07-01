# Backend PA/VSA

## Purpose

Use this when designing, reviewing, or refactoring a backend toward a modular-monolith shape with:

- vertical slice architecture at the module boundary
- clean architecture applied inside modules where it earns its place
- ports and adapters for external variability
- strict dependency direction

This is the Meridian backend default for both:

- .NET modular monoliths
- TypeScript/Nest modular backends

It is based primarily on the CaseBridge backend rules and architecture tests, with Waduno as the TS/Nest expression of the same ideas.

## Default Recommendation

Build a **single-project or single-package modular monolith** first.

Do not start with:

- flat service folders
- giant `common/services`
- many tiny packages/projects
- fake microservice boundaries

The stable boundary is the **module**, not the class and not the package.

## Core Principle

Use **VSA first, CA where needed**.

That means:

- every meaningful product capability gets its own feature module
- modules are the primary structural unit
- inside a module, use clean architecture only when the domain or infrastructure variability justifies it

Do not force full CA into every trivial CRUD slice.

### When CA is warranted inside a module

Use ports/use-cases/domain types when at least one is true:

- the module has real business rules or invariants worth protecting
- infrastructure could realistically vary or be swapped
- orchestration would become hard to reason about inline
- testability matters because the capability is important or brittle

If none of those are true, stay simpler.

## Non-Negotiable Dependency Rules

These are the hard rules.

### Inside a module

- `Domain` depends on nothing outside itself
- `Application` may depend on `Domain`
- `Application` must not depend on `Infrastructure`
- `Infrastructure` implements `Application/Ports`
- interface/transport/controllers call application services or use cases only

### Across modules

**Never cross; always Common.** Modules must not depend on sibling modules at all — not their `Domain`, not their `Infrastructure`, not their `Application` types, and not their `Application/Ports` either. Cross-module dependencies go through **shared/common application ports** (`Common/Ports`), full stop.

That means:

- `ModuleA.Application` may depend on shared/common application ports
- modules must not depend on another module’s `Infrastructure`
- modules must not depend on another module’s `Domain`
- modules must not depend on another module’s `Application` types — including its `Application/Ports`

There is no "expose it deliberately from the owning module" option. If two modules need the same capability, the port moves to `Common/Ports` and the owning module implements it. Any `using Modules.Y.*` inside `Modules.X` is a violation.

**Transactions and events** (settled 2026-06-10): a use case is one
transaction. Cross-module consistency is never a shared transaction — it is an
explicit port call from a use case that may fail independently. No in-process
event bus, no MediatR notifications, no domain-event dispatchers, until a real
async boundary (a queue) exists. A module tells another module something
happened by calling a `Common/Ports` port, explicitly.

**Module-merge heuristic**: if `Common/Ports` accumulates ports faster than
modules accumulate capabilities, the module boundaries are too fine — merge or
dissolve modules rather than accumulate ports. A "module" every other module
needs but that owns no product capability is an infrastructure concern wearing
a module costume; dissolve it into Common infrastructure behind Common ports.

### Shared/common rule

Shared locations exist for genuine cross-cutting concerns only.

Use them for:

- cross-module ports
- base error types
- common middleware/filters
- shared value types that are truly cross-module

Do not use shared/common as:

- a dumping ground
- a backdoor around module boundaries
- a place to hide poorly named feature logic

## Standard Module Shape

### .NET

```text
Modules/<Feature>/
├── Domain/
├── Application/
│   ├── Ports/
│   └── <UseCaseName>/
│       └── <UseCaseName>UseCase.cs
├── Infrastructure/
├── <Feature>Controller.cs
└── <Feature>Module.cs
```

Rules:

- controllers live at the module root
- no `Interface/` folder by default
- ports live in `Application/Ports`
- infrastructure implements those ports
- module registration is explicit in `<Feature>Module.cs`

### TypeScript / Nest

```text
src/modules/<feature>/
├── domain/
├── application/
│   ├── ports/
│   └── <use-case>.ts
├── infrastructure/
├── <feature>.controller.ts
└── <feature>.module.ts
```

Rules:

- same dependency direction as .NET
- module registration is explicit in the Nest module
- do not hide boundaries behind barrel files or magic provider discovery
- ports live in `application/ports`
- adapters live in `infrastructure`

## Ports and Adapters

Ports should be:

- narrow
- capability-shaped
- owned by the application layer

Prefer:

- `UserRepository`
- `PasswordHasher`
- `PaymentGateway`
- `FeatureToggleProvider`
- `WorkflowStarter`

Avoid:

- giant “service” ports
- ports that just mirror an infrastructure SDK
- abstraction with no plausible second implementation or no meaningful boundary

### TypeScript / Nest port convention

In TS/Nest, prefer **abstract classes as DI tokens**.

This is a deliberate hack to get:

- runtime DI identity
- interface-like ergonomics
- explicit, readable boundaries

The abstract should be effectively stateless and interface-like:

- no fields
- no implementation
- no static factory logic
- no non-abstract methods
- a `private constructor()` so it cannot be instantiated or extended accidentally as a real base type

Example:

```ts
export abstract class Mailer {
  private constructor() {}

  abstract send(input: SendMailInput): Promise<void>;
}
```

Concrete adapters should `implement` the port, not `extend` it.

Example:

```ts
export class SendgridMailer implements Mailer {
  async send(input: SendMailInput): Promise<void> {
    // ...
  }
}
```

Treat these ports as runtime DI keys with interface semantics, not as OO base classes.

When two adapters want shared behavior, the answer is composition — a shared
module of pure functions both adapters call — never a base adapter class. The
port's private constructor makes `extends` impossible on purpose; do not
reintroduce inheritance beside it with an `AbstractBaseMailer`.

### TypeScript / Nest naming conventions

Ports are named after the capability itself:

- `Mailer`
- `PasswordHasher`
- `WorkflowStarter`
- `UserRepository`

Adapters are named after the concrete implementation of that capability:

- `SendgridMailer`
- `BcryptPasswordHasher`
- `TemporalWorkflowStarter`
- `PrismaUserRepository`

File naming: **no type-tag suffixes — the directory carries the role, the file
is named after the thing.** (Settled 2026-06-11: `.port.ts`, `.service.ts`,
`.provider.ts`, `.use-case.ts`, `.interface.ts`, `.handler.ts` are all banned —
tagging one kind implies tagging them all, so none are tagged. HTTP route
registration is a suffix-free `interface/http/<module>-routes.ts`.)

- ports: `application/ports/mailer.ts`, `application/ports/user-repository.ts`
  — named after the capability; the `ports/` dir already says what they are
- adapters: `infrastructure/sendgrid-mailer.ts`,
  `infrastructure/prisma-user-repository.ts` — named after the implementation
- use cases: `application/create-form.ts` (or `application/use-cases/create-form.ts`)
- sole exception: `<feature>.module.ts` — the Nest composition-root idiom
- test/config dotted names (`.spec.ts`, `.test.ts`, `.config.ts`, `.d.ts`) are
  not type tags

Do not use vague names like:

- `MailerService`
- `MailerInterface`
- `DefaultMailer`
- `BaseMailer`

### Cross-module ports

If a port is needed across module boundaries, put it in the shared/common application ports location (`Common/Ports`). That is the only option — never expose it from the owning module’s `Application/Ports` for a sibling to import. **Never cross; always Common.**

Do not import another module’s types just because the compiler allows it.

## Coding Style Rules

These are part of the architecture, not just aesthetics.

### General

- data transforms over object hierarchies
- explicit orchestration over magic
- readability over abstraction
- top-to-bottom understandable use cases
- minimal dependencies

### .NET

- `sealed` on all concrete types
- records for DTOs, commands, results, value objects
- EF entities may be `sealed class` rather than records
- explicit `IServiceCollection` registration
- no MediatR
- no AutoMapper
- no DI auto-scanning
- use cases named `<UseCaseName>UseCase`
- colocate `Command` and `Result` with the use case — as sibling records (see
  Commands and Results below)

Recommended use case signature:

```csharp
Task<CreateFormResult> ExecuteAsync(CreateFormCommand command, CancellationToken cancellationToken)
```

### Commands and Results

Command and Result records are **siblings of the use case in the same file**,
never nested inside the use case class. (Settled 2026-06-10; the nested
`CreateTranscriptionUseCase.Command` style SpeechScribe currently uses is
migration backlog.)

```csharp
public sealed record CreateFormCommand(string Name);
public sealed record CreateFormResult(Guid Id);

public sealed class CreateFormUseCase { /* ... */ }
```

Sibling records keep call sites readable (`CreateFormCommand`, not
`CreateFormUseCase.Command`) and keep the use case class purely behavioral.

### Validation

Shape validation lives at the transport edge: FluentValidation
`IValidator<TRequest>` implementations registered explicitly (no assembly
scanning — the anti-magic rule applies) and applied by a global validation
filter. Use cases keep **domain invariants only** — rules that must hold no
matter who calls. (Settled 2026-06-10; inline `Result.Validation(...)` factories
inside use cases are migration backlog.)

- request shape (required, format, lengths) → FluentValidation at the edge
- business invariants (state transitions, uniqueness, permissions) → the use
  case / domain — not as a parallel shape-validation pass

### Results vs exceptions

(Settled 2026-06-10; blessed 2026-06-11.) **Declared failures are results;
undeclared failures are exceptions.** If the contract declares the failure
(`.Returns<ErrorResponse>(4xx)`), the use case returns it as a value and the
endpoint maps it — declared failures are control flow the caller must handle,
and values make that visible. Exceptions are reserved for "this should never
happen" and are translated once by the error middleware. Do not throw for
outcomes the API contract promises; do not return result objects for genuine
programmer errors.

**The canonical result type is FluentResults** (`Result` / `Result<T>`) — do
not hand-roll a Result type per repo. FluentResults is *furniture*: like Zod
in TS, it may appear in domain and application freely; the
minimal-dependencies bias does not apply to blessed furniture libraries.
Reinventing the wheel is worse dogma than a stable, boring dependency.

Authorization follows the same split: authentication is transport (middleware);
authorization is a business invariant decided in the use case — never in
controllers.

### Error Envelope

The canonical API error shape is one general envelope:

```csharp
public sealed record ErrorResponse(string Code, string Message,
    IReadOnlyDictionary<string, string[]>? Errors = null);
```

(Settled 2026-06-10.) One type serves every declared failure —
`.Returns<ErrorResponse>(422)` in contracts and one conversion at the transport
edge. No `*Dto` suffix, and no special-purpose variants like
`ValidationErrorDto`: validation failures are the same envelope with `Errors`
populated. The pipeline is: use case throws a `DomainException` subclass (or
returns a failed result) → middleware/edge maps it to `ErrorResponse` once →
the frontend matches on `Code`.

### TypeScript / Nest

- strict typing
- narrow ports as abstract classes with private constructors
- concrete adapters `implement` ports
- prefer constructor property promotion for injected dependencies
- explicit provider wiring
- no hidden framework abstraction layers

Example:

```ts
export class TickPet {
  public static inject = [
    "clock",
    "getWindowTitle",
    "petEffects",
    "petStateMachine",
    "petStatePersistence",
  ] as const;

  public constructor(
    private readonly clock: Clock,
    private readonly getWindowTitle: () => string | null,
    private readonly petEffects: PetEffects,
    private readonly petStateMachine: PetStateMachine,
    private readonly petStatePersistence: PetStatePersistence,
  ) {}

  public async execute(input: TickPetInput): Promise<PetState> {
    // ...
  }
}
```

Prefer:

- `public static inject = [...] as const` for `typed-inject`-assembled classes
- constructor property promotion for long-lived injected dependencies
- `private readonly` by default
- `protected readonly` only when there is a real inheritance reason

Avoid:

- constructor args assigned manually to fields for no reason
- grabbing dependencies from service locators inside methods
- mutable injected dependency fields
- no barrel-heavy indirection that hides provenance
- keep domain/application free of framework and transport details

## What Goes Where

### Domain

Put in domain:

- entities/value objects if they earn their place
- pure rules
- invariants
- calculations
- policy decisions

Do not put in domain:

- repositories
- HTTP
- database access
- framework imports
- SDK clients
- logging (`ILogger<T>` belongs in application and infrastructure; domain
  decisions are values, not log lines)

### Application

Put in application:

- use cases
- orchestration
- ports
- DTOs/results local to the use case when appropriate

Application should make side effects visible in sequence.

### Infrastructure

Put in infrastructure:

- EF/Prisma repositories
- HTTP clients
- queue adapters
- storage adapters
- auth provider integrations
- third-party SDK wrappers

Infrastructure may depend on frameworks and libraries freely.

## Persistence

(Settled 2026-06-10.) One host-level DbContext is acceptable as the persistence
root — but each module owns its entities' mapping:

- `IEntityTypeConfiguration<T>` implementations live in the owning module's
  `Infrastructure/` (`Modules/<X>/Infrastructure/Persistence/` — CaseBridge's
  layout is the golden shape)
- a module never configures another module's entities, and never centralises
  mapping next to the DbContext
- cross-module DATA access follows "never cross; always Common": module X never
  queries module Y's entities or DbSets; it calls a `Common/Ports` port and the
  owning module's adapter does the querying
- migrations are host-level (they serialize the whole model), but the model
  itself is assembled from module-owned configurations

## Use Cases vs Direct Services

Do not cargo-cult a use case class for every trivial operation.

Use a full use case when:

- the flow coordinates multiple side effects
- there is meaningful sequencing
- the capability matters enough to deserve a named orchestration boundary

If the behavior is genuinely simple and procedural, a direct service may be enough.

The key test:

- does this boundary improve clarity and protect business behavior?

If yes, keep it.
If not, simplify.

## Common Failure Modes

Watch for these:

1. Shared dumping ground
- `Common/` or `shared/` starts absorbing feature logic

2. Cross-module leakage
- one module imports another module’s infrastructure or internal application types

3. Fake repositories everywhere
- ports with no real variability or boundary value

4. Application logic hiding in controllers
- transport layer becomes orchestration layer

5. Domain logic hiding in use cases
- business rules are inline `if/else` branches instead of explicit domain decisions

6. Package/project sprawl
- splitting modules into separate packages before a real runtime or deployment boundary exists

## Enforcement

Document the rules, then enforce them.

### .NET

Prefer architecture tests for:

- domain not depending on application/infrastructure
- application not depending on infrastructure
- modules not referencing sibling modules at all — never cross, always Common:
  cross-module ports live only in shared/common (`Common/Ports`)

### TS/Nest

Use whatever is lightest and enforceable:

- lint/import-boundary rules
- dependency-cruiser
- architectural tests
- workspace package boundaries where they are real

The point is not tooling purity. The point is to stop the drift.

## Decision Heuristics

### Should this become a new module?

Yes if:

- it is a real product capability
- it has its own language, workflow, or lifecycle
- it can be reasoned about as a bounded context

No if:

- it is only an infrastructure concern
- it is just a utility/helper
- it is an implementation detail of another module

### Should this become a port?

Yes if:

- it crosses I/O or infrastructure boundaries
- there is plausible variability
- the use case should not know implementation details

No if:

- it is pure computation
- it is incidental indirection
- the abstraction is wider than the actual capability

### Should this go in shared/common?

Yes if:

- it is genuinely cross-cutting
- it is a cross-module port or contract
- it is not secretly owned by one module

No if:

- it exists only because one module is leaking
- it would erase a meaningful feature boundary

## Short Version

If in doubt:

1. start with a modular monolith
2. make modules the primary boundary
3. keep domain pure
4. keep application explicit
5. put ports in application
6. let infrastructure implement them
7. cross modules only through application ports
8. promote truly shared concerns to shared/common
9. avoid magic and unnecessary abstraction
10. enforce the rules with tests or linting once the codebase is big enough

## Observability

Edge-only (ruled 2026-06-11): logging, metrics, and tracing live at the
edges — transport middleware (`hono/logger` on TS server entries, ASP.NET
request logging) and infrastructure adapters. **Domain and application stay
silent** — no logger imports, no console statements; a use case that needs to
"log a warning" is usually missing a declared result or a domain event.
Composition entries decide what observability exists per environment: the
in-browser transport ships none, the server entry ships request logging.
