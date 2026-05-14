import { useCallback, useMemo, useRef, useState } from "react";
import { GanBleLab } from "./gan/ganBle";
import { LibraryConnector } from "./gan/libraryConnector";
import { normalizeMac } from "./gan/mac";
import type { BleLogEntry, ConnectionMode, ConnectionStatus, PacketRow } from "./gan/types";

// ── Formatting helpers ──────────────────────────────────────────────────────

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
  } as Intl.DateTimeFormatOptions);
}

function formatDeltaMs(ms: number): string {
  if (ms < 1000) return `+${ms}ms`;
  if (ms < 60_000) return `+${(ms / 1000).toFixed(2)}s`;
  return `+${Math.round(ms / 60_000)}m`;
}

function shortenUuid(uuid: string | null): string {
  if (!uuid) return "—";
  return "…" + uuid.replace(/-/g, "").slice(-8);
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const MAX_ROWS = 2000;
const SOLVED_2X2_FACELETS = "UUUURRRRFFFFDDDDLLLLBBBB";
const FACE_ORDER = ["U", "R", "F", "D", "L", "B"] as const;
type CubeDriveMode = "state" | "moves";
const FACE_COLOR_CLASS: Record<(typeof FACE_ORDER)[number], string> = {
  U: "face-u",
  R: "face-r",
  F: "face-f",
  D: "face-d",
  L: "face-l",
  B: "face-b",
};

function splitFacelets24(facelets24: string): Record<(typeof FACE_ORDER)[number], string[]> {
  const padded = (facelets24 + SOLVED_2X2_FACELETS).slice(0, 24);
  return {
    U: padded.slice(0, 4).split(""),
    R: padded.slice(4, 8).split(""),
    F: padded.slice(8, 12).split(""),
    D: padded.slice(12, 16).split(""),
    L: padded.slice(16, 20).split(""),
    B: padded.slice(20, 24).split(""),
  };
}

function Virtual2x2Panel({
  facelets24,
  source,
  driveMode,
  onDriveModeChange,
}: {
  facelets24: string;
  source: PacketRow | null;
  driveMode: CubeDriveMode;
  onDriveModeChange: (mode: CubeDriveMode) => void;
}) {
  const faces = splitFacelets24(facelets24);
  return (
    <section className="lab-panel virtual-cube-panel">
      <div className="virtual-cube-head">
        <div>
          <h2>Virtual 2x2 Cube</h2>
          <p>
            {source
              ? `${driveMode === "state" ? "State packet" : "Move stream"} view updated by packet #${source.packetNum}: ${source.decodedSummary ?? source.meaning}`
              : `Waiting for decoded GAN251 ${driveMode === "state" ? "state" : "move"} packets.`}
          </p>
        </div>
        <div className="virtual-cube-controls">
          <div className="virtual-drive-toggle" role="tablist" aria-label="Virtual cube driver">
            <button
              type="button"
              className={driveMode === "state" ? "active" : ""}
              onClick={() => onDriveModeChange("state")}
              aria-pressed={driveMode === "state"}
            >
              Facelets/state
            </button>
            <button
              type="button"
              className={driveMode === "moves" ? "active" : ""}
              onClick={() => onDriveModeChange("moves")}
              aria-pressed={driveMode === "moves"}
            >
              Moves only
            </button>
          </div>
          <span className="virtual-facelets mono">{facelets24}</span>
        </div>
      </div>
      <Cube3D2x2 faces={faces} />
    </section>
  );
}

function Cube3D2x2({ faces }: { faces: Record<(typeof FACE_ORDER)[number], string[]> }) {
  return (
    <div className="cube3d-stage" aria-label="Virtual 3D 2x2 cube">
      <div className="cube3d">
        <Cube3DFace face="F" stickers={faces.F} className="cube3d-face-front" />
        <Cube3DFace face="B" stickers={faces.B} className="cube3d-face-back" />
        <Cube3DFace face="R" stickers={faces.R} className="cube3d-face-right" />
        <Cube3DFace face="L" stickers={faces.L} className="cube3d-face-left" />
        <Cube3DFace face="U" stickers={faces.U} className="cube3d-face-top" />
        <Cube3DFace face="D" stickers={faces.D} className="cube3d-face-bottom" />
      </div>
    </div>
  );
}

function Cube3DFace({
  face,
  stickers,
  className,
}: {
  face: (typeof FACE_ORDER)[number];
  stickers: string[];
  className: string;
}) {
  return (
    <div className={`cube3d-face ${className}`} data-face={face}>
      {stickers.map((sticker, index) => {
        const faceKey = FACE_ORDER.includes(sticker as (typeof FACE_ORDER)[number])
          ? sticker as (typeof FACE_ORDER)[number]
          : face;
        return (
          <span
            key={`${face}-${index}`}
            className={`cube3d-sticker ${FACE_COLOR_CLASS[faceKey]}`}
            title={`${face}${index}: ${sticker}`}
          />
        );
      })}
    </div>
  );
}

// ── Component ───────────────────────────────────────────────────────────────

export default function App() {
  const [mode, setMode] = useState<ConnectionMode>("library");
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [manualMacInput, setManualMacInput] = useState("");
  const [preferManualMac, setPreferManualMac] = useState(true);

  const [packetRows, setPacketRows] = useState<PacketRow[]>([]);
  const [showTelemetry, setShowTelemetry] = useState(false);
  const [cubeDriveMode, setCubeDriveMode] = useState<CubeDriveMode>("state");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);

  const rawLabRef = useRef<GanBleLab | null>(null);
  const libConnRef = useRef<LibraryConnector | null>(null);
  const rowBufferRef = useRef<PacketRow[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const normalizedMac = normalizeMac(manualMacInput);
  const macEmpty = manualMacInput.trim() === "";

  // Debounced row flush (150ms) to batch React state updates
  const addPacketRow = useCallback((row: PacketRow) => {
    rowBufferRef.current.push(row);
    if (!flushTimerRef.current) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        const buf = rowBufferRef.current.splice(0);
        if (buf.length === 0) return;
        setPacketRows((prev) => {
          const next = [...buf, ...prev];
          return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next;
        });
      }, 150);
    }
  }, []);

  const addLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setLogLines((prev) => [`[${ts}] ${msg}`, ...prev].slice(0, 500));
  }, []);

  const handleConnect = useCallback(async (fallback = false) => {
    if (mode === "raw") {
      rawLabRef.current = new GanBleLab({
        manualMac: normalizedMac,
        preferManualMac,
        onPacketRow: addPacketRow,
        onLog: (entry: Omit<BleLogEntry, "id" | "timestamp">) => addLog(`[${entry.type}] ${entry.message}`),
      });
      setStatus("requesting-device");
      if (fallback) {
        await rawLabRef.current.connectFallbackAllDevices();
      } else {
        await rawLabRef.current.connectNormal();
      }
    } else {
      libConnRef.current = new LibraryConnector({
        manualMac: normalizedMac,
        onPacketRow: addPacketRow,
        onLog: addLog,
        onStatusChange: setStatus,
      });
      await libConnRef.current.connect();
    }
  }, [mode, normalizedMac, preferManualMac, addPacketRow, addLog]);

  const handleDisconnect = useCallback(async () => {
    if (mode === "raw") {
      await rawLabRef.current?.disconnect();
      rawLabRef.current = null;
      setStatus("disconnected");
    } else {
      await libConnRef.current?.disconnect();
      libConnRef.current = null;
    }
  }, [mode]);

  const handleClear = useCallback(() => {
    rowBufferRef.current = [];
    setPacketRows([]);
  }, []);

  const visibleRows = useMemo(
    () => (showTelemetry ? packetRows : packetRows.filter((r) => !r.isTelemetry)),
    [packetRows, showTelemetry]
  );

  const handleExport = useCallback(() => {
    downloadJson(
      `gan251-lab-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      { exportedAt: new Date().toISOString(), mode, showTelemetry, rows: visibleRows }
    );
  }, [mode, showTelemetry, visibleRows]);

  const deltaMs = useMemo(
    () =>
      visibleRows.map((row, i) => {
        const prev = visibleRows[i + 1];
        return prev ? row.at - prev.at : null;
      }),
    [visibleRows]
  );

  const counts = useMemo(() => {
    const c: Partial<Record<PacketRow["packetType"], number>> = {};
    for (const r of packetRows) c[r.packetType] = (c[r.packetType] ?? 0) + 1;
    return c;
  }, [packetRows]);

  const latestStateDrivenRow = useMemo(
    () => packetRows.find((row) => row.decodedKind === "state" && row.stateDrivenFacelets24) ?? null,
    [packetRows]
  );
  const latestMoveDrivenRow = useMemo(
    () => packetRows.find((row) => row.decodedKind === "move" && row.moveDrivenFacelets24) ?? null,
    [packetRows]
  );
  const latestVirtualRow = cubeDriveMode === "state" ? latestStateDrivenRow : latestMoveDrivenRow;
  const latestFacelets24 =
    cubeDriveMode === "state"
      ? latestStateDrivenRow?.stateDrivenFacelets24 ?? SOLVED_2X2_FACELETS
      : latestMoveDrivenRow?.moveDrivenFacelets24 ?? SOLVED_2X2_FACELETS;

  const isConnected = status === "connected";
  const isBusy = status === "requesting-device" || status === "connecting";

  const macStatusLabel = macEmpty
    ? mode === "library"
      ? "No MAC — required for GAN Gen2/3/4 (251 UI, 356i v2, etc.); without it the library will fail"
      : "No MAC — raw GAN packet decryption unavailable"
    : normalizedMac
    ? `MAC: ${normalizedMac} ✓`
    : "Invalid MAC format";
  const macStatusClass = macEmpty
    ? mode === "library" ? "mac-warn" : "mac-neutral"
    : normalizedMac ? "mac-valid" : "mac-invalid";

  return (
    <main className="lab-shell">
      <header className="lab-header">
        <h1>GAN 251 UI · Bluetooth Lab</h1>
        <p className="lab-subtitle">Raw BLE packet inspector + library mode with full decryption</p>
      </header>

      {/* Mode selector */}
      <section className="lab-panel">
        <div className="mode-selector">
          <button
            className={`mode-btn${mode === "library" ? " active" : ""}`}
            onClick={() => setMode("library")}
            disabled={isConnected || isBusy}
          >
            Library mode
            <span className="mode-hint">smartcube-web-bluetooth — full decrypt + events · MAC required for Gen2+</span>
          </button>
          <button
            className={`mode-btn${mode === "raw" ? " active" : ""}`}
            onClick={() => setMode("raw")}
            disabled={isConnected || isBusy}
          >
            Raw BLE mode
            <span className="mode-hint">Direct Web Bluetooth — Gen1 + GAN251 UI V3-2 AES decrypt</span>
          </button>
        </div>
      </section>

      {/* Connection */}
      <section className="lab-panel">
        <h2>Connection</h2>

        <div className="field">
          <label htmlFor="macInput">
            Cube MAC address
            <span className="field-hint"> (required for GAN251 UI raw decrypt &amp; Gen2+ library mode)</span>
          </label>
          <input
            id="macInput"
            type="text"
            value={manualMacInput}
            onChange={(e) => setManualMacInput(e.target.value)}
            placeholder="AB:12:34:56:78:9A  ·  AB-12-34-56-78-9A  ·  AB12345678A"
            className="mac-input"
            disabled={isConnected || isBusy}
          />
          <span className={`mac-status ${macStatusClass}`}>{macStatusLabel}</span>
        </div>

        {mode === "raw" && (
          <div className="field checkbox-field">
            <label>
              <input
                type="checkbox"
                checked={preferManualMac}
                onChange={(e) => setPreferManualMac(e.target.checked)}
                disabled={isConnected || isBusy}
              />
              {" "}Prefer manual MAC over browser-detected MAC
            </label>
          </div>
        )}

        <div className="button-row">
          {!isConnected ? (
            <>
              <button onClick={() => handleConnect(false)} disabled={isBusy}>
                {isBusy ? "Connecting…" : "Connect"}
              </button>
              {mode === "raw" && (
                <button onClick={() => handleConnect(true)} disabled={isBusy}>
                  Connect (all devices)
                </button>
              )}
            </>
          ) : (
            <button onClick={handleDisconnect} className="btn-danger">
              Disconnect
            </button>
          )}
        </div>

        <div className="status-row">
          <span className="status-label">Status</span>
          <span className={`status-badge status-${status}`}>{status}</span>
          <span className="status-label">Mode</span>
          <span className="mode-badge">{mode === "library" ? "Library" : "Raw BLE"}</span>
        </div>
      </section>

      <Virtual2x2Panel
        facelets24={latestFacelets24}
        source={latestVirtualRow}
        driveMode={cubeDriveMode}
        onDriveModeChange={setCubeDriveMode}
      />

      {/* Packet table */}
      <section className="lab-panel">
        <div className="table-toolbar">
          <div className="table-title-group">
            <h2>BLE Packet Table</h2>
            {packetRows.length > 0 && (
              <div className="count-badges">
                {(["MOVE", "FACELETS", "GYRO", "BATTERY", "HARDWARE", "DISCONNECT", "NOTIFY"] as const).map((t) =>
                  counts[t] ? (
                    <span key={t} className={`count-badge ptype-${t.toLowerCase()}`}>
                      {counts[t]} {t}
                    </span>
                  ) : null
                )}
              </div>
            )}
          </div>
          <div className="table-actions">
            <button
              className={`lab-btn${showTelemetry ? " active" : ""}`}
              onClick={() => setShowTelemetry((v) => !v)}
              title="GYRO and BATTERY rows hidden by default"
            >
              {showTelemetry ? "Hide Telemetry" : "Show Telemetry"}
            </button>
            <button className="lab-btn" onClick={handleExport} disabled={packetRows.length === 0}>
              Export JSON
            </button>
            <button className="lab-btn btn-danger" onClick={handleClear} disabled={packetRows.length === 0}>
              Clear
            </button>
          </div>
        </div>

        {visibleRows.length === 0 ? (
          <div className="table-empty">
            {packetRows.length === 0
              ? "No packets yet — connect a cube and interact with it."
              : "All packets hidden by telemetry filter."}
          </div>
        ) : (
          <div className="table-wrapper">
            <table className="packet-table">
              <thead>
                <tr>
                  <th className="col-num">#</th>
                  <th className="col-time">Time</th>
                  <th className="col-dt">ΔT</th>
                  <th className="col-mode">Mode</th>
                  <th className="col-type">Type</th>
                  <th className="col-cubets">Cube TS</th>
                  <th className="col-char">Characteristic</th>
                  <th className="col-raw">Raw (hex)</th>
                  <th className="col-dec">Decrypted (hex)</th>
                  <th className="col-meaning">Meaning</th>
                  <th className="col-transform">Transform</th>
                  <th className="col-facelets">2x2 Facelets</th>
                  <th className="col-proto">Protocol</th>
                  <th className="col-valid">Valid?</th>
                  <th className="col-reason">Validation</th>
                  <th className="col-cryptohex">Salt</th>
                  <th className="col-cryptohex">Key</th>
                  <th className="col-cryptohex">IV</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row, i) => {
                  const dt = deltaMs[i];
                  const dtClass =
                    dt === null ? "" : dt > 2000 ? "dt-red" : dt > 500 ? "dt-yellow" : "dt-green";

                  return (
                    <tr key={row.id} data-type={row.packetType} className={row.isTelemetry ? "row-telemetry" : ""}>
                      <td className="col-num mono">{row.packetNum}</td>
                      <td className="col-time mono">{formatTime(row.at)}</td>
                      <td className={`col-dt mono dt-cell ${dtClass}`}>
                        {dt !== null ? formatDeltaMs(dt) : "—"}
                      </td>
                      <td className="col-mode">
                        <span className={`mode-tag mode-tag-${row.mode}`}>{row.mode}</span>
                      </td>
                      <td className="col-type">
                        <span className={`ptype ptype-${row.packetType.toLowerCase()}`}>
                          {row.packetType}
                        </span>
                      </td>
                      <td className="col-cubets mono">
                        {row.cubeTimestamp !== null ? row.cubeTimestamp.toLocaleString() : "—"}
                      </td>
                      <td className="col-char mono" title={row.characteristicUuid ?? undefined}>
                        {shortenUuid(row.characteristicUuid)}
                      </td>
                      <td className="col-raw mono">
                        {row.rawHex ? (
                          <>
                            <span className="hex-bytes">{row.rawHex}</span>
                            <span className="byte-count">{row.rawByteLength}B</span>
                          </>
                        ) : "—"}
                      </td>
                      <td className="col-dec mono">
                        {row.decryptedHex ? (
                          <span className="hex-bytes">{row.decryptedHex}</span>
                        ) : row.decryptStatus === "plain" ? (
                          <span className="no-enc">plain</span>
                        ) : row.decryptStatus === "unavailable" ? (
                          <span className="no-enc">no MAC</span>
                        ) : row.decryptStatus === "failed" ? (
                          <span className="dec-failed">failed</span>
                        ) : "—"}
                      </td>
                      <td className="col-meaning mono">{row.meaning}</td>
                      <td className="col-transform">
                        {row.transform ? (
                          <span className="transform-move">{row.transform}</span>
                        ) : <span className="dim-dash">—</span>}
                      </td>
                      <td className="col-facelets mono" title={row.facelets24 ?? undefined}>
                        {row.facelets24 ?? "—"}
                      </td>
                      <td className="col-proto">
                        {row.protocolName ?? "—"}
                      </td>
                      <td className="col-valid">
                        {row.protocolValid === null ? (
                          <span className="dim-dash">—</span>
                        ) : row.protocolValid ? (
                          <span className="valid-yes">✓</span>
                        ) : (
                          <span className="valid-no">✗</span>
                        )}
                      </td>
                      <td className="col-reason mono" title={row.validationReason ?? undefined}>
                        {row.validationReason ?? "—"}
                      </td>
                      <td className="col-cryptohex mono" title={row.saltHex ?? undefined}>
                        {row.saltHex ? row.saltHex.slice(0, 11) + "…" : "—"}
                      </td>
                      <td className="col-cryptohex mono" title={row.finalKeyHex ?? undefined}>
                        {row.finalKeyHex ? row.finalKeyHex.slice(0, 11) + "…" : "—"}
                      </td>
                      <td className="col-cryptohex mono" title={row.finalIvHex ?? undefined}>
                        {row.finalIvHex ? row.finalIvHex.slice(0, 11) + "…" : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Diagnostic log */}
      <section className="lab-panel lab-panel-log">
        <button className="log-toggle" onClick={() => setShowLog((v) => !v)}>
          Diagnostic Log ({logLines.length} lines) {showLog ? "▲" : "▼"}
        </button>
        {showLog && (
          <pre className="log-viewer">
            {logLines.length === 0 ? "(no log entries)" : logLines.join("\n")}
          </pre>
        )}
      </section>
    </main>
  );
}
