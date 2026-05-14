import { crc16CcittFalse } from "./gan251Crypto";

export type SyntheticGan251Move = "U" | "U'" | "R" | "R'" | "F" | "F'";

const MOVE_BYTE_BY_NOTATION: Record<SyntheticGan251Move, number> = {
  U: 0x02,
  "U'": 0x42,
  R: 0x20,
  "R'": 0x60,
  F: 0x08,
  "F'": 0x48,
};

function writeLe16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}

function writeLe32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

export function moveByteForSyntheticGan251Move(move: SyntheticGan251Move): number {
  return MOVE_BYTE_BY_NOTATION[move];
}

export function createSyntheticGan251MovePacket(
  move: SyntheticGan251Move,
  step: number,
  cubeTimestamp: number,
): Uint8Array {
  const packet = new Uint8Array(20);
  packet[0] = 0x01;
  packet[1] = 0x07;
  writeLe32(packet, 2, cubeTimestamp >>> 0);
  writeLe16(packet, 6, step & 0xffff);
  packet[8] = moveByteForSyntheticGan251Move(move);

  // Real prime packets observed from GAN251 UI carry these extra bytes after the
  // move byte. The decoder only needs byte 8 today, but keeping this shape makes
  // keyboard packets closer to the Bluetooth packets they emulate.
  if (move.endsWith("'")) {
    packet[9] = 0x02;
    packet[10] = 0x04;
    writeLe32(packet, 11, cubeTimestamp >>> 0);
  }

  const crc = crc16CcittFalse(packet.slice(0, -2));
  writeLe16(packet, packet.length - 2, crc);
  return packet;
}
