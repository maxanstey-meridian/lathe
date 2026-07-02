import { client } from "@lathe/contract";
import type { components } from "@lathe/contract";
import { ref } from "vue";

type ValidatePacketResponse = components["schemas"]["ValidatePacketResponse"];

export const usePacketValidation = () => {
  const preview = ref<ValidatePacketResponse | null>(null);
  const previewError = ref<string | null>(null);

  const validatePacket = async (content: string, filename: string): Promise<void> => {
    previewError.value = null;
    try {
      const result = await client.POST("/packet", {
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
