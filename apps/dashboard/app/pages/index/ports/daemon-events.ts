import type { LatheEvent } from "@lathe/contract";
import type { Ref } from "vue";

import { useProvideInject } from "~/composables/useProvideInject";

export type DaemonEvent = {
  seq: number;
  kind: string;
  data: LatheEvent;
};

export interface DaemonEvents {
  readonly events: Ref<DaemonEvent[]>;
  readonly isLive: Ref<boolean>;
}

export const [injectDaemonEvents, provideDaemonEvents] = useProvideInject<DaemonEvents>("DaemonEvents");
