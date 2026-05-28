// ─────────────────────────────────────────────────────────────────────────────
// GAN 251 UI / GAN22-style 2x2 Algorithm Matcher — Hypothesis Branching Engine
//
// The GAN 251 hardware reports moves only as U / R / F (plus primes and doubles).
// Physical D collapses to U, physical L collapses to R, physical B collapses to F.
// Confirmed from hardware capture (May 2026):
//   byte 0x02 = U axis  (physical U or D)
//   byte 0x20 = R axis  (physical R or L)
//   byte 0x08 = F axis  (physical F or B)
//
// A reported "U" is EVIDENCE, not fact. It means the user turned either U or D.
// This matcher keeps all compatible physical interpretations alive as hypotheses,
// pruning only those that are inconsistent with the expected algorithm.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Core types ────────────────────────────────────────────────────────────

export type Face = "U" | "D" | "R" | "L" | "F" | "B";
export type GanFace = "U" | "R" | "F";
export type Suffix = "" | "'" | "2";
export type Move = `${Face}${Suffix}`;
export type GanMove = `${GanFace}${Suffix}`;

export type MatchQuality = "exact" | "axis-equivalent";

export type ValidationStatus =
  | "exact"
  | "ambiguous"
  | "axis-equivalent"
  | "wrong"
  | "incomplete";

// Orientation frame: maps user hand-space face names to the cube's canonical face names.
// Initially identity. May shift after certain physical moves if the cube's internal
// reference frame drifts (experimental — not yet confirmed on real hardware).
export type OrientationFrame = {
  handToCanonical: Record<Face, Face>;
};

export const IDENTITY_FRAME: OrientationFrame = {
  handToCanonical: { U: "U", D: "D", R: "R", L: "L", F: "F", B: "B" },
};

export type Hypothesis = {
  stepIndex: number;
  physicalMoves: Move[];       // physical (hand-space) moves chosen so far
  qualities: MatchQuality[];   // match quality per step vs expected alg
  score: number;               // exact=+3, axis-equivalent=+1
  notes: string[];
  frame: OrientationFrame;     // orientation frame accumulated so far
};

export type FrameTransitionMode = "none" | "experimental";

export type FrameTransitionOptions = {
  mode: FrameTransitionMode;
  // Called after each physical move to produce the updated frame.
  // Default (mode "none"): identity, frame never changes.
  transitionFn?: (frame: OrientationFrame, physicalMove: Move) => OrientationFrame;
};

export type MatchOptions = {
  frameTransition?: FrameTransitionOptions;
  maxHypotheses?: number;
};

export type MatchResult = {
  status: ValidationStatus;
  bestHypothesis: Hypothesis | null;
  activeHypotheses: Hypothesis[];
  completeHypotheses: Hypothesis[];
  debug: {
    expectedMoves: Move[];
    reportedMoves: GanMove[];
    activeHypothesisCount: number;
    completeHypothesisCount: number;
    exactCompleteCount: number;
    axisEquivalentCompleteCount: number;
  };
};

// ─── Constants ─────────────────────────────────────────────────────────────

const ALL_FACES: Face[] = ["U", "D", "R", "L", "F", "B"];
const ALL_SUFFIXES: Suffix[] = ["", "'", "2"];

// Physical face → GAN-reported axis face. D/L/B collapse to their opposite.
// Confirmed from real GAN22 hardware captures (May 2026 session).
const FACE_TO_GAN_AXIS: Record<Face, GanFace> = {
  U: "U", D: "U",
  R: "R", L: "R",
  F: "F", B: "F",
};

// ─── Parse utilities ────────────────────────────────────────────────────────

export function parseMove(move: string): { face: Face; suffix: Suffix } | null {
  if (!move || move.length < 1) return null;
  const face = move[0] as Face;
  const suffix = move.slice(1) as Suffix;
  if (!(ALL_FACES as string[]).includes(face)) return null;
  if (!(ALL_SUFFIXES as string[]).includes(suffix)) return null;
  return { face, suffix };
}

function parseGanMove(move: string): GanMove | null {
  if (!move || move.length < 1) return null;
  const face = move[0];
  const suffix = move.slice(1) as Suffix;
  if (!face || !(["U", "R", "F"] as string[]).includes(face)) return null;
  if (!(ALL_SUFFIXES as string[]).includes(suffix)) return null;
  return `${face as GanFace}${suffix}` as GanMove;
}

