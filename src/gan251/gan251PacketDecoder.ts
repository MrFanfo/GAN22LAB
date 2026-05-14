import { gan251BytesToHex, validateGan251Crc16 } from "./gan251Crypto";
import { Virtual2x2Cube } from "./virtual2x2Cube";
import type {
  Gan251DecodedPacket,
  Gan251Face,
  Gan251GenericPacket,
  Gan251InvalidPacket,
  Gan251MoveByteDecode,
  Gan251MoveDirection,
  Gan251MovePacket,
  Gan251PacketKind,
  Gan251StatePacket,
} from "./types";

const FACE_MASK_TO_FACE: Record<number, Gan251Face> = {
  0x02: "U",
  0x20: "R",
  0x08: "F",
  0x01: "D",
  0x10: "L",
  0x04: "B",
};

type PacketInfo = {
  kind: Exclude<Gan251PacketKind, "move" | "state" | "invalid">;
  meaning: string;
};

const GENERIC_PACKET_INFO: Record<number, PacketInfo> = {
  0x02: { kind: "notify", meaning: "GAN251 time / solve event" },
  0xd2: { kind: "notify", meaning: "GAN251 result (32-bit)" },
  0xd3: { kind: "notify", meaning: "GAN251 result (8-bit)" },
  0xd4: { kind: "notify", meaning: "GAN251 result (8-bit)" },
  0xdc: { kind: "notify", meaning: "GAN251 result (32-bit)" },
  0xea: { kind: "notify", meaning: "GAN251 type / event" },
  0xec: { kind: "gyro", meaning: "GAN251 gyro / orientation" },
  0xee: { kind: "gyro", meaning: "GAN251 face-angle motion" },
  0xef: { kind: "battery", meaning: "GAN251 battery" },
  0xf0: { kind: "notify", meaning: "GAN251 content / string" },
  0xf5: { kind: "hardware", meaning: "GAN251 build time" },
  0xf6: { kind: "hardware", meaning: "GAN251 restart reason" },
  0xfa: { kind: "hardware", meaning: "GAN251 product date" },
  0xfc: { kind: "hardware", meaning: "GAN251 model string" },
  0xfd: { kind: "hardware", meaning: "GAN251 version" },
  0xfe: { kind: "hardware", meaning: "GAN251 device version" },
  0xff: { kind: "hardware", meaning: "GAN251 device MAC-like info" },
};

class MsbBitReader {
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  read(offset: number, length: number): number {
    let value = 0;
    for (let i = 0; i < length; i++) {
      const bitOffset = offset + i;
      const byte = this.bytes[Math.floor(bitOffset / 8)] ?? 0;
      const bit = (byte >> (7 - (bitOffset % 8))) & 1;
      value = (value << 1) | bit;
    }
    return value;
  }
}

function le16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function le32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function invalidPacket(
  rawHex: string,
  decrypted: Uint8Array | null,
  packetId: number | null,
  error: string,
): Gan251InvalidPacket {
  return {
    kind: "invalid",
    rawHex,
    decryptedHex: decrypted ? gan251BytesToHex(decrypted) : null,
    packetId,
    crcValid: null,
    validationReason: error,
    rawBytes: [],
    decryptedBytes: decrypted ? Array.from(decrypted) : null,
    error,
  };
}

function inferMissingCorner(firstSeven: number[]): number {
  const used = new Set(firstSeven);
  for (let value = 0; value < 8; value++) {
    if (!used.has(value)) return value;
  }
  return 7;
}

function validateCornerArrays(cp: number[], co: number[]): string | null {
  const sorted = [...cp].sort((a, b) => a - b);
  if (cp.length !== 8 || !sorted.every((value, index) => value === index)) {
    return `corner permutation is not a permutation of 0..7: ${cp.join(",")}`;
  }
  if (co.length !== 8 || !co.every((value) => value >= 0 && value <= 2)) {
    return `corner orientation contains values outside 0..2: ${co.join(",")}`;
  }
  return null;
}

export function decodeGan251MoveByte(rawMoveByte: number): Gan251MoveByteDecode {
  const faceMask = rawMoveByte & 0x3f;
  const turnBits = (rawMoveByte >> 6) & 0x03;
  const face = FACE_MASK_TO_FACE[faceMask] ?? null;

  // Confirmed captures currently use turnBits=0 and the byte equals the face
  // mask. The other mappings are intentionally isolated here so future packet
  // captures can adjust direction semantics without touching BLE/session code.
  let direction: Gan251MoveDirection = "unknown";
  if (face) {
    if (turnBits === 0) direction = "clockwise";
    else if (turnBits === 1) direction = "counterclockwise";
    else if (turnBits === 2) direction = "double";
  }

  const suffix =
    direction === "counterclockwise" ? "'"
      : direction === "double" ? "2"
        : direction === "clockwise" ? ""
          : "";
  const notation = face && direction !== "unknown" ? `${face}${suffix}` : null;

  return {
    rawMoveByte,
    faceMask,
    face,
    turnBits,
    direction,
    notation,
    notationGuess: notation ?? face,
  };
}

