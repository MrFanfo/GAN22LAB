export type ConnectionStatus =
  | "disconnected"
  | "requesting-device"
  | "connecting"
  | "connected"
  | "disconnected-by-device"
  | "error";

export type MacSource = "manual" | "auto" | "missing";

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
  expectedMoveLabel?: string;
  data?: unknown;
};

export type GanBleLabOptions = {
  manualMac: string | null;
  preferManualMac: boolean;
  expectedMoveLabelGetter: () => string;
};

export type GanCharacteristicProperties = {
  read: boolean;
  write: boolean;
  writeWithoutResponse: boolean;
  notify: boolean;
  indicate: boolean;
};

export type NotificationLogData = {
  characteristicUuid: string;
  byteLength: number;
  rawHex: string;
  changedBytes: Array<{
    index: number;
    previous: string | null;
    current: string;
  }>;
  expectedMoveLabel: string;
  mac: string | null;
  macSource: MacSource;
  decryptedHex?: string;
  decryptStatus?: "not-implemented" | "success" | "failed";
  decryptError?: string;
};