export function parseAlg(alg: string): Move[] | null {
  const tokens = alg.trim().split(/\s+/).filter(t => t.length > 0);
  const moves: Move[] = [];
  for (const token of tokens) {
    const p = parseMove(token);
    if (!p) return null;
    moves.push(`${p.face}${p.suffix}` as Move);
  }
  return moves;
}

export function parseGanAlg(moves: string[]): GanMove[] | null {
  const result: GanMove[] = [];
  for (const m of moves) {
    const p = parseGanMove(m);
    if (!p) return null;
    result.push(p);
  }
  return result;
}

// ─── Normalization ──────────────────────────────────────────────────────────

// Collapse a physical/canonical face move to what the GAN hardware reports.
// U or D → "U", R or L → "R", F or B → "F". Suffix is preserved.
export function normalizePhysicalToGan251(move: Move): GanMove {
  const p = parseMove(move);
  if (!p) throw new Error(`Invalid move: ${move}`);
  return `${FACE_TO_GAN_AXIS[p.face]}${p.suffix}` as GanMove;
}

// ─── Candidate generation ───────────────────────────────────────────────────

// Naive (identity-frame) candidates for a reported GAN move.
// "U" → ["U", "D"],  "R" → ["R", "L"],  "F" → ["F", "B"]  (suffix preserved)
// Use computeFrameAwareCandidates() inside the hypothesis loop when frames may differ.
export function candidatesFromReportedMove(reportedMove: GanMove): Move[] {
  const p = parseMove(reportedMove);
  if (!p) return [];
  const pairs: Record<GanFace, [Face, Face]> = {
    U: ["U", "D"],
    R: ["R", "L"],
    F: ["F", "B"],
  };
  const [a, b] = pairs[p.face as GanFace];
  return [`${a}${p.suffix}` as Move, `${b}${p.suffix}` as Move];
}

// Frame-aware candidate generation.
// Finds every hand-space face that, when mapped through the frame and then collapsed
// to a GAN axis, matches the reported GAN axis. This handles non-identity frames
// where e.g. hand-R maps to canonical-F, so reported "F" implies physical R.
function computeFrameAwareCandidates(reportedMove: GanMove, frame: OrientationFrame): Move[] {
  const p = parseMove(reportedMove);
  if (!p) return [];
  const ganFace = p.face as GanFace;
  const suffix = p.suffix;
  return ALL_FACES
    .filter(hf => FACE_TO_GAN_AXIS[frame.handToCanonical[hf]] === ganFace)
    .map(hf => `${hf}${suffix}` as Move);
}

// ─── Frame operations ───────────────────────────────────────────────────────

// Map a hand-space move through the orientation frame to canonical space.
export function moveThroughFrame(move: Move, frame: OrientationFrame): Move {
  const p = parseMove(move);
  if (!p) throw new Error(`Invalid move: ${move}`);
  return `${frame.handToCanonical[p.face]}${p.suffix}` as Move;
}

// What would the GAN hardware report if the user physically did `candidate`
// given the current orientation frame?
export function expectedReportedMoveForCandidate(candidate: Move, frame: OrientationFrame): GanMove {
  return normalizePhysicalToGan251(moveThroughFrame(candidate, frame));
}

// ─── Comparison ─────────────────────────────────────────────────────────────

// Compare a candidate physical move to the expected physical move (both in hand space).
// Returns:
//   "exact"            — candidate === expected
//   "axis-equivalent"  — same GAN axis and same suffix (e.g. R vs L, D vs U)
//   null               — axes differ; this branch is incompatible with expected alg
export function compareCandidateToExpected(candidate: Move, expected: Move): MatchQuality | null {
  if (candidate === expected) return "exact";
  const c = parseMove(candidate);
  const e = parseMove(expected);
  if (!c || !e) return null;
  if (c.suffix !== e.suffix) return null;
  if (FACE_TO_GAN_AXIS[c.face] === FACE_TO_GAN_AXIS[e.face]) return "axis-equivalent";
  return null;
}

// ─── Frame transitions ──────────────────────────────────────────────────────

