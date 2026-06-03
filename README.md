# GAN 251 UI Bluetooth Lab

A standalone debug app for investigating GAN 251 UI Bluetooth behavior over Web Bluetooth.

This is **not** part of the Cubyqo app and has no integration with it.

---

## Setup

```bash
npm install
npm run dev
```

Open the URL shown in the terminal (default: http://localhost:5173).
hello!
---

## Browser requirements

Use **Chrome** or **Edge** on desktop.  
Web Bluetooth is not supported in Firefox, Safari, or mobile browsers.

---

## Testing sequence

1. Open the app.
2. Enter your manual MAC address if available (optional to connect, required for GAN251 UI raw decrypt if advertisement MAC capture fails).
3. Click **Connect**.
4. If normal connect fails (device not found), click **Connect fallback / all devices** to scan with `acceptAllDevices`.
5. Wait for the log to fill in with services, characteristics, and any initial reads.
6. Type an expected move label in the **Expected move label** field, e.g. `R`.
7. Click **Add marker** to record a marker entry.
8. Perform exactly that move on the cube.
9. Observe the notification entries in the log.
10. Repeat for `R'`, `U`, `U'`, `F`, `F'`, `D`, `D'`, `L`, `L'`, `B`, `B'`.
11. Click **Export logs as JSON** to download the full session.

---

## What this version does

- Connects to a GAN device via Web Bluetooth.
- Reads the Device Information service (0x180A) where available.
- Inspects GAN FFF0 service characteristics FFF1–FFF7.
- Logs characteristic properties (read/write/notify/indicate).
- Reads initial values from readable characteristics.
- Starts notifications on all notifiable/indicatable characteristics.
- Logs every notification with: raw hex, byte length, MAC info, derived crypto material, decrypt status, and protocol sanity notes.
- Decrypts GAN251 UI raw notifications whose Bluetooth name starts with `gan251ui_` or `ganic251_` using the V3-2 AES/CBC profile, reversed-MAC salt, overlapping 16-byte block handling, trailing-zero trimming, and CRC16 validation.
- Decodes GAN251 UI move packets (`0x01`) into face/notation guesses and cube-state packets (`0xED`) into corner state plus a 24-sticker 2x2 facelet string.
- Maintains a reusable virtual 2x2 cube model that updates from move packets and resyncs from full state packets.
- Logs can be exported as JSON for offline analysis.

---

## What this version does NOT do

- Does not decode moves or facelets.
- Does not assume GAN 251 UI has the same packet structure as GAN 12 UI.
- Does not require a manual MAC to connect.

---

## Manual MAC note

Manual MAC is optional for connection but required for raw GAN251 UI decryption when the browser cannot capture the MAC from advertisement data.  
Web Bluetooth on most platforms does **not** expose the real hardware MAC address — `device.id` is a browser-specific opaque identifier.  
The MAC you enter stays in memory only and appears in exported local logs. It is never sent anywhere.

---

## Alg Tracker (anchor-corner frame model)

The **Alg Tracker** tab is a focused page for following an algorithm on the GAN 251
and confirming each move from the live BLE stream, despite the hardware only
reporting `U` / `R` / `F` (+ primes).

### Why the hardware is "lying"

The 251 is a 2x2 — it has no fixed centres, so it describes every turn relative to a
single fixed reference corner: the **anchor corner** (orange/blue/yellow, the `DLB`
corner, opposite the white/green/red `URF` corner). In the home pose (white top,
green front) that gives:

- `yellow → U`, `orange → R`, `blue → F` (and `white → U`, `red → R`, `green → F`)

so physical `D → U`, `L → R`, `B → F`.

The key subtlety: **a turn that moves the anchor corner rotates the whole reference
frame.** After a physical `D`, the anchor's orange sticker swings to the front, so
"front" now sits on the orange/red (`R`) axis — a following physical `F` is therefore
reported as `R`. The tracker models this drift from first principles with integer 3x3
rotation matrices, so it is correct for every face, every suffix (`'`, `2`) and any
number of chained moves.

### Modules

- `src/lib/algTracker.ts` — the deterministic tracker. Tracks the cube's orientation
  as a rotation matrix anchored to the `DLB` corner; advances the frame only when a
  move turns the layer containing the anchor; collapses canonical faces to the
  reported `U`/`R`/`F` axis. Key exports: `trackAlg`, `reportedMoveForPhysical`,
  `advanceFrame`, `handToCanonical`, `simulateReportsWithFrameDrift`.
- `src/components/AlgTrackerPanel.tsx` — the page: virtual cube, alg to follow,
  reported stream, and the per-step transformed/accepted table.

Because the alg is known, the tracker is **deterministic** (it advances the frame by
the expected move and checks the reported token is consistent) rather than the
hypothesis-branching search used by the older `gan251AlgMatcher.ts`.

Test the logic without a cube: press `U` / `R` / `F` (hold `Shift` for a prime) to
feed synthetic reported moves into the stream.

Run the regression self-test:

```bash
node_modules/.bin/esbuild scripts/algTracker.selftest.ts --bundle \
  --platform=node --format=esm --outfile=/tmp/algtest.mjs && node /tmp/algtest.mjs
```

---

## Missed-move recovery (raw BLE)

BLE notifications can be dropped during fast turning, leaving holes in the move
stream. The raw BLE path now recovers them, ported from the `smartcube-web-bluetooth`
library's **GAN Gen4** driver (the GAN251 UI shares that move/serial/command format).

How it works:

- Every move carries an 8-bit **serial** (byte 6–7 of the decrypted move packet).
- A FIFO buffer (`src/gan251/gan251MoveRecovery.ts`) only emits a move when its serial
  is contiguous with the last one emitted. A gap means moves were missed.
- On a gap, the lab sends an encrypted **move-history request** (`0xD1 0x04 <serial> 0
  <count> 0`) to the cube's command characteristic (`fff5`), built with
  `encryptGan251CommandPacket()` (the inverse of the notify decrypt).
- The cube replies with a `0xD1` **MOVE_HISTORY** packet; `gan251PacketDecoder.ts`
  decodes the packed 4-bit moves, and they are injected ahead of the held move so the
  buffer drains in correct serial order.
- Periodic `0xED` state packets also carry the serial, so idle gaps are caught too.
- Safety: if no history reply arrives within 1.5 s (e.g. a cube that doesn't support
  the command), the buffer is force-flushed so the live stream never stalls; the gap is
  logged.

Recovered moves are flagged (`recovered: true`, with `moveSerial`) and shown with a
`↺` marker in the packet table. Self-tests:

```bash
node_modules/.bin/esbuild scripts/recovery.selftest.ts    --bundle --platform=node --format=esm --outfile=/tmp/r.mjs && node /tmp/r.mjs
node_modules/.bin/esbuild scripts/recovery-io.selftest.ts --bundle --platform=node --format=esm --outfile=/tmp/r.mjs && node /tmp/r.mjs
```

---

## GAN251 module layout

The Raw BLE GAN251 UI path is implemented as reusable modules under `src/gan251/`:

- `gan251Crypto.ts` — V3-2 key/IV derivation, reversed-MAC salt, app-style overlapping AES/CBC decrypt, trimming helpers, CRC16.
- `gan251PacketDecoder.ts` — packet type dispatch, move-byte decode, state/cubie decode, generic packet preservation.
- `virtual2x2Cube.ts` — corner permutation/orientation model, move application, 24-facelet conversion.
- `gan251Session.ts` — decrypts incoming notify packets, updates the virtual cube, emits structured decoded packets.
- `gan251Examples.ts` — small known-packet self-test and example usage helpers.

Example:

```ts
import { Gan251Session } from "./gan251";

const session = new Gan251Session({ mac: "E4:66:E5:04:FA:06", debug: true });

for (const encryptedNotifyPacket of packetsFromFff6) {
  const decoded = session.processEncryptedNotify(encryptedNotifyPacket);
  console.log(decoded.kind, decoded.validationReason);
  console.log(session.getFacelets24());
}
```

The 2x2 facelet output uses face order `U,R,F,D,L,B`, four stickers per face:
`UUUURRRRFFFFDDDDLLLLBBBB` for solved state.

---

## Log export format

```json
{
  "app": "gan251-lab",
  "exportedAt": "2026-05-12T10:00:00.000Z",
  "status": "connected",
  "manualMacProvided": true,
  "normalizedManualMac": "AB:12:34:5D:34:12",
  "preferManualMac": true,
  "logs": [ ... ]
}
```
