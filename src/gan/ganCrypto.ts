import type { MacSource } from "./types";

export type GanDecryptInput = {
  encryptedBytes: Uint8Array;
  mac: string | null;
  macSource: MacSource;
  deviceInfo?: Record<string, unknown>;
};

export type GanDecryptResult =
  | {
      status: "not-implemented";
      decryptedBytes: null;
      message: string;
    }
  | {
      status: "success";
      decryptedBytes: Uint8Array;
      message: string;
    }
  | {
      status: "failed";
      decryptedBytes: null;
      message: string;
    };

export async function tryDecryptGanPacket(
  _input: GanDecryptInput
): Promise<GanDecryptResult> {
  return {
    status: "not-implemented",
    decryptedBytes: null,
    message: "GAN AES decryption is not implemented in this lab version yet.",
  };
}
