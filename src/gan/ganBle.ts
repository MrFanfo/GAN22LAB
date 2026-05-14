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
import {
  tryDecryptGen1Packet,
  tryDecryptGen234Packet,
  classifyGen4Event,
  deriveGen234CryptoDebug,
  detectGen234CryptoProfile,
} from "./ganCrypto";
import type { Gen1DeviceInfo, Gen234CryptoDebug, Gen234CryptoProfileId } from "./ganCrypto";
import type { BleLogEntry, ConnectionStatus, GanBleLabOptions, PacketRow } from "./types";
import { Gan251Session, summarizeGan251Packet } from "../gan251/gan251Session";
import type { Gan251DecodedPacket } from "../gan251/types";

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
  private cryptoProfile: Gen234CryptoProfileId = "default-gen234";
  private gan251Session: Gan251Session | null = null;
  private chosenMac: string | null = null;
  private cryptoDebug: Gen234CryptoDebug | null = null;
  private advManufacturerDataHex: string | null = null;
  private advMac: string | null = null;
  private advServiceUuids: string[] = [];
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
    this.cryptoProfile = "default-gen234";
    this.gan251Session = null;
    this.chosenMac = null;
    this.cryptoDebug = null;
    this.advManufacturerDataHex = null;
    this.advMac = null;
    this.advServiceUuids = [];
    this.notifyTimes.clear();
    this.options.onLog({ type: "info", message: "Disconnected by user" });
  }

  private setStatus(status: ConnectionStatus) {
    this.options.onLog({ type: "info", message: `Status: ${status}` });
  }

  private async captureAdvertisementData(device: BluetoothDevice): Promise<void> {
    if (typeof (device as unknown as { watchAdvertisements?: unknown }).watchAdvertisements !== "function") {
      this.options.onLog({ type: "info", message: "watchAdvertisements not supported in this browser — advertisement data unavailable" });
      return;
    }

    this.options.onLog({ type: "info", message: "Waiting for advertisement packet (up to 5 s)…" });

    await new Promise<void>((resolve) => {
      const abort = new AbortController();
      let settled = false;

      const done = () => {
        if (settled) return;
        settled = true;
        device.removeEventListener("advertisementreceived", onAdv as EventListener);
        abort.abort();
        resolve();
      };

      const onAdv = (evt: BluetoothAdvertisingEvent) => {
        // Extract manufacturer data and MAC (GAN uses CICs with low byte = 0x01)
        let mfHex: string | null = null;
        let mac: string | null = null;

        if (evt.manufacturerData) {
          for (let hi = 0; hi <= 0xFF; hi++) {
            const cic = (hi << 8) | 0x01;
            if (evt.manufacturerData.has(cic)) {
              const dv = evt.manufacturerData.get(cic)!;
              const raw = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
              mfHex = Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join(" ");

              // MAC is the last 6 bytes of the first 9 bytes, read in reverse
              const data = new Uint8Array(dv.buffer, dv.byteOffset, Math.min(dv.byteLength, 9));
              if (data.length >= 6) {
                const parts: string[] = [];
                for (let i = 1; i <= 6; i++) parts.push(data[data.length - i]!.toString(16).toUpperCase().padStart(2, "0"));
                mac = parts.join(":");
              }
              break;
            }
          }
        }

        const uuids = evt.uuids ? [...evt.uuids].map(String) : [];

        this.advManufacturerDataHex = mfHex;
        this.advMac = mac;
        this.advServiceUuids = uuids;

        this.options.onLog({
          type: "debug",
          message: "Advertisement received",
          data: {
            manufacturerDataHex: mfHex,
            macFromManufacturerData: mac,
            serviceUuids: uuids,
            rssi: (evt as BluetoothAdvertisingEvent & { rssi?: number }).rssi ?? null,
          },
        });

        done();
      };

      device.addEventListener("advertisementreceived", onAdv as EventListener);

      (device.watchAdvertisements as (opts: { signal: AbortSignal }) => Promise<void>)({ signal: abort.signal })
        .catch(() => done());

      setTimeout(done, 5000);
    });
  }

  private async connectWithOptions(requestOptions: RequestDeviceOptions): Promise<void> {
    this.setStatus("requesting-device");
    this.gen1DeviceInfo = { firmwareRevision: null, systemId: null };
    this.deviceName = null;
    this.gan251Session = null;

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
    this.cryptoProfile = detectGen234CryptoProfile(this.deviceName);

    // Capture advertisement data (watchAdvertisements) before GATT connect so the
    // device is still actively advertising. This gives us manufacturer data and MAC.
    await this.captureAdvertisementData(device);

    const { mac } = chooseMac({
      manualMac: this.options.manualMac,
      autoMac: this.advMac,
      preferManualMac: this.options.preferManualMac,
    });
    this.chosenMac = mac;

    this.options.onLog({
      type: "device",
      message: "Device selected",
      data: {
        deviceName: device.name ?? "(no name)",
        advertisementManufacturerDataHex: this.advManufacturerDataHex,
        macFromManufacturerData: this.advMac,
        serviceUuids: this.advServiceUuids,
        cachedMac: null,
        manualMac: this.options.manualMac ?? null,
        finalMacUsed: mac,
        rawCryptoProfile: this.cryptoProfile,
      },
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
    const profileLabel = this.cryptoProfile === "gan251-ui-v3-2" ? " / GAN251 UI V3-2" : "";
    this.detectedGenLabel = `GAN ${genLabel}${profileLabel} (raw)`;
    this.detectedGen = detectedServiceUuid === GAN_GEN1_SERVICE ? "gen1" : "gen234";
    this.options.onLog({ type: "service", message: `GAN service found: ${genLabel}` });

    if (this.detectedGen === "gen234" && this.chosenMac) {
      this.cryptoDebug = deriveGen234CryptoDebug(this.chosenMac, this.cryptoProfile) ?? null;
      if (this.cryptoProfile === "gan251-ui-v3-2") {
        try {
          this.gan251Session = new Gan251Session({
            mac: this.chosenMac,
            debug: true,
            onDebug: (entry) => {
              this.options.onLog({
                type: "debug",
                message: `GAN251 decoded ${entry.decodedKind}: ${entry.decodedSummary}`,
                data: entry,
              });
            },
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          this.options.onLog({ type: "error", message: `GAN251 session init failed: ${msg}` });
        }
      }
    }

    this.options.onLog({
      type: "crypto",
      message: "Connection crypto debug",
      data: {
        deviceName: this.deviceName,
        serviceUuids: this.advServiceUuids,
        selectedProtocol: genLabel,
        advertisementManufacturerDataHex: this.advManufacturerDataHex,
        macFromManufacturerData: this.advMac,
        cachedMac: null,
        manualMac: this.options.manualMac ?? null,
        finalMacUsed: this.chosenMac,
        rawCryptoProfile: this.cryptoProfile,
        cryptoProfileLabel: this.cryptoDebug?.profile ?? null,
        saltHex: this.cryptoDebug?.saltHex ?? null,
        baseKeyHex: this.cryptoDebug?.baseKeyHex ?? null,
        baseIvHex: this.cryptoDebug?.baseIvHex ?? null,
        finalKeyHex: this.cryptoDebug?.finalKeyHex ?? null,
        finalIvHex: this.cryptoDebug?.finalIvHex ?? null,
      },
    });

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
    let protocolValid: boolean | null = null;
    let validationReason: string | null = null;

    if (this.detectedGen === "gen234") {
      if (this.cryptoProfile === "gan251-ui-v3-2") {
        if (!this.gan251Session) {
          const row: PacketRow = {
            id: crypto.randomUUID(),
            packetNum: ++this.rowCounter,
            at: Date.now(),
            mode: "raw",
            packetType,
            characteristicUuid: uuid,
            rawHex,
            rawByteLength: bytes.length,
            decryptedHex: null,
            decryptStatus: "unavailable",
            meaning: "GAN251 UI V3-2 packet (MAC/session required)",
            transform: null,
            cubeTimestamp: null,
            deviceName: this.deviceName,
            protocolName: this.detectedGenLabel,
            isTelemetry,
            saltHex: this.cryptoDebug?.saltHex ?? null,
            finalKeyHex: this.cryptoDebug?.finalKeyHex ?? null,
            finalIvHex: this.cryptoDebug?.finalIvHex ?? null,
            protocolValid: null,
            validationReason: "GAN251 session unavailable; check MAC",
            decodedKind: null,
            decodedSummary: null,
            facelets24: null,
          };
          this.options.onPacketRow(row);
          return;
        }
        const decoded = this.gan251Session.processEncryptedNotify(bytes);
        this.options.onPacketRow(this.mapGan251DecodedToPacketRow(decoded, uuid, rawHex, bytes.length));
        return;
      }

      const result = tryDecryptGen234Packet(bytes, this.chosenMac, this.cryptoProfile);
      if (result.status === "success") {
        decryptedHex = toHex(result.decryptedBytes);
        decryptStatus = "success";
        protocolValid = result.protocolValid ?? null;
        validationReason = result.validationReason ?? null;
        this.cryptoDebug = result.cryptoDebug ?? this.cryptoDebug;
        const cls = classifyGen4Event(result.decryptedBytes[0] ?? 0);
        packetType = cls.packetType;
        meaning = cls.meaning;
        isTelemetry = cls.isTelemetry;
      } else {
        decryptStatus = result.status;
        if (result.status === "failed") {
          protocolValid = false;
          validationReason = result.message;
        }
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
      saltHex: this.cryptoDebug?.saltHex ?? null,
      finalKeyHex: this.cryptoDebug?.finalKeyHex ?? null,
      finalIvHex: this.cryptoDebug?.finalIvHex ?? null,
      protocolValid,
      validationReason,
    };

    this.options.onPacketRow(row);
  }

  private mapGan251DecodedToPacketRow(
    decoded: Gan251DecodedPacket,
    uuid: string,
    rawHex: string,
    rawByteLength: number,
  ): PacketRow {
    const packetType: PacketRow["packetType"] =
      decoded.kind === "move" ? "MOVE"
        : decoded.kind === "state" ? "FACELETS"
          : decoded.kind === "gyro" ? "GYRO"
            : decoded.kind === "battery" ? "BATTERY"
              : decoded.kind === "hardware" ? "HARDWARE"
                : "NOTIFY";
    const isTelemetry = decoded.kind === "gyro" || decoded.kind === "battery";
    const decodedSummary = summarizeGan251Packet(decoded);

    return {
      id: crypto.randomUUID(),
      packetNum: ++this.rowCounter,
      at: Date.now(),
      mode: "raw",
      packetType,
      characteristicUuid: uuid,
      rawHex,
      rawByteLength,
      decryptedHex: decoded.decryptedHex,
      decryptStatus: decoded.decryptedHex ? "success" : "failed",
      meaning: decodedSummary,
      transform: decoded.kind === "move" ? decoded.notation ?? decoded.notationGuess : null,
      cubeTimestamp: decoded.kind === "move" ? decoded.cubeTimestamp : null,
      deviceName: this.deviceName,
      protocolName: this.detectedGenLabel,
      isTelemetry,
      saltHex: decoded.cryptoDebug?.saltHex ?? this.cryptoDebug?.saltHex ?? null,
      finalKeyHex: decoded.cryptoDebug?.finalKeyHex ?? this.cryptoDebug?.finalKeyHex ?? null,
      finalIvHex: decoded.cryptoDebug?.finalIvHex ?? this.cryptoDebug?.finalIvHex ?? null,
      protocolValid: decoded.crcValid,
      validationReason: decoded.validationReason,
      decodedKind: decoded.kind,
      decodedSummary,
      facelets24: decoded.virtualCubeFacelets24 ?? null,
    };
  }
}

// Re-export type for use in App.tsx
export type { BleLogEntry };
