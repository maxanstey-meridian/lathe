import type { TailEvent, TailSnapshotDto } from "@lathe/contract";
import { strict as assert } from "node:assert";
import { mount } from "@vue/test-utils";
import { defineComponent, nextTick } from "vue";
import { afterEach, test, vi } from "vitest";

import { useLatheTail } from "../app/pages/index/composables/useLatheTail";

class FakeEventSource {
  public onopen: ((event: Event) => void) | null = null;

  public onerror: ((event: Event) => void) | null = null;

  public readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

  public closeCount = 0;

  public constructor(public readonly url: string) {
    sources.push(this);
  }

  public addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  public close(): void {
    this.closeCount += 1;
  }

  public emitOpen(): void {
    this.onopen?.(new Event("open"));
  }

  public emitError(): void {
    this.onerror?.(new Event("error"));
  }

  public emit(event: TailEvent): void {
    for (const listener of this.listeners.get(event.kind) ?? []) {
      listener(new MessageEvent(event.kind, { data: JSON.stringify(event) }));
    }
  }
}

const sources: FakeEventSource[] = [];

const snapshot = (runId: string): TailSnapshotDto => ({
  runId,
  summary: null,
  status: "running",
  startedAt: null,
  models: { baby: "baby", promoted: "promoted", daddy: "daddy", super: "super" },
  promoted: false,
  budget: 100,
  worktree: `/tmp/${runId}`,
  outcomesDone: 0,
  outcomesTotal: 1,
  gateReason: null,
  contextTokens: 0,
  turn: 0,
  rotations: 0,
  panes: { baby: [], daddy: [], super: [] },
  acceptanceReviewLines: [],
  driverCommands: [],
  journal: [],
  lastSeq: 0,
});

afterEach(() => {
  sources.length = 0;
  vi.unstubAllGlobals();
});

test("useLatheTail waits for the first frame and ignores callbacks from a closed generation", async () => {
  vi.stubGlobal("useRuntimeConfig", () => ({
    public: { apiBaseUrl: "http://127.0.0.1:4198" },
  }));
  vi.stubGlobal("EventSource", FakeEventSource);

  let tail: ReturnType<typeof useLatheTail> | undefined;
  const wrapper = mount(
    defineComponent({
      setup() {
        tail = useLatheTail(Date.now);
        return () => null;
      },
    }),
  );
  assert.ok(tail);
  const mountedTail = tail;
  const activeSource = sources[0];
  assert.ok(activeSource);
  assert.equal(mountedTail.isLoading.value, true);

  activeSource.emitOpen();
  assert.equal(mountedTail.isLive.value, true);
  assert.equal(mountedTail.isLoading.value, true);

  mountedTail.selectRun("run-two");
  await nextTick();
  const selectedSource = sources[1];
  assert.ok(selectedSource);
  assert.equal(activeSource.closeCount, 1);
  assert.equal(mountedTail.state.value.snapshot, null);
  assert.equal(mountedTail.isLoading.value, true);

  activeSource.emit({
    kind: "tail.run.changed",
    runId: "run-one",
    snapshot: snapshot("run-one"),
  });
  activeSource.emitError();
  assert.equal(mountedTail.state.value.snapshot, null);
  assert.equal(mountedTail.errorMessage.value, null);
  assert.equal(mountedTail.isLoading.value, true);

  selectedSource.emit({
    kind: "tail.run.changed",
    runId: "run-two",
    snapshot: snapshot("run-two"),
  });
  assert.equal(mountedTail.state.value.snapshot?.runId, "run-two");
  assert.equal(mountedTail.isLoading.value, false);

  wrapper.unmount();
  assert.equal(selectedSource.closeCount, 1);
});
