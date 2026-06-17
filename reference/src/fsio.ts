// Validated file IO: every durable file passes its schema on read AND write
// (CONTRACT D6). A read that fails validation throws — fail closed (D5); the
// caller decides whether that parks a run or rejects an admission.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync } from "fs"
import { dirname } from "path"
import type { z } from "zod"

export const readValidated = <S extends z.ZodTypeAny>(path: string, schema: S): z.infer<S> => {
  const raw = readFileSync(path, "utf-8")
  const parsed = schema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    throw new Error(`${path} failed schema validation: ${parsed.error.message}`)
  }
  return parsed.data
}

export const readValidatedIfExists = <S extends z.ZodTypeAny>(
  path: string,
  schema: S,
): z.infer<S> | undefined => (existsSync(path) ? readValidated(path, schema) : undefined)

// Atomic write: temp file + rename, so a crash mid-write never leaves a
// half-written durable file for a validated read to choke on.
export const writeValidated = <S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  value: z.infer<S>,
): void => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`refusing to write ${path}: ${parsed.error.message}`)
  }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(parsed.data, null, 2), "utf-8")
  renameSync(tmp, path)
}

export const appendJsonl = <S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  value: z.infer<S>,
): void => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new Error(`refusing to append to ${path}: ${parsed.error.message}`)
  }
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(parsed.data) + "\n", "utf-8")
}

export const readJsonl = <S extends z.ZodTypeAny>(path: string, schema: S): z.infer<S>[] => {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, "utf-8").split("\n").map((l) => l.trim()).filter(Boolean)
  const out: z.infer<S>[] = []
  for (const line of lines) {
    const parsed = schema.safeParse(JSON.parse(line))
    if (parsed.success) out.push(parsed.data)
    // Invalid journal lines are skipped, not fatal: the journal is observability,
    // and one bad line must not brick replay of the rest. Durable *state* files
    // (meta, outcomes, gate) go through readValidated and DO fail closed.
  }
  return out
}

export const nowIso = (): string => new Date().toISOString()
