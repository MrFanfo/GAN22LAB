// Shared GAN251 move notation helpers for the deterministic tracker.

export type Face = "U" | "D" | "R" | "L" | "F" | "B";
export type GanFace = "U" | "R" | "F";
export type Suffix = "" | "'" | "2";
export type Move = `${Face}${Suffix}`;
export type GanMove = `${GanFace}${Suffix}`;

const ALL_FACES: Face[] = ["U", "D", "R", "L", "F", "B"];
const ALL_SUFFIXES: Suffix[] = ["", "'", "2"];

// Physical/canonical faces collapse to the three GAN251 reported axes.
const FACE_TO_GAN_AXIS: Record<Face, GanFace> = {
  U: "U",
  D: "U",
  R: "R",
  L: "R",
  F: "F",
  B: "F",
};

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
  const face = move[0] as GanFace;
  const suffix = move.slice(1) as Suffix;
  if (!(["U", "R", "F"] as string[]).includes(face)) return null;
  if (!(ALL_SUFFIXES as string[]).includes(suffix)) return null;
  return `${face}${suffix}` as GanMove;
}

export function parseAlg(alg: string): Move[] | null {
  const tokens = alg.trim().split(/\s+/).filter((token) => token.length > 0);
  const moves: Move[] = [];
  for (const token of tokens) {
    const parsed = parseMove(token);
    if (!parsed) return null;
    moves.push(`${parsed.face}${parsed.suffix}` as Move);
  }
  return moves;
}

export function parseGanAlg(moves: string[]): GanMove[] | null {
  const result: GanMove[] = [];
  for (const move of moves) {
    const parsed = parseGanMove(move);
    if (!parsed) return null;
    result.push(parsed);
  }
  return result;
}

export function normalizePhysicalToGan251(move: Move): GanMove {
  const parsed = parseMove(move);
  if (!parsed) throw new Error(`Invalid move: ${move}`);
  return `${FACE_TO_GAN_AXIS[parsed.face]}${parsed.suffix}` as GanMove;
}
