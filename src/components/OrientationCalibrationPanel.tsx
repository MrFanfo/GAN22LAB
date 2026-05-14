import { useState } from "react";
import type { CubeColor } from "../lib/orientation";
import type { GyroDebugState } from "../hooks/useSmartcubeConnection";

const COLORS: CubeColor[] = ["white", "yellow", "green", "blue", "red", "orange"];

type OrientationCalibrationPanelProps = {
  debug: GyroDebugState;
  onResetGyro: () => void;
  onCalibrate: (top: CubeColor, front: CubeColor) => void;
};

export function OrientationCalibrationPanel({
  debug,
  onResetGyro,
  onCalibrate,
}: OrientationCalibrationPanelProps) {
  const [topColor, setTopColor] = useState<CubeColor>("yellow");
  const [frontColor, setFrontColor] = useState<CubeColor>("green");

  return (
    <section className="lab-panel orientation-panel">
      <div className="orientation-panel-head">
        <div>
          <h2>Gyro + Semantic Orientation</h2>
          <p>Visual gyro reset changes the viewing basis. Top/front calibration teaches the app how you are holding the physical 2x2.</p>
        </div>
        <button className="lab-btn" type="button" onClick={onResetGyro}>Reset Gyro View</button>
      </div>

      <div className="calibration-grid">
        <label>
          Top color
          <select value={topColor} onChange={(event) => setTopColor(event.target.value as CubeColor)}>
            {COLORS.map((color) => <option key={color} value={color}>{color}</option>)}
          </select>
        </label>
        <label>
          Front color
          <select value={frontColor} onChange={(event) => setFrontColor(event.target.value as CubeColor)}>
            {COLORS.map((color) => <option key={color} value={color}>{color}</option>)}
          </select>
        </label>
        <button className="lab-btn" type="button" onClick={() => onCalibrate(topColor, frontColor)}>
          Calibrate Top / Front
        </button>
      </div>

      <div className="gyro-debug-grid">
        <span>Raw q</span><strong className="mono">{debug.rawQuaternionText}</strong>
        <span>Three q</span><strong className="mono">{debug.remappedQuaternionText}</strong>
        <span>Display q</span><strong className="mono">{debug.displayQuaternionText}</strong>
        <span>Velocity</span><strong className="mono">{debug.velocityText}</strong>
        <span>Basis</span><strong>{debug.gyroBasisActive ? "active" : "waiting"}</strong>
        <span>Calibration</span><strong>{debug.semanticCalibrationActive ? `${debug.calibratedTopColor} up / ${debug.calibratedFrontColor} front` : "not calibrated"}</strong>
        <span>Detected top</span><strong>{debug.detectedTop} {debug.topConfidence !== null ? `(${debug.topConfidence.toFixed(2)})` : ""}</strong>
        <span>Detected front</span><strong>{debug.detectedFront} {debug.frontConfidence !== null ? `(${debug.frontConfidence.toFixed(2)})` : ""}</strong>
        <span>Detected right</span><strong>{debug.detectedRight} {debug.rightConfidence !== null ? `(${debug.rightConfidence.toFixed(2)})` : ""}</strong>
      </div>
    </section>
  );
}
