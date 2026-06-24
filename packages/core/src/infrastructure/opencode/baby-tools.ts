// ---------------------------------------------------------------------------
// Baby tools — write_handoff and verify_handoff (verify-handoff protocol)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunRef } from "../bridge.js";
import { writeAtomic, nowIso, readValidatedIfExists } from "../fsio.js";
import type { HandoffArtifact, VerifyVerdict } from "../../domain/handoff.js";
import { HandoffArtifact as HandoffArtifactSchema } from "../../domain/handoff.js";
import { runVerify } from "./daddy-verify.js";
import { diffStat } from "../git.js";

// ---------------------------------------------------------------------------
// Tool input types
// ---------------------------------------------------------------------------

export type WriteHandoffInput = {
  completedSteps: Array<{ description: string; files?: string[] }>;
  remainingWork: string[];
  decisionsMade: string[];
  resumeFrom: string;
};

export type VerifyHandoffInput = {
  claimedCompletions: string[];
  questionsForDaddy?: string[];
};

// ---------------------------------------------------------------------------
// Text result helpers (mirrors bridge.ts text/errorText)
// ---------------------------------------------------------------------------

const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  isError: false as const,
});

const errorText = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  isError: true as const,
});

const turnCompleteError = () =>
  errorText(
    JSON.stringify({
      error: "End your turn now — the driver has recorded your submission and will act on it.",
    }),
  );

// ---------------------------------------------------------------------------
// write_handoff — baby writes progress to disk
// ---------------------------------------------------------------------------

// Handles write_handoff tool calls: validates the input, constructs a
// HandoffArtifact (with runId + timestamp added), and writes it atomically
// to {runStateDir}/handoff.json. Each call overwrites the previous.
// The file persists across baby recycling; the run loop reads it when
// spawning a replacement baby.
export const handleWriteHandoff = async (
  ref: RunRef,
  input: WriteHandoffInput,
) => {
  const ctx = ref.current;
  if (!ctx) {
    return errorText(JSON.stringify({ error: "no active run" }));
  }
  if (ctx.awaitingVerification) return errorText(JSON.stringify({ error: "Handoff verification required. Call verify_handoff before any other tool." }));
  if (ctx.turnComplete) return turnCompleteError();

  const runId = ctx.packet.runId;
  const runDir = ctx.paths.runDir(runId);
  const handoffPath = join(runDir, "handoff.json");

  // Validate and construct the artifact.
  const artifact: HandoffArtifact = {
    runId,
    timestamp: nowIso(),
    completedSteps: input.completedSteps.map((s) => ({
      description: s.description,
      files: s.files ?? [],
    })),
    remainingWork: input.remainingWork,
    decisionsMade: input.decisionsMade,
    resumeFrom: input.resumeFrom,
  };

  // Validate against the schema.
  const validated = HandoffArtifactSchema.safeParse(artifact);
  if (!validated.success) {
    return errorText(
      JSON.stringify({
        error: "write_handoff failed: invalid artifact",
        problems: validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      }),
    );
  }

  // Write atomically: temp file + rename.
  try {
    writeAtomic(handoffPath, JSON.stringify(validated.data, null, 2));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return errorText(JSON.stringify({ error: `write_handoff failed to persist: ${detail}` }));
  }

  return text(JSON.stringify({ written: true }));
};

// ---------------------------------------------------------------------------
// verify_handoff — baby asks daddy for a spot-check verdict
// ---------------------------------------------------------------------------

// Handles verify_handoff tool calls: reads the handoff.json, runs a targeted
// git diff and file reads for the declared surface, invokes daddy in verify
// mode, and returns the VerifyVerdict as the tool result.
// Clears awaitingVerification after the verdict resolves (regardless of ok/fail).
//
// This is synchronous from the MCP handler's perspective. If the verify
// surface is small (a few files), daddy should respond within ~1-2 minutes.
// If the surface is large or daddy is slow, the call may hit the ~5min MCP
// client cancellation; in that case, switch to the deferred pattern
// (record verify intent, turn loop runs it).
export const handleVerifyHandoff = async (
  ref: RunRef,
  input: VerifyHandoffInput,
) => {
  const ctx = ref.current;
  if (!ctx) {
    return errorText(JSON.stringify({ error: "no active run" }));
  }
  if (ctx.turnComplete) return turnCompleteError();

  // Read the handoff artifact from disk.
  const runDir = ctx.paths.runDir(ctx.packet.runId);
  const handoffPath = join(runDir, "handoff.json");
  let handoff: HandoffArtifact;
  try {
    const parsed = readValidatedIfExists(handoffPath, HandoffArtifactSchema);
    if (!parsed) {
      return errorText(
        JSON.stringify({
          error: "verify_handoff: no handoff.json found — call write_handoff first",
        }),
      );
    }
    handoff = parsed;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return errorText(
      JSON.stringify({ error: `verify_handoff: failed to read handoff.json: ${detail}` }),
    );
  }

  // Gather the declared surface: git diff stat + file samples.
  // Only read files listed in completedSteps[*].files — no full repo scan.
  const fullDiff = diffStat(ctx.worktree, ctx.packet.frontmatter.base);

  // Collect all unique files from the handoff.
  const fileSet = new Set<string>();
  for (const step of handoff.completedSteps) {
    for (const f of step.files) {
      fileSet.add(f);
    }
  }

  // Post-filter the diff stat to only include lines for declared file paths.
  // A diff stat line like "src/foo.ts | 5 ++++" starts with the file path.
  const declaredDiff =
    fileSet.size > 0
      ? fullDiff
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .filter((line) => {
            // The path is the first whitespace-delimited token.
            const path = line.split(/\s+/)[0] ?? "";
            return fileSet.has(path);
          })
          .join("\n")
      : "";

  const fileSamples: Record<string, string> = {};

  try {
    // Read each file's content.
    for (const file of fileSet) {
      try {
        const content = readFileSync(join(ctx.worktree, file), "utf-8");
        fileSamples[file] = content;
      } catch {
        fileSamples[file] = "(file not found — read failed)";
      }
    }
  } catch {
    /* file read failures are non-fatal; they appear in samples as errors */
  }

  // Run the verify call.
  const verdict = await runVerify(
    ctx.executor,
    ctx.verifyModel,
    ctx.config.daddy.timeoutMs,
    ctx.worktree,
    handoff,
    declaredDiff,
    fileSamples,
    input.questionsForDaddy ?? [],
  );

  // Clear the verification gate regardless of verdict — baby has verified,
  // it can now act on whatever daddy returned.
  ctx.awaitingVerification = false;

  return text(JSON.stringify(verdict));
};