export function updateFrameAfterPhysicalMove(
  frame: OrientationFrame,
  physicalMove: Move,
  options: FrameTransitionOptions = { mode: "none" },
): OrientationFrame {
  if (options.mode === "none" || !options.transitionFn) return frame;
  return options.transitionFn(frame, physicalMove);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPERIMENTAL DEMO TRANSITION FUNCTION
//
// ⚠️  NOT CONFIRMED GAN HARDWARE BEHAVIOR ⚠️
// This function exists only to prove the architecture supports hidden-frame
// transitions. The actual frame shifts (if any) must be derived empirically
// from real cube captures and replace this function.
//
// Demo model: after certain physical moves, the cube's canonical reference
// frame rotates around the corresponding axis (y'/x/z'). This causes subsequent
// hand-space moves to map to different canonical faces.
//
//   After physical D / D' / D2  →  canonical rotates y'  (R→F, F→L, L→B, B→R; U/D stay)
//   After physical L / L' / L2  →  canonical rotates x   (U→F, F→D, D→B, B→U; R/L stay)
//   After physical B / B' / B2  →  canonical rotates z'  (U→R, R→D, D→L, L→U; F/B stay)
//
// All other physical moves leave the frame unchanged in this demo.
// ─────────────────────────────────────────────────────────────────────────────

type CanonicalRotation = "y-prime" | "x-turn" | "z-prime";

const CANONICAL_ROTATION_MAP: Record<CanonicalRotation, Partial<Record<Face, Face>>> = {
  "y-prime": { R: "F", F: "L", L: "B", B: "R" },
  "x-turn":  { U: "F", F: "D", D: "B", B: "U" },
  "z-prime": { U: "R", R: "D", D: "L", L: "U" },
};

function applyCanonicalRotation(frame: OrientationFrame, rotation: CanonicalRotation): OrientationFrame {
  const rot = CANONICAL_ROTATION_MAP[rotation];
  const newMapping = { ...frame.handToCanonical };
  for (const hf of ALL_FACES) {
    const canon = frame.handToCanonical[hf];
    newMapping[hf] = rot[canon] ?? canon;
  }
  return { handToCanonical: newMapping };
}

export function experimentalDemoTransitionFn(
  frame: OrientationFrame,
  physicalMove: Move,
): OrientationFrame {
  const p = parseMove(physicalMove);
  if (!p) return frame;
  // Only D/L/B trigger frame shifts in this demo model
  if (p.face === "D") return applyCanonicalRotation(frame, "y-prime");
  if (p.face === "L") return applyCanonicalRotation(frame, "x-turn");
  if (p.face === "B") return applyCanonicalRotation(frame, "z-prime");
  return frame;
}

// ─── Core hypothesis engine ─────────────────────────────────────────────────

export function advanceHypotheses(
  hypotheses: Hypothesis[],
  reportedMove: GanMove,
  expectedMove: Move,
  frameTransition: FrameTransitionOptions,
): Hypothesis[] {
  const next: Hypothesis[] = [];
  for (const hyp of hypotheses) {
    const candidates = computeFrameAwareCandidates(reportedMove, hyp.frame);
    for (const candidate of candidates) {
      const quality = compareCandidateToExpected(candidate, expectedMove);
      if (quality === null) continue; // axes don't match — prune this branch
      const newFrame = updateFrameAfterPhysicalMove(hyp.frame, candidate, frameTransition);
      next.push({
        stepIndex: hyp.stepIndex + 1,
        physicalMoves: [...hyp.physicalMoves, candidate],
        qualities: [...hyp.qualities, quality],
        score: hyp.score + (quality === "exact" ? 3 : 1),
        notes: hyp.notes,
        frame: newFrame,
      });
    }
  }
  return next;
}

export function pruneHypotheses(hypotheses: Hypothesis[], max: number): Hypothesis[] {
  if (hypotheses.length <= max) return hypotheses;
  return [...hypotheses].sort((a, b) => b.score - a.score).slice(0, max);
}

function determineStatus(completeHypotheses: Hypothesis[]): ValidationStatus {
  if (completeHypotheses.length === 0) return "wrong";
  const hasAllExact = completeHypotheses.some(h => h.qualities.every(q => q === "exact"));
  if (!hasAllExact) return "axis-equivalent";
  // "exact" only when every surviving hypothesis is also all-exact (no axis-equiv alternatives)
  const allAreExact = completeHypotheses.every(h => h.qualities.every(q => q === "exact"));
  return allAreExact ? "exact" : "ambiguous";
}

function buildMatchResult(
  status: ValidationStatus,
  active: Hypothesis[],
  complete: Hypothesis[],
  expectedMoves: Move[],
  reportedMoves: GanMove[],
): MatchResult {
  const sortedComplete = [...complete].sort((a, b) => b.score - a.score);
  const sortedActive = [...active].sort((a, b) => b.score - a.score);
  return {
    status,
    bestHypothesis: sortedComplete[0] ?? sortedActive[0] ?? null,
    activeHypotheses: sortedActive,
    completeHypotheses: sortedComplete,
    debug: {
      expectedMoves,
      reportedMoves,
      activeHypothesisCount: active.length,
      completeHypothesisCount: complete.length,
      exactCompleteCount: complete.filter(h => h.qualities.every(q => q === "exact")).length,
      axisEquivalentCompleteCount: complete.filter(h => h.qualities.some(q => q === "axis-equivalent")).length,
    },
  };
}

// ─── Main entry point ───────────────────────────────────────────────────────

export function matchGan251ReportedStream(
  expectedAlg: string,
  reportedMoves: GanMove[],
  options: MatchOptions = {},
): MatchResult {
  const maxHypotheses = options.maxHypotheses ?? 50;
  const frameTransition = options.frameTransition ?? { mode: "none" };
  const expectedMoves = parseAlg(expectedAlg);

  if (!expectedMoves) {
    return buildMatchResult("wrong", [], [], [], reportedMoves);
  }

  // Empty alg edge cases
  if (expectedMoves.length === 0) {
    if (reportedMoves.length === 0) {
      const empty: Hypothesis = { stepIndex: 0, physicalMoves: [], qualities: [], score: 0, notes: [], frame: IDENTITY_FRAME };
      return buildMatchResult("exact", [], [empty], [], []);
    }
    return buildMatchResult("wrong", [], [], [], reportedMoves);
  }

  // More reported moves than expected → wrong (extra moves)
  if (reportedMoves.length > expectedMoves.length) {
    return buildMatchResult("wrong", [], [], expectedMoves, reportedMoves);
  }

  // No reported moves yet → incomplete
  if (reportedMoves.length === 0) {
    const seed: Hypothesis = { stepIndex: 0, physicalMoves: [], qualities: [], score: 0, notes: [], frame: IDENTITY_FRAME };
    return buildMatchResult("incomplete", [seed], [], expectedMoves, reportedMoves);
  }

  let active: Hypothesis[] = [{
    stepIndex: 0, physicalMoves: [], qualities: [], score: 0, notes: [], frame: IDENTITY_FRAME,
  }];
  let complete: Hypothesis[] = [];

  for (let i = 0; i < reportedMoves.length; i++) {
    const reported = reportedMoves[i]!;
    const expected = expectedMoves[i]!;
    const next = advanceHypotheses(active, reported, expected, frameTransition);

    if (next.length === 0) {
      return buildMatchResult("wrong", [], [], expectedMoves, reportedMoves);
    }

    if (i === expectedMoves.length - 1) {
      // Final expected step consumed — these hypotheses are complete
      complete = pruneHypotheses(next, maxHypotheses);
      active = [];
    } else {
      active = pruneHypotheses(next, maxHypotheses);
    }
  }

  // Fewer reported moves than expected → incomplete
  if (reportedMoves.length < expectedMoves.length) {
    return buildMatchResult("incomplete", active, complete, expectedMoves, reportedMoves);
  }

  return buildMatchResult(determineStatus(complete), active, complete, expectedMoves, reportedMoves);
}

// ─── Simulation helper ──────────────────────────────────────────────────────

// Produce the GAN-reported move stream that the hardware would emit for a physical alg.
// With mode "none" (default): D→U, L→R, B→F, same direction.
// With mode "experimental": frame shifts accumulate between moves.
export function simulateGan251ReportsFromPhysicalAlg(
  physicalAlg: string,
  options: MatchOptions = {},
): GanMove[] {
  const moves = parseAlg(physicalAlg);
  if (!moves) return [];
  const frameTransition = options.frameTransition ?? { mode: "none" };
  let frame = IDENTITY_FRAME;
  const result: GanMove[] = [];
  for (const move of moves) {
    result.push(expectedReportedMoveForCandidate(move, frame));
    frame = updateFrameAfterPhysicalMove(frame, move, frameTransition);
  }
  return result;
}
