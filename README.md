# lathe

The Meridian **v3** rebuild — a sequential overnight executor of human-written
specs, built clean from `CONTRACT.v3.md`. (v2 lives in the `plumb` repo; the
running `meridian` CLI is built from there and drives this build via its chain
machinery.)

## Layout

- **`CONTRACT.v3.md`** — the golden contract. The single source of truth for
  behaviour and invariants. Build from this.
- **`ARCHITECTURE.v3.md`** — the clean-room ports-&-adapters design (the layers,
  the pure `evaluateTurn` keystone, the clause→location map).
- **`src/`** — the v3 implementation, built across the packet chain:
  `src/domain` (pure) → `src/application` (use cases + ports) →
  `src/infrastructure` (adapters) → `src/interfaces` (CLI/TUI).
- **`reference/`** — a **read-only** snapshot of the v2 implementation
  (`reference/src`, `reference/plugin`, `reference/tests`). The packets cite it
  for the concrete logic and the live "scars". **Never edit `reference/`** — it is
  outside every packet's surface and excluded from the build. It shows WHAT must be
  true, never HOW to arrange v3.

## How it gets built

The v3 packets are a linear chain registered with the live `meridian` (from
`plumb`) via `meridian chain add`. Each link builds on the previous link's
super-daddy-converged tip. See the operator guide in `plumb/.packets/_CHAIN.md`.
