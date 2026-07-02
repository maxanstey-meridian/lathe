# Frontend PA/VSA

## Purpose

Use this when designing, reviewing, or refactoring a Vue/Nuxt frontend toward a decoupled, page-colocated,
ports-and-adapters shape with:

- dumb views/components
- page-level composition roots
- pure logic separated from framework code
- explicit capability boundaries
- typed runtime wiring via provide/inject

This is the Meridian frontend default.

**Meridian frontends are SPAs** (settled 2026-06-11): assume `ssr: false`
throughout. SSR idioms (hydration-aware `useAsyncData` patterns, server
components) are not house style, and nothing in this reference should be read
as ruling on them.

It is based primarily on:

- `~/Sites/medway/casebridge/ui/CONTRIBUTING.md`
- `~/Sites/meridian/perch-next/CLAUDE.md`

## Default Recommendation

Treat the **page** as the composition root.

Do not default to:

- global stores for everything
- component-local business logic
- fake API service wrappers around generated clients
- `app/features/...` sprawl for page-local code

The stable boundary is the **page-local feature**, not the composable and not the component.

## Core Principle

Keep views dumb and dependencies explicit.

The point of this pattern is not “do DI on the frontend”.

The point is:

- rendering stays in views
- pure logic stays pure
- framework code stays at the edge
- capability wiring happens once at the page root
- runtime seams are explicit instead of ambient

`provide` / `inject` is just the cleanest Vue mechanism for expressing that boundary.

## Dependency Rule

```text
logic/         ← pure TypeScript, zero Vue/Nuxt imports
ports/         ← typed capability contracts + provide/inject helpers
adapters/      ← optional pure implementations satisfying ports
composables/   ← framework-rich implementations / reactive shells
pages/         ← composition roots
components/    ← presentational only
```

Each layer may only import from layers above it in that list.

Meaning:

- `logic/` depends on nothing framework-specific
- `ports/` contain contracts and wiring helpers only
- `adapters/` may depend on `logic/`
- `composables/` may depend on `logic/`, `ports/`, generated Rivet clients, Pinia, VueUse, etc.
- `pages/` provide concrete capabilities
- `components/` render and consume already-composed capabilities

## Standard Layout

Page-local code is colocated by default.

```text
app/pages/forms/
├── index.vue
├── [id].vue
├── components/
├── composables/
├── logic/
├── ports/
└── adapters/
```

For the root page, use an adjacent folder:

```text
app/pages/
├── index.vue
└── index/
    ├── components/
    ├── composables/
    ├── logic/
    ├── ports/
    └── adapters/
```

Do not promote code to app-global folders until it is genuinely shared by multiple pages.

### Promotion

**Never cross; always Common.** A page or layout subtree must never import from another page's local dirs — not its `logic/`, `ports/`, `adapters/`, `composables/`, or `components/`. When code is needed by more than one subtree, the fix is always promotion to `app/shared/`; reaching sideways into the other subtree is a violation, full stop.

When a port or logic module is consumed by more than one composition root (e.g. a layout and a page, or two pages), promote it to `app/shared/`.

```text
app/shared/
├── ports/
│   └── auth.ts          ← shared port (type + provide/inject)
└── logic/
    └── auth.ts          ← shared pure logic (e.g. getInitials)
```

Rules:

- **Promote only what is genuinely shared.** The port type and provide/inject helper promote when the capability is wired at one composition root (e.g. layout) but consumed in another subtree (e.g. page components). Pure logic promotes when used by components in multiple page subtrees.
- **Never re-export from a shim file.** Consumers import from `app/shared/` directly. No `export { X } from "..."` pass-through files — that just hides the real dependency location.
- **Composables stay at their composition root.** Only the port and pure logic promote. The composable that implements the port stays with its composition root (e.g. `layouts/default/composables/`) because only that root calls it.
- **Delete the page-local file.** When a port or logic module is promoted, remove the original — do not leave a re-export stub behind.

