import { ModeOfOperation } from "aes-js";
import type { Gan251CrcResult, Gan251CryptoDebug } from "./types";

const GAN251_BASE_KEY = new Uint8Array([
  0x58, 0x98, 0x61, 0xfc, 0x1f, 0xec, 0xd7, 0x60,
  0x9f, 0x85, 0xd3, 0x62, 0xbe, 0x37, 0x17, 0x2c,
]);

const GAN251_BASE_IV = new Uint8Array([
  0x7f, 0x61, 0xd0, 0x52, 0x75, 0xc1, 0x39, 0x52,
  0x08, 0x2e, 0x54, 0x1d, 0x8a, 0x78, 0x63, 0x4d,
]);

export function gan251BytesToHex(bytes: Uint8Array | number[]): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join(" ");
}

export function gan251HexToBytes(hex: string): Uint8Array {
  const compact = hex.replace(/[^0-9a-f]/gi, "");
  if (compact.length % 2 !== 0) {
    throw new Error("Hex string must contain a whole number of bytes");
  }
  const out = new Uint8Array(compact.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function macToReversedSalt(mac: string): Uint8Array | null {
  const parts = mac.split(":");
  if (parts.length !== 6) return null;
  const parsed = parts.map((part) => parseInt(part, 16));
  if (parsed.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    return null;
  }
  return new Uint8Array(parsed.reverse());
}

export function deriveGan251KeyIv(mac: string): {
  key: Uint8Array;
  iv: Uint8Array;
  salt: Uint8Array;
  debug: Gan251CryptoDebug;
} | null {
  const salt = macToReversedSalt(mac);
  if (!salt) return null;

  const key = new Uint8Array(GAN251_BASE_KEY);
  const iv = new Uint8Array(GAN251_BASE_IV);
  for (let i = 0; i < 6; i++) {
    key[i] = (GAN251_BASE_KEY[i]! + salt[i]!) % 0xff;
    iv[i] = (GAN251_BASE_IV[i]! + salt[i]!) % 0xff;
  }

  return {
    key,
    iv,
    salt,
    debug: {
      profile: "GAN251 UI V3-2",
      saltHex: gan251BytesToHex(salt),
      baseKeyHex: gan251BytesToHex(GAN251_BASE_KEY),
      baseIvHex: gan251BytesToHex(GAN251_BASE_IV),
      finalKeyHex: gan251BytesToHex(key),
      finalIvHex: gan251BytesToHex(iv),
    },
  };
}

function decryptAesCbcWindow(buffer: Uint8Array, offset: number, key: Uint8Array, iv: Uint8Array): void {
  const cipher = new ModeOfOperation.cbc(key, iv);
  buffer.set(cipher.decrypt(buffer.subarray(offset, offset + 16)), offset);
}

export function decryptGan251NotifyPacket(rawPacket: Uint8Array, mac: string): {
  decrypted: Uint8Array;
  cryptoDebug: Gan251CryptoDebug;
} {
  const derived = deriveGan251KeyIv(mac);
  if (!derived) {
    throw new Error(`Invalid GAN251 MAC: ${mac}`);
  }

  if (rawPacket.length < 16) {
    throw new Error(`GAN251 encrypted packet too short: ${rawPacket.length} bytes`);
  }

  const decrypted = new Uint8Array(rawPacket);
  if (decrypted.length > 16) {
    decryptAesCbcWindow(decrypted, decrypted.length - 16, derived.key, derived.iv);
  }
  decryptAesCbcWindow(decrypted, 0, derived.key, derived.iv);

  return { decrypted, cryptoDebug: derived.debug };
}

export function trimGan251TrailingZeros(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return end === bytes.length ? bytes : bytes.slice(0, end);
}

export function crc16CcittFalse(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = (crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc & 0xffff;
}

function wordHex(value: number): string {
  return `0x${value.toString(16).padStart(4, "0")}`;
}

export function validateGan251Crc16(decryptedPacket: Uint8Array): Gan251CrcResult {
  if (decryptedPacket.length < 3) {
    return {
      checked: false,
      valid: null,
      expected: null,
      computed: null,
      reason: "CRC16 not checked: packet is shorter than 3 bytes",
    };
  }

  const body = decryptedPacket.slice(0, -2);
  const expected = decryptedPacket[decryptedPacket.length - 2]! |
    (decryptedPacket[decryptedPacket.length - 1]! << 8);
  const computed = crc16CcittFalse(body);

  return {
    checked: true,
    valid: computed === expected,
    expected,
    computed,
    reason: computed === expected
      ? `CRC16 ok little-endian ${wordHex(computed)}`
      : `CRC16 failed: computed ${wordHex(computed)}, expected little-endian ${wordHex(expected)}`,
  };
}
