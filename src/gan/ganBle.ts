import {
  ALL_GAN_SERVICE_UUIDS,
  GAN_GEN1_SERVICE,
  GAN_GEN2_SERVICE,
  GAN_GEN3_SERVICE,
  GAN_GEN4_SERVICE,
  DEVICE_INFO_SERVICE_UUID,
  DEVICE_INFO_CHARACTERISTICS,
} from "./ganConstants";
import { chooseMac } from "./mac";
import { dataViewToBytes, dataViewToHex, tryDecodeUtf8 } from "./hex";
import { tryDecryptGen1Packet, tryDecryptGen234Packet, classifyGen4Event } from "./ganCrypto";
import type { Gen1DeviceInfo } from "./ganCrypto";
import type { BleLogEntry, ConnectionStatus, GanBleLabOptions, PacketRow } from "./types";

// Known characteristic UUID → label / packet type
const CHAR_META: Record<string, { label: string; packetType: PacketRow["packetType"]; isTelemetry: boolean }> = {
  // Gen1
  "0000fff2-0000-1000-8000-00805f9b34fb": { label: "Gen1 Facelets state",      packetType: "FACELETS",  isTelemetry: false },
  "0000fff4-0000-1000-8000-00805f9b34fb": { label: "Gen1 Gyro data",           packetType: "GYRO",      isTelemetry: true  },
  "0000fff5-0000-1000-8000-00805f9b34fb": { label: "Gen1/4 Cube state/moves",  packetType: "MOVE",      isTelemetry: false },
  "0000fff6-0000-1000-8000-00805f9b34fb": { label: "Gen1/4 Move counter",      packetType: "NOTIFY",    isTelemetry: false },
  "0000fff7-0000-1000-8000-00805f9b34fb": { label: "Gen1/4 Battery status",    packetType: "BATTERY",   isTelemetry: true  },
  // Gen2
  "28be4a4a-cd67-11e9-a32f-2a2ae2dbcce4": { label: "Gen2 Command",            packetType: "NOTIFY",    isTelemetry: false },
  "28be4cb6-cd67-11e9-a32f-2a2ae2dbcce4": { label: "Gen2 State",              packetType: "MOVE",      isTelemetry: false },
  // Gen3
  "8653000c-43e6-47b7-9cb0-5fc21d4ae340": { label: "Gen3 Command",            packetType: "NOTIFY",    isTelemetry: false },
  "8653000b-43e6-47b7-9cb0-5fc21d4ae340": { label: "Gen3 State",              packetType: "MOVE",      isTelemetry: false },
};

