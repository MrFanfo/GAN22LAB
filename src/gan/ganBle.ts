import {
  GAN_SERVICE_UUID,
  GAN_CHARACTERISTIC_UUIDS,
  DEVICE_INFO_SERVICE_UUID,
  DEVICE_INFO_CHARACTERISTICS,
} from "./ganConstants";
import { chooseMac } from "./mac";
import { dataViewToBytes, dataViewToHex, tryDecodeUtf8 } from "./hex";
import { tryDecryptGen1Packet } from "./ganCrypto";
import type { Gen1DeviceInfo } from "./ganCrypto";
import type { BleLogEntry, ConnectionStatus, GanBleLabOptions, PacketRow } from "./types";

// Map GAN Gen1 characteristic UUID → label / packet type / telemetry flag
const CHAR_META: Record<string, { label: string; packetType: PacketRow["packetType"]; isTelemetry: boolean }> = {
  "0000fff2-0000-1000-8000-00805f9b34fb": { label: "Facelets state",        packetType: "FACELETS",  isTelemetry: false },
  "0000fff4-0000-1000-8000-00805f9b34fb": { label: "Gyro data",             packetType: "GYRO",      isTelemetry: true  },
  "0000fff5-0000-1000-8000-00805f9b34fb": { label: "Cube state / moves",    packetType: "MOVE",      isTelemetry: false },
  "0000fff6-0000-1000-8000-00805f9b34fb": { label: "Move counter",          packetType: "NOTIFY",    isTelemetry: false },
  "0000fff7-0000-1000-8000-00805f9b34fb": { label: "Battery status",        packetType: "BATTERY",   isTelemetry: true  },
};

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

export class GanBleLab {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private gen1DeviceInfo: Gen1DeviceInfo = { firmwareRevision: null, systemId: null };
  private deviceName: string | null = null;
  private rowCounter = 0;

  constructor(private options: GanBleLabOptions) {}

  async connectNormal(): Promise<void> {
    await this.connectWithOptions({
      filters: [{ services: [GAN_SERVICE_UUID] }],
      optionalServices: [GAN_SERVICE_UUID, DEVICE_INFO_SERVICE_UUID],
    });
  }

  async connectFallbackAllDevices(): Promise<void> {
    await this.connectWithOptions({
      acceptAllDevices: true,
      optionalServices: [GAN_SERVICE_UUID, DEVICE_INFO_SERVICE_UUID],
    });
  }

  async disconnect(): Promise<void> {
    if (this.device?.gatt?.connected) {
      this.device.gatt.disconnect();
    }
    this.device = null;
    this.server = null;
    this.gen1DeviceInfo = { firmwareRevision: null, systemId: null };
    this.deviceName = null;
    this.options.onLog({ type: "info", message: "Disconnected by user" });
  }

  private setStatus(status: ConnectionStatus) {
    this.options.onLog({ type: "info", message: `Status: ${status}` });
  }

  private async connectWithOptions(requestOptions: RequestDeviceOptions): Promise<void> {
    this.setStatus("requesting-device");
    this.gen1DeviceInfo = { firmwareRevision: null, systemId: null };
    this.deviceName = null;

    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice(requestOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("cancelled") || msg.includes("User cancelled")) {
        this.options.onLog({ type: "info", message: "Bluetooth picker cancelled" });
      } else {
        this.options.onLog({ type: "error", message: `requestDevice failed: ${msg}` });
      }
      this.setStatus("disconnected");
      return;
    }

    this.device = device;
    this.deviceName = device.name ?? null;

    const { mac } = chooseMac({
      manualMac: this.options.manualMac,
      autoMac: null,
      preferManualMac: this.options.preferManualMac,
    });

    this.options.onLog({
      type: "device",
      message: "Device selected",
      data: { name: device.name ?? "(no name)", mac, manualMac: this.options.manualMac },
    });

    device.addEventListener("gattserverdisconnected", () => {
      this.setStatus("disconnected-by-device");
      this.options.onLog({ type: "info", message: "Device disconnected" });
    });

    this.setStatus("connecting");
    try {
      if (!device.gatt) throw new Error("No GATT");
      this.server = await device.gatt.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.options.onLog({ type: "error", message: `GATT connect failed: ${msg}` });
      this.setStatus("error");
      return;
    }

    this.setStatus("connected");
    this.options.onLog({ type: "info", message: "GATT connected" });

