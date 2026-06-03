// ─────────────────────────────────────────────────────────────────────────────
// GAN 251 (2x2) deterministic algorithm tracker — anchor-corner frame model
//
// WHY THIS EXISTS
// The GAN 251 is a 2x2 with no fixed centres. It reports moves only as U / R / F
// (+ primes). Physical D collapses to U, physical L → R, physical B → F, because
// the hardware describes every turn relative to ONE fixed reference corner — the
// "anchor corner" (the orange/blue/yellow DLB corner, opposite white/green/red).
//
// In the home pose (white top, green front) the anchor sits at Down-Left-Back, so:
//   yellow→U axis, orange→R axis, blue→F axis  (and white→U, red→R, green→F).
//
// The subtlety: a turn that MOVES the anchor corner rotates the cube's whole
// reference frame. After a physical D, the anchor's orange sticker swings to the
// front, so "front" is now on the orange/red (R) axis. A subsequent physical F is
// therefore reported by the hardware as R. This module models that frame drift
// from first principles using integer 3x3 rotation matrices, so it is correct for
// every face, every suffix (', 2) and any number of chained moves — not just the
// hand-checked D-then-F case.
//
// The tracker is DETERMINISTIC, not a hypothesis search: we already told the user
// which move to do, so the frame advances by the EXPECTED move and we only check
// that the reported token is consistent with it.
// ─────────────────────────────────────────────────────────────────────────────

import {
  normalizePhysicalToGan251,
  parseMove,
  type Face,
  type GanMove,
  type Move,
  type Suffix,
} from "./gan251AlgMatcher";

// ─── Tiny integer linear algebra (all rotations are 90° multiples) ───────────

type Vec3 = [number, number, number];
type Mat3 = [Vec3, Vec3, Vec3]; // row-major

const IDENTITY: Mat3 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function matVec(m: Mat3, v: Vec3): Vec3 {
  return [dot(m[0], v), dot(m[1], v), dot(m[2], v)];
}

function matMul(a: Mat3, b: Mat3): Mat3 {
  const out: number[][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += a[i]![k]! * b[k]![j]!;
      out[i]![j] = s;
    }
  }
  return out as Mat3;
}

function transpose(m: Mat3): Mat3 {
  // For an orthonormal rotation matrix the transpose is the inverse.
  return [
    [m[0][0], m[1][0], m[2][0]],
    [m[0][1], m[1][1], m[2][1]],
    [m[0][2], m[1][2], m[2][2]],
  ];
}

// Right-hand 90° rotation matrices about the three positive principal axes.
const R90_X: Mat3 = [
  [1, 0, 0],
  [0, 0, -1],
  [0, 1, 0],
];
const R90_Y: Mat3 = [
  [0, 0, 1],
  [0, 1, 0],
  [-1, 0, 0],
];
const R90_Z: Mat3 = [
  [0, -1, 0],
  [1, 0, 0],
  [0, 0, 1],
];

// Rotation by `k` quarter-turns (right-hand, k may be negative) about a signed
// principal axis vector (e.g. [0,-1,0] = the -y / Down axis).
function rotateAboutAxis(axis: Vec3, quarterTurns: number): Mat3 {
  const idx = axis[0] !== 0 ? 0 : axis[1] !== 0 ? 1 : 2;
  const sign = axis[idx]!; // +1 or -1
  // Rotation by k about the negative axis == rotation by -k about the positive axis.
  let k = ((sign > 0 ? quarterTurns : -quarterTurns) % 4 + 4) % 4;
  const base = idx === 0 ? R90_X : idx === 1 ? R90_Y : R90_Z;
  let acc: Mat3 = IDENTITY;
  for (let i = 0; i < k; i++) acc = matMul(base, acc);
  return acc;
}

// ─── Cube geometry in the user's fixed hand frame ────────────────────────────
// x = right, y = up, z = front (toward the user). Right-handed.

const FACE_NORMAL: Record<Face, Vec3> = {
  U: [0, 1, 0],
  D: [0, -1, 0],
  R: [1, 0, 0],
  L: [-1, 0, 0],
  F: [0, 0, 1],
  B: [0, 0, -1],
};

// Home (solved, white-top green-front) colour → spatial direction, i.e. which
// canonical face lives at a given home-frame normal.
const HOME_NORMAL_TO_FACE: Array<[Vec3, Face]> = [
  [[0, 1, 0], "U"], // white up
  [[0, -1, 0], "D"], // yellow down
  [[1, 0, 0], "R"], // red right
  [[-1, 0, 0], "L"], // orange left
  [[0, 0, 1], "F"], // green front
  [[0, 0, -1], "B"], // blue back
];

