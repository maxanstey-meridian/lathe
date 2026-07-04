// ---------------------------------------------------------------------------
// Rotation (CONTRACT §8 O5/O6, ARCHITECTURE §3.2)
//
// Discard the Baby session and seed a fresh one from durable state. Every
// rotation re-latches first-edit (O5) so the new context clears its plan before
// editing; the crash path (no checkpoint) stacks reconciliation on top (O6).
// Used by the context-budget teardown, the no-progress rotation, the
// send-failure crash path, and reorient.
// ---------------------------------------------------------------------------

import { dirname } from "node:path";
import { rotationGateState } from "../../domain/gate-decisions.js";
import type { Packet } from "../../domain/packet.js";
import { journal, type RunPorts } from "./run-runtime.js";

// Replace the Baby session and return the new session id (the loop tracks it as
// the live executor session). `needsReconciliation` selects the gate the successor
// inherits: false re-latches first-edit only; true stacks reconciliation (crash
// path: no checkpoint AND no prior accepted reconciliation).
export const rotateSession = async (
  ports: RunPorts,
  packet: Packet,
  worktree: string,
  oldSessionId: string,
  turn: number,
  needsReconciliation: boolean,
): Promise<string> => {
  const runId = packet.runId;

  await ports.executor.deleteSession(oldSessionId);
  const newSessionId = await ports.executor.createSession(`baby:${runId}:r${turn}`, worktree);
  journal(ports, runId, turn, { event: "rotation", phase: "session_replaced", newSessionId });

  const meta = ports.store.readMeta(runId);
  ports.store.writeMeta({ ...meta, babySessionId: newSessionId, updatedAt: ports.clock.nowIso() });
  ports.store.addActiveRun({
    runId,
    runDir: dirname(worktree),
    worktree,
    babySessionId: newSessionId,
    startedAt: ports.clock.nowIso(),
  });

  const gate = ports.store.readGateState(runId);
  const { next, reason } = rotationGateState(gate, needsReconciliation);
  ports.store.writeGateState(runId, next);
  journal(ports, runId, turn, { event: "gate_latched", reason });

  return newSessionId;
};
