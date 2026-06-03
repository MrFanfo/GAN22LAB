export type Gan251Face = "U" | "R" | "F" | "D" | "L" | "B";

export type Gan251MoveDirection =
  | "clockwise"
  | "counterclockwise"
  | "double"
  | "unknown";

export type Gan251PacketKind =
  | "move"
  | "state"
  | "history"
  | "battery"
  | "gyro"
  | "hardware"
  | "notify"
  | "invalid";

export type Gan251CrcResult = {
  checked: boolean;
  valid: boolean | null;
  expected: number | null;
  computed: number | null;
  reason: string;
};

export type Gan251CryptoDebug = {
  profile: "GAN251 UI V3-2";
  saltHex: string;
  baseKeyHex: string;
  baseIvHex: string;
  finalKeyHex: string;
  finalIvHex: string;
};

export type Gan251DecodeBase = {
  kind: Gan251PacketKind;
  rawHex: string;
  decryptedHex: string | null;
  packetId: number | null;
  crcValid: boolean | null;
  validationReason: string;
  rawBytes: number[];
  decryptedBytes: number[] | null;
  cryptoDebug?: Gan251CryptoDebug;
  virtualCubeFacelets24?: string;
  moveDrivenFacelets24?: string;
  stateDrivenFacelets24?: string;
};

export type Gan251MoveByteDecode = {
  rawMoveByte: number;
  faceMask: number;
  face: Gan251Face | null;
  turnBits: number;
  direction: Gan251MoveDirection;
  notation: string | null;
  notationGuess: string | null;
};

export type Gan251MovePacket = Gan251DecodeBase & {
  kind: "move";
  packetId: 0x01;
  cubeTimestamp: number;
  step: number;
  rawMoveByte: number;
  faceMask: number;
  face: Gan251Face | null;
  turnBits: number;
  direction: Gan251MoveDirection;
  notation: string | null;
  notationGuess: string | null;
  unknownBytes: number[];
};

export type Gan251StatePacket = Gan251DecodeBase & {
  kind: "state";
  packetId: 0xed;
  step: number;
  cornerPermutation: number[];
  cornerOrientation: number[];
  edgePermutation: number[];
  edgeOrientation: number[];
  facelets24: string;
  faceletsByFace: Record<Gan251Face, string[]>;
  rawFields: {
    dataLength: number;
    cubiePayload: number[];
    reservedBytes: number[];
  };
};

export type Gan251HistoryMove = {
  serial: number;
  face: Gan251Face;
  direction: Gan251MoveDirection;
  notation: string;
};

// MOVE_HISTORY response (event type 0xD1). Mirrors the GAN Gen4 protocol the
// GAN251 UI shares: a batch of past moves, newest-first, packed 4 bits each.
export type Gan251HistoryPacket = Gan251DecodeBase & {
  kind: "history";
  packetId: 0xd1;
  startSerial: number;
  count: number;
  moves: Gan251HistoryMove[];
};

export type Gan251InvalidPacket = Gan251DecodeBase & {
  kind: "invalid";
  error: string;
};

export type Gan251GenericPacket = Gan251DecodeBase & {
  kind: Exclude<Gan251PacketKind, "move" | "state" | "history" | "invalid">;
  meaning: string;
  payloadBytes: number[];
};

export type Gan251DecodedPacket =
  | Gan251MovePacket
  | Gan251StatePacket
  | Gan251HistoryPacket
  | Gan251InvalidPacket
  | Gan251GenericPacket;
