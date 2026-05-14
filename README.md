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
