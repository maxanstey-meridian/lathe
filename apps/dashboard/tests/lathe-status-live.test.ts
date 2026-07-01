import { strict as assert } from "node:assert";
import { test } from "node:test";

import { connectLatheStatusLiveUpdates, REFRESH_EVENT_KINDS } from "../app/pages/index/composables/lathe-status-live";

class FakeEventSource {
  public onopen: ((event: Event) => void) | null = null;

  public onerror: ((event: Event) => void) | null = null;

  public readonly listeners = new Map<string, Array<() => void>>();

  public closeCount = 0;

  constructor(public readonly url: string) {}

  addEventListener = (type: string, listener: () => void): void => {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  };

  close = (): void => {
    this.closeCount += 1;
  };

  emitOpen = (): void => {
    this.onopen?.(new Event("open"));
  };

  emitError = (): void => {
    this.onerror?.(new Event("error"));
  };

  emit = (type: string): void => {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  };
}

test("connectLatheStatusLiveUpdates debounces refreshes and keeps the SSE connection open on errors", async () => {
  const createdSources: FakeEventSource[] = [];
  const liveStates: boolean[] = [];
  let refreshCount = 0;

  const connection = connectLatheStatusLiveUpdates({
    url: "http://127.0.0.1:4198/events",
    debounceMs: 10,
    onLiveChange: (isLive) => {
      liveStates.push(isLive);
    },
    onRefresh: () => {
      refreshCount += 1;
    },
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      createdSources.push(source);
      return source;
    },
  });

  assert.equal(createdSources.length, 1);
  assert.equal(createdSources[0]?.url, "http://127.0.0.1:4198/events");
  assert.deepEqual([...createdSources[0]!.listeners.keys()].sort(), [...REFRESH_EVENT_KINDS].sort());

  createdSources[0]!.emitOpen();
  assert.deepEqual(liveStates, [true]);

  createdSources[0]!.emit("run.state");
  createdSources[0]!.emit("verdict");
  createdSources[0]!.emit("tokens");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(refreshCount, 1);

  createdSources[0]!.emitError();
  assert.deepEqual(liveStates, [true, false]);
  assert.equal(createdSources[0]!.closeCount, 0);

  connection.close();
  assert.equal(createdSources[0]!.closeCount, 1);
});
