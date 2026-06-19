import { existsSync, readFileSync } from "node:fs"
import { Config } from "./schemas.js"
import { makePaths, expandHome, type Paths } from "./paths.js"

const DEFAULT_ROOT = "~/.meridian/v2"

// Config lives inside the state root, but the state root is itself config —
// bootstrap order: read the default location; an explicit stateRoot inside it
// relocates everything else. The process reads no env directly; Config is the
// single validated boundary (CONTRACT §14).
export const loadConfig = (): { config: Config; paths: Paths } => {
  const defaultPaths = makePaths(DEFAULT_ROOT)
  const raw = existsSync(defaultPaths.configFile)
    ? JSON.parse(readFileSync(defaultPaths.configFile, "utf-8"))
    : {}
  const parsed = Config.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`${defaultPaths.configFile} failed validation: ${parsed.error.message}`)
  }
  const config = parsed.data
  const paths = makePaths(config.stateRoot)
  return { config, paths }
}

export const babyContextBudget = (config: Config): number =>
  Math.floor(config.baby.contextWindow * config.thresholds.rotationFraction)

export { expandHome, type Paths }
