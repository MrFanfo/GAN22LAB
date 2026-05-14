import { gan251HexToBytes } from "./gan251Crypto";
import { Gan251Session } from "./gan251Session";
import type { Gan251DecodedPacket } from "./types";

const KNOWN_DECRYPTED_PACKETS = [
  "01 07 15 62 00 00 02 00 08 00 00 00 00 00 00 00 00 00 ad 7a",
  "01 07 cb 66 00 00 03 00 02 00 00 00 00 00 00 00 00 00 c6 00",
  "01 07 5b 6a 00 00 04 00 20 00 00 00 00 00 00 00 00 00 86 78",
  "ed 0e 01 00 05 39 70 00 00 09 1a 2b 3c 4d 00 00 00 00 54 38",
  "ed 0e 02 00 35 31 33 04 80 09 1a 2b 3c 4d 00 00 00 00 d7 ed",
  "ed 0e 03 00 66 a1 30 c4 80 09 1a 2b 3c 4d 00 00 00 00 ec 4e",
  "ed 0e 04 00 06 bf 32 ca 90 09 1a 2b 3c 4d 00 00 00 00 80 c3",
];

export function exampleDecodeEncryptedGan251Notifications(
  mac: string,
  encryptedNotifyPackets: Uint8Array[],
): Array<{ decoded: Gan251DecodedPacket; facelets24: string }> {
  const session = new Gan251Session({ mac });
  return encryptedNotifyPackets.map((packet) => {
    const decoded = session.processEncryptedNotify(packet);
    return { decoded, facelets24: session.getFacelets24() };
  });
}

export function runGan251KnownPacketSelfTest(): {
  decoded: Gan251DecodedPacket[];
  facelets24: string;
} {
  const session = new Gan251Session({ mac: "E4:66:E5:04:FA:06" });
  const decoded = KNOWN_DECRYPTED_PACKETS.map((hex) =>
    session.processDecryptedPacket(gan251HexToBytes(hex), hex),
  );

  const firstThreeFaces = decoded.slice(0, 3).map((packet) =>
    packet.kind === "move" ? packet.face : null,
  );
  const expectedFaces = ["F", "U", "R"];
  if (firstThreeFaces.join(",") !== expectedFaces.join(",")) {
    throw new Error(`GAN251 move self-test failed: got ${firstThreeFaces.join(",")}`);
  }
  if (decoded.some((packet) => packet.crcValid === false)) {
    throw new Error("GAN251 self-test failed: at least one known packet failed CRC16");
  }

  return { decoded, facelets24: session.getFacelets24() };
}
