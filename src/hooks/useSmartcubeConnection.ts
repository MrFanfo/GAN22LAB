import { useCallback, useMemo, useRef, useState } from "react";
import { connectSmartCube, type SmartCubeConnection, type SmartCubeEvent, type SmartCubeRawMessage } from "smartcube-web-bluetooth";
import type { Subscription } from "rxjs";
import * as THREE from "three";
import {
  computeDisplayQuaternion,
  createGyroBasis,
  formatQuaternion,
  formatSmartcubeQuaternion,
  formatVelocity,
  mapSmartcubeQuaternionToThree,
  type SmartcubeQuaternionLike,
  type SmartcubeVelocityLike,
} from "../lib/gyro";
import {
  createSemanticCalibration,
  detectSemanticOrientation,
  semanticQuaternionFromDisplay,
  type CubeColor,
  type SemanticCalibration,
  type SemanticOrientationResult,
} from "../lib/orientation";
import type { ConnectionStatus, PacketRow } from "../gan/types";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

function eventMeaning(event: SmartCubeEvent): string {
  switch (event.type) {
    case "MOVE": return `Move: ${event.move}`;
    case "FACELETS": return `Facelets: ${event.facelets}`;
    case "GYRO": return `Gyro ${formatSmartcubeQuaternion(event.quaternion)}`;
    case "BATTERY": return `Battery: ${event.batteryLevel}%`;
    case "HARDWARE": return event.hardwareName ?? "Hardware info";
    case "DISCONNECT": return "Disconnected";
  }
}

export type GyroDebugState = {
  rawQuaternionText: string;
  remappedQuaternionText: string;
  displayQuaternionText: string;
  velocityText: string;
  gyroBasisActive: boolean;
  semanticCalibrationActive: boolean;
  calibratedTopColor: CubeColor | null;
  calibratedFrontColor: CubeColor | null;
  detectedTop: string;
  detectedFront: string;
  detectedRight: string;
  topConfidence: number | null;
  frontConfidence: number | null;
  rightConfidence: number | null;
  lastUpdateAt: number | null;
};

export type UseSmartcubeConnectionOptions = {
  manualMac: string | null;
  onPacketRow: (row: PacketRow) => void;
  onLog: (message: string) => void;
  onStatusChange: (status: ConnectionStatus) => void;
};

