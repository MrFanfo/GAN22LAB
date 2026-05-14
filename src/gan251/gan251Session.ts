import {
  decryptGan251NotifyPacket,
  deriveGan251KeyIv,
  gan251BytesToHex,
  trimGan251TrailingZeros,
} from "./gan251Crypto";
import { decodeGan251DecryptedPacket } from "./gan251PacketDecoder";
import { Virtual2x2Cube } from "./virtual2x2Cube";
import type { Gan251DecodedPacket, Gan251MovePacket, Gan251StatePacket } from "./types";

export type Gan251SessionDebugEntry = {
  rawHex: string;
  decryptedHex: string | null;
  packetId: number | null;
  crcValid: boolean | null;
  decodedKind: Gan251DecodedPacket["kind"];
  decodedSummary: string;
  virtualCubeFacelets24: string;
};

export type Gan251SessionOptions = {
  mac: string;
  debug?: boolean;
  onDebug?: (entry: Gan251SessionDebugEntry) => void;
};

export class Gan251Session {
  private readonly mac: string;
  private readonly debug: boolean;
  private readonly onDebug?: (entry: Gan251SessionDebugEntry) => void;
  private readonly cube = Virtual2x2Cube.solved();
  private readonly moveDrivenCube = Virtual2x2Cube.solved();
  private readonly stateDrivenCube = Virtual2x2Cube.solved();

  constructor(options: Gan251SessionOptions) {
    this.mac = options.mac;
    this.debug = options.debug ?? false;
    this.onDebug = options.onDebug;
    if (!deriveGan251KeyIv(this.mac)) {
      throw new Error(`Invalid GAN251 MAC: ${this.mac}`);
    }
  }

  reset(): void {
    this.cube.reset();
    this.moveDrivenCube.reset();
    this.stateDrivenCube.reset();
  }

  cloneCube(): Virtual2x2Cube {
    return this.cube.clone();
  }

  getFacelets24(): string {
    return this.cube.toFacelets24();
  }

  getMoveDrivenFacelets24(): string {
    return this.moveDrivenCube.toFacelets24();
  }

  getStateDrivenFacelets24(): string {
    return this.stateDrivenCube.toFacelets24();
  }

  getCornerPermutation(): number[] {
    return this.cube.getCornerPermutation();
  }

  getCornerOrientation(): number[] {
    return this.cube.getCornerOrientation();
  }

  processEncryptedNotify(rawPacket: Uint8Array): Gan251DecodedPacket {
    const rawHex = gan251BytesToHex(rawPacket);
    try {
      const { decrypted, cryptoDebug } = decryptGan251NotifyPacket(rawPacket, this.mac);
      const decoded = this.decodeWithCarefulTrim(decrypted, rawHex);
      decoded.cryptoDebug = cryptoDebug;
      decoded.rawBytes = Array.from(rawPacket);
      this.applyDecodedPacket(decoded);
      this.attachFaceletViews(decoded);
      this.emitDebug(decoded, rawHex);
      return decoded;
    } catch (error) {
      const message = error instanceof Error ? error.message : "GAN251 decrypt error";
      const decoded: Gan251DecodedPacket = {
        kind: "invalid",
        rawHex,
        decryptedHex: null,
        packetId: null,
        crcValid: null,
        validationReason: message,
        rawBytes: Array.from(rawPacket),
        decryptedBytes: null,
        error: message,
      };
      this.attachFaceletViews(decoded);
      this.emitDebug(decoded, rawHex);
      return decoded;
    }
  }

  processDecryptedPacket(decryptedPacket: Uint8Array, rawHex = ""): Gan251DecodedPacket {
    const decoded = this.decodeWithCarefulTrim(decryptedPacket, rawHex);
    this.applyDecodedPacket(decoded);
    this.attachFaceletViews(decoded);
    this.emitDebug(decoded, rawHex);
    return decoded;
  }

  private decodeWithCarefulTrim(decryptedPacket: Uint8Array, rawHex: string): Gan251DecodedPacket {
    const trimmed = trimGan251TrailingZeros(decryptedPacket);
    const trimmedCount = decryptedPacket.length - trimmed.length;
    const trimmedDecoded = decodeGan251DecryptedPacket(trimmed, rawHex);

    if (trimmedCount === 0) {
      return trimmedDecoded;
    }

    if (trimmedDecoded.crcValid === true) {
      trimmedDecoded.validationReason += `; trimmed ${trimmedCount} trailing zero byte(s) before CRC`;
      return trimmedDecoded;
    }

    const untrimmedDecoded = decodeGan251DecryptedPacket(decryptedPacket, rawHex);
    if (untrimmedDecoded.crcValid === true) {
      untrimmedDecoded.validationReason +=
        `; retained trailing zero byte(s) because they are part of the CRC/payload`;
      return untrimmedDecoded;
    }

    trimmedDecoded.validationReason +=
      `; tried untrimmed ${decryptedPacket.length}-byte candidate too: ${untrimmedDecoded.validationReason}`;
    return trimmedDecoded;
  }

  private applyDecodedPacket(decoded: Gan251DecodedPacket): void {
    if (decoded.kind === "state") {
      this.applyState(decoded);
      return;
    }
    if (decoded.kind === "move") {
      this.applyMove(decoded);
    }
  }

  private applyState(decoded: Gan251StatePacket): void {
    if (decoded.crcValid === false) return;
    this.cube.loadCorners(decoded.cornerPermutation, decoded.cornerOrientation);
    this.stateDrivenCube.loadCorners(decoded.cornerPermutation, decoded.cornerOrientation);
  }

  private applyMove(decoded: Gan251MovePacket): void {
    if (decoded.crcValid === false || !decoded.face || decoded.direction === "unknown") return;
    this.cube.applyMove(decoded.face, decoded.direction);
    this.moveDrivenCube.applyMove(decoded.face, decoded.direction);
  }

  private attachFaceletViews(decoded: Gan251DecodedPacket): void {
    decoded.virtualCubeFacelets24 = this.getFacelets24();
    decoded.moveDrivenFacelets24 = this.getMoveDrivenFacelets24();
    decoded.stateDrivenFacelets24 = this.getStateDrivenFacelets24();
  }

  private emitDebug(decoded: Gan251DecodedPacket, rawHex: string): void {
    if (!this.debug || !this.onDebug) return;
    this.onDebug({
      rawHex,
      decryptedHex: decoded.decryptedHex,
      packetId: decoded.packetId,
      crcValid: decoded.crcValid,
      decodedKind: decoded.kind,
      decodedSummary: summarizeGan251Packet(decoded),
      virtualCubeFacelets24: this.getFacelets24(),
    });
  }
}

export function summarizeGan251Packet(decoded: Gan251DecodedPacket): string {
  switch (decoded.kind) {
    case "move":
      return `move step=${decoded.step} ts=${decoded.cubeTimestamp} byte=0x${decoded.rawMoveByte.toString(16).padStart(2, "0")} notation=${decoded.notation ?? decoded.notationGuess ?? "?"}`;
    case "state":
      return `state step=${decoded.step} cp=${decoded.cornerPermutation.join("")} co=${decoded.cornerOrientation.join("")} facelets=${decoded.facelets24}`;
    case "invalid":
      return `invalid ${decoded.error}`;
    default:
      return `${decoded.kind} packetId=${decoded.packetId === null ? "?" : `0x${decoded.packetId.toString(16)}`}`;
  }
}