export function decodeGan251DecryptedPacket(
  decrypted: Uint8Array,
  rawHex = "",
): Gan251DecodedPacket {
  const decryptedHex = gan251BytesToHex(decrypted);
  if (decrypted.length < 1) {
    return invalidPacket(rawHex, decrypted, null, "GAN251 packet is empty");
  }

  const packetId = decrypted[0]!;
  const crc = validateGan251Crc16(decrypted);
  if (packetId === 0x01) {
    return decodeMovePacket(rawHex, decrypted, decryptedHex, crc.reason, crc.valid);
  }
  if (packetId === 0xed) {
    return decodeStatePacket(rawHex, decrypted, decryptedHex, crc.reason, crc.valid);
  }

  const info = GENERIC_PACKET_INFO[packetId] ?? {
    kind: "notify" as const,
    meaning: `GAN251 unknown bleProtoId 0x${packetId.toString(16).padStart(2, "0")}`,
  };
  const generic: Gan251GenericPacket = {
    kind: info.kind,
    rawHex,
    decryptedHex,
    packetId,
    crcValid: crc.valid,
    validationReason: crc.reason,
    rawBytes: [],
    decryptedBytes: Array.from(decrypted),
    meaning: info.meaning,
    payloadBytes: Array.from(decrypted.slice(2, -2)),
  };
  return generic;
}

function decodeMovePacket(
  rawHex: string,
  decrypted: Uint8Array,
  decryptedHex: string,
  crcReason: string,
  crcValid: boolean | null,
): Gan251MovePacket | Gan251InvalidPacket {
  if (decrypted.length < 11) {
    return invalidPacket(rawHex, decrypted, 0x01, "GAN251 move packet too short");
  }

  const move = decodeGan251MoveByte(decrypted[8]!);
  const reasons = [crcReason];
  if (!move.face) {
    reasons.push(`unknown face mask 0x${move.faceMask.toString(16).padStart(2, "0")}`);
  }

  return {
    kind: "move",
    rawHex,
    decryptedHex,
    packetId: 0x01,
    crcValid,
    validationReason: reasons.join("; "),
    rawBytes: [],
    decryptedBytes: Array.from(decrypted),
    cubeTimestamp: le32(decrypted, 2),
    step: le16(decrypted, 6),
    rawMoveByte: move.rawMoveByte,
    faceMask: move.faceMask,
    face: move.face,
    turnBits: move.turnBits,
    direction: move.direction,
    notation: move.notation,
    notationGuess: move.notationGuess,
    unknownBytes: Array.from(decrypted.slice(9, -2)),
  };
}

function decodeStatePacket(
  rawHex: string,
  decrypted: Uint8Array,
  decryptedHex: string,
  crcReason: string,
  crcValid: boolean | null,
): Gan251StatePacket | Gan251InvalidPacket {
  if (decrypted.length < 18) {
    return invalidPacket(rawHex, decrypted, 0xed, "GAN251 state packet too short");
  }

  const dataLength = decrypted[1] ?? 0;
  const dataEnd = Math.min(2 + dataLength, decrypted.length - 2);
  const cubiePayload = decrypted.slice(4, dataEnd);
  const reservedBytes = decrypted.slice(dataEnd, -2);
  const reader = new MsbBitReader(cubiePayload);

  const firstSevenCorners = Array.from({ length: 7 }, (_, index) => reader.read(index * 3, 3));
  const cornerPermutation = [...firstSevenCorners, inferMissingCorner(firstSevenCorners)];
  const cornerOrientation = Array.from({ length: 8 }, (_, index) => reader.read(21 + index * 2, 2) % 3);
  const edgePermutation = Array.from({ length: 11 }, (_, index) => reader.read(37 + index * 4, 4));
  const edgeOrientation = Array.from({ length: 12 }, (_, index) => reader.read(81 + index, 1));
  const structuralError = validateCornerArrays(cornerPermutation, cornerOrientation);

  const cube = structuralError
    ? Virtual2x2Cube.solved()
    : new Virtual2x2Cube(cornerPermutation, cornerOrientation);
  const faceletsByFace = cube.toFaceletsByFace();
  const reasons = [crcReason];
  if (structuralError) reasons.push(structuralError);

  return {
    kind: "state",
    rawHex,
    decryptedHex,
    packetId: 0xed,
    crcValid: structuralError ? false : crcValid,
    validationReason: reasons.join("; "),
    rawBytes: [],
    decryptedBytes: Array.from(decrypted),
    step: le16(decrypted, 2),
    cornerPermutation,
    cornerOrientation,
    edgePermutation,
    edgeOrientation,
    facelets24: cube.toFacelets24(),
    faceletsByFace,
    rawFields: {
      dataLength,
      cubiePayload: Array.from(cubiePayload),
      reservedBytes: Array.from(reservedBytes),
    },
  };
}
