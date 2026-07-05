export const daemonEventsUrl = (apiBaseUrl: string): string => `${apiBaseUrl.replace(/\/+$/, "")}/events`;

export const daemonTailEventsUrl = (apiBaseUrl: string): string => `${apiBaseUrl.replace(/\/+$/, "")}/tail/active/events`;

export const daemonTailRunEventsUrl = (apiBaseUrl: string, runId: string): string =>
  `${apiBaseUrl.replace(/\/+$/, "")}/tail/${encodeURIComponent(runId)}/events`;
