import { homedir } from "os"
import { join } from "path"

export const expandHome = (p: string): string =>
  p.startsWith("~") ? join(homedir(), p.slice(1)) : p

export type Paths = {
  root: string
  configFile: string
  queueDir: string
  rejectedDir: string
  stagedDir: string
  stagedFile: (runId: string) => string
  runsDir: string
  activeRunFile: string
  xdgConfigHome: string
  opencodeConfigFile: string
  serveLogFile: string
  runDir: (runId: string) => string
  packetFile: (runId: string) => string
  metaFile: (runId: string) => string
  journalFile: (runId: string) => string
  decisionsFile: (runId: string) => string
  reviewStateFile: (runId: string) => string
  outcomesFile: (runId: string) => string
  gateStateFile: (runId: string) => string
  checkpointsDir: (runId: string) => string
  reportFile: (runId: string) => string
  nitsFile: (runId: string) => string
  convergenceFile: (runId: string) => string
  campaignsDir: string
  campaignDir: (campaignId: string) => string
  campaignFile: (campaignId: string) => string
}

export const makePaths = (stateRoot: string): Paths => {
  const root = expandHome(stateRoot)
  const runsDir = join(root, "runs")
  const runDir = (runId: string) => join(runsDir, runId)
  const campaignsDir = join(root, "campaigns")
  const campaignDir = (campaignId: string) => join(campaignsDir, campaignId)
  return {
    root,
    configFile: join(root, "config.json"),
    queueDir: join(root, "queue"),
    // Packets are NEVER deleted — a rejected/dropped packet moves here (with a
    // .problems.txt sidecar when it failed validation) so it can always be
    // inspected, fixed, and re-admitted. Nothing in the pipeline unlinks a packet
    // outright; the only "removal" is relocation (to a run dir on consume, here on
    // reject/drop).
    rejectedDir: join(root, "rejected"),
    // Chained child packets registered via `meridian chain add`, waiting for their
    // upstream campaign to converge before they are promoted into the queue (§19).
    // Like the queue, a staged packet is never destroyed — promotion failure
    // archives it to rejectedDir with reasons.
    stagedDir: join(root, "staged"),
    stagedFile: (runId) => join(root, "staged", `${runId}.md`),
    runsDir,
    activeRunFile: join(root, "active-run.json"),
    // Inside an isolated XDG_CONFIG_HOME so the serve instance reads ONLY this
    // config — opencode merges every config location it knows, so the global
    // ~/.config/opencode (v1 plugins, v1 bridge, MCP toy box) must be out of
    // its search path entirely, not merely overridden.
    xdgConfigHome: join(root, "xdg"),
    opencodeConfigFile: join(root, "xdg", "opencode", "opencode.json"),
    serveLogFile: join(root, "opencode-serve.log"),
    runDir,
    packetFile: (runId) => join(runDir(runId), "packet.md"),
    metaFile: (runId) => join(runDir(runId), "meta.json"),
    journalFile: (runId) => join(runDir(runId), "journal.jsonl"),
    decisionsFile: (runId) => join(runDir(runId), "decisions.jsonl"),
    reviewStateFile: (runId) => join(runDir(runId), "review-state.json"),
    outcomesFile: (runId) => join(runDir(runId), "outcomes.json"),
    gateStateFile: (runId) => join(runDir(runId), "gate-state.json"),
    checkpointsDir: (runId) => join(runDir(runId), "checkpoints"),
    reportFile: (runId) => join(runDir(runId), "report.md"),
    nitsFile: (runId) => join(runDir(runId), "nits.md"),
    convergenceFile: (runId) => join(runDir(runId), "convergence.jsonl"),
    campaignsDir,
    campaignDir,
    campaignFile: (campaignId) => join(campaignDir(campaignId), "campaign.json"),
  }
}
