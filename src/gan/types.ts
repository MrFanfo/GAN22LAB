export type ConnectionStatus =
  | "disconnected"
  | "requesting-device"
  | "connecting"
  | "connected"
  | "disconnected-by-device"
  | "error";

export type MacSource = "manual" | "auto" | "missing";

export type ConnectionMode = "raw" | "library";

export type PacketType =
  | "MOVE"
  | "GYRO"
  | "FACELETS"
  | "BATTERY"
  | "HARDWARE"
  | "DISCONNECT"
  | "NOTIFY";

export type DecryptStatus = "success" | "failed" | "plain" | "unavailable";

export type PacketRow = {
  id: string;
  packetNum: number;
  at: number;
  mode: ConnectionMode;
  packetType: PacketType;
  characteristicUuid: string | null;
  rawHex: string | null;
  rawByteLength: number | null;
  decryptedHex: string | null;
  decryptStatus: DecryptStatus | null;
  meaning: string;
  transform: string | null;
  cubeTimestamp: number | null;
  deviceName: string | null;
  protocolName: string | null;
  isTelemetry: boolean;
  saltHex: string | null;
  finalKeyHex: string | null;
  finalIvHex: string | null;
  protocolValid: boolean | null;
  validationReason: string | null;
  decodedKind?: string | null;
  decodedSummary?: string | null;
  facelets24?: string | null;
  moveDrivenFacelets24?: string | null;
  stateDrivenFacelets24?: string | null;
  /** Move serial number (0-255), when known — used to order/recover the move stream. */
  moveSerial?: number | null;
  /** True if this move was missed over BLE and recovered from the cube's move history. */
  recovered?: boolean;
};

// Legacy log entry kept for the diagnostic log panel
export type BleLogEntry = {
  id: string;
  timestamp: string;
  type:
    | "info"
    | "error"
    | "warning"
    | "device"
    | "service"
    | "characteristic"
    | "read"
    | "notification"
    | "marker"
    | "baseline"
    | "crypto"
    | "debug";
  message: string;
  data?: unknown;
};

export type GanBleLabOptions = {
  manualMac: string | null;
  preferManualMac: boolean;
  onPacketRow: (row: PacketRow) => void;
  onLog: (entry: Omit<BleLogEntry, "id" | "timestamp">) => void;
};

export type GanCharacteristicProperties = {
  read: boolean;
  write: boolean;
  writeWithoutResponse: boolean;
  notify: boolean;
  indicate: boolean;
};
