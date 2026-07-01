// ---------------------------------------------------------------------------
// Daddy verify mode — lightweight spot-check of a handoff artifact
// (verify-handoff protocol).
//
// This module is the daddy-side of verify_handoff: build a compact, targeted
// prompt, send it to Daddy via a short-lived session, and return a parsed
// VerifyVerdict.
// Verify mode shares no code with convergence — two separate concerns.
// ---------------------------------------------------------------------------

import type { Executor, ModelConfig } from "../../application/ports/executor.js";
import type { HandoffArtifact, VerifyVerdict } from "../../domain/handoff.js";
import { parseVerifyVerdict } from "../../domain/handoff.js";
import { harvestReply } from "./harvest.js";

// ---------------------------------------------------------------------------
// buildVerifyPrompt — pure function, no I/O
// ---------------------------------------------------------------------------

// Build the prompt for daddy's verify mode. Daddy reads baby's claimed
// completions and the file samples for the declared surface, then responds with
// ONLY a VerifyVerdict JSON block.
//
// The prompt is intentionally compact — it targets only the declared surface,
// no full convergence, no report. Daddy reads as much as it needs to give a
// confident verdict (do not cap or truncate daddy's context).
export const buildVerifyPrompt = (
  handoff: HandoffArtifact,
  fileSamples: Record<string, string>,
  questions: string[],
): string => {
  const stepsBlock =
    handoff.completedSteps.length > 0
      ? `## Claimed completions

${handoff.completedSteps
  .map(
    (s) =>
      `- ${s.description}
  Files: ${s.files.join(", ") || "(none)"}`,
  )
  .join("\n")}

`
      : "";

  const samplesBlock =
    Object.keys(fileSamples).length > 0
      ? `## File samples (declared surface)

${Object.entries(fileSamples)
  .map(
    ([path, content]) => `### ${path}

\`\`\`
${content}
\`\`\``,
  )
  .join("\n\n")}

`
      : "";

  const questionsBlock =
    questions.length > 0
      ? `## Baby's questions

${questions.map((q) => `- ${q}`).join("\n")}

`
      : "";

  return `You are in verify mode. Spot-check baby's handoff artifact and return ONLY a VerifyVerdict JSON block — no reasoning, no prose, no markdown fences, nothing before the opening { or after the closing }.

${stepsBlock}${samplesBlock}${questionsBlock}## Your task

1. Read each claimed completion. For each, check that the files listed in completedSteps[*].files exist and contain the work described.
2. Confirm each file listed in the handoff actually contains the claimed change.
3. Read file samples to verify the work is structurally sound (types, no obvious errors).
4. Answer baby's questions if any.
5. Respond with ONLY a VerifyVerdict JSON block:

{
  "ok": true | false,
  "trusted": [{ "description": "step that checks out", "files": ["file1", "file2"] }],
  "issues": [{ "file": "problematic-file.ts", "problem": "one-line problem description" }],
  "resumeHint": "one sentence: where baby should pick up next"
}

- ok: true if baby can confidently stand on this work and continue; false if there are structural issues or missing pieces baby should fix first.
- trusted: which steps (subset or all) check out — description and files from the handoff.
- issues: anything that doesn't check out — file path and one-line problem.
- resumeHint: where baby should pick up next, based on the handoff's resumeFrom and remainingWork.`;
};

// ---------------------------------------------------------------------------
// runVerify — orchestrates a daddy-verify call
// ---------------------------------------------------------------------------

// Run a verify call: create a short-lived session, send the prompt to daddy,
// parse the verdict, delete the session.
//
// This is synchronous from the MCP handler's perspective. If the verify
// surface is small (a few files), this should complete within ~1-2 minutes
// and avoid the ~5min MCP client cancellation scar.
//
// If the surface is large or daddy is slow, the caller should switch to the
// deferred pattern (record verify intent, turn loop runs it off the MCP path).
export const runVerify = async (
  executor: Executor,
  verifyModel: ModelConfig,
  verifyTimeoutMs: number,
  worktree: string,
  handoff: HandoffArtifact,
  fileSamples: Record<string, string>,
  questions: string[],
): Promise<VerifyVerdict> => {
  const prompt = buildVerifyPrompt(handoff, fileSamples, questions);

  let sessionId: string | undefined;
  try {
    sessionId = await executor.createSession("lathe-verify", worktree);
    const response = await executor.sendMessage(sessionId, prompt, verifyModel, verifyTimeoutMs);
    // All-message harvest: daddy reads files (multi-step) before emitting the
    // verdict, which can land in an earlier step leaving the final message empty.
    const { text: raw } = await harvestReply(executor, sessionId, response);
    return parseVerifyVerdict(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      trusted: [],
      issues: [{ file: "daddy-verify", problem: `verify call failed: ${detail}` }],
      resumeHint: "ask_planner to investigate",
    };
  } finally {
    try {
      if (sessionId) {
        await executor.deleteSession(sessionId);
      }
    } catch {
      /* session cleanup failure is non-fatal */
    }
  }
};
