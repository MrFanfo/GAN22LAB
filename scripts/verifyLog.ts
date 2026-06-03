// Validate the anchor-corner frame model against a REAL hardware capture.
// User physically performed:  (L D' L F2 L' D L') x2   then   (R2 U' B2 U2 R2 U' R2) x2
// The log below is the cube's reported move stream (oldest-first), steps 164..203.

import { parseAlg, type GanMove, type Move } from "../src/lib/gan251Moves";
import { simulateReportsWithFrameDrift } from "../src/lib/algTracker";

// ── Reported stream from anchormovinglog.json, ordered by cube step 164→203 ──
// (step 181 is the second move encoded inside the packet that reports step 180)
const reported: GanMove[] = [
  "R", "F'", "R", "F'", "F'", "R'", "U", "F'",            // 164-171
  "F", "U'", "R", "F'", "F'", "R'", "F", "R'",            // 172-179
  "R", "R", "U'", "F", "F", "U'", "U'", "R'", "R'", "U'", // 180-189
  "F", "F", "F", "F", "U'", "F", "F", "U'", "U'", "R'",   // 190-199
  "R'", "U'", "R", "R",                                   // 200-203
];

// ── Physical algorithms the user performed ──
const algA = "L D' L F2 L' D L'";
const algB = "R2 U' B2 U2 R2 U' R2";

// Expand doubles (X2) into two quarter turns, since the hardware reports quarter
// turns only. Direction is unknown to us; CW is a placeholder — a double only
// affects the reported PRIME, never the axis or the net frame drift.
function expandDoubles(moves: Move[]): Move[] {
  const out: Move[] = [];
  for (const m of moves) {
    if (m.endsWith("2")) {
      const face = m[0] as Move;
      out.push(face, face);
    } else {
      out.push(m);
    }
  }
  return out;
}

const physical = expandDoubles([
  ...parseAlg(algA)!, ...parseAlg(algA)!,
  ...parseAlg(algB)!, ...parseAlg(algB)!,
]);

// Track which predicted positions came from a double (prime is ambiguous there).
const fromDouble: boolean[] = [];
for (const m of [...parseAlg(algA)!, ...parseAlg(algA)!, ...parseAlg(algB)!, ...parseAlg(algB)!]) {
  if (m.endsWith("2")) { fromDouble.push(true, true); } else { fromDouble.push(false); }
}

const predicted = simulateReportsWithFrameDrift(physical);

console.log(`physical quarter-turns: ${physical.length}`);
console.log(`reported moves:         ${reported.length}`);
console.log(`predicted moves:        ${predicted.length}\n`);

const face = (m: string) => m[0];
let axisMismatch = 0;
let exactMismatch = 0;
let doublePrimeDiff = 0;

console.log("idx  physical  predicted  reported   axis  exact");
for (let i = 0; i < Math.max(predicted.length, reported.length); i++) {
  const p = predicted[i] ?? "—";
  const r = reported[i] ?? "—";
  const axisOk = face(p) === face(r);
  const exactOk = p === r;
  if (!axisOk) axisMismatch++;
  if (!exactOk) {
    if (axisOk && fromDouble[i]) doublePrimeDiff++;
    else exactMismatch++;
  }
  const phys = physical[i] ?? "—";
  const flag = !axisOk ? "  ✗AXIS"
    : !exactOk ? (fromDouble[i] ? "  ~dbl-dir" : "  ✗PRIME")
      : "  ✓";
  console.log(
    `${String(i).padStart(3)}  ${phys.padEnd(8)}  ${p.padEnd(9)}  ${r.padEnd(9)}  ${axisOk ? "ok " : "NO "}  ${exactOk ? "ok" : "no"}${flag}`,
  );
}

console.log(`\naxis mismatches:            ${axisMismatch}`);
console.log(`prime-only diffs on doubles: ${doublePrimeDiff}  (expected — we don't know which way a 180 was turned)`);
console.log(`unexplained exact mismatches: ${exactMismatch}`);
console.log(
  axisMismatch === 0 && exactMismatch === 0
    ? "\n✅ MODEL MATCHES HARDWARE (every axis correct; only double-turn directions differ)"
    : "\n❌ MODEL DIVERGES FROM HARDWARE — see ✗ rows",
);
