import { AES, ModeOfOperation } from "aes-js";
import { decompressFromEncodedURIComponent } from "lz-string";

function bytesToHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join(" ");
}

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

export type Gen234CryptoDebug = {
  profile: string;
  saltHex: string;
  baseKeyHex: string;
  baseIvHex: string;
  finalKeyHex: string;
  finalIvHex: string;
};

export type GanDecryptResult =
  | { status: "success"; decryptedBytes: Uint8Array; cryptoDebug?: Gen234CryptoDebug; protocolValid?: boolean; validationReason?: string }
  | { status: "failed"; message: string; cryptoDebug?: Gen234CryptoDebug }
  | { status: "unavailable"; message: string };

// ── Gen4 packet validation (ported from library source) ────────────────────

class GanBitReader {
  private readonly bits: string;
  constructor(message: Uint8Array) {
    this.bits = Array.from(message, (b) => (b + 256).toString(2).slice(1)).join("");
  }
  getBitWord(offset: number, bitLength: number): number {
    if (bitLength <= 8) return parseInt(this.bits.slice(offset, offset + bitLength), 2);
    const buf = new Uint8Array(bitLength / 8);
    for (let i = 0; i < buf.length; i++)
      buf[i] = parseInt(this.bits.slice(8 * i + offset, 8 * i + offset + 8), 2);
    const dv = new DataView(buf.buffer);
    return bitLength === 16 ? dv.getUint16(0, false) : dv.getUint32(0, false);
  }
}

const GEN4_VALID_FIRST_BYTES = [1, 209, 237, 236, 239, 234, 250, 251, 252, 253, 254];

function validateGen4Packet(e: Uint8Array): { valid: boolean; reason: string } {
  if (e.length < 16) return { valid: false, reason: "packet too short" };
  try {
    const t = new GanBitReader(e);
    const firstByte = t.getBitWord(0, 8);
    if (!GEN4_VALID_FIRST_BYTES.includes(firstByte)) {
      return { valid: false, reason: `first byte 0x${firstByte.toString(16).padStart(2, "0")} not in valid set` };
    }
    if (firstByte === 1) {
      const face = t.getBitWord(66, 6);
      if (![2, 32, 8, 1, 16, 4].includes(face)) {
        return { valid: false, reason: `first byte=0x01 but face bits=${face} invalid` };
      }
    }
    return { valid: true, reason: `first byte 0x${firstByte.toString(16).padStart(2, "0")} valid` };
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : "validation error" };
  }
}

// ── Gen2 / Gen3 / Gen4 (AES-128-CBC, salted by MAC) ────────────────────────

const GAN_GEN234_BASE_KEY = [0x01,0x02,0x42,0x28,0x31,0x91,0x16,0x07,0x20,0x05,0x18,0x54,0x42,0x11,0x12,0x53] as const;
const GAN_GEN234_BASE_IV  = [0x11,0x03,0x32,0x28,0x21,0x01,0x76,0x27,0x20,0x95,0x78,0x14,0x32,0x12,0x02,0x43] as const;

const GAN251_UI_BASE_KEY = [0x58,0x98,0x61,0xfc,0x1f,0xec,0xd7,0x60,0x9f,0x85,0xd3,0x62,0xbe,0x37,0x17,0x2c] as const;
const GAN251_UI_BASE_IV  = [0x7f,0x61,0xd0,0x52,0x75,0xc1,0x39,0x52,0x08,0x2e,0x54,0x1d,0x8a,0x78,0x63,0x4d] as const;

export type Gen234CryptoProfileId = "default-gen234" | "gan251-ui-v3-2";

type Gen234CryptoProfile = {
  id: Gen234CryptoProfileId;
  label: string;
  baseKey: readonly number[];
  baseIv: readonly number[];
  trimTrailingZeros: boolean;
  validateCrc16: boolean;
};

const GEN234_CRYPTO_PROFILES: Record<Gen234CryptoProfileId, Gen234CryptoProfile> = {
  "default-gen234": {
    id: "default-gen234",
    label: "GAN public Gen2/3/4",
    baseKey: GAN_GEN234_BASE_KEY,
    baseIv: GAN_GEN234_BASE_IV,
    trimTrailingZeros: false,
    validateCrc16: false,
  },
  "gan251-ui-v3-2": {
    id: "gan251-ui-v3-2",
    label: "GAN251 UI V3-2",
    baseKey: GAN251_UI_BASE_KEY,
    baseIv: GAN251_UI_BASE_IV,
    trimTrailingZeros: true,
    validateCrc16: true,
  },
};

export function detectGen234CryptoProfile(deviceName: string | null | undefined): Gen234CryptoProfileId {
  const name = (deviceName ?? "").trim().toLowerCase();
  if (name.startsWith("gan251ui_") || name.startsWith("ganic251_")) {
    return "gan251-ui-v3-2";
  }
  return "default-gen234";
}

function macToSalt(mac: string): Uint8Array | null {
  const parts = mac.split(":");
  if (parts.length !== 6) return null;
  const bytes = parts.map((p) => parseInt(p, 16));
  if (bytes.some(isNaN)) return null;
  return new Uint8Array(bytes.reverse());
}

function deriveRuntimeKeyIv(
  mac: string,
  profileId: Gen234CryptoProfileId = "default-gen234",
): { salt: Uint8Array; key: Uint8Array; iv: Uint8Array; profile: Gen234CryptoProfile } | null {
  const salt = macToSalt(mac);
  if (!salt) return null;
  const profile = GEN234_CRYPTO_PROFILES[profileId];
  const key = new Uint8Array(profile.baseKey);
  const iv  = new Uint8Array(profile.baseIv);
  for (let i = 0; i < 6; i++) {
    key[i] = (profile.baseKey[i]! + salt[i]!) % 0xFF;
    iv[i]  = (profile.baseIv[i]!  + salt[i]!) % 0xFF;
  }
  return { salt, key, iv, profile };
}

