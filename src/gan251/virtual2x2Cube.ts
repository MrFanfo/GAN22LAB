import type { Gan251Face, Gan251MoveDirection } from "./types";

const FACE_ORDER: Gan251Face[] = ["U", "R", "F", "D", "L", "B"];
const SOLVED_CP = [0, 1, 2, 3, 4, 5, 6, 7] as const;
const SOLVED_CO = [0, 0, 0, 0, 0, 0, 0, 0] as const;

type CornerName = "URF" | "UFL" | "ULB" | "UBR" | "DFR" | "DLF" | "DBL" | "DRB";

const CORNER_NAMES: CornerName[] = ["URF", "UFL", "ULB", "UBR", "DFR", "DLF", "DBL", "DRB"];

const CORNER_COLORS: Record<number, [Gan251Face, Gan251Face, Gan251Face]> = {
  0: ["U", "R", "F"],
  1: ["U", "F", "L"],
  2: ["U", "L", "B"],
  3: ["U", "B", "R"],
  4: ["D", "F", "R"],
  5: ["D", "L", "F"],
  6: ["D", "B", "L"],
  7: ["D", "R", "B"],
};

type StickerRef = { face: Gan251Face; index: number };

// 24-sticker layout:
// face order U,R,F,D,L,B; each face is [top-left, top-right, bottom-left, bottom-right]
// as viewed from outside that face. The corner order is the common cubie-cube order:
// URF,UFL,ULB,UBR,DFR,DLF,DBL,DRB. Orientation handling below assumes orientation 0
// means these stickers are in solved order; orientation 1/2 cycles the cubie stickers.
const CORNER_STICKERS: Record<number, [StickerRef, StickerRef, StickerRef]> = {
  0: [{ face: "U", index: 3 }, { face: "R", index: 2 }, { face: "F", index: 1 }],
  1: [{ face: "U", index: 2 }, { face: "F", index: 0 }, { face: "L", index: 1 }],
  2: [{ face: "U", index: 0 }, { face: "L", index: 0 }, { face: "B", index: 1 }],
  3: [{ face: "U", index: 1 }, { face: "B", index: 0 }, { face: "R", index: 1 }],
  4: [{ face: "D", index: 1 }, { face: "F", index: 3 }, { face: "R", index: 0 }],
  5: [{ face: "D", index: 0 }, { face: "L", index: 3 }, { face: "F", index: 2 }],
  6: [{ face: "D", index: 2 }, { face: "B", index: 3 }, { face: "L", index: 2 }],
  7: [{ face: "D", index: 3 }, { face: "R", index: 3 }, { face: "B", index: 2 }],
};

type MoveDef = {
  cycle: [number, number, number, number];
  coDelta: [number, number, number, number];
};

// Quarter-turn tables are intentionally isolated from BLE decoding. Direction
// refinement can reuse these same tables by applying a face 1, 2, or 3 times.
const MOVE_DEFS: Record<Gan251Face, MoveDef> = {
  U: { cycle: [0, 1, 2, 3], coDelta: [0, 0, 0, 0] },
  R: { cycle: [0, 3, 7, 4], coDelta: [2, 1, 2, 1] },
  F: { cycle: [0, 4, 5, 1], coDelta: [1, 2, 1, 2] },
  D: { cycle: [4, 7, 6, 5], coDelta: [0, 0, 0, 0] },
  L: { cycle: [1, 5, 6, 2], coDelta: [1, 2, 1, 2] },
  B: { cycle: [2, 6, 7, 3], coDelta: [2, 1, 2, 1] },
};

function assertCornerState(cp: number[], co: number[]): void {
  if (cp.length !== 8 || co.length !== 8) {
    throw new Error("2x2 corner state must contain exactly 8 corners");
  }
  const sorted = [...cp].sort((a, b) => a - b);
  if (!sorted.every((value, index) => value === index)) {
    throw new Error(`Invalid corner permutation: ${cp.join(",")}`);
  }
  if (!co.every((value) => Number.isInteger(value) && value >= 0 && value <= 2)) {
    throw new Error(`Invalid corner orientation: ${co.join(",")}`);
  }
}

