import { useRef, useState, useEffect } from "react";
import { GanBleLab } from "./gan/ganBle";
import { normalizeMac } from "./gan/mac";
import type { BleLogEntry, ConnectionStatus } from "./gan/types";

function makeid(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatEntry(entry: BleLogEntry, index: number): string {
  const lines: string[] = [
    `[${index}] ${entry.timestamp}`,
    `  type: ${entry.type}`,
    `  message: ${entry.message}`,
  ];
  if (entry.expectedMoveLabel) {
    lines.push(`  expectedMoveLabel: ${entry.expectedMoveLabel}`);
  }
  if (entry.data !== undefined) {
    lines.push(`  data: ${JSON.stringify(entry.data, null, 4).replace(/\n/g, "\n  ")}`);
  }
  return lines.join("\n");
}

export default function App() {
  const [logs, setLogs] = useState<BleLogEntry[]>([]);
  const [status, setStatus] = useState<ConnectionStatus>("disconnected");
  const [manualMacInput, setManualMacInput] = useState("");
  const [preferManualMac, setPreferManualMac] = useState(true);
  const [expectedMoveLabel, setExpectedMoveLabel] = useState("");

  const labRef = useRef<GanBleLab | null>(null);
  const expectedMoveLabelRef = useRef(expectedMoveLabel);
  const logScrollRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    expectedMoveLabelRef.current = expectedMoveLabel;
  }, [expectedMoveLabel]);

  const normalizedManualMac = normalizeMac(manualMacInput);
  const macInputEmpty = manualMacInput.trim() === "";

  function addLog(entry: Omit<BleLogEntry, "id" | "timestamp">) {
    setLogs((prev) => [
      ...prev,
      { id: makeid(), timestamp: nowIso(), ...entry },
    ]);
  }

  useEffect(() => {
    if (logScrollRef.current) {
      logScrollRef.current.scrollTop = logScrollRef.current.scrollHeight;
    }
  }, [logs]);

  function createLab() {
    labRef.current = new GanBleLab(addLog, setStatus, {
      manualMac: normalizedManualMac,
      preferManualMac,
      expectedMoveLabelGetter: () => expectedMoveLabelRef.current,
    });
    return labRef.current;
  }

  async function handleConnect() {
    const lab = createLab();
    await lab.connectNormal();
  }

  async function handleConnectFallback() {
    const lab = createLab();
    await lab.connectFallbackAllDevices();
  }

  async function handleDisconnect() {
    if (labRef.current) {
      await labRef.current.disconnect();
    }
  }

  function handleClearLogs() {
    setLogs([]);
  }

  function handleExport() {
    const payload = {
      app: "gan251-lab",
      exportedAt: nowIso(),
      status,
      manualMacProvided: manualMacInput.trim() !== "",
      normalizedManualMac,
      preferManualMac,
      logs,
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const now = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `gan251-lab-${now}.json`;
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function handleAddMarker() {
    addLog({
      type: "marker",
      message: "Expected move marker",
      expectedMoveLabel,
    });
  }

  function handleMarkBaseline() {
    addLog({
      type: "baseline",
      message: "User marked cube as solved/reset baseline",
    });
  }

  const macStatusText = macInputEmpty
    ? "No manual MAC provided"
    : normalizedManualMac
    ? `Manual MAC valid: ${normalizedManualMac}`
    : "Invalid MAC format";

  const macStatusClass = macInputEmpty
    ? "mac-neutral"
    : normalizedManualMac
    ? "mac-valid"
    : "mac-invalid";

  const isConnected = status === "connected";
  const isBusy =
    status === "requesting-device" || status === "connecting";

  return (
    <main>
      <h1>GAN 251 UI Bluetooth Lab</h1>
      <p className="description">
        Standalone Web Bluetooth lab for inspecting GAN 251 UI connection,
        characteristics, notifications, MAC handling, and packet logs.
      </p>

      <section className="panel">
        <h2>Connection</h2>

        <div className="field">
          <label htmlFor="macInput">Manual MAC address (optional)</label>
          <input
            id="macInput"
            type="text"
            value={manualMacInput}
            onChange={(e) => setManualMacInput(e.target.value)}
            placeholder="AB:12:34:5D:34:12 or AB-12-34-5D-34-12 or AB12345D3412"
            className="mac-input"
          />
          <span className={`mac-status ${macStatusClass}`}>{macStatusText}</span>
        </div>

        <div className="field checkbox-field">
          <label>
            <input
              type="checkbox"
              checked={preferManualMac}
              onChange={(e) => setPreferManualMac(e.target.checked)}
            />
            {" "}Prefer manual MAC over auto-detected MAC
          </label>
        </div>

        <div className="button-row">
          <button onClick={handleConnect} disabled={isBusy || isConnected}>
            Connect
          </button>
          <button onClick={handleConnectFallback} disabled={isBusy || isConnected}>
            Connect fallback / all devices
          </button>
          <button onClick={handleDisconnect} disabled={!isConnected && !isBusy}>
            Disconnect
          </button>
        </div>

        <div className="status-row">
          <span className="status-label">Status:</span>
          <span className={`status-value status-${status}`}>{status}</span>
        </div>
      </section>

      <section className="panel">
        <h2>Move Capture</h2>

        <div className="field">
          <label htmlFor="moveLabel">Expected move label</label>
          <input
            id="moveLabel"
            type="text"
            value={expectedMoveLabel}
            onChange={(e) => setExpectedMoveLabel(e.target.value)}
            placeholder="R, R', U, U', F, F', etc."
            className="move-input"
          />
        </div>

        <div className="button-row">
          <button onClick={handleAddMarker}>Add marker</button>
          <button onClick={handleMarkBaseline}>Mark solved / reset baseline</button>
        </div>
      </section>

      <section className="panel">
        <div className="log-header">
          <h2>Logs <span className="log-count">({logs.length} entries)</span></h2>
          <div className="button-row">
            <button onClick={handleClearLogs}>Clear logs</button>
            <button onClick={handleExport} disabled={logs.length === 0}>
              Export logs as JSON
            </button>
          </div>
        </div>

        <pre className="log-viewer" ref={logScrollRef}>
          {logs.length === 0
            ? "(no logs yet)"
            : logs.map((entry, i) => formatEntry(entry, i)).join("\n\n")}
        </pre>
      </section>
    </main>
  );
}
