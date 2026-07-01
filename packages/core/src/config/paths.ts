import { homedir } from "node:os";
import { join } from "node:path";

export const expandHome = (p: string): string =>
  p.startsWith("~") ? join(homedir(), p.slice(1)) : p;

export type Paths = {
  root: string;
  configFile: string;
  dbFile: string;
  runsDir: string;
  xdgConfigHome: string;
  opencodeConfigFile: string;
  serveLogFile: string;
  runDir: (runId: string) => string;
  packetFile: (runId: string) => string;
};

export const makePaths = (stateRoot: string): Paths => {
  const root = expandHome(stateRoot);
  const runsDir = join(root, "runs");
  const runDir = (runId: string) => join(runsDir, runId);
  return {
    root,
    configFile: join(root, "config.json"),
    dbFile: join(root, "lathe.db"),
    runsDir,
    xdgConfigHome: join(root, "xdg"),
    opencodeConfigFile: join(root, "xdg", "opencode", "opencode.json"),
    serveLogFile: join(root, "opencode-serve.log"),
    runDir,
    packetFile: (runId) => join(runDir(runId), "packet.md"),
  };
};
