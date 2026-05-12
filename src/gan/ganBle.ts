import {
  GAN_SERVICE_UUID,
  GAN_CHARACTERISTIC_UUIDS,
  DEVICE_INFO_SERVICE_UUID,
  DEVICE_INFO_CHARACTERISTICS,
} from "./ganConstants";
import { chooseMac } from "./mac";
import { dataViewToBytes, dataViewToHex, diffBytes, tryDecodeUtf8 } from "./hex";
import { tryDecryptGanPacket } from "./ganCrypto";
import type { BleLogEntry, ConnectionStatus, GanBleLabOptions } from "./types";

export class GanBleLab {
  private device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private previousNotificationByCharacteristic = new Map<string, Uint8Array>();
  private deviceInfo: Record<string, unknown> = {};
  private autoMac: string | null = null;

  constructor(
    private log: (entry: Omit<BleLogEntry, "id" | "timestamp">) => void,
    private setStatus: (status: ConnectionStatus) => void,
    private options: GanBleLabOptions
  ) {}

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
    this.previousNotificationByCharacteristic.clear();
    this.setStatus("disconnected");
    this.log({ type: "info", message: "Disconnected by user" });
  }

  private async connectWithOptions(
    requestOptions: RequestDeviceOptions
  ): Promise<void> {
    this.setStatus("requesting-device");
    this.previousNotificationByCharacteristic.clear();
    this.deviceInfo = {};
    this.autoMac = null;

    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice(requestOptions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("User cancelled") || msg.includes("cancelled")) {
        this.log({ type: "info", message: "Bluetooth picker cancelled by user" });
      } else {
        this.log({ type: "error", message: `requestDevice failed: ${msg}` });
      }
      this.setStatus("disconnected");
      return;
    }

    this.device = device;

    const { mac, source } = chooseMac({
      manualMac: this.options.manualMac,
      autoMac: this.autoMac,
      preferManualMac: this.options.preferManualMac,
    });

    this.log({
      type: "device",
      message: "Device selected",
      data: {
        name: device.name ?? "(no name)",
        browserDeviceId: device.id,
        manualMac: this.options.manualMac,
        preferManualMac: this.options.preferManualMac,
        chosenMac: mac,
        macSource: source,
      },
    });

    device.addEventListener("gattserverdisconnected", () => {
      this.setStatus("disconnected-by-device");
      this.log({ type: "info", message: "Device disconnected by device/browser" });
    });

    this.setStatus("connecting");
    try {
      if (!device.gatt) throw new Error("No GATT on this device");
      this.server = await device.gatt.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log({ type: "error", message: `GATT connect failed: ${msg}` });
      this.setStatus("error");
      return;
    }

    this.setStatus("connected");
    this.log({ type: "info", message: "GATT connected" });

    await this.readDeviceInfoService();
    await this.inspectGanServiceAndStartNotifications();
  }

  private async readDeviceInfoService(): Promise<void> {
    if (!this.server) return;

    let service: BluetoothRemoteGATTService;
    try {
      service = await this.server.getPrimaryService(DEVICE_INFO_SERVICE_UUID);
      this.log({ type: "service", message: "Device Information service found" });
    } catch {
      this.log({
        type: "warning",
        message: "Device Information service not available (0x180A)",
      });
      return;
    }

    for (const [name, uuid] of Object.entries(DEVICE_INFO_CHARACTERISTICS)) {
      try {
        const char = await service.getCharacteristic(uuid);
        if (!char.properties.read) continue;
        const value = await char.readValue();
        const hex = dataViewToHex(value);
        const text = tryDecodeUtf8(value);
        this.deviceInfo[name] = text ?? hex;
        this.log({
          type: "read",
          message: `Device info: ${name}`,
          data: { uuid, hex, text },
        });
      } catch {
        // Characteristic simply not present — not an error
      }
    }
  }

  private async inspectGanServiceAndStartNotifications(): Promise<void> {
    if (!this.server) return;

    let service: BluetoothRemoteGATTService;
    try {
      service = await this.server.getPrimaryService(GAN_SERVICE_UUID);
      this.log({ type: "service", message: "GAN service found", data: { uuid: GAN_SERVICE_UUID } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log({ type: "error", message: `GAN service not found: ${msg}` });
      return;
    }

    for (const uuid of GAN_CHARACTERISTIC_UUIDS) {
      try {
        await this.inspectCharacteristic(service, uuid);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log({
          type: "warning",
          message: `Error inspecting characteristic ${uuid}: ${msg}`,
          data: { uuid },
        });
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
      this.log({
        type: "info",
        message: `Characteristic not found: ${uuid}`,
        data: { uuid },
      });
      return;
    }

    const props = {
      read: char.properties.read,
      write: char.properties.write,
      writeWithoutResponse: char.properties.writeWithoutResponse,
      notify: char.properties.notify,
      indicate: char.properties.indicate,
    };

    this.log({
      type: "characteristic",
      message: "Characteristic found",
      data: { uuid, properties: props },
    });

    if (char.properties.read) {
      try {
        const value = await char.readValue();
        const hex = dataViewToHex(value);
        const text = tryDecodeUtf8(value);
        this.log({
          type: "read",
          message: `Read value from ${uuid}`,
          data: { uuid, hex, byteLength: value.byteLength, text },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log({
          type: "warning",
          message: `Read failed on ${uuid}: ${msg}`,
          data: { uuid },
        });
      }
    }

    if (char.properties.notify || char.properties.indicate) {
      try {
        await char.startNotifications();
        char.addEventListener(
          "characteristicvaluechanged",
          (event: Event) => {
            this.handleNotification(uuid, event);
          }
        );
        this.log({
          type: "info",
          message: `Notifications started on ${uuid}`,
          data: { uuid },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log({
          type: "error",
          message: `Failed to start notifications on ${uuid}: ${msg}`,
          data: { uuid },
        });
      }
    }
  }

  private handleNotification(uuid: string, event: Event): void {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (!value) return;

    const bytes = dataViewToBytes(value);
    const rawHex = dataViewToHex(value);
    const previous = this.previousNotificationByCharacteristic.get(uuid) ?? null;
    const changedBytes = diffBytes(previous, bytes);
    this.previousNotificationByCharacteristic.set(uuid, bytes.slice());

    const expectedMoveLabel = this.options.expectedMoveLabelGetter();

    const { mac, source: macSource } = chooseMac({
      manualMac: this.options.manualMac,
      autoMac: this.autoMac,
      preferManualMac: this.options.preferManualMac,
    });

    tryDecryptGanPacket({
      encryptedBytes: bytes,
      mac,
      macSource,
      deviceInfo: this.deviceInfo,
    }).then((decryptResult) => {
      const data: Record<string, unknown> = {
        characteristicUuid: uuid,
        byteLength: bytes.length,
        rawHex,
        changedBytes,
        expectedMoveLabel,
        mac,
        macSource,
        decryptStatus: decryptResult.status,
      };

      if (decryptResult.status === "success" && decryptResult.decryptedBytes) {
        data.decryptedHex = decryptResult.decryptedBytes
          .reduce((acc, b) => acc + b.toString(16).padStart(2, "0") + " ", "")
          .trim();
      }

      if (decryptResult.status === "failed") {
        data.decryptError = decryptResult.message;
      }

      this.log({
        type: "notification",
        message: "Notification received",
        expectedMoveLabel,
        data,
      });
    });
  }
}
