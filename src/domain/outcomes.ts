import { z } from "zod"

// ---------------------------------------------------------------------------
// Outcome ledger (CONTRACT §8)

export const OutcomeStatus = z.enum(["not_started", "in_progress", "done", "blocked"])
export type OutcomeStatus = z.infer<typeof OutcomeStatus>

export const OutcomeEntry = z.object({
  id: z.string(),
  description: z.string(),
  status: OutcomeStatus,
  evidence: z.array(z.string()).default([]),
  state: z.string().optional(),
  nextAction: z.string().optional(),
  updatedAt: z.string(),
})
export type OutcomeEntry = z.infer<typeof OutcomeEntry>

export const OutcomeLedger = z.object({
  runId: z.string(),
  outcomes: z.array(OutcomeEntry),
  updatedAt: z.string(),
})
export type OutcomeLedger = z.infer<typeof OutcomeLedger>

// ---------------------------------------------------------------------------
// Checkpoint (CONTRACT §8 O4)

export const CheckpointOutcome = z.object({
  id: z.string(),
  status: OutcomeStatus,
  evidence: z.array(z.string()).default([]),
  state: z.string().optional(),
  nextAction: z.string().optional(),
})
export type CheckpointOutcome = z.infer<typeof CheckpointOutcome>

export const Checkpoint = z.object({
  number: z.number().int(),
  reason: z.string(),
  summary: z.string(),
  outcomes: z.array(CheckpointOutcome).min(1),
  filesChanged: z.array(z.object({ path: z.string(), reason: z.string().optional() })).default([]),
  filesInspected: z.array(z.object({ path: z.string(), learned: z.string().optional() })).default([]),
  uncertainties: z.array(z.string()).default([]),
  writtenAt: z.string(),
})
export type Checkpoint = z.infer<typeof Checkpoint>
