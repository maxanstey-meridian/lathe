import type { LatheEvent, TailEvent, TailSnapshotDto } from "@lathe/contract";

export interface EventBus {
  publish(seq: number, event: LatheEvent): void;
  subscribe(onEvent: (seq: number, event: LatheEvent) => void): () => void;
}

export interface TailEventBus {
  publish(event: TailEvent): void;
  revision(): number;
  subscribe(onEvent: (revision: number, event: TailEvent) => void): () => void;
}

export const createEventBus = (): EventBus => {
  const subs = new Set<(seq: number, event: LatheEvent) => void>();
  return {
    publish: (seq, event) => { for (const subscriber of subs) subscriber(seq, event); },
    subscribe: (onEvent) => { subs.add(onEvent); return () => subs.delete(onEvent); },
  };
};

export const createTailEventBus = (): TailEventBus => {
  const subs = new Set<(revision: number, event: TailEvent) => void>();
  let revision = 0;
  return {
    publish: (event) => {
      revision += 1;
      for (const subscriber of subs) subscriber(revision, event);
    },
    revision: () => revision,
    subscribe: (onEvent) => { subs.add(onEvent); return () => subs.delete(onEvent); },
  };
};

export type PreparedTailSnapshot = {
  readonly snapshot: TailSnapshotDto | null;
  readonly revision: number;
};

export interface AppDeps {
  bus: EventBus;
  readEventsSince: (seq: number) => { seq: number; event: LatheEvent }[];
  tailBus?: TailEventBus;
  readTailEventsSince?: (seq: number, runId: string) => TailEvent[];
  prepareTailSnapshot?: (runId: string | null) => Promise<PreparedTailSnapshot>;
  resolveActiveTailRunId?: () => string | null;
}
