import { AES } from "aes-js";
import { decompressFromEncodedURIComponent } from "lz-string";

// GAN Gen1 compressed key blobs (same as library source)
const GAN_GEN1_COMPRESSED_KEYS = [
  "NoRgnAHANATADDWJYwMxQOxiiEcfYgSK6Hpr4TYCs0IG1OEAbDszALpA",
  "NoNg7ANATFIQnARmogLBRUCs0oAYN8U5J45EQBmFADg0oJAOSlUQF0g",
  "NoRgNATGBs1gLABgQTjCeBWSUDsYBmKbCeMADjNnXxHIoIF0g",
  "NoRg7ANAzBCsAMEAsioxBEIAc0Cc0ATJkgSIYhXIjhMQGxgC6QA",
  "NoVgNAjAHGBMYDYCcdJgCwTFBkYVgAY9JpJYUsYBmAXSA",
  "NoRgNAbAHGAsAMkwgMyzClH0LFcArHnAJzIqIBMGWEAukA",
] as const;

type AesEcb = AES & { decrypt(block: number[]): number[] };

class GanGen1Aes {
  private readonly aes: AesEcb;

  constructor(keyBytes: Uint8Array) {
    this.aes = new AES([...keyBytes]) as AesEcb;
  }

  decrypt(data: Uint8Array): Uint8Array {
    if (data.length < 16) throw new Error("Data too short");
    const t = Array.from(data);
    if (t.length > 16) {
      const i = t.length - 16;
      const n = this.aes.decrypt(t.slice(i, i + 16));
      for (let r = 0; r < 16; r++) t[r + i] = n[r]!;
    }
    const s = this.aes.decrypt(t.slice(0, 16));
    for (let r = 0; r < 16; r++) t[r] = s[r]!;
    return new Uint8Array(t);
  }
}

function deriveGen1Key(fwVersion: number, hw: DataView): Uint8Array | null {
  const idx = (fwVersion >> 8) & 255;
  const compressed =
    GAN_GEN1_COMPRESSED_KEYS[idx] ?? GAN_GEN1_COMPRESSED_KEYS[0];
  if (!compressed) return null;
  const json = decompressFromEncodedURIComponent(compressed);
  if (!json) return null;
  let arr: number[];
  try {
    arr = JSON.parse(json) as number[];
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length < 16 || hw.byteLength < 6) return null;
  for (let s = 0; s < 6; s++) {
    arr[s] = (arr[s]! + hw.getUint8(5 - s)) & 255;
  }
  return new Uint8Array(arr.slice(0, 16));
}

export type Gen1DeviceInfo = {
  // firmware revision DataView (0x2a28)
  firmwareRevision: DataView | null;
  // system ID DataView (0x2a23)
  systemId: DataView | null;
};

export type GanDecryptResult =
  | { status: "success"; decryptedBytes: Uint8Array }
  | { status: "failed"; message: string }
  | { status: "unavailable"; message: string };

export function tryDecryptGen1Packet(
  encryptedBytes: Uint8Array,
  deviceInfo: Gen1DeviceInfo
): GanDecryptResult {
  const { firmwareRevision, systemId } = deviceInfo;

  if (!firmwareRevision || !systemId) {
    return {
      status: "unavailable",
      message: "Need firmware revision + system ID from Device Information service",
    };
  }

  if (firmwareRevision.byteLength < 3) {
    return { status: "failed", message: "Firmware revision too short" };
  }

  const fwVersion =
    (firmwareRevision.getUint8(0) << 16) |
    (firmwareRevision.getUint8(1) << 8) |
    firmwareRevision.getUint8(2);

  const key = deriveGen1Key(fwVersion, systemId);
  if (!key) {
    return { status: "failed", message: "Failed to derive Gen1 AES key" };
  }

  try {
    const decrypted = new GanGen1Aes(key).decrypt(encryptedBytes);
    return { status: "success", decryptedBytes: decrypted };
  } catch (e) {
    return {
      status: "failed",
      message: e instanceof Error ? e.message : "AES decrypt error",
    };
  }
}
