// The queue is a directory; lexical filename order is queue order (F1).
// Requeued parked runs re-enter at the front (F2) via the requeue list in
// front of fresh packets, not by renaming files.

import { readdirSync, readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "fs"
import { join, basename } from "path"
import { parsePacket, stampBaseFromHead, type AdmissionResult } from "./packet.js"
import { readValidatedIfExists } from "./fsio.js"
import { RunMeta } from "./schemas.js"
import type { Paths } from "./paths.js"

export type QueueEntry = { file: string; runId: string; kind: "fresh" | "requeued" }

// A packet is never deleted — it is moved to the rejected dir so it can be
// inspected and re-admitted. `problems` (admission failures) are preserved in a
// sibling .problems.txt so the REASON survives too (the driver only logged
// "(REJECTED)" before, losing it). On a name collision (same packet rejected
// twice) a numeric suffix keeps both rather than clobbering. Returns the dest.
export const archivePacket = (paths: Paths, packetPath: string, problems?: string[]): string => {
  mkdirSync(paths.rejectedDir, { recursive: true })
  const base = basename(packetPath)
  let dest = join(paths.rejectedDir, base)
  for (let n = 1; existsSync(dest); n++) dest = join(paths.rejectedDir, base.replace(/\.md$/, `.${n}.md`))
  renameSync(packetPath, dest)
  if (problems && problems.length > 0) writeFileSync(`${dest}.problems.txt`, `${problems.join("\n")}\n`)
  return dest
}

export const listQueue = (paths: Paths): QueueEntry[] => {
  mkdirSync(paths.queueDir, { recursive: true })

  // Parked/interrupted runs that have been requeued: meta.status back to "queued"
  // but the run dir already exists. They go first (F2).
  const requeued: QueueEntry[] = existsSync(paths.runsDir)
    ? readdirSync(paths.runsDir)
        .sort()
        .flatMap((runId) => {
          const meta = readValidatedIfExists(paths.metaFile(runId), RunMeta)
          return meta?.status === "queued"
            ? [{ file: paths.packetFile(runId), runId, kind: "requeued" as const }]
            : []
        })
    : []

  const fresh: QueueEntry[] = readdirSync(paths.queueDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ file: join(paths.queueDir, f), runId: f.replace(/\.md$/, ""), kind: "fresh" as const }))
    // A packet whose run dir already exists is consumed, not fresh.
    .filter((e) => !existsSync(paths.runDir(e.runId)))

  return [...requeued, ...fresh]
}

export const addToQueue = (paths: Paths, packetPath: string): AdmissionResult => {
  // Stamp `base` from the repo's current branch when the packet omits it (infra
  // Daddy shouldn't author — see stampBaseFromHead), BEFORE validating. The
  // stamped copy in the queue dir is the authoritative artifact the driver later
  // freezes and forks from, so base is resolved exactly once, here at admission.
  mkdirSync(paths.queueDir, { recursive: true })
  const dest = join(paths.queueDir, basename(packetPath))
  writeFileSync(dest, stampBaseFromHead(readFileSync(packetPath, "utf-8")))
  const result = parsePacket(dest)
  // Never leave a half-valid packet queued (D5) — but never delete it either:
  // archive it (with its problems) so it can be fixed and re-admitted.
  if (!result.ok) archivePacket(paths, dest, result.problems)
  return result
}

export const dropFromQueue = (paths: Paths, runId: string): boolean => {
  const file = join(paths.queueDir, `${runId}.md`)
  if (!existsSync(file)) return false
  archivePacket(paths, file) // dropped, not destroyed — recoverable from the rejected dir
  return true
}
