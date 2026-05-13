import {
  connectSmartCube,
  type SmartCubeConnection,
  type SmartCubeEvent,
  type SmartCubeRawMessage,
} from "smartcube-web-bluetooth";
import { type Subscription } from "rxjs";
import type { ConnectionStatus, PacketRow } from "./types";

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

function buildMeaning(event: SmartCubeEvent): string {
  switch (event.type) {
    case "MOVE":
      return `Move: ${event.move}`;
    case "GYRO": {
      const q = event.quaternion;
      return `Gyro x=${q.x.toFixed(2)} y=${q.y.toFixed(2)} z=${q.z.toFixed(2)} w=${q.w.toFixed(2)}`;
    }
    case "FACELETS":
      return `Facelets: ${event.facelets}`;
    case "BATTERY":
      return `Battery: ${event.batteryLevel}%`;
    case "HARDWARE":
      return [
        event.hardwareName && `HW: ${event.hardwareName}`,
        event.softwareVersion && `SW: ${event.softwareVersion}`,
        event.hardwareVersion && `HWv: ${event.hardwareVersion}`,
      ]
        .filter(Boolean)
        .join(" · ") || "Hardware info";
    case "DISCONNECT":
      return "Disconnected";
    default:
      return "Unknown event";
  }
}

export type LibraryConnectorOptions = {
  manualMac: string | null;
  onPacketRow: (row: PacketRow) => void;
  onLog: (msg: string) => void;
  onStatusChange: (status: ConnectionStatus) => void;
};

export class LibraryConnector {
  private connection: SmartCubeConnection | null = null;
  private rawSub: Subscription | null = null;
  private eventSub: Subscription | null = null;
  private lastRawMsg: SmartCubeRawMessage | null = null;
  private rowCounter = 0;

  constructor(private options: LibraryConnectorOptions) {}

  async connect(): Promise<void> {
    this.options.onStatusChange("requesting-device");

    const manualMac = this.options.manualMac?.trim() || null;

    try {
      const conn = await connectSmartCube({
        enableAddressSearch: true,
        onStatus: (msg) => this.options.onLog(msg),
        macAddressProvider: manualMac
          ? async () => manualMac
          : undefined,
      });

      this.connection = conn;
      this.options.onStatusChange("connected");
      this.options.onLog(`Connected: ${conn.deviceName} · ${conn.protocol.name}`);

      this.rawSub = conn.rawMessages$.subscribe({
        next: (msg) => {
          this.lastRawMsg = msg;
        },
      });

      this.eventSub = conn.events$.subscribe({
        next: (event) => this.handleEvent(event),
        error: (err) => {
          const msg = err instanceof Error ? err.message : String(err);
          this.options.onLog(`Error: ${msg}`);
          this.options.onStatusChange("error");
        },
        complete: () => {
          this.options.onStatusChange("disconnected-by-device");
          this.options.onLog("Connection closed by device");
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("cancelled") || msg.includes("User cancelled")) {
        this.options.onLog("Bluetooth picker cancelled");
        this.options.onStatusChange("disconnected");
      } else {
        this.options.onLog(`Connect failed: ${msg}`);
        this.options.onStatusChange("error");
      }
    }
  }

  async disconnect(): Promise<void> {
    this.rawSub?.unsubscribe();
    this.eventSub?.unsubscribe();
    this.rawSub = null;
    this.eventSub = null;
    this.lastRawMsg = null;
    await this.connection?.disconnect().catch(() => {});
    this.connection = null;
    this.options.onStatusChange("disconnected");
    this.options.onLog("Disconnected by user");
  }

  private handleEvent(event: SmartCubeEvent): void {
    const conn = this.connection;
    if (!conn) return;

    const raw = this.lastRawMsg;
    const isTelemetry = event.type === "GYRO" || event.type === "BATTERY";

    const row: PacketRow = {
      id: crypto.randomUUID(),
      packetNum: ++this.rowCounter,
      at: Date.now(),
      mode: "library",
      packetType: event.type === "DISCONNECT" ? "DISCONNECT" : (event.type as PacketRow["packetType"]),
      characteristicUuid: raw?.characteristicUuid ?? null,
      rawHex: raw ? toHex(raw.raw) : null,
      rawByteLength: raw ? raw.raw.byteLength : null,
      decryptedHex: raw?.decrypted ? toHex(raw.decrypted) : null,
      decryptStatus: raw ? (raw.decrypted ? "success" : "plain") : "unavailable",
      meaning: buildMeaning(event),
      transform: event.type === "MOVE" ? event.move : null,
      cubeTimestamp: event.type === "MOVE" ? event.cubeTimestamp : null,
      deviceName: conn.deviceName,
      protocolName: conn.protocol.name,
      isTelemetry,
    };

    this.options.onPacketRow(row);
  }
}