export function useSmartcubeConnection(options: UseSmartcubeConnectionOptions) {
  const connectionRef = useRef<SmartCubeConnection | null>(null);
  const eventSubRef = useRef<Subscription | null>(null);
  const rawSubRef = useRef<Subscription | null>(null);
  const lastRawRef = useRef<SmartCubeRawMessage | null>(null);
  const rowCounterRef = useRef(0);

  const rawGyroQuaternionRef = useRef<THREE.Quaternion | null>(null);
  const cubeQuaternionRef = useRef<THREE.Quaternion | null>(null);
  const gyroBasisRef = useRef<THREE.Quaternion | null>(null);
  const semanticCalibrationRef = useRef<SemanticCalibration | null>(null);
  const semanticOrientationRef = useRef<SemanticOrientationResult | null>(null);
  const latestFaceletsRef = useRef<string | null>(null);
  const latestMoveRef = useRef<string | null>(null);
  const lastMirrorAtRef = useRef(0);

  const [status, setStatusState] = useState<ConnectionStatus>("disconnected");
  const [debug, setDebug] = useState<GyroDebugState>({
    rawQuaternionText: "none",
    remappedQuaternionText: "none",
    displayQuaternionText: "none",
    velocityText: "none",
    gyroBasisActive: false,
    semanticCalibrationActive: false,
    calibratedTopColor: null,
    calibratedFrontColor: null,
    detectedTop: "unknown",
    detectedFront: "unknown",
    detectedRight: "unknown",
    topConfidence: null,
    frontConfidence: null,
    rightConfidence: null,
    lastUpdateAt: null,
  });

  const setStatus = useCallback((next: ConnectionStatus) => {
    setStatusState(next);
    options.onStatusChange(next);
  }, [options]);

  const mirrorDebug = useCallback((
    raw: SmartcubeQuaternionLike | null,
    remapped: THREE.Quaternion | null,
    display: THREE.Quaternion | null,
    velocity: SmartcubeVelocityLike | null,
  ) => {
    const semantic = semanticOrientationRef.current;
    const calibration = semanticCalibrationRef.current;
    setDebug({
      rawQuaternionText: formatSmartcubeQuaternion(raw),
      remappedQuaternionText: formatQuaternion(remapped),
      displayQuaternionText: formatQuaternion(display),
      velocityText: formatVelocity(velocity),
      gyroBasisActive: Boolean(gyroBasisRef.current),
      semanticCalibrationActive: Boolean(calibration),
      calibratedTopColor: calibration?.topColor ?? null,
      calibratedFrontColor: calibration?.frontColor ?? null,
      detectedTop: semantic ? `${semantic.currentTopColor}/${semantic.currentTopFace}` : "unknown",
      detectedFront: semantic ? `${semantic.currentFrontColor}/${semantic.currentFrontFace}` : "unknown",
      detectedRight: semantic ? `${semantic.currentRightColor}/${semantic.currentRightFace}` : "unknown",
      topConfidence: semantic?.topConfidence ?? null,
      frontConfidence: semantic?.frontConfidence ?? null,
      rightConfidence: semantic?.rightConfidence ?? null,
      lastUpdateAt: Date.now(),
    });
  }, []);

  const handleGyro = useCallback((event: Extract<SmartCubeEvent, { type: "GYRO" }>) => {
    const remapped = mapSmartcubeQuaternionToThree(event.quaternion);
    rawGyroQuaternionRef.current = remapped;
    if (!gyroBasisRef.current) {
      gyroBasisRef.current = createGyroBasis(remapped);
    }

    const display = computeDisplayQuaternion(remapped, gyroBasisRef.current);
    cubeQuaternionRef.current = display;

    const semanticQ = semanticQuaternionFromDisplay(display, semanticCalibrationRef.current);
    semanticOrientationRef.current = detectSemanticOrientation(semanticQ, semanticOrientationRef.current);

    const now = Date.now();
    if (now - lastMirrorAtRef.current > 220) {
      lastMirrorAtRef.current = now;
      mirrorDebug(event.quaternion, remapped, display, event.velocity ?? null);
    }
  }, [mirrorDebug]);

  const handleEvent = useCallback((event: SmartCubeEvent) => {
    const conn = connectionRef.current;
    if (!conn) return;

    if (event.type === "GYRO") {
      handleGyro(event);
    }
    if (event.type === "FACELETS") {
      latestFaceletsRef.current = event.facelets;
    }
    if (event.type === "MOVE") {
      latestMoveRef.current = event.move;
    }
    if (event.type === "DISCONNECT") {
      setStatus("disconnected-by-device");
    }

    const raw = lastRawRef.current;
    options.onPacketRow({
      id: crypto.randomUUID(),
      packetNum: ++rowCounterRef.current,
      at: Date.now(),
      mode: "library",
      packetType: event.type === "DISCONNECT" ? "DISCONNECT" : (event.type as PacketRow["packetType"]),
      characteristicUuid: raw?.characteristicUuid ?? null,
      rawHex: raw ? bytesToHex(raw.raw) : null,
      rawByteLength: raw?.raw.byteLength ?? null,
      decryptedHex: raw?.decrypted ? bytesToHex(raw.decrypted) : null,
      decryptStatus: raw ? (raw.decrypted ? "success" : "plain") : "unavailable",
      meaning: eventMeaning(event),
      transform: event.type === "MOVE" ? event.move : null,
      cubeTimestamp: event.type === "MOVE" ? event.cubeTimestamp : null,
      deviceName: conn.deviceName,
      protocolName: conn.protocol.name,
      isTelemetry: event.type === "GYRO" || event.type === "BATTERY",
      saltHex: null,
      finalKeyHex: null,
      finalIvHex: null,
      protocolValid: null,
      validationReason: null,
      facelets24: latestFaceletsRef.current?.length === 24 ? latestFaceletsRef.current : null,
    });
  }, [handleGyro, options, setStatus]);

  const disconnect = useCallback(async () => {
    eventSubRef.current?.unsubscribe();
    rawSubRef.current?.unsubscribe();
    eventSubRef.current = null;
    rawSubRef.current = null;
    lastRawRef.current = null;
    rawGyroQuaternionRef.current = null;
    cubeQuaternionRef.current = null;
    gyroBasisRef.current = null;
    semanticCalibrationRef.current = null;
    semanticOrientationRef.current = null;
    latestFaceletsRef.current = null;
    latestMoveRef.current = null;
    await connectionRef.current?.disconnect().catch(() => {});
    connectionRef.current = null;
    setStatus("disconnected");
  }, [setStatus]);

  const connect = useCallback(async () => {
    setStatus("requesting-device");
    try {
      const manualMac = options.manualMac?.trim() || null;
      const conn = await connectSmartCube({
        enableAddressSearch: true,
        onStatus: options.onLog,
        macAddressProvider: manualMac ? async () => manualMac : undefined,
      });
      connectionRef.current = conn;
      setStatus("connected");
      options.onLog(`Connected: ${conn.deviceName} · ${conn.protocol.name}`);
      rawSubRef.current = conn.rawMessages$.subscribe({ next: (raw) => { lastRawRef.current = raw; } });
      eventSubRef.current = conn.events$.subscribe({
        next: handleEvent,
        error: (error) => {
          options.onLog(error instanceof Error ? error.message : String(error));
          setStatus("error");
        },
        complete: () => setStatus("disconnected-by-device"),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.onLog(message.includes("cancel") ? "Bluetooth picker cancelled" : `Connect failed: ${message}`);
      setStatus(message.includes("cancel") ? "disconnected" : "error");
    }
  }, [handleEvent, options, setStatus]);

  const resetGyroBasis = useCallback(() => {
    gyroBasisRef.current = null;
    options.onLog("Gyro visual basis reset requested; next gyro packet becomes neutral.");
  }, [options]);

  const calibrateSemanticOrientation = useCallback((topColor: CubeColor, frontColor: CubeColor) => {
    const display = cubeQuaternionRef.current;
    if (!display) {
      options.onLog("Cannot calibrate semantic orientation before a gyro packet arrives.");
      return;
    }
    try {
      semanticCalibrationRef.current = createSemanticCalibration(display, topColor, frontColor);
      const semanticQ = semanticQuaternionFromDisplay(display, semanticCalibrationRef.current);
      semanticOrientationRef.current = detectSemanticOrientation(semanticQ, null);
      mirrorDebug(null, rawGyroQuaternionRef.current, display, null);
      options.onLog(`Semantic orientation calibrated: ${topColor} up, ${frontColor} front.`);
    } catch (error) {
      options.onLog(error instanceof Error ? error.message : String(error));
    }
  }, [mirrorDebug, options]);

  return useMemo(() => ({
    status,
    debug,
    cubeQuaternionRef,
    latestFaceletsRef,
    semanticOrientationRef,
    connect,
    disconnect,
    resetGyroBasis,
    calibrateSemanticOrientation,
  }), [calibrateSemanticOrientation, connect, debug, disconnect, resetGyroBasis, status]);
}