Example — Auth port promoted from page-local to shared:

```text
Before (page-local only):
  app/pages/index/ports/auth.ts           ← owns Auth type + provide/inject
  app/pages/index/composables/useRivetAuth.ts
  app/pages/index/logic/auth-card.ts       ← owns getInitials

After (layout provides auth, sidebar + pages consume):
  app/shared/ports/auth.ts                 ← promoted: Auth type + provide/inject
  app/shared/logic/auth.ts                 ← promoted: getInitials
  app/layouts/default/composables/useRivetAuth.ts   ← stays: only layout calls it
  app/layouts/default.vue                  ← composition root: provideAuth(useRivetAuth())
```

```ts
// app/shared/ports/auth.ts — the promoted port
import type { Ref } from "vue";
import { useProvideInject } from "~/composables/useProvideInject";

export interface Auth {
  currentSession: Ref<CurrentUserDto | null>;
  errorMessage: Ref<string | null>;
  isLoading: Ref<boolean>;
  load: () => Promise<void>;
}

export const [injectAuth, provideAuth] = useProvideInject<Auth>("Auth");
```

```ts
// app/layouts/default/composables/useRivetAuth.ts — composable stays at composition root
import type { Auth } from "~/shared/ports/auth";
// ...implementation...

// app/layouts/default.vue — composition root
import { provideAuth } from "~/shared/ports/auth";
import { useRivetAuth } from "./default/composables/useRivetAuth";

const auth = provideAuth(useRivetAuth());
```

```ts
// app/layouts/default/components/app-sidebar.vue — consumer imports from shared
import { injectAuth } from "~/shared/ports/auth";
import { getInitials } from "~/shared/logic/auth";

// app/pages/index/components/auth-card.vue — another consumer, same shared imports
import { injectAuth } from "~/shared/ports/auth";
import { getInitials } from "~/shared/logic/auth";
```

## Logic

`logic/` is pure TypeScript.

Hard rule:

- no imports from `vue`
- no imports from `nuxt`
- no imports from `#imports`
- no framework packages

Put in `logic/`:

- pure transforms
- calculations
- derivation rules
- immutable data shaping
- domain-ish UI rules that do not require reactivity

If something can be a pure function, put it here.

Components may import `logic/` directly because it has zero framework dependencies.

## Ports

A port is a **narrow typed contract describing a capability the UI needs**.

Rules:

- one port per feature concern, not one port per function
- ports are capability-shaped, not DTO-shaped
- port files contain only the type and the injection helper
- ports are for capabilities the subtree depends on, not for disguising an existing client

Good:

- `Auth`
- `Recordings`
- `SubmissionStatusPort`
- `TimelineDisplayPort`

Bad:

- `CurrentUserDtoPort`
- `NotesApiPort` that just mirrors generated methods
- `FormDataService`

### Naming

Use names that make runtime wiring obvious at the call site:

- injected capability consumers use `injectX`
- composition roots use `provideX`
- concrete implementation composables may keep `useX` when they are real Vue composables

Examples:

- `injectAuth` / `provideAuth`
- `injectRecordings` / `provideRecordings`
- `injectSubmissionStatus` / `provideSubmissionStatus`

Why:

- `injectX` makes it obvious that a component is consuming a provided port
- `useX` remains available for concrete composables such as `useRivetAuth` or `usePlatformAuth`
- components should generally import `injectX` from `ports/`, not implementation composables from `composables/`

## Provide / Inject Pattern

Use typed provide/inject helpers based on Vue `InjectionKey` and VueUse local injection.

This is the canonical Meridian frontend port pattern. The exported pair must be named
`injectX` first and `provideX` second:

```ts
export const [injectRecorder, provideRecorder] = useProvideInject<Recorder>("Recorder");
```

Do not export `useRecorder` for a provided port. `useX` names are for concrete implementation
composables or framework hooks. The distinction matters at call sites:

