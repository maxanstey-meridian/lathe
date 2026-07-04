// Bridge port: the single-driver lock interface (ARCHITECTURE §3.2).
// Use cases depend on this; the adapter implements it. Interfaces only — zero runtime.
//
// Generic over Ref so the port does not transitively depend on ActiveRunRef
// (which imports AskPlannerInput, BridgeIntent, Paths, etc.) and the MER-BT-011
// check does not see an infrastructure import from application code.

export type BridgePort<Ref = unknown> = {
  bind(): Promise<Ref>;
  clearActive(ref: Ref, runId: string): void;
  close(): void;
};
