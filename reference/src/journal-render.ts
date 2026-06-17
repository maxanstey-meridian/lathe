// One-line renderings of journal events, shared by the plain tail, the Ink
// tail's event strip, and status.

import type { JournalEvent } from "./schemas.js"

export const renderJournalEvent = (e: JournalEvent): string => {
  const t = e.at.slice(11, 19)
  switch (e.event) {
    case "run_started":
      return `${t} ▶ run started (attempt ${e.attempt})`
    case "prompt_sent":
      return `${t} → ${e.promptName}`
    case "turn_ended":
      return `${t} ◀ turn ${e.turn ?? "?"} (${e.contextTokens} ctx tokens)${e.text ? `\n   ${e.text.slice(0, 200).replace(/\n/g, "\n   ")}` : ""}`
    case "tool_call":
      return `${t}   ${e.gateDenied ? "⛔" : "·"} ${e.tool}${e.command ? ` ${e.command.slice(0, 80)}` : ""}${e.target ? ` ${e.target}` : ""}${e.status === "error" && !e.gateDenied ? " ✗" : ""}`
    case "gate_latched":
      return `${t} ⛔ gate latched: ${e.reason}`
    case "gate_cleared":
      return `${t} ✓ gate cleared`
    case "checkpoint_volume_nudge":
      return `${t} 📣 checkpoint shout: ${e.reason}`
    case "planner_exchange":
      return `${t} ☎ [${e.status}] Q: ${e.question.slice(0, 120)}\n   A: ${e.answer.slice(0, 160)}${e.constraints.length ? `\n   constraints: ${e.constraints.join(" | ")}` : ""}`
    case "outcomes_updated":
      return `${t} ☑ outcomes: ${e.outcomes.map((o) => `${o.id}=${o.status}`).join(", ")}`
    case "checkpoint_written":
      return `${t} ⛳ checkpoint ${e.number} ${e.valid ? "valid" : `INVALID: ${e.problems.join("; ")}`}`
    case "rotation":
      return `${t} ♻ rotation: ${e.phase}${e.contextTokens ? ` at ${e.contextTokens} tokens` : ""}`
    case "verification_run":
      return `${t} ${e.exitCode === 0 ? "✅" : "❌"} verification: ${e.command} (exit ${e.exitCode})`
    case "report_submitted":
      return `${t} 📋 report submitted: ${e.status}`
    case "report_rejected":
      return `${t} 📋 report REJECTED: ${e.problems.join("; ")}`
    case "report_accepted":
      return `${t} 📋 report accepted: ${e.status}`
    case "final_review":
      return `${t} 🔍 final review [${e.verdict}]${e.findings.length ? `\n   ${e.findings.join("\n   ")}` : ""}`
    case "ladder_step":
      return `${t} ⚠ no-progress ladder: ${e.count}`
    case "parked":
      return `${t} 🅿 parked (${e.reason})${e.question ? `: ${e.question.slice(0, 120)}` : ""}`
    case "committed":
      return `${t} ⎇ committed ${e.sha.slice(0, 8)}`
    case "driver_note":
      return `${t} ✎ ${e.note}`
    case "stall_recovery":
      return `${t} ${e.action === "requeue" ? "↻" : "🅿"} stall ${e.action} (auto-retry ${e.stallRetries})`
    case "reorient":
      return `${t} 🧭 reorient #${e.attempt} (Baby derailed) → fix: ${e.fix.slice(0, 120)}`
  }
}

// Events worth a line in the Ink event strip (the live panes already carry
// prose and tool calls).
export const isDriverEvent = (e: JournalEvent): boolean =>
  e.event !== "tool_call" && e.event !== "turn_ended" && e.event !== "prompt_sent"
