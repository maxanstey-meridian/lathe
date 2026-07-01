# Tools

## Purpose

Use this when choosing tooling for Meridian projects or when checking whether a repo is aligned with current defaults.

This file is about **tool choices and config defaults**, not architecture structure.

## TypeScript / Vue / Nuxt

### Default stack

- package manager: `pnpm`
- framework: `Nuxt 4` + `Vue 3`
- language: `TypeScript`
- typecheck: `vue-tsc`
- UI layer: `@nuxt/ui`
- utility layer: `@vueuse/core`
- validation/schema: `zod` when needed
- tests: `vitest` + `@vue/test-utils` + `happy-dom`
- e2e: `playwright` where warranted

### Dependency injection

For explicit runtime DI in TypeScript backends or local hosts:

- prefer `typed-inject`

Use it when:

- you want explicit composition without Nest-style framework DI
- you are bootstrapping a local API/runtime host
- you want typed assembly with obvious provenance

Do not use it to hide boundaries or to recreate a magic container culture.

### Linting and formatting

Default bias:

- prefer `oxlint` over `eslint`
- prefer `oxfmt` over Prettier
- use `eslint` only where Vue/Nuxt support is still needed

Current practical rule:

- `ox*` does the general JS/TS lint/format work
- `eslint` remains for Vue/Nuxt-specific linting because `oxlint` does not cover that fully yet

So the intended stack is:

- `oxlint`
- `oxfmt`
- `eslint` + `@nuxt/eslint` only as the Vue/Nuxt layer on top

**Base configs (settled 2026-06-10).** The golden base config files live in
`~/Sites/plumb/configs/` and plumb enforces them (MER-TO-002/005): every TS
repo carries `.oxlintrc.json` and `.oxfmtrc.json` containing *at least* the
golden settings, with the golden values — repos extend the base (extra rules,
ignorePatterns, internalPattern aliases), never contradict it. Apps with `.vue`
files additionally carry the `@nuxt/eslint` layer; apps without `.vue` files
carry no eslint at all.

### Golden TS examples

Golden base configs (the enforced minimum):

- [oxlintrc.json](/Users/max/Sites/plumb/configs/oxlintrc.json)
- [oxfmtrc.json](/Users/max/Sites/plumb/configs/oxfmtrc.json)

Nuxt + `oxlint` + `eslint` integration:

- [casebridge/ui/eslint.config.mjs](/Users/max/Sites/medway/casebridge/ui/eslint.config.mjs)

Architecture-aware `oxlint` restrictions:

- [perch-next/.oxlintrc.json](/Users/max/Sites/meridian/perch-next/.oxlintrc.json)

Typed DI / explicit assembly examples:

- [perch/packages/api/src/bootstrap.ts](/Users/max/Sites/meridian/perch/packages/api/src/bootstrap.ts)
- [perch-next/apps/api/src/local.ts](/Users/max/Sites/meridian/perch-next/apps/api/src/local.ts)
- [waduno/CONTEXT.md](/Users/max/Sites/melon/waduno/CONTEXT.md)

