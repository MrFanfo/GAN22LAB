// Gen1 (356i "API v1")
export const GAN_GEN1_SERVICE = "0000fff0-0000-1000-8000-00805f9b34fb";
export const GAN_GEN1_CHARACTERISTIC_UUIDS = [
  "0000fff1-0000-1000-8000-00805f9b34fb",
  "0000fff2-0000-1000-8000-00805f9b34fb",
  "0000fff3-0000-1000-8000-00805f9b34fb",
  "0000fff4-0000-1000-8000-00805f9b34fb",
  "0000fff5-0000-1000-8000-00805f9b34fb",
  "0000fff6-0000-1000-8000-00805f9b34fb",
  "0000fff7-0000-1000-8000-00805f9b34fb",
] as const;

// Gen2 (356i v2, 356X)
export const GAN_GEN2_SERVICE = "6e400001-b5a3-f393-e0a9-e50e24dc4179";
export const GAN_GEN2_CHARACTERISTIC_UUIDS = [
  "28be4a4a-cd67-11e9-a32f-2a2ae2dbcce4",
  "28be4cb6-cd67-11e9-a32f-2a2ae2dbcce4",
] as const;

// Gen3
export const GAN_GEN3_SERVICE = "8653000a-43e6-47b7-9cb0-5fc21d4ae340";
export const GAN_GEN3_CHARACTERISTIC_UUIDS = [
  "8653000c-43e6-47b7-9cb0-5fc21d4ae340",
  "8653000b-43e6-47b7-9cb0-5fc21d4ae340",
] as const;

// Gen4
export const GAN_GEN4_SERVICE = "00000010-0000-fff7-fff6-fff5fff4fff0";
export const GAN_GEN4_CHARACTERISTIC_UUIDS = [
  "0000fff5-0000-1000-8000-00805f9b34fb",
  "0000fff6-0000-1000-8000-00805f9b34fb",
] as const;

// All known GAN service UUIDs (used for device filter + optionalServices)
export const ALL_GAN_SERVICE_UUIDS = [
  GAN_GEN1_SERVICE,
  GAN_GEN2_SERVICE,
  GAN_GEN3_SERVICE,
  GAN_GEN4_SERVICE,
] as const;

// Kept for backward-compat references within this app
export const GAN_SERVICE_UUID = GAN_GEN1_SERVICE;
export const GAN_CHARACTERISTIC_UUIDS = GAN_GEN1_CHARACTERISTIC_UUIDS;

export const DEVICE_INFO_SERVICE_UUID = "0000180a-0000-1000-8000-00805f9b34fb";

export const DEVICE_INFO_CHARACTERISTICS = {
  systemId: "00002a23-0000-1000-8000-00805f9b34fb",
  modelNumber: "00002a24-0000-1000-8000-00805f9b34fb",
  serialNumber: "00002a25-0000-1000-8000-00805f9b34fb",
  firmwareRevision: "00002a26-0000-1000-8000-00805f9b34fb",
  hardwareRevision: "00002a27-0000-1000-8000-00805f9b34fb",
  softwareRevision: "00002a28-0000-1000-8000-00805f9b34fb",
  manufacturerName: "00002a29-0000-1000-8000-00805f9b34fb",
} as const;
