import { useMemo, useState } from "react";
import {
  matchGan251ReportedStream,
  simulateGan251ReportsFromPhysicalAlg,
  type GanMove,
  type ValidationStatus,
} from "../lib/gan251AlgMatcher";

type AlgMatcherPanelProps = {
  liveGanMoves: GanMove[];   // moves from the BLE connection, oldest-first
  onReset: () => void;       // clears the live session
};

function statusColor(status: ValidationStatus): string {
  switch (status) {
    case "exact":           return "#22c55e";
    case "ambiguous":       return "#22c55e";
    case "axis-equivalent": return "#fbbf24";
    case "incomplete":      return "#60a5fa";
    case "wrong":           return "#f87171";
  }
}

function statusLabel(status: ValidationStatus): string {
  switch (status) {
    case "exact":           return "✓  CORRECT";
    case "ambiguous":       return "✓  CORRECT";
    case "axis-equivalent": return "~  CLOSE (axis only)";
    case "incomplete":      return "…  IN PROGRESS";
    case "wrong":           return "✗  WRONG";
  }
}

export function AlgMatcherPanel({ liveGanMoves, onReset }: AlgMatcherPanelProps) {
  const [expectedAlg, setExpectedAlg] = useState("R D U L D' F");

  // What the GAN22 should report when this alg is performed correctly
  const simulatedReports = useMemo(
    () => simulateGan251ReportsFromPhysicalAlg(expectedAlg),
    [expectedAlg]
  );

  const result = useMemo(() => {
    if (liveGanMoves.length === 0) return null;
    return matchGan251ReportedStream(expectedAlg, liveGanMoves);
  }, [expectedAlg, liveGanMoves]);

  const best = result?.bestHypothesis;

  return (
    <section className="lab-panel matcher-panel">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <h2>Algorithm Matcher — Hypothesis Branching</h2>
        <button className="lab-btn btn-danger" onClick={onReset} style={{ fontSize: "0.75rem" }}>
          Reset attempt
        </button>
      </div>
      <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 16px" }}>
        GAN22 can't distinguish D/U, L/R, B/F. Connect the cube and follow the alg — the matcher reads the live move stream and figures out if it matches.
      </p>

      {/* ── Alg to follow ── */}
      <div className="field">
        <label htmlFor="matcher-expected">
          Algorithm to follow
          <span className="field-hint"> (physical notation — U D R L F B and ′ 2)</span>
        </label>
        <input
          id="matcher-expected"
          className="mac-input"
          value={expectedAlg}
          onChange={e => setExpectedAlg(e.target.value)}
          placeholder="R D U L D' F"
          spellCheck={false}
        />
      </div>

      {/* ── Expected hardware stream ── */}
      <div style={{ margin: "10px 0 14px", padding: "10px 14px", background: "rgba(255,255,255,0.03)", borderRadius: 6, border: "1px solid rgba(255,255,255,0.07)" }}>
        <div style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: 4 }}>
          If done correctly, GAN22 will report:
        </div>
        <span className="mono" style={{ color: "#60a5fa", letterSpacing: "0.06em", fontSize: "0.95rem" }}>
          {simulatedReports.length > 0
            ? simulatedReports.join("  ")
            : <span style={{ color: "#475569" }}>—</span>}
        </span>
        <div style={{ fontSize: "0.68rem", color: "#475569", marginTop: 4 }}>
          D→U · L→R · B→F (hardware axis collapse)
        </div>
      </div>

      {/* ── Live move stream ── */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: 6 }}>
          Live from cube ({liveGanMoves.length} move{liveGanMoves.length !== 1 ? "s" : ""} so far):
        </div>
        {liveGanMoves.length === 0 ? (
          <span style={{ color: "#334155", fontSize: "0.82rem", fontStyle: "italic" }}>
            Waiting for moves — connect cube and start turning
          </span>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {liveGanMoves.map((m, i) => {
              // colour each live move vs expected at that position
              const expected = simulatedReports[i];
              const match = expected === undefined ? "extra"
                : m === expected ? "exact"
                : "mismatch";
              const bg = match === "exact" ? "rgba(34,197,94,0.15)"
                : match === "mismatch" ? "rgba(248,113,113,0.15)"
                : "rgba(251,191,36,0.15)";
              const col = match === "exact" ? "#22c55e"
                : match === "mismatch" ? "#f87171"
                : "#fbbf24";
              return (
                <span key={i} className="mono" style={{
                  padding: "2px 8px", borderRadius: 4, background: bg,
                  color: col, fontSize: "0.85rem", border: `1px solid ${col}33`,
                }}>
                  {m}
                </span>
              );
            })}
            {/* ghost slots for remaining expected moves */}
            {simulatedReports.slice(liveGanMoves.length).map((m, i) => (
              <span key={`ghost-${i}`} className="mono" style={{
                padding: "2px 8px", borderRadius: 4,
                color: "#334155", fontSize: "0.85rem",
                border: "1px dashed #1e293b",
              }}>
                {m}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* ── Live result ── */}
      {result && (
        <div style={{
          padding: "14px 16px",
          background: "rgba(255,255,255,0.03)",
          borderRadius: 8,
          borderLeft: `4px solid ${statusColor(result.status)}`,
        }}>
          <div style={{ fontSize: "1.1rem", fontWeight: 700, color: statusColor(result.status), marginBottom: 8 }}>
            {statusLabel(result.status)}
          </div>
          {best && (
            <>
              <div className="matcher-detail-row">
                <span className="matcher-detail-key">Best physical trace:</span>
                <span className="mono" style={{ color: "#e2e8f0" }}>
                  {best.physicalMoves.join("  ")}
                </span>
              </div>
              <div className="matcher-detail-row" style={{ marginTop: 6 }}>
                <span className="matcher-detail-key">Score:</span>
                <span className="mono">{best.score} / {best.physicalMoves.length * 3}</span>
                <span style={{ fontSize: "0.72rem", color: "#64748b", marginLeft: 8 }}>
                  ({result.debug.completeHypothesisCount} possible interpretations · {result.debug.exactCompleteCount} fully exact)
                </span>
              </div>
            </>
          )}
        </div>
      )}

      {!result && liveGanMoves.length === 0 && (
        <div style={{ color: "#334155", fontSize: "0.8rem", fontStyle: "italic" }}>
          Start turning the cube to see live matching.
        </div>
      )}
    </section>
  );
}
