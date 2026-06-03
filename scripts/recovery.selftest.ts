// Self-test for the GAN251 missed-move recovery FIFO.
// esbuild scripts/recovery.selftest.ts --bundle --platform=node --format=esm --outfile=/tmp/r.mjs && node /tmp/r.mjs
import { Gan251MoveRecovery, type RecoveredMove } from "../src/gan251/gan251MoveRecovery";
import type { Gan251Face, Gan251HistoryMove } from "../src/gan251/types";

let failures = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}: got ${g}${ok ? "" : `  want ${w}`}`);
}

type Harness = {
  rec: Gan251MoveRecovery;
  emitted: string[]; // "U@10" face@serial
  requests: Array<[number, number]>;
};

function harness(): Harness {
  const emitted: string[] = [];
  const requests: Array<[number, number]> = [];
  const rec = new Gan251MoveRecovery({
    emitMove: (m: RecoveredMove) => emitted.push(`${m.face}${m.direction === "counterclockwise" ? "'" : ""}@${m.serial}`),
    requestHistory: (serial, count) => requests.push([serial, count]),
    now: () => 1000,
  });
  return { rec, emitted, requests };
}

const F = (face: Gan251Face): Gan251Face => face;

// 1) No drops — moves evict immediately, in order.
{
  const h = harness();
  h.rec.ingestMove(10, F("U"), "clockwise", 100);
  h.rec.ingestMove(11, F("R"), "clockwise", 110);
  h.rec.ingestMove(12, F("F"), "clockwise", 120);
  eq("no-drop emitted", h.emitted, ["U@10", "R@11", "F@12"]);
  eq("no-drop requests", h.requests, []);
}

// 2) One dropped move (serial 11 never arrives) — gap detected, history requested,
//    then the recovered move drains ahead of the held move.
{
  const h = harness();
  h.rec.ingestMove(10, F("U"), "clockwise", 100);
  h.rec.ingestMove(12, F("F"), "clockwise", 120); // gap: 11 missing
  eq("drop1 emitted before history", h.emitted, ["U@10"]); // 12 held back
  eq("drop1 requested history", h.requests.length > 0, true);
  // Cube replies with history (newest-first): serial 12 then 11.
  const hist: Gan251HistoryMove[] = [
    { serial: 12, face: "F", direction: "clockwise", notation: "F" },
    { serial: 11, face: "R", direction: "clockwise", notation: "R" },
  ];
  h.rec.ingestHistory(hist);
  eq("drop1 emitted after history", h.emitted, ["U@10", "R@11", "F@12"]);
}

// 3) Two consecutive dropped moves (11, 12 missing).
{
  const h = harness();
  h.rec.ingestMove(10, F("U"), "clockwise", 100);
  h.rec.ingestMove(13, F("D"), "clockwise", 130); // gap: 11,12 missing
  eq("drop2 held", h.emitted, ["U@10"]);
  h.rec.ingestHistory([
    { serial: 13, face: "D", direction: "clockwise", notation: "D" },
    { serial: 12, face: "F", direction: "clockwise", notation: "F" },
    { serial: 11, face: "R", direction: "clockwise", notation: "R" },
  ]);
  eq("drop2 reconstructed", h.emitted, ["U@10", "R@11", "F@12", "D@13"]);
}

// 4) Serial wrap-around (255 -> 0) with a drop at 0.
{
  const h = harness();
  h.rec.ingestMove(254, F("U"), "clockwise", 100);
  h.rec.ingestMove(1, F("F"), "clockwise", 130); // gap: 255, 0 missing
  h.rec.ingestHistory([
    { serial: 1, face: "F", direction: "clockwise", notation: "F" },
    { serial: 0, face: "D", direction: "clockwise", notation: "D" },
    { serial: 255, face: "R", direction: "clockwise", notation: "R" },
  ]);
  eq("wrap reconstructed", h.emitted, ["U@254", "R@255", "D@0", "F@1"]);
}

// 5) forceFlush safety valve when history never comes.
{
  const h = harness();
  h.rec.ingestMove(10, F("U"), "clockwise", 100);
  h.rec.ingestMove(14, F("F"), "clockwise", 140); // big gap, held
  eq("flush held before", h.emitted, ["U@10"]);
  const gapped = h.rec.forceFlush();
  eq("flush emits held", h.emitted, ["U@10", "F@14"]);
  eq("flush reports gap", gapped, [14]);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
