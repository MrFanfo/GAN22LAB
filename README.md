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
2. Enter your manual MAC address if available (optional — connection works without it).
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
- Logs every notification with: raw hex, byte length, changed bytes vs previous, expected move label, MAC info, and decrypt status.
- Logs can be exported as JSON for offline analysis.

---

## What this version does NOT do

- Does not decrypt GAN AES packets (placeholder hook exists for future implementation).
- Does not decode moves or facelets.
- Does not assume GAN 251 UI has the same packet structure as GAN 12 UI.
- Does not require a manual MAC to connect.

---

## Manual MAC note

Manual MAC is optional and only used for future decryption key derivation tests.  
Web Bluetooth on most platforms does **not** expose the real hardware MAC address — `device.id` is a browser-specific opaque identifier.  
The MAC you enter stays in memory only and appears in exported local logs. It is never sent anywhere.

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