export function deriveGen234CryptoDebug(
  mac: string,
  profileId: Gen234CryptoProfileId = "default-gen234",
): Gen234CryptoDebug | null {
  const derived = deriveRuntimeKeyIv(mac, profileId);
  if (!derived) return null;
  const { salt, key, iv, profile } = derived;
  return {
    profile: profile.label,
    saltHex: bytesToHex(salt),
    baseKeyHex: bytesToHex(new Uint8Array(profile.baseKey)),
    baseIvHex: bytesToHex(new Uint8Array(profile.baseIv)),
    finalKeyHex: bytesToHex(key),
    finalIvHex: bytesToHex(iv),
  };
}

function decryptChunk(buf: Uint8Array, offset: number, key: Uint8Array, iv: Uint8Array): void {
  // New CBC instance each call so IV is always fresh (matches library behavior)
  const cipher = new ModeOfOperation.cbc(key, iv);
  const chunk = cipher.decrypt(buf.subarray(offset, offset + 16));
  buf.set(chunk, offset);
}

function trimTrailingZeros(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return end === bytes.length ? bytes : bytes.slice(0, end);
}

function crc16CcittFalse(bytes: Uint8Array): number {
  let crc = 0xFFFF;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}

function formatWordHex(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

function validateGanCrc16(bytes: Uint8Array): { valid: boolean; reason: string } {
  if (bytes.length < 3) {
    return { valid: false, reason: "CRC16 unavailable: payload too short" };
  }

  const body = bytes.slice(0, -2);
  const crcLo = bytes[bytes.length - 2]!;
  const crcHi = bytes[bytes.length - 1]!;
  const expectedLe = crcLo | (crcHi << 8);
  const expectedBe = (crcLo << 8) | crcHi;
  const computed = crc16CcittFalse(body);
  const matchesLe = computed === expectedLe;
  const matchesBe = computed === expectedBe;

  if (matchesLe || matchesBe) {
    return {
      valid: true,
      reason:
        `CRC16 ok (${matchesLe ? "little" : "big"}-endian ` +
        `${formatWordHex(computed)})`,
    };
  }

  return {
    valid: false,
    reason:
      `CRC16 failed: computed ${formatWordHex(computed)}, ` +
      `packet le=${formatWordHex(expectedLe)} be=${formatWordHex(expectedBe)}`,
  };
}

export type Gen234EventClassification = {
  packetType: "MOVE" | "FACELETS" | "GYRO" | "BATTERY" | "NOTIFY";
  meaning: string;
  isTelemetry: boolean;
};

export function classifyGen4Event(eventByte: number): Gen234EventClassification {
  switch (eventByte) {
    case 0x01: return { packetType: "MOVE",     meaning: "Gen4 Move",         isTelemetry: false };
    case 0xD1: return { packetType: "MOVE",     meaning: "Gen4 Move history", isTelemetry: false };
    case 0xED: return { packetType: "FACELETS", meaning: "Gen4 Facelets",     isTelemetry: false };
    case 0xEC: return { packetType: "GYRO",     meaning: "Gen4 Gyro",         isTelemetry: true  };
    case 0xEF: return { packetType: "BATTERY",  meaning: "Gen4 Battery",      isTelemetry: true  };
    default:   return {
      packetType: "NOTIFY",
      meaning: `Gen4 Unknown (0x${eventByte.toString(16).padStart(2, "0")})`,
      isTelemetry: false,
    };
  }
}

export function tryDecryptGen234Packet(
  encryptedBytes: Uint8Array,
  mac: string | null,
  profileId: Gen234CryptoProfileId = "default-gen234",
): GanDecryptResult {
  if (!mac) {
    return { status: "unavailable", message: "MAC required for Gen2/3/4 decryption" };
  }

  const derived = deriveRuntimeKeyIv(mac, profileId);
  if (!derived) {
    return { status: "failed", message: `Invalid MAC: ${mac}` };
  }
  const { salt, key, iv, profile } = derived;

  const cryptoDebug: Gen234CryptoDebug = {
    profile: profile.label,
    saltHex: bytesToHex(salt),
    baseKeyHex: bytesToHex(new Uint8Array(profile.baseKey)),
    baseIvHex: bytesToHex(new Uint8Array(profile.baseIv)),
    finalKeyHex: bytesToHex(key),
    finalIvHex: bytesToHex(iv),
  };

  try {
    const result = new Uint8Array(encryptedBytes);
    if (result.length > 16) {
      decryptChunk(result, result.length - 16, key, iv);
    }
    decryptChunk(result, 0, key, iv);
    const processed = profile.trimTrailingZeros ? trimTrailingZeros(result) : result;
    const sanity = validateGen4Packet(processed);
    const crc = profile.validateCrc16 ? validateGanCrc16(processed) : null;
    const trimNote = processed.length === result.length ? "" : `; trimmed ${result.length - processed.length} trailing zero byte(s)`;
    const validationParts = [
      `${profile.label}: ${crc ? crc.reason : sanity.reason}`,
      crc ? `first-byte sanity: ${sanity.reason}` : null,
      trimNote ? trimNote.slice(2) : null,
    ].filter(Boolean);
    return {
      status: "success",
      decryptedBytes: processed,
      cryptoDebug,
      protocolValid: crc ? crc.valid : sanity.valid,
      validationReason: validationParts.join("; "),
    };
  } catch (e) {
    return { status: "failed", message: e instanceof Error ? e.message : "AES decrypt error", cryptoDebug };
  }
}

// ── Gen1 ────────────────────────────────────────────────────────────────────

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
