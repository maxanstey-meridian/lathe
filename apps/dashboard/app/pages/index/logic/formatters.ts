import type { RunStatus } from "@lathe/contract";

const UNITS = [
  { max: 60, value: 1, label: "s" },
  { max: 3600, value: 60, label: "m" },
  { max: 86400, value: 3600, label: "h" },
  { max: 604800, value: 86400, label: "d" },
  { max: Infinity, value: 604800, label: "w" },
] as const;

export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = Math.max(0, Math.floor((now - then) / 1000));

  for (const unit of UNITS) {
    if (diff < unit.max) {
      const count = Math.max(1, Math.floor(diff / unit.value));
      return `${count}${unit.label} ago`;
    }
  }

  return "just now";
}

export function runStatusColor(status: RunStatus): "error" | "primary" | "secondary" | "success" | "info" | "warning" | "neutral" {
  switch (status) {
    case "queued":
      return "info";
    case "running":
      return "primary";
    case "interrupted":
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
    case "interrupted":
      return "Interrupted";
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