function turnsForDirection(direction: Gan251MoveDirection): number {
  switch (direction) {
    case "clockwise": return 1;
    case "double": return 2;
    case "counterclockwise": return 3;
    case "unknown": return 0;
  }
}

export class Virtual2x2Cube {
  private cornerPermutation: number[];
  private cornerOrientation: number[];

  constructor(
    cornerPermutation: number[] = [...SOLVED_CP],
    cornerOrientation: number[] = [...SOLVED_CO],
  ) {
    assertCornerState(cornerPermutation, cornerOrientation);
    this.cornerPermutation = [...cornerPermutation];
    this.cornerOrientation = [...cornerOrientation];
  }

  static solved(): Virtual2x2Cube {
    return new Virtual2x2Cube();
  }

  clone(): Virtual2x2Cube {
    return new Virtual2x2Cube(this.cornerPermutation, this.cornerOrientation);
  }

  reset(): void {
    this.cornerPermutation = [...SOLVED_CP];
    this.cornerOrientation = [...SOLVED_CO];
  }

  loadCorners(cornerPermutation: number[], cornerOrientation: number[]): void {
    assertCornerState(cornerPermutation, cornerOrientation);
    this.cornerPermutation = [...cornerPermutation];
    this.cornerOrientation = [...cornerOrientation];
  }

  applyMove(face: Gan251Face, direction: Gan251MoveDirection = "clockwise"): void {
    const turns = turnsForDirection(direction);
    for (let i = 0; i < turns; i++) {
      this.applyClockwiseFace(face);
    }
  }

  getCornerPermutation(): number[] {
    return [...this.cornerPermutation];
  }

  getCornerOrientation(): number[] {
    return [...this.cornerOrientation];
  }

  toFaceletsByFace(): Record<Gan251Face, string[]> {
    const faces = Object.fromEntries(FACE_ORDER.map((face) => [face, [face, face, face, face]])) as Record<Gan251Face, string[]>;

    for (let position = 0; position < 8; position++) {
      const cubie = this.cornerPermutation[position]!;
      const orientation = this.cornerOrientation[position]! % 3;
      const colors = CORNER_COLORS[cubie]!;
      const stickers = CORNER_STICKERS[position]!;
      for (let stickerIndex = 0; stickerIndex < 3; stickerIndex++) {
        const color = colors[(stickerIndex + 3 - orientation) % 3]!;
        const target = stickers[stickerIndex]!;
        faces[target.face][target.index] = color;
      }
    }

    return faces;
  }

  toFacelets24(): string {
    const byFace = this.toFaceletsByFace();
    return FACE_ORDER.map((face) => byFace[face].join("")).join("");
  }

  toHumanReadableState(): string {
    return CORNER_NAMES.map((name, index) => {
      const cubieName = CORNER_NAMES[this.cornerPermutation[index]!]!;
      const orientation = this.cornerOrientation[index]!;
      return `${name}:${cubieName}/${orientation}`;
    }).join(" ");
  }

  private applyClockwiseFace(face: Gan251Face): void {
    const def = MOVE_DEFS[face];
    const oldCp = [...this.cornerPermutation];
    const oldCo = [...this.cornerOrientation];
    const [a, b, c, d] = def.cycle;

    this.cornerPermutation[a] = oldCp[d]!;
    this.cornerPermutation[b] = oldCp[a]!;
    this.cornerPermutation[c] = oldCp[b]!;
    this.cornerPermutation[d] = oldCp[c]!;

    this.cornerOrientation[a] = (oldCo[d]! + def.coDelta[0]) % 3;
    this.cornerOrientation[b] = (oldCo[a]! + def.coDelta[1]) % 3;
    this.cornerOrientation[c] = (oldCo[b]! + def.coDelta[2]) % 3;
    this.cornerOrientation[d] = (oldCo[c]! + def.coDelta[3]) % 3;
  }
}
