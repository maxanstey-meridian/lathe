import type { RunStatus } from "@lathe/contract";

export function runStatusColor(status: RunStatus): "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" {
  switch (status) {
    case "queued":
      return "info";
    case "running":
      return "primary";
    case "ready_for_review":
      return "warning";
    case "accepted":
      return "success";
    case "stopped":
      return "error";
    case "failed":
      return "error";
    case "blocked":
      return "error";
    default:
      return "neutral";
  }
}

export function runStatusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "Awaiting start";
    case "running":
      return "Implementation in progress";
    case "accepted":
      return "Prepared for merge";
    case "stopped":
      return "Cancelled";
    case "failed":
      return "Needs attention";
    case "ready_for_review":
      return "Awaiting acceptance review";
    case "blocked":
      return "Needs input";
    default:
      return status.replaceAll("_", " ");
  }
}

export function campaignStatusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Repair sequence in progress";
    case "converged":
      return "Review passed";
    case "needs_max":
      return "Needs operator decision";
    default:
      return status.replaceAll("_", " ");
  }
}

export function campaignStatusIcon(status: string): string {
  switch (status) {
    case "converged":
      return "✅";
    case "needs_max":
      return "🅿";
    default:
      return "…";
  }
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const sliced = text.slice(0, max);
  const lastSpace = sliced.lastIndexOf(" ");
  const cut = lastSpace > max * 0.7 ? lastSpace : max;
  return `${sliced.slice(0, cut).replace(/[\s.…]+$/, "")}…`;
}
