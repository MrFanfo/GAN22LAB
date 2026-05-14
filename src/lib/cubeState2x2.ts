export const SOLVED_2X2_FACELETS = "UUUURRRRFFFFDDDDLLLLBBBB";

export function normalizeFacelets24(facelets: string | null | undefined): string {
  if (!facelets) return SOLVED_2X2_FACELETS;
  const clean = facelets.toUpperCase().replace(/[^URFDLB]/g, "");
  return (clean + SOLVED_2X2_FACELETS).slice(0, 24);
}

export function splitFacelets24(facelets24: string): Record<"U" | "R" | "F" | "D" | "L" | "B", string[]> {
  const padded = normalizeFacelets24(facelets24);
  return {
    U: padded.slice(0, 4).split(""),
    R: padded.slice(4, 8).split(""),
    F: padded.slice(8, 12).split(""),
    D: padded.slice(12, 16).split(""),
    L: padded.slice(16, 20).split(""),
    B: padded.slice(20, 24).split(""),
  };
}
