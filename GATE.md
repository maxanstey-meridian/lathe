# GatePhase Refactor Notes

Lathe now represents gate control state with a `GatePhase` discriminated union
instead of the previous `latched`, `firstEditApproved`, `reconciliationRequired`,
and `latchReason` boolean cluster. This makes the valid lifecycle states explicit
and removes ordering hazards from gate decision functions.

## Implemented Shape

```ts
type GatePhase =
  | { phase: "initial" }
  | { phase: "first-edit-latched"; reason: string }
  | { phase: "reconciliation-latched"; reason: string }
  | { phase: "cleared" }
  | { phase: "checkpoint-demand-latched"; reason: string }
```

`lastAcceptedDecisionAt` intentionally remains a top-level `GateState` field. It
is orthogonal to phase and must survive rotation/relatch state spreads so stale
planner decisions cannot re-clear the gate.

## State Mapping

| Legacy booleans (`latched`, `firstEditApproved`, `reconciliationRequired`) | Phase | How entered |
|---|---|---|
| `false`, `false`, `false` | `initial` | `initialGateState` |
| `true`, `false`, `false` | `first-edit-latched` | clean session rotation |
| `true`, `false`, `true` | `reconciliation-latched` | rotation requiring reconciliation |
| `false`, `true`, `false` | `cleared` | accepted planner decision / answer |
| `true`, `true`, `false` | `checkpoint-demand-latched` | checkpoint demand after a cleared gate |

Any remaining legacy boolean combinations are mapped to
`checkpoint-demand-latched` during migration. They should not be produced by the
current factories, but mapping them preserves fail-closed behavior for old state
files.

## Helpers

Consumers should use the domain helpers instead of inspecting phase details
directly when they only need latch status or a display/deny reason.

```ts
export const isLatched = (gate: GateState): boolean =>
  gate.phase.phase !== "initial" && gate.phase.phase !== "cleared"

export const gateReason = (gate: GateState): string | undefined => {
  switch (gate.phase.phase) {
    case "first-edit-latched":
    case "reconciliation-latched":
    case "checkpoint-demand-latched":
      return gate.phase.reason
    case "initial":
    case "cleared":
      return undefined
  }
}
```

## Migration

`packages/core/src/domain/gate.ts` keeps a legacy schema with a Zod transform.
Reading old `gate-state.json` or SQLite gate rows transparently returns the new
phase shape. The first subsequent `writeGateState` rewrites that run in the new
format.

The plugin reads `gate-state.json` directly without Zod, so
`packages/core/plugin/gate-core.ts` carries a matching lightweight migration.
The driver and plugin must ship together; otherwise the driver can write phase
state that an older plugin does not understand.

## Decision Function Changes

- `gateTriggerReason` now fires only in `initial` when there is a diff.
- Reconciliation is represented by `reconciliation-latched`, so callers use
  `isLatched` / `gateReason` instead of asking `gateTriggerReason` to rediscover
  it.
- `mutationDenyReason` is an exhaustive phase switch after the absolute-path
  surface guard.
- `checkpointNudgeDue` and `checkpointNudgeNotice` only run for `cleared` with a
  `lastAcceptedDecisionAt`.
- `relatchGate` is called only when the current gate is not latched. From
  `cleared` it creates `checkpoint-demand-latched`; from `initial` it creates
  `first-edit-latched`.

## Review Notes

- The legacy transform is durable compatibility code for persisted run state.
- The plugin migration is duplicated by design because the plugin must remain
  dependency-free inside OpenCode's runtime.
- `lastAcceptedDecisionAt` is deliberately not embedded in phase variants.
