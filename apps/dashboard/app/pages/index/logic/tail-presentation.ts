export const runLabel = (runId: string, summary: string | null): string => {
  const raw = summary && summary.trim().length > 0
    ? summary.trim()
    : runId.replace(/^\d{8}-\d{6}-/, "").replace(/-/g, " ");

  return raw.length > 50 ? `${raw.slice(0, 49)}...` : raw;
};

export const formatTailDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return hours > 0
    ? `${hours}h${String(minutes).padStart(2, "0")}m`
    : `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
};