function canonicalFaceForHomeNormal(v: Vec3): Face {
  for (const [n, face] of HOME_NORMAL_TO_FACE) {
    if (n[0] === v[0] && n[1] === v[1] && n[2] === v[2]) return face;
  }
  throw new Error(`No canonical face for vector ${v.join(",")}`);
}

// The anchor (DLB orange/blue/yellow) corner's home position octant.
const ANCHOR_HOME: Vec3 = [-1, -1, -1];

// Physical quarter-turn sense for each suffix. An unprimed face turn is clockwise
// as seen from outside that face = -90° (right-hand) about its outward normal.
function quarterTurnsForSuffix(suffix: Suffix): number {
  return suffix === "" ? -1 : suffix === "'" ? 1 : 2;
}

// ─── Orientation = the cube's reference frame, anchored to the DLB corner ─────
// `orientation` (R) maps home-frame directions to current world directions.

export type CubeFrame = {
  orientation: Mat3;
};

export const HOME_FRAME: CubeFrame = { orientation: IDENTITY };

// Which canonical face currently occupies each hand-space slot.
export function handToCanonical(frame: CubeFrame): Record<Face, Face> {
  const inv = transpose(frame.orientation);
  const map = {} as Record<Face, Face>;
  for (const face of Object.keys(FACE_NORMAL) as Face[]) {
    map[face] = canonicalFaceForHomeNormal(matVec(inv, FACE_NORMAL[face]));
  }
  return map;
}

// Is the anchor corner part of the layer turned by this hand face?
function anchorInLayer(frame: CubeFrame, face: Face): boolean {
  const anchorPos = matVec(frame.orientation, ANCHOR_HOME);
  return dot(anchorPos, FACE_NORMAL[face]) > 0;
}

// Advance the frame after the user physically performs `move`. Only moves that
// turn the layer containing the anchor corner rotate the reference frame.
export function advanceFrame(frame: CubeFrame, move: Move): CubeFrame {
  const p = parseMove(move);
  if (!p) return frame;
  if (!anchorInLayer(frame, p.face)) return frame;
  const turn = rotateAboutAxis(FACE_NORMAL[p.face], quarterTurnsForSuffix(p.suffix));
  return { orientation: matMul(turn, frame.orientation) };
}

// What the hardware reports when the user physically performs `move` while the
// cube is in the given frame: re-express the move in canonical space, then
// collapse the canonical face to its U / R / F axis (suffix preserved).
export function reportedMoveForPhysical(frame: CubeFrame, move: Move): GanMove {
  const p = parseMove(move);
  if (!p) throw new Error(`Invalid move: ${move}`);
  const canonicalFace = handToCanonical(frame)[p.face];
  return normalizePhysicalToGan251(`${canonicalFace}${p.suffix}` as Move);
}

// ─── The tracker ─────────────────────────────────────────────────────────────

export type StepStatus = "accepted" | "wrong" | "pending";

export type TrackedStep = {
  index: number;
  expectedPhysical: Move; // what we asked the user to do (hand notation)
  expectedReported: GanMove[]; // what the hardware should emit for it, in THIS frame
  expectedReportedAlternatives: GanMove[][]; // equivalent streams, e.g. X2 or X X
  actualReported: GanMove[]; // what the hardware actually emitted for this step so far
  acceptedAsPhysical: Move | null; // expectedPhysical, once accepted
  status: StepStatus;
  movesAnchor: boolean; // does this move turn the anchor corner → rotate the frame?
};

export type TrackResult = {
  steps: TrackedStep[];
  acceptedPhysical: Move[]; // accepted physical moves in order (drives the cube)
  extraReported: GanMove[]; // reported moves beyond the end of the algorithm
  firstErrorIndex: number | null; // index of the first mismatch, if any
  complete: boolean; // every step accepted
};

function sameReportStream(a: GanMove[], b: GanMove[]): boolean {
  return a.length === b.length && a.every((move, index) => move === b[index]);
}

function uniqueReportStreams(streams: GanMove[][]): GanMove[][] {
  const out: GanMove[][] = [];
  for (const stream of streams) {
    if (!out.some((existing) => sameReportStream(existing, stream))) out.push(stream);
  }
  return out;
}

function splitDoubleMoveReports(frame: CubeFrame, move: Move, suffix: "" | "'"): GanMove[] {
  const p = parseMove(move);
  if (!p) throw new Error(`Invalid move: ${move}`);
  const first = `${p.face}${suffix}` as Move;
  const midFrame = advanceFrame(frame, first);
  const second = `${p.face}${suffix}` as Move;
  return [
    reportedMoveForPhysical(frame, first),
    reportedMoveForPhysical(midFrame, second),
  ];
}

