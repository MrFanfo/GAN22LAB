// Regression self-test for the deterministic anchor-corner alg tracker.
// Run with:  node_modules/.bin/esbuild scripts/algTracker.selftest.ts --bundle \
//              --platform=node --format=esm --outfile=/tmp/algtest.mjs && node /tmp/algtest.mjs
import { parseAlg } from "../src/lib/gan251AlgMatcher";
import {
  simulateReportsWithFrameDrift,
  trackAlg,
  handToCanonical,
  HOME_FRAME,
  advanceFrame,
} from "../src/lib/algTracker";

let failures = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}: got ${g}${ok ? "" : `  want ${w}`}`);
}

const sim = (alg: string) => simulateReportsWithFrameDrift(parseAlg(alg)!);

// The headline example: physical D then F -> hardware reports U then R.
eq("D F -> reports", sim("D F"), ["U", "R"]);

// No anchor movement: U/R/F report straight through, no drift.
eq("U R F -> reports", sim("U R F"), ["U", "R", "F"]);

// Single anchor-moving moves in the home frame.
eq("D -> U", sim("D"), ["U"]);
eq("L -> R", sim("L"), ["R"]);
eq("B -> F", sim("B"), ["F"]);
eq("D' -> U'", sim("D'"), ["U'"]);
eq("D2 -> U2", sim("D2"), ["U2"]);

// After D the anchor's orange sticker points front, so hand-F is on the R axis.
// The F turn rotates the anchor about that same front axis, keeping orange front,
// so the second F still reports R.
eq("D F F -> reports", sim("D F F"), ["U", "R", "R"]);

// A drift that changes axis: after D, hand-R reads canonical F (green to the
// right), so a physical R is reported as F.
eq("D R -> reports", sim("D R"), ["U", "F"]);

// A move that undoes itself returns the frame to home.
eq(
  "D D' frame == home",
  advanceFrame(advanceFrame(HOME_FRAME, "D"), "D'").orientation,
  HOME_FRAME.orientation,
);

// handToCanonical after D: hand-F should read canonical L (orange to the front).
eq("after D, hand->canon", handToCanonical(advanceFrame(HOME_FRAME, "D")), {
  U: "U",
  D: "D",
  R: "F",
  L: "B",
  F: "L",
  B: "R",
});

// Tracker acceptance: doing D (reported U) then F (reported R) accepts both as D,F.
const r1 = trackAlg(parseAlg("D F")!, ["U", "R"]);
eq("track D F accepted", r1.acceptedPhysical, ["D", "F"]);
eq("track D F complete", r1.complete, true);

// Tracker rejection: alg expects D (reported U) but the cube reports F -> wrong.
const r2 = trackAlg(parseAlg("D F")!, ["F"]);
eq("track wrong status", r2.steps[0]!.status, "wrong");
eq("track wrong index", r2.firstErrorIndex, 0);

// Tracker partial: only first of two moves done.
const r3 = trackAlg(parseAlg("D F")!, ["U"]);
eq("track partial accepted", r3.acceptedPhysical, ["D"]);
eq("track partial step2 pending", r3.steps[1]!.status, "pending");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
