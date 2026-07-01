// ---------------------------------------------------------------------------
// Admit-packet use case (CONTRACT §4 K1, K3, F3)
//
// Application-layer entry point for packet admission. Delegates to the Store
// port which wires the pure domain parse (parsePacketShape) to the Repo-port
// filesystem checks (repo exists + is git, base resolves; stamp base from HEAD
// when omitted). On failure, the Store records the rejected packet and its
// problems — never deletes the caller's source file (F3).
// ---------------------------------------------------------------------------

import type { Store } from "../ports/store.js";

// Admit a packet file (identified by runId) into the queue. The raw packet
// content is validated at every layer: YAML parse → schema validate → repo
// check → base resolve → queued run write. Any failure records the rejection (F3).
export const admitPacket = (store: Store, runId: string, raw: string): void => {
  store.admitQueue(runId, raw);
};
