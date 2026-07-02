const REFRESH_EVENT_KINDS = ["run.state", "verdict", "tokens"] as const;

type LatheStatusEventSource = {
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener: (type: string, listener: () => void) => void;
  close: () => void;
};

type ConnectLatheStatusLiveUpdatesParams = {
  url: string;
  debounceMs?: number;
  onLiveChange: (isLive: boolean) => void;
  onRefresh: () => void;
  createEventSource?: (url: string) => LatheStatusEventSource;
};

export const connectLatheStatusLiveUpdates = ({
  url,
  debounceMs = 500,
  onLiveChange,
  onRefresh,
  createEventSource = (targetUrl) => new EventSource(targetUrl),
}: ConnectLatheStatusLiveUpdatesParams): { close: () => void } => {
  const eventSource = createEventSource(url);
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleRefresh = (): void => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      onRefresh();
    }, debounceMs);
  };

  eventSource.onopen = () => {
    onLiveChange(true);
  };

  eventSource.onerror = () => {
    onLiveChange(false);
  };

  for (const kind of REFRESH_EVENT_KINDS) {
    eventSource.addEventListener(kind, scheduleRefresh);
  }

  return {
    close: () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }

      eventSource.close();
    },
  };
};

export { REFRESH_EVENT_KINDS };