    await this.readDeviceInfoService();
    await this.inspectGanServiceAndStartNotifications();
  }

  private async readDeviceInfoService(): Promise<void> {
    if (!this.server) return;

    let service: BluetoothRemoteGATTService;
    try {
      service = await this.server.getPrimaryService(DEVICE_INFO_SERVICE_UUID);
      this.options.onLog({ type: "service", message: "Device Information service found" });
    } catch {
      this.options.onLog({ type: "warning", message: "Device Information service not available (0x180A)" });
      return;
    }

    for (const [name, uuid] of Object.entries(DEVICE_INFO_CHARACTERISTICS)) {
      try {
        const char = await service.getCharacteristic(uuid);
        if (!char.properties.read) continue;
        const value = await char.readValue();

        // Store raw DataViews needed for Gen1 key derivation
        if (name === "softwareRevision") {
          // 0x2a28 = firmware revision = fwVersion bytes
          this.gen1DeviceInfo.firmwareRevision = value;
        }
        if (name === "systemId") {
          // 0x2a23 = system ID = hardware bytes for key derivation
          this.gen1DeviceInfo.systemId = value;
        }

        const hex = dataViewToHex(value);
        const text = tryDecodeUtf8(value);
        this.options.onLog({
          type: "read",
          message: `Device info: ${name}`,
          data: { uuid, hex, text },
        });
      } catch {
        // Characteristic not present
      }
    }
  }

  private async inspectGanServiceAndStartNotifications(): Promise<void> {
    if (!this.server) return;

    let service: BluetoothRemoteGATTService;
    try {
      service = await this.server.getPrimaryService(GAN_SERVICE_UUID);
      this.options.onLog({ type: "service", message: "GAN service found" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.options.onLog({ type: "error", message: `GAN service not found: ${msg}` });
      return;
    }

    for (const uuid of GAN_CHARACTERISTIC_UUIDS) {
      try {
        await this.inspectCharacteristic(service, uuid);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.options.onLog({ type: "warning", message: `Error on ${uuid}: ${msg}` });
      }
    }
  }

  private async inspectCharacteristic(
    service: BluetoothRemoteGATTService,
    uuid: string
  ): Promise<void> {
    let char: BluetoothRemoteGATTCharacteristic;
    try {
      char = await service.getCharacteristic(uuid);
    } catch {
      return;
    }

    this.options.onLog({
      type: "characteristic",
      message: `Characteristic ${uuid.slice(4, 8)}`,
      data: {
        read: char.properties.read,
        notify: char.properties.notify,
        indicate: char.properties.indicate,
      },
    });

    if (char.properties.read) {
      try {
        const value = await char.readValue();
        this.options.onLog({
          type: "read",
          message: `Read ${uuid.slice(4, 8)}: ${dataViewToHex(value)}`,
        });
      } catch {}
    }

    if (char.properties.notify || char.properties.indicate) {
      try {
        await char.startNotifications();
        char.addEventListener("characteristicvaluechanged", (event: Event) => {
          this.handleNotification(uuid, event);
        });
        this.options.onLog({ type: "info", message: `Notifications started on ${uuid.slice(4, 8)}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.options.onLog({ type: "error", message: `Notifications failed on ${uuid.slice(4, 8)}: ${msg}` });
      }
    }
  }

  private handleNotification(uuid: string, event: Event): void {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;

    const bytes = dataViewToBytes(value);
    const rawHex = toHex(bytes);
    const meta = CHAR_META[uuid] ?? { label: `Unknown (${uuid.slice(4, 8)})`, packetType: "NOTIFY" as const, isTelemetry: false };

    const decryptResult = tryDecryptGen1Packet(bytes, this.gen1DeviceInfo);

    const row: PacketRow = {
      id: crypto.randomUUID(),
      packetNum: ++this.rowCounter,
      at: Date.now(),
      mode: "raw",
      packetType: meta.packetType,
      characteristicUuid: uuid,
      rawHex,
      rawByteLength: bytes.length,
      decryptedHex:
        decryptResult.status === "success"
          ? toHex(decryptResult.decryptedBytes)
          : null,
      decryptStatus:
        decryptResult.status === "success"
          ? "success"
          : decryptResult.status === "failed"
          ? "failed"
          : "unavailable",
      meaning: meta.label,
      transform: null,
      cubeTimestamp: null,
      deviceName: this.deviceName,
      protocolName: "GAN Gen1 (raw)",
      isTelemetry: meta.isTelemetry,
    };

    this.options.onPacketRow(row);
  }
}

// Re-export type for use in App.tsx
export type { BleLogEntry };
