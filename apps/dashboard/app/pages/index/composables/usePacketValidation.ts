import type { RivetClient } from "@lathe/contract";
import type { components } from "@lathe/contract";
import { ref } from "vue";

import { client } from "@lathe/contract";

type ValidatePacketResponse = components["schemas"]["ValidatePacketResponse"];

export const validatePacketWithClient = async (
  c: RivetClient,
  content: string,
  filename: string,
): Promise<{ data: ValidatePacketResponse | null; error: string | null }> => {
  try {
    const result = await c.POST("/packet", {
      body: { content, filename },
    });
    return { data: result.data ?? null, error: null };
  } catch (err) {
    const msg = typeof err === "string" ? err : (err && typeof err === "object" && "message" in err && typeof (err as { message: unknown }).message === "string" ? (err as { message: string }).message : "Unable to validate packet.");
    return { data: null, error: msg };
  }
};

export const usePacketValidation = (c: RivetClient = client) => {
  const preview = ref<ValidatePacketResponse | null>(null);
  const previewError = ref<string | null>(null);

  const validatePacket = async (content: string, filename: string): Promise<void> => {
    previewError.value = null;
    try {
      const result = await c.POST("/packet", {
        body: { content, filename },
      });
      preview.value = result.data ?? null;
    } catch {
      previewError.value = "Unable to validate packet.";
      preview.value = null;
    }
  };

  const clearPacket = (): void => {
    preview.value = null;
    previewError.value = null;
  };

  return { preview, previewError, validatePacket, clearPacket };
};
