import * as THREE from "three";
import { rotateVectorByQuaternion } from "./gyro";

export type CubeFace = "U" | "R" | "F" | "D" | "L" | "B";
export type CubeColor = "white" | "red" | "green" | "yellow" | "orange" | "blue";

export type SemanticCalibration = {
  topColor: CubeColor;
  frontColor: CubeColor;
  referenceQuaternion: THREE.Quaternion;
  correctionQuaternion: THREE.Quaternion;
};

export type SemanticOrientationResult = {
  currentTopFace: CubeFace;
  currentFrontFace: CubeFace;
  currentRightFace: CubeFace;
  currentTopColor: CubeColor;
  currentFrontColor: CubeColor;
  currentRightColor: CubeColor;
  topConfidence: number;
  frontConfidence: number;
  rightConfidence: number;
  validPair: boolean;
};

export type OrientationHysteresisConfig = {
  minConfidence: number;
  switchMargin: number;
};

export const DEFAULT_HYSTERESIS: OrientationHysteresisConfig = {
  minConfidence: 0.55,
  switchMargin: 0.08,
};

export const LOCAL_FACE_NORMALS: Record<CubeFace, THREE.Vector3> = {
  U: new THREE.Vector3(0, 1, 0),
  D: new THREE.Vector3(0, -1, 0),
  F: new THREE.Vector3(0, 0, 1),
  B: new THREE.Vector3(0, 0, -1),
  R: new THREE.Vector3(1, 0, 0),
  L: new THREE.Vector3(-1, 0, 0),
};

export const COLOR_TO_FACE: Record<CubeColor, CubeFace> = {
  white: "U",
  red: "R",
  green: "F",
  yellow: "D",
  orange: "L",
  blue: "B",
};

export const FACE_TO_COLOR = Object.fromEntries(
  Object.entries(COLOR_TO_FACE).map(([color, face]) => [face, color]),
) as Record<CubeFace, CubeColor>;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_FRONT = new THREE.Vector3(0, 0, 1);
const WORLD_RIGHT = new THREE.Vector3(1, 0, 0);

function oppositeFace(face: CubeFace): CubeFace {
  return ({ U: "D", D: "U", F: "B", B: "F", R: "L", L: "R" } as const)[face];
}

function isAdjacent(a: CubeFace, b: CubeFace): boolean {
  return a !== b && oppositeFace(a) !== b;
}

function bestFaceForAxis(
  semanticQuaternion: THREE.Quaternion,
  worldAxis: THREE.Vector3,
  previousFace: CubeFace | null,
  config: OrientationHysteresisConfig,
): { face: CubeFace; confidence: number; runnerUp: number } {
  const scored = (Object.keys(LOCAL_FACE_NORMALS) as CubeFace[])
    .map((face) => ({
      face,
      score: rotateVectorByQuaternion(LOCAL_FACE_NORMALS[face], semanticQuaternion).dot(worldAxis),
    }))
    .sort((a, b) => b.score - a.score);

  const winner = scored[0]!;
  const runnerUp = scored[1]?.score ?? -1;
  if (previousFace) {
    const previous = scored.find((item) => item.face === previousFace);
    if (
      previous &&
      previous.score >= config.minConfidence &&
      winner.score - previous.score < config.switchMargin
    ) {
      return { face: previous.face, confidence: previous.score, runnerUp };
    }
  }
  return { face: winner.face, confidence: winner.score, runnerUp };
}

function quaternionFromTopFront(topFace: CubeFace, frontFace: CubeFace): THREE.Quaternion {
  const top = LOCAL_FACE_NORMALS[topFace].clone();
  const front = LOCAL_FACE_NORMALS[frontFace].clone();
  const right = new THREE.Vector3().crossVectors(front, top).normalize();
  const basis = new THREE.Matrix4().makeBasis(right, top, front);
  return new THREE.Quaternion().setFromRotationMatrix(basis).normalize();
}

export function createSemanticCalibration(
  displayQuaternion: THREE.Quaternion,
  topColor: CubeColor,
  frontColor: CubeColor,
): SemanticCalibration {
  const topFace = COLOR_TO_FACE[topColor];
  const frontFace = COLOR_TO_FACE[frontColor];
  if (!isAdjacent(topFace, frontFace)) {
    throw new Error("Top and front colors must be adjacent faces");
  }
  const expected = quaternionFromTopFront(topFace, frontFace);
  const correction = expected.clone().multiply(displayQuaternion.clone().invert()).normalize();
  return {
    topColor,
    frontColor,
    referenceQuaternion: displayQuaternion.clone(),
    correctionQuaternion: correction,
  };
}

export function semanticQuaternionFromDisplay(
  displayQuaternion: THREE.Quaternion,
  calibration: SemanticCalibration | null,
): THREE.Quaternion {
  if (!calibration) return displayQuaternion.clone();
  return calibration.correctionQuaternion.clone().multiply(displayQuaternion).normalize();
}

export function detectSemanticOrientation(
  semanticQuaternion: THREE.Quaternion,
  previous: SemanticOrientationResult | null,
  config: OrientationHysteresisConfig = DEFAULT_HYSTERESIS,
): SemanticOrientationResult {
  const top = bestFaceForAxis(semanticQuaternion, WORLD_UP, previous?.currentTopFace ?? null, config);
  let front = bestFaceForAxis(semanticQuaternion, WORLD_FRONT, previous?.currentFrontFace ?? null, config);
  const right = bestFaceForAxis(semanticQuaternion, WORLD_RIGHT, previous?.currentRightFace ?? null, config);

  if (!isAdjacent(top.face, front.face)) {
    const candidates = (Object.keys(LOCAL_FACE_NORMALS) as CubeFace[])
      .filter((face) => isAdjacent(top.face, face))
      .map((face) => ({
        face,
        score: rotateVectorByQuaternion(LOCAL_FACE_NORMALS[face], semanticQuaternion).dot(WORLD_FRONT),
      }))
      .sort((a, b) => b.score - a.score);
    const best = candidates[0]!;
    front = { face: best.face, confidence: best.score, runnerUp: candidates[1]?.score ?? -1 };
  }

  return {
    currentTopFace: top.face,
    currentFrontFace: front.face,
    currentRightFace: right.face,
    currentTopColor: FACE_TO_COLOR[top.face],
    currentFrontColor: FACE_TO_COLOR[front.face],
    currentRightColor: FACE_TO_COLOR[right.face],
    topConfidence: top.confidence,
    frontConfidence: front.confidence,
    rightConfidence: right.confidence,
    validPair: isAdjacent(top.face, front.face),
  };
}

export function getCurrentPhysicalOrientation(result: SemanticOrientationResult | null) {
  return result
    ? { top: result.currentTopFace, front: result.currentFrontFace, right: result.currentRightFace }
    : null;
}

export function normalizeMoveToTrainingFrame(move: string): string {
  // Placeholder boundary for later move transcoding. The orientation detector now
  // supplies current top/front/right; this function will eventually map moves
  // from the physical frame into a chosen training frame.
  return move;
}

export function orientationToRotationMap(result: SemanticOrientationResult | null) {
  return result ? getCurrentPhysicalOrientation(result) : null;
}