- `provideRecorder(usePlatformRecorder(...))` means the composition root is wiring the capability.
- `injectRecorder()` means the consumer depends on an already-wired capability.
- `usePlatformRecorder()` means the root is constructing a concrete implementation.

Canonical helper:

```ts
import { injectLocal, provideLocal } from "@vueuse/core";
import type { InjectionKey } from "vue";

export const useProvideInject = <T>(name: string) => {
  const key: InjectionKey<T> = Symbol(name);

  const useProvide = (value: T): T => {
    provideLocal(key, value);
    return value;
  };

  const useInject = (): T => {
    const value = injectLocal(key);
    if (value === undefined) {
      throw new Error(`[Context:${name}] inject() called outside provider`);
    }
    return value;
  };

  return [useInject, useProvide] as const;
};
```

Why this pattern:

- typed capability seam
- subtree-scoped dependency wiring
- no prop drilling
- no ambient global soup
- hard failure outside the composition root
- `provide*` returns the provided value so the page root can assign and provide in one expression

This is runtime wiring, not the architecture itself.

## Adapters

Adapters are optional.

Use an adapter when a pure implementation buys clarity by keeping non-framework logic out of composables.

Rules:

- zero Vue/Nuxt imports
- if it needs `ref`, `computed`, `watch`, or lifecycle hooks, it is not an adapter
- adapters should usually just assemble pure functions from `logic/` into a port-shaped object

Example:

```ts
import {
  createSection,
  removeSectionById,
  reorderSections,
} from "../logic/section-state";
import type { SectionStatePort } from "../ports/section-state";

export const sectionStateAdapter: SectionStatePort = {
  createSection,
  removeSection: removeSectionById,
  reorderSections,
};
```

Preferred frontend example:

```ts
// ports/auth.ts
import type { Ref } from "vue";
import { useProvideInject } from "~/composables/useProvideInject";

export interface Auth {
  currentSession: Ref<CurrentUserDto | null>;
  errorMessage: Ref<string | null>;
  isLoading: Ref<boolean>;
  load: () => Promise<void>;
}

export const [injectAuth, provideAuth] = useProvideInject<Auth>("Auth");
```

```ts
// composables/useRivetAuth.ts
import { ref } from "vue";
import { session } from "@app/contracts/client";
import type { Auth } from "../ports/auth";

export const useRivetAuth = (): Auth => {
  const currentSession = ref<CurrentUserDto | null>(null);
  const errorMessage = ref<string | null>(null);
  const isLoading = ref(false);

  const load = async (): Promise<void> => {
    isLoading.value = true;
    errorMessage.value = null;

    try {
      const result = await session.me({ unwrap: false });

      if (result.isOk()) {
        currentSession.value = result.data;
        return;
      }

      errorMessage.value = "Unable to load the auth session.";
    } catch {
      errorMessage.value = "Unable to load the auth session.";
    } finally {
      isLoading.value = false;
    }
  };

  return {
    currentSession,
    errorMessage,
    isLoading,
    load,
  };
};
```

```ts
// page composition root
import { provideAuth } from "./ports/auth";
import { useRivetAuth } from "./composables/useRivetAuth";

const auth = provideAuth(useRivetAuth());
```

This composable-direct path is often the better default on the frontend.

## Composables

Composables are the framework-rich layer.

They may own:

- `ref` / `reactive` / `computed` / `watch`
- VueUse
- Pinia when appropriate
- generated Rivet client calls
- side effects
- loading flags
- local UI orchestration

Composables should:

- inject a port with `injectX` when they depend on a provided capability
- keep pure logic out of themselves where feasible
- expose a clean capability-shaped surface

Composables should not:

- grow into god-objects
- hide large amounts of pure business logic

If a composable gets too large, pull pure logic down into `logic/`.

### File naming

Composable files are camelCase, matching the exported function: `useAuth.ts`
exports `useAuth`. (Settled 2026-06-10; kebab-case `use-auth.ts` is migration
backlog.)