function expectedReportAlternatives(frame: CubeFrame, move: Move): GanMove[][] {
  const p = parseMove(move);
  if (!p) throw new Error(`Invalid move: ${move}`);
  if (p.suffix !== "2") return [[reportedMoveForPhysical(frame, move)]];

  // Real GAN251 move streams commonly expose a double as two quarter-turn events.
  // Keep the one-packet X2 form too, so decoder variants remain compatible.
  return uniqueReportStreams([
    splitDoubleMoveReports(frame, move, ""),
    splitDoubleMoveReports(frame, move, "'"),
    [reportedMoveForPhysical(frame, move)],
  ]);
}

function streamMatchesPrefix(stream: GanMove[], reported: GanMove[], startIndex: number): boolean {
  const available = Math.min(stream.length, reported.length - startIndex);
  for (let i = 0; i < available; i++) {
    if (stream[i] !== reported[startIndex + i]) return false;
  }
  return true;
}

function matchExpectedReports(
  alternatives: GanMove[][],
  reported: GanMove[],
  startIndex: number,
): { status: StepStatus; actualReported: GanMove[]; consumed: number } {
  for (const stream of alternatives) {
    if (reported.length - startIndex < stream.length) continue;
    if (sameReportStream(stream, reported.slice(startIndex, startIndex + stream.length))) {
      return { status: "accepted", actualReported: stream, consumed: stream.length };
    }
  }

  const remaining = Math.max(0, reported.length - startIndex);
  const pendingStream = alternatives.find((stream) => remaining < stream.length && streamMatchesPrefix(stream, reported, startIndex));
  if (pendingStream) {
    return {
      status: "pending",
      actualReported: reported.slice(startIndex),
      consumed: 0,
    };
  }

  if (remaining > 0) {
    return {
      status: "wrong",
      actualReported: reported.slice(startIndex, startIndex + 1),
      consumed: 1,
    };
  }

  return { status: "pending", actualReported: [], consumed: 0 };
}

// Run the deterministic tracker over an expected algorithm and the live stream of
// reported hardware moves. The reference frame starts at HOME (white-top green-front)
// and advances by each ACCEPTED expected move.
export function trackAlg(expectedMoves: Move[], reported: GanMove[]): TrackResult {
  const steps: TrackedStep[] = [];
  const acceptedPhysical: Move[] = [];
  let frame = HOME_FRAME;
  let firstErrorIndex: number | null = null;
  let reportedIndex = 0;
  let stopped = false;

  for (let i = 0; i < expectedMoves.length; i++) {
    const expectedPhysical = expectedMoves[i]!;
    // "Cube should say" always assumes the earlier steps were done correctly, so
    // the frame is advanced by the EXPECTED move every iteration (below), matching
    // the perfect-run prediction — not gated on acceptance.
    const expectedReportedAlternatives = expectedReportAlternatives(frame, expectedPhysical);
    const expectedReported = expectedReportedAlternatives[0]!;

    let status: StepStatus = "pending";
    let actualReported: GanMove[] = [];
    let acceptedAsPhysical: Move | null = null;

    if (!stopped) {
      const match = matchExpectedReports(expectedReportedAlternatives, reported, reportedIndex);
      status = match.status;
      actualReported = match.actualReported;
      if (match.status === "accepted") {
        acceptedAsPhysical = expectedPhysical;
        acceptedPhysical.push(expectedPhysical);
        reportedIndex += match.consumed;
      } else if (match.status === "wrong") {
        firstErrorIndex = i;
        reportedIndex += match.consumed;
        stopped = true; // user diverged — stop consuming the live stream
      }
    }

    // advanceFrame returns the SAME frame object when the move doesn't turn the
    // anchor corner's layer, so an identity change flags an anchor-moving move.
    const nextFrame = advanceFrame(frame, expectedPhysical);
    const movesAnchor = nextFrame !== frame;

    steps.push({
      index: i,
      expectedPhysical,
      expectedReported,
      expectedReportedAlternatives,
      actualReported,
      acceptedAsPhysical,
      status,
      movesAnchor,
    });
    frame = nextFrame;
  }

  const complete = firstErrorIndex === null && acceptedPhysical.length === expectedMoves.length;
  const extraReported = complete ? reported.slice(reportedIndex) : [];

  return {
    steps,
    acceptedPhysical,
    extraReported: stopped ? [] : extraReported,
    firstErrorIndex,
    complete,
  };
}

// Convenience: the full reported stream a correct run would produce, with frame
// drift applied. Useful for the "if done correctly the cube will report:" hint.
export function simulateReportsWithFrameDrift(expectedMoves: Move[]): GanMove[] {
  let frame = HOME_FRAME;
  const out: GanMove[] = [];
  for (const move of expectedMoves) {
    out.push(...expectedReportAlternatives(frame, move)[0]!);
    frame = advanceFrame(frame, move);
  }
  return out;
}
