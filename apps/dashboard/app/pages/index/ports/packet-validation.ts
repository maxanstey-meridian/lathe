import type { Ref } from "vue";

import type { ValidatePacketResponse } from "@lathe/contract";

import { useProvideInject } from "~/composables/useProvideInject";

export interface PacketValidation {
  readonly preview: Ref<ValidatePacketResponse | null>;
  readonly previewError: Ref<string | null>;
  validatePacket(content: string, filename: string): Promise<void>;
  clearPacket(): void;
}

export const [injectPacketValidation, providePacketValidation] = useProvideInject<PacketValidation>("PacketValidation");