### Framework state (`useState`)

Nuxt `useState()` is blessed — **behind composables only**. `useState(` may
appear only inside `composables/` files; the composable owns the key and exposes
a named capability:

```ts
// composables/useAppBooted.ts
export const useAppBooted = () => useState("app-booted", () => false);
```

Every other layer — components, pages, plugins, logic, adapters — consumes the
owning composable (`useAppBooted()`), never the string key. Two files sharing a
bare key is provenance-invisible coupling; the composable makes the owner
greppable. There is no `state/` directory: composables are the state home in
this taxonomy.

## Two Valid Implementation Styles

Both are valid. Choose the simpler one that keeps boundaries honest.

### 1. Pure adapter + thin composable

Use this when there is real pure logic worth separating.

Pattern:

- page provides adapter
- composable injects port via `injectX`
- composable holds reactive state and delegates logic to the port

### 2. Composable directly implements the port

Use this when the implementation is already inherently reactive/stateful and an adapter would just add ceremony.

Pattern:

- composable returns the port-shaped capability
- page provides that composable result directly

This is valid:

```ts
provideAuth(useRivetAuth());
```

Do not create an adapter just to satisfy a pattern if the composable is already the cleanest implementation.

## Pages As Composition Roots

Pages assemble the feature once.

Pages may:

- create implementation composables
- provide ports
- compose presentational components

Pages should not:

- become a dump for business logic
- reimplement pure transforms inline
- hide composition behind global setup unless it is genuinely app-wide

Example:

```ts
import { provideSectionState } from "../ports/section-state";
import { sectionStateAdapter } from "../adapters/section-state";

const sectionState = provideSectionState(sectionStateAdapter);
```

Or:

```ts
import { provideAuth } from "./index/ports/auth";
import { useRivetAuth } from "./index/composables/useRivetAuth";

const auth = provideAuth(useRivetAuth());
```

## Components

Components are presentational.

They may:

- render data
- hold local UI interaction
- emit events
- consume already-provided capabilities
- import pure `logic/` helpers directly

They should not:

- call generated clients directly
- own workflow orchestration
- construct infrastructure dependencies
- reach around the page composition root

## Rivet Rules

Generated Rivet clients are already typed contracts.

Therefore:

- do not wrap Rivet behind ports by default
- do not create fake API service layers unless there is a genuine need
- bootstrap Rivet once at the app boundary
- call generated clients directly inside the composable that implements the capability when appropriate

Good:

- `useRivetAuth()` calls generated session client
- `useSubmissionMessages()` calls generated messaging endpoints directly

Bad:

- `MessagesApiPort` that mirrors generated methods one-for-one
- “service” wrappers that only rename generated methods

## When Not To Use This Pattern

Do not force full PA/VSA frontend structure when the feature is tiny.

Skip ceremony when:

- the component is purely presentational
- the composable is already small and clear
- there is no real capability boundary
- no subtree wiring is needed

If something is trivial, keep it trivial.

## Failure Modes

Watch for these:

- ports around everything
- fake API abstraction over generated clients
- adapters with Vue imports
- composables importing adapters directly when the port seam should be used
- global stores used as a default transport for unrelated concerns
- promoting code to shared/global before it is actually shared
- re-export shims (`export { X } from "..."`) left behind after promotion — consumers should import from the promoted location directly
- page-local code prematurely moved into `app/features/...`

## Testing Bias

Prefer:

- tests of pure `logic/`
- composable/page integration tests
- outcome-based behaviour tests

Avoid:

- mock-heavy tests that verify implementation detail only
- component tests that need large fake environment setup because boundaries were ignored

## Summary

The intended frontend style is:

- page as composition root
- dumb views
- explicit capability seams
- pure logic separated from framework code
- provide/inject used as typed subtree wiring
- generated Rivet clients used directly where honest
- colocation first, promotion later
