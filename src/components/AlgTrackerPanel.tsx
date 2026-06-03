import { useMemo, useRef, useState } from "react";
import type { Quaternion } from "three";
import { parseAlg, type GanMove } from "../lib/gan251AlgMatcher";
import {
  simulateReportsWithFrameDrift,
  trackAlg,
  type TrackedStep,
} from "../lib/algTracker";
import { Virtual2x2Cube } from "../gan251/virtual2x2Cube";
import type { Gan251Face, Gan251MoveDirection } from "../gan251/types";
import { SOLVED_2X2_FACELETS } from "../lib/cubeState2x2";
import { VirtualCube2x2 } from "./VirtualCube2x2";

type AlgTrackerPanelProps = {
  liveGanMoves: GanMove[]; // reported moves from cube/keyboard, oldest-first
  onReset: () => void;
};

const DIRECTION_FOR_SUFFIX: Record<string, Gan251MoveDirection> = {
  "": "clockwise",
  "'": "counterclockwise",
  "2": "double",
};

function formatMoveStream(moves: readonly string[]): string {
  return moves.length ? moves.join(" ") : "—";
}

function formatMoveStreamAlternatives(alternatives: readonly (readonly string[])[]): string {
  return alternatives.map(formatMoveStream).join(" / ");
}

// Build the 2x2 facelet string after applying a list of physical moves.
function faceletsAfter(moves: string[]): string {
  const cube = Virtual2x2Cube.solved();
  for (const move of moves) {
    const face = move[0] as Gan251Face;
    const suffix = move.slice(1);
    cube.applyMove(face, DIRECTION_FOR_SUFFIX[suffix] ?? "clockwise");
  }
  return cube.toFacelets24();
}

function MoveChip({
  label,
  tone,
  dim,
}: {
  label: string;
  tone: "neutral" | "good" | "bad" | "active";
  dim?: boolean;
}) {
  const palette: Record<string, { bg: string; col: string; border: string }> = {
    neutral: { bg: "rgba(255,255,255,0.04)", col: "#cbd5e1", border: "rgba(255,255,255,0.10)" },
    good: { bg: "rgba(34,197,94,0.15)", col: "#22c55e", border: "rgba(34,197,94,0.4)" },
    bad: { bg: "rgba(248,113,113,0.15)", col: "#f87171", border: "rgba(248,113,113,0.4)" },
    active: { bg: "rgba(96,165,250,0.16)", col: "#60a5fa", border: "rgba(96,165,250,0.5)" },
  };
  const p = palette[tone]!;
  return (
    <span
      className="mono"
      style={{
        padding: "3px 10px",
        borderRadius: 5,
        background: p.bg,
        color: p.col,
        border: `1px solid ${p.border}`,
        fontSize: "0.9rem",
        opacity: dim ? 0.45 : 1,
      }}
    >
      {label}
    </span>
  );
}