// Gen → service UUID map (for logging detected generation)
const SERVICE_GEN_LABEL: Record<string, string> = {
  [GAN_GEN1_SERVICE]: "Gen1 (fff0)",
  [GAN_GEN2_SERVICE]: "Gen2",
  [GAN_GEN3_SERVICE]: "Gen3",
  [GAN_GEN4_SERVICE]: "Gen4",
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
  private detectedGenLabel: string = "GAN (raw)";
  private detectedGen: "gen1" | "gen234" | null = null;
  private chosenMac: string | null = null;
  private rowCounter = 0;
  // Sliding window of recent notification timestamps per characteristic UUID,
  // used to detect high-frequency characteristics (gyro spam ~12 Hz).
  private readonly notifyTimes = new Map<string, number[]>();

  private isHighFrequency(uuid: string): boolean {
    const now = Date.now();
    const times = this.notifyTimes.get(uuid) ?? [];
    const recent = times.filter((t) => now - t < 1000);
    recent.push(now);
    this.notifyTimes.set(uuid, recent);
    return recent.length > 5;
  }

  constructor(private options: GanBleLabOptions) {}

  async connectNormal(): Promise<void> {
    // Filter shows all known GAN cube generations in the picker
    await this.connectWithOptions({
      filters: ALL_GAN_SERVICE_UUIDS.map((uuid) => ({ services: [uuid] })),
      optionalServices: [...ALL_GAN_SERVICE_UUIDS, DEVICE_INFO_SERVICE_UUID],
    });
  }

  async connectFallbackAllDevices(): Promise<void> {
    await this.connectWithOptions({
      acceptAllDevices: true,
      optionalServices: [...ALL_GAN_SERVICE_UUIDS, DEVICE_INFO_SERVICE_UUID],
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
    this.detectedGenLabel = "GAN (raw)";
    this.detectedGen = null;
    this.chosenMac = null;
    this.notifyTimes.clear();
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
    this.chosenMac = mac;

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

    // Try each known GAN service UUID in generation order
    let service: BluetoothRemoteGATTService | null = null;
    let detectedServiceUuid: string | null = null;

    for (const uuid of ALL_GAN_SERVICE_UUIDS) {
      try {
        service = await this.server.getPrimaryService(uuid);
        detectedServiceUuid = uuid;
        break;
      } catch {
        // Not this generation — try next
      }
    }

    if (!service || !detectedServiceUuid) {
      // Try to enumerate ALL primary services so the user can see what the device actually has
      let allServices: BluetoothRemoteGATTService[] = [];
      try {
        allServices = await this.server.getPrimaryServices();
      } catch {
        // browser may block getPrimaryServices() without a UUID arg — ignore
      }

      if (allServices.length > 0) {
        const uuids = allServices.map((s) => s.uuid).join(", ");
        this.options.onLog({
          type: "error",
          message: `No known GAN service found on this device. Services actually present: ${uuids}`,
        });
        this.options.onLog({
          type: "warning",
          message: `To inspect these services, add their UUIDs to the code and reconnect using "Connect (all devices)".`,
        });

        // For any service UUID we didn't know about, try to list its characteristics
        // (this will only succeed if the UUID happened to be in optionalServices already)
        for (const svc of allServices) {
          if (ALL_GAN_SERVICE_UUIDS.includes(svc.uuid as typeof ALL_GAN_SERVICE_UUIDS[number])) continue;
          try {
            const chars = await svc.getCharacteristics();
            const charUuids = chars.map((c) => `${c.uuid.slice(4, 8)} (${[
              c.properties.read && "read",
              c.properties.write && "write",
              c.properties.notify && "notify",
              c.properties.indicate && "indicate",
            ].filter(Boolean).join("|")})`).join(", ");
            this.options.onLog({
              type: "service",
              message: `Unknown service ${svc.uuid}: characteristics → ${charUuids || "(none)"}`,
            });
            // Subscribe to any notify/indicate characteristics we find
            for (const char of chars) {
              if (char.properties.notify || char.properties.indicate) {
                try {
                  await char.startNotifications();
                  char.addEventListener("characteristicvaluechanged", (event: Event) =>
                    this.handleNotification(char.uuid, event)
                  );
                  this.options.onLog({ type: "info", message: `Subscribed to unknown char ${char.uuid.slice(4, 8)}` });
                } catch {}
              }
            }
          } catch {
            // Characteristic access blocked — service not in optionalServices
            this.options.onLog({
              type: "warning",
              message: `Service ${svc.uuid} found but characteristics inaccessible (not in optionalServices). Add this UUID and use "Connect (all devices)" to inspect it.`,
            });
          }
        }
      } else {
        this.options.onLog({
          type: "error",
          message: `No GAN service found. Tried: ${ALL_GAN_SERVICE_UUIDS.join(", ")}. Could not list device services (browser may require explicit service UUIDs).`,
        });
      }
      return;
    }

    const genLabel = SERVICE_GEN_LABEL[detectedServiceUuid] ?? detectedServiceUuid;
    this.detectedGenLabel = `GAN ${genLabel} (raw)`;
    this.detectedGen = detectedServiceUuid === GAN_GEN1_SERVICE ? "gen1" : "gen234";
    this.options.onLog({ type: "service", message: `GAN service found: ${genLabel}` });

    // Enumerate all characteristics on this service
    let characteristics: BluetoothRemoteGATTCharacteristic[] = [];
    try {
      characteristics = await service.getCharacteristics();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.options.onLog({ type: "warning", message: `Could not enumerate characteristics: ${msg}` });
    }

    for (const char of characteristics) {
      try {
        await this.inspectCharacteristic(service, char.uuid);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.options.onLog({ type: "warning", message: `Error on ${char.uuid}: ${msg}` });
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

    let packetType = meta.packetType;
    let meaning = meta.label;
    let isTelemetry = meta.isTelemetry;
    let decryptedHex: string | null = null;
    let decryptStatus: PacketRow["decryptStatus"] = "unavailable";

    if (this.detectedGen === "gen234") {
      const result = tryDecryptGen234Packet(bytes, this.chosenMac);
      if (result.status === "success") {
        decryptedHex = toHex(result.decryptedBytes);
        decryptStatus = "success";
        const cls = classifyGen4Event(result.decryptedBytes[0] ?? 0);
        packetType = cls.packetType;
        meaning = cls.meaning;
        isTelemetry = cls.isTelemetry;
      } else {
        decryptStatus = result.status;
        // Fall back to rate-based detection when decryption unavailable/failed
        const highFreq = this.isHighFrequency(uuid);
        if (highFreq && packetType !== "GYRO") packetType = "GYRO";
        isTelemetry = isTelemetry || highFreq;
        if (highFreq) meaning = `${meta.label} (high-freq / gyro)`;
      }
    } else {
      // Gen1 path
      const result = tryDecryptGen1Packet(bytes, this.gen1DeviceInfo);
      if (result.status === "success") {
        decryptedHex = toHex(result.decryptedBytes);
      }
      decryptStatus = result.status;
      const highFreq = this.isHighFrequency(uuid);
      if (highFreq && packetType !== "GYRO") packetType = "GYRO";
      isTelemetry = isTelemetry || highFreq;
      if (highFreq) meaning = `${meta.label} (high-freq / gyro)`;
    }

    const row: PacketRow = {
      id: crypto.randomUUID(),
      packetNum: ++this.rowCounter,
      at: Date.now(),
      mode: "raw",
      packetType,
      characteristicUuid: uuid,
      rawHex,
      rawByteLength: bytes.length,
      decryptedHex,
      decryptStatus,
      meaning,
      transform: null,
      cubeTimestamp: null,
      deviceName: this.deviceName,
      protocolName: this.detectedGenLabel,
      isTelemetry,
    };

    this.options.onPacketRow(row);
  }
}

// Re-export type for use in App.tsx
export type { BleLogEntry };
