import * as THREE from "three";

export type SmartcubeQuaternionLike = {
  x: number;
  y: number;
  z: number;
  w: number;
};

export type SmartcubeVelocityLike = {
  x: number;
  y: number;
  z: number;
};

// Display home pose. Tweak these two angles to change the default pleasing
// cube angle without changing the gyro pipeline.
export const HOME_ORIENTATION = new THREE.Quaternion().setFromEuler(
  new THREE.Euler((-24 * Math.PI) / 180, (34 * Math.PI) / 180, 0, "XYZ"),
);

export function formatQuaternion(q: THREE.Quaternion | null): string {
  if (!q) return "none";
  return `x=${q.x.toFixed(3)} y=${q.y.toFixed(3)} z=${q.z.toFixed(3)} w=${q.w.toFixed(3)}`;
}

export function formatSmartcubeQuaternion(q: SmartcubeQuaternionLike | null): string {
  if (!q) return "none";
  return `x=${q.x.toFixed(3)} y=${q.y.toFixed(3)} z=${q.z.toFixed(3)} w=${q.w.toFixed(3)}`;
}

export function formatVelocity(v: SmartcubeVelocityLike | null): string {
  if (!v) return "none";
  return `x=${v.x.toFixed(3)} y=${v.y.toFixed(3)} z=${v.z.toFixed(3)}`;
}

export function mapSmartcubeQuaternionToThree(q: SmartcubeQuaternionLike): THREE.Quaternion {
  // Cubedex-proven axis remap. The smartcube library coordinate frame is not
  // Three.js display space, so direct (x,y,z,w) makes the cube feel wrong.
  return new THREE.Quaternion(q.x, q.z, -q.y, q.w).normalize();
}

export function createGyroBasis(rawThreeQuaternion: THREE.Quaternion): THREE.Quaternion {
  return rawThreeQuaternion.clone().conjugate().normalize();
}

export function computeDisplayQuaternion(
  rawThreeQuaternion: THREE.Quaternion,
  gyroBasis: THREE.Quaternion | null,
  homeOrientation: THREE.Quaternion = HOME_ORIENTATION,
): THREE.Quaternion {
  // Multiplication order is intentional:
  // 1. `gyroBasis * raw` makes the latest reset pose become identity.
  // 2. `home * corrected` puts that identity pose at the pleasant app view.
  const corrected = rawThreeQuaternion.clone();
  if (gyroBasis) {
    corrected.premultiply(gyroBasis);
  }
  return homeOrientation.clone().multiply(corrected).normalize();
}

export function rotateVectorByQuaternion(vector: THREE.Vector3, q: THREE.Quaternion): THREE.Vector3 {
  return vector.clone().applyQuaternion(q).normalize();
}