export function AlgTrackerPanel({ liveGanMoves, onReset }: AlgTrackerPanelProps) {
  const [algValue, setAlgValue] = useState("D F");

  const expectedMoves = useMemo(() => parseAlg(algValue) ?? [], [algValue]);
  const algValid = useMemo(() => parseAlg(algValue) !== null, [algValue]);

  const result = useMemo(
    () => trackAlg(expectedMoves, liveGanMoves),
    [expectedMoves, liveGanMoves],
  );

  // What a perfect run reports (with anchor-frame drift) — the "target" stream.
  const targetReports = useMemo(
    () => simulateReportsWithFrameDrift(expectedMoves),
    [expectedMoves],
  );

  const facelets = useMemo(
    () => (result.acceptedPhysical.length ? faceletsAfter(result.acceptedPhysical) : SOLVED_2X2_FACELETS),
    [result.acceptedPhysical],
  );

  const nullQuatRef = useRef<Quaternion | null>(null);

  const currentStep = result.steps.findIndex((s) => s.status === "pending");

  return (
    <section className="lab-panel">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 4 }}>
        <h2>Alg Tracker — anchor-corner frame</h2>
        <button className="lab-btn btn-danger" onClick={onReset} style={{ fontSize: "0.75rem" }}>
          Reset attempt
        </button>
      </div>
      <p style={{ color: "#64748b", fontSize: "0.82rem", margin: "4px 0 14px" }}>
        Start with <strong style={{ color: "#cbd5e1" }}>white on top, green in front</strong>. The GAN 251 reports
        every turn relative to its fixed anchor corner (orange/blue/yellow, DLB). A move that moves the anchor rotates
        the whole reference frame, so later faces report on a different axis. This tracker advances that frame by each
        accepted move and checks the live stream against it.
      </p>

      {/* ── 2) Alg to follow ── */}
      <div className="field">
        <label htmlFor="tracker-alg">
          Algorithm to follow
          <span className="field-hint"> (physical notation — U D R L F B with ′ and 2)</span>
        </label>
        <input
          id="tracker-alg"
          className="mac-input"
          value={algValue}
          onChange={(e) => setAlgValue(e.target.value)}
          placeholder="D F"
          spellCheck={false}
          style={algValid ? undefined : { borderColor: "#f87171" }}
        />
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, margin: "10px 0 18px" }}>
        {expectedMoves.length === 0 ? (
          <span style={{ color: "#475569", fontSize: "0.82rem", fontStyle: "italic" }}>
            {algValid ? "Empty algorithm." : "Invalid algorithm — check the notation."}
          </span>
        ) : (
          expectedMoves.map((m, i) => {
            const s = result.steps[i];
            const tone =
              s?.status === "accepted" ? "good"
                : s?.status === "wrong" ? "bad"
                  : i === currentStep ? "active"
                    : "neutral";
            return <MoveChip key={i} label={m} tone={tone} dim={tone === "neutral" && i !== currentStep} />;
          })
        )}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {/* ── 1) Virtual cube ── */}
        <div>
          <div style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: 6 }}>
            Virtual cube — accepted moves applied ({result.acceptedPhysical.length})
          </div>
          <VirtualCube2x2 targetQuaternionRef={nullQuatRef} gyroEnabled={false} facelets24={facelets} moveAlg="" />
        </div>

        {/* ── 3) + 4) Reported & transformed ── */}
        <div>
          <div style={{ fontSize: "0.72rem", color: "#64748b", marginBottom: 6 }}>
            Cube would report (perfect run): {" "}
            <span className="mono" style={{ color: "#60a5fa" }}>
              {targetReports.length ? targetReports.join("  ") : "—"}
            </span>
          </div>

          <div style={{ fontSize: "0.72rem", color: "#64748b", margin: "12px 0 6px" }}>
            Live from cube ({liveGanMoves.length} move{liveGanMoves.length !== 1 ? "s" : ""}):
          </div>
          {liveGanMoves.length === 0 ? (
            <span style={{ color: "#334155", fontSize: "0.82rem", fontStyle: "italic" }}>
              Waiting — connect the cube or press U / R / F (Shift = prime).
            </span>
          ) : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {liveGanMoves.map((m, i) => {
                const want = targetReports[i];
                const tone = want === undefined ? "bad" : m === want ? "good" : "bad";
                return <MoveChip key={i} label={m} tone={tone} />;
              })}
            </div>
          )}

          {/* ── 4) Transformed / accepted table ── */}
          <table className="tracker-table" style={{ width: "100%", marginTop: 14, borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <thead>
              <tr style={{ color: "#64748b", textAlign: "left" }}>
                <th style={{ padding: "4px 8px", fontWeight: 600 }}>#</th>
                <th style={{ padding: "4px 8px", fontWeight: 600 }}>Asked</th>
                <th style={{ padding: "4px 8px", fontWeight: 600 }}>Cube should say</th>
                <th style={{ padding: "4px 8px", fontWeight: 600 }}>Cube said</th>
                <th style={{ padding: "4px 8px", fontWeight: 600 }}>Accepted as</th>
                <th style={{ padding: "4px 8px", fontWeight: 600 }}>Anchor</th>
              </tr>
            </thead>
            <tbody>
              {result.steps.map((step) => (
                <TrackerRow key={step.index} step={step} />
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: 8, fontSize: "0.7rem", color: "#64748b", display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "rgba(168,85,247,0.13)", boxShadow: "inset 2px 0 0 #a855f7" }} />
            Violet rows turn the anchor corner and rotate the reference frame (the next face reports on a new axis).
          </div>

          <div style={{ marginTop: 12 }}>
            {result.firstErrorIndex !== null ? (
              <span style={{ color: "#f87171", fontWeight: 700 }}>
                ✗ Wrong move at step {result.firstErrorIndex + 1}
              </span>
            ) : result.complete ? (
              <span style={{ color: "#22c55e", fontWeight: 700 }}>✓ Algorithm complete</span>
            ) : (
              <span style={{ color: "#60a5fa", fontWeight: 700 }}>… In progress</span>
            )}
            {result.extraReported.length > 0 && (
              <span style={{ color: "#fbbf24", marginLeft: 12 }}>
                +{result.extraReported.length} extra move(s) past the end
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function TrackerRow({ step }: { step: TrackedStep }) {
  const rowColor =
    step.status === "accepted" ? "#22c55e"
      : step.status === "wrong" ? "#f87171"
        : "#475569";
  // Highlight rows whose move turns the anchor corner (drifts the reference frame).
  const anchorTint = "rgba(168,85,247,0.13)"; // violet
  return (
    <tr
      style={{
        borderTop: "1px solid rgba(255,255,255,0.06)",
        background: step.movesAnchor ? anchorTint : "transparent",
        boxShadow: step.movesAnchor ? "inset 3px 0 0 #a855f7" : "none",
      }}
    >
      <td className="mono" style={{ padding: "5px 8px", color: "#64748b" }}>{step.index + 1}</td>
      <td className="mono" style={{ padding: "5px 8px", color: "#cbd5e1" }}>{step.expectedPhysical}</td>
      <td className="mono" style={{ padding: "5px 8px", color: "#60a5fa" }}>
        {formatMoveStreamAlternatives(step.expectedReportedAlternatives)}
      </td>
      <td className="mono" style={{ padding: "5px 8px", color: rowColor }}>
        {formatMoveStream(step.actualReported)}
      </td>
      <td className="mono" style={{ padding: "5px 8px", color: rowColor, fontWeight: 600 }}>
        {step.status === "accepted" ? step.acceptedAsPhysical
          : step.status === "wrong" ? "✗"
            : "…"}
      </td>
      <td className="mono" style={{ padding: "5px 8px", color: step.movesAnchor ? "#c084fc" : "#334155" }}>
        {step.movesAnchor ? "⟳ moves" : "—"}
      </td>
    </tr>
  );
}
