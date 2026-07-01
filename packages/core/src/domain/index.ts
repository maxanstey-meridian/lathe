// Barrel re-export for all domain schemas and inferred types

// Packet (CONTRACT §4)
export * from "./packet.js";
export type { Packet } from "./packet.js";

// Run lifecycle (CONTRACT §3, §5)
export * from "./run.js";

// Outcome ledger + Checkpoint (CONTRACT §8)
export * from "./outcomes.js";

// Gate state (CONTRACT §10) — schemas + pure logic + classification + decisions
export * from "./gate.js";
export * from "./gate-classification.js";
export * from "./gate-tools.js";
export * from "./gate-decisions.js";

// Planner + Review (CONTRACT §9)
export * from "./review.js";

// Reconciliation (resume without checkpoint)
export * from "./reconciliation.js";

// Prompts (CONTRACT §15)
export * from "./prompts.js";

// Convergence (SUPER-DADDY.md §18)
export * from "./convergence.js";

// Campaign (CONTRACT §19)
export * from "./campaign.js";

// Chain (CONTRACT §19)
export * from "./chain.js";

// Journal (CONTRACT §13)
export * from "./journal.js";

// Report (CONTRACT §11)
export * from "./report.js";

// Agent response shapes (opencode API — pure types + helpers)
export * from "./agent-response.js";

// Liveness + Turn evaluation (CONTRACT §5/§6)
export * from "./liveness.js";
export * from "./turn.js";

// Handoff artifact + Verify verdict (verify-handoff protocol)
export * from "./handoff.js";