Concrete `typed-inject` class shape:

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
}
```

### Notes

- Prettier is not the current default in newer repos.
- Older repos may still contain heavier ESLint/Prettier/plugin stacks; do not treat those as the preferred Meridian baseline.

## .NET

### Default stack

- SDK pinned with `global.json`
- pin to `.NET 10`
- set `rollForward` to `latestFeature`
- nullable enabled
- implicit usings enabled
- built-in .NET analyzers enabled
- `.editorconfig` as the main style/analyzer policy source

### Web/API defaults

- ASP.NET Core
- `FluentValidation`
- `Rivet.Attributes`
- EF Core when persistence is relational
- PostgreSQL via `Npgsql` / `Npgsql.EntityFrameworkCore.PostgreSQL`

### Testing defaults

- `xUnit`
- `FluentAssertions`
- `Microsoft.AspNetCore.Mvc.Testing`
- `Testcontainers`
- `Respawn`
- `ArchUnitNET`

Mocks:

- `NSubstitute` is available
- but it is not the testing philosophy default

### Formatting and analyzers

Current rule (settled 2026-06-10, enforced by plumb MER-TO-012/014):

- `CSharpier` is part of the formatting workflow — wired via a dotnet tool
  manifest (`.config/dotnet-tools.json`) or `CSharpier.MsBuild`; it is
  deliberately config-free, so no style file
- `.editorconfig` is the main formatting/style/analyzer authority — the golden
  canonical lives at
  [editorconfig.dotnet](/Users/max/Sites/plumb/configs/editorconfig.dotnet);
  repos contain at least its settings (tightening a severity is fine,
  diverging is not)
- analyzers should be enabled in project files (`EnforceCodeStyleInBuild` or
  `AnalysisLevel` in the csproj or `Directory.Build.props`)

So the real golden sources today are:

- the formatter command in repo workflows
- the golden `.editorconfig` (plumb `configs/`)
- analyzer settings in `.csproj`
- SDK pinning in `global.json`

If a repo adds a `CSharpier` config file later, keep it aligned with `.editorconfig` and do not invent a second competing style doctrine.

### Golden .NET examples

SDK pinning:

- [casebridge/api/global.json](/Users/max/Sites/medway/casebridge/api/global.json)

Formatting workflow:

- [casebridge/Taskfile.yml](/Users/max/Sites/medway/casebridge/Taskfile.yml)

Style/analyzer baseline:

- [editorconfig.dotnet](/Users/max/Sites/plumb/configs/editorconfig.dotnet) — the golden canonical
- [casebridge/api/.editorconfig](/Users/max/Sites/medway/casebridge/api/.editorconfig)

Modern ASP.NET Core package/tooling baseline:

- [casebridge/api/CaseBridge/CaseBridge.csproj](/Users/max/Sites/medway/casebridge/api/CaseBridge/CaseBridge.csproj)
- [speechscribe-azure/apps/api/SpeechScribe.Api.csproj](/Users/max/Sites/medway/speechscribe-azure/apps/api/SpeechScribe.Api.csproj)

Analyzer-enabled project setup:

- [lagon/azure-functions/src/LaganGateway.FunctionsHost/LaganGateway.FunctionsHost.csproj](/Users/max/Sites/medway/lagon/azure-functions/src/LaganGateway.FunctionsHost/LaganGateway.FunctionsHost.csproj)

Testing/tooling baseline:

- [casebridge/api/CaseBridge.Tests/CaseBridge.Tests.csproj](/Users/max/Sites/medway/casebridge/api/CaseBridge.Tests/CaseBridge.Tests.csproj)

## Workspace / orchestration

When the repo is a real monorepo:

- package manager: `pnpm`
- task graph/caching: `turbo`

For local orchestration:

- use `Task` / `go-task`
- prefer `Taskfile.yml` over ad hoc shell sprawl once commands become real workflow

Example:

- [perch-next/package.json](/Users/max/Sites/meridian/perch-next/package.json)
- [casebridge/Taskfile.yml](/Users/max/Sites/medway/casebridge/Taskfile.yml)

## Summary

The current Meridian tools default is:

- TS/Nuxt: `pnpm`, `Nuxt 4`, `Vue 3`, `TypeScript`, `vue-tsc`, `@nuxt/ui`, `@vueuse/core`, `oxlint`, `oxfmt`, `eslint` only for Vue/Nuxt gaps, `typed-inject` for explicit runtime DI outside framework DI, `vitest`, `happy-dom`, `playwright`
- .NET: `.NET 10`, `global.json` with `rollForward: latestFeature`, `.editorconfig`, analyzers on, ASP.NET Core, `FluentValidation`, `Rivet.Attributes`, EF Core + Npgsql, `xUnit`, `FluentAssertions`, `Mvc.Testing`, `Testcontainers`, `Respawn`, `ArchUnitNET`

## Starting a new project

`plumb init <dir> [--name <n>] [--ts-backend | --dotnet-backend | --no-api]`
scaffolds a golden-shape workspace, git-inits it with a first commit, and
finishes by running plumb — a fresh init has zero findings by construction
(the dotnet flavor carries one expected RV-026 warn until Rivet 0.35).

- `--ts-backend` (default): apps/api Hono backend + apps/ui Nuxt SPA +
  packages/contracts, Taskfile, golden lint/format configs
- `--dotnet-backend`: same ui/contracts + golden's .NET api copied as a
  renamed template (analyzers on, CSharpier manifest, canonical dotnet
  .editorconfig, dotnet Taskfile) — the CaseBridge shape
- `--no-api`: Nuxt ui + contracts only, for an API living elsewhere

The engine is rivet-ts's `scaffold` command (`scaffold-mock` for the
contract-first mock variant); see `~/Sites/medway/rivet-ts/SCAFFOLDER_PLAN.md`.
