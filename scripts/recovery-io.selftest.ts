// Validates the outbound command encryption (inverse of decrypt) and the 0xD1
// move-history decoder.
// esbuild scripts/recovery-io.selftest.ts --bundle --platform=node --format=esm --outfile=/tmp/rio.mjs && node /tmp/rio.mjs
import {
  encryptGan251CommandPacket,
  decryptGan251NotifyPacket,
  gan251BytesToHex,
} from "../src/gan251/gan251Crypto";
import { decodeGan251DecryptedPacket } from "../src/gan251/gan251PacketDecoder";

let failures = 0;
function eq(label: string, got: unknown, want: unknown) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  if (!ok) failures++;
  console.log(`${ok ? "✓" : "✗"} ${label}: got ${g}${ok ? "" : `  want ${w}`}`);
}

const MAC = "E4:66:E5:04:FA:06";

// 1) Encrypt a move-history request, then decrypt it — must round-trip back to the
//    plaintext command. This proves encrypt is the correct inverse of decrypt.
{
  const plain = new Uint8Array(20);
  plain.set([0xd1, 0x04, 0xcb, 0x00, 0x06, 0x00]); // request 6 moves ending at serial 0xCB
  const encrypted = encryptGan251CommandPacket(plain, MAC);
  const { decrypted } = decryptGan251NotifyPacket(encrypted, MAC);
  eq("command round-trips through decrypt", gan251BytesToHex(decrypted), gan251BytesToHex(plain));
  eq("ciphertext differs from plaintext", gan251BytesToHex(encrypted) !== gan251BytesToHex(plain), true);
}

// 2) Decode a hand-built 0xD1 move-history packet.
//    startSerial=12, newest-first moves: serial12=F(cw), serial11=R(cw).
//    Nibble = faceCode*2 + dirBit, faceCode from table [1,5,3,0,4,2] indexed by URFDLB.
//    F -> index2 -> faceCode3 -> cw nibble 6 ; R -> index1 -> faceCode5 -> cw nibble 10(0xA).
{
  const packet = new Uint8Array([0xd1, 0x02, 0x0c, 0x6a]); // dataLength=2 => count=2
  const decoded = decodeGan251DecryptedPacket(packet);
  eq("history kind", decoded.kind, "history");
  if (decoded.kind === "history") {
    eq("history startSerial", decoded.startSerial, 12);
    eq("history count", decoded.count, 2);
    eq("history moves", decoded.moves.map((m) => `${m.notation}@${m.serial}`), ["F@12", "R@11"]);
  }
}

// 3) Decode a packet with a prime move: serial 20 = U' (faceCode1, dir1 -> nibble 3),
//    serial 19 = U (faceCode1, dir0 -> nibble 2). byte = 0x32.
{
  const packet = new Uint8Array([0xd1, 0x02, 0x14, 0x32]); // high nibble 3 = U', low nibble 2 = U(cw)
  const decoded = decodeGan251DecryptedPacket(packet);
  if (decoded.kind === "history") {
    eq("history prime move", decoded.moves.map((m) => `${m.notation}@${m.serial}`), ["U'@20", "U@19"]);
  } else {
    eq("history prime move (kind)", decoded.kind, "history");
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
