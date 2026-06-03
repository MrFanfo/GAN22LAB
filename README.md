# GAN 251 Lab

A standalone browser tool for debugging GAN 251 (2×2) Bluetooth Low Energy behavior — live packet inspection, hardware decryption, virtual cube tracking, algorithm verification, and missed-move recovery.

**Live:** [mrfanfo.github.io/GAN22LAB/](https://mrfanfo.github.io/GAN22LAB/)

> Not part of Cubyqo. No backend, no accounts, no data leaves the browser.

---

## What it does

- **BLE Lab** — connect a GAN 251 over Web Bluetooth, see every raw/decrypted packet in a live table (hex, CRC, decoded meaning, facelets, derived key/IV, timings)
- **Alg Tracker** — follow an algorithm step-by-step; the tracker accounts for the GAN 251's anchor-corner frame drift so `D` is correctly mapped to a reported `U`, and frame changes after moves are applied automatically
- **Virtual 2×2 cube** — 3D Three.js view driven by the live move/state stream
- **Hypothesis matcher** — resolves the `U`/`D`, `R`/`L`, `F`/`B` axis ambiguity when you don't know which physical move was made
- **Missed-move recovery** — detects BLE serial gaps and requests history from the cube to fill them in before emitting to the app
- **Orientation calibration** — gyroscope quaternion pipeline with semantic face detection
- **Keyboard simulation** — press `U`/`R`/`F` (Shift for prime) to inject synthetic moves without a physical cube

---

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173/GAN22LAB/
npm run build    # tsc + vite → dist/
```

Requires **Chrome or Edge** on desktop — Web Bluetooth is not available in Firefox/Safari.

### Self-tests (no cube needed)

```bash
# Anchor-corner frame drift regression
node_modules/.bin/esbuild scripts/algTracker.selftest.ts \
  --bundle --platform=node --format=esm --outfile=/tmp/algtest.mjs \
  && node /tmp/algtest.mjs

# Move-recovery FIFO
node_modules/.bin/esbuild scripts/recovery.selftest.ts \
  --bundle --platform=node --format=esm --outfile=/tmp/r.mjs \
  && node /tmp/r.mjs

# Move-recovery with history request/response
node_modules/.bin/esbuild scripts/recovery-io.selftest.ts \
  --bundle --platform=node --format=esm --outfile=/tmp/r.mjs \
  && node /tmp/r.mjs
```

---

## Architecture at a glance

```
Web Bluetooth (Chrome/Edge)
        │
   GanBleLab           ← generic GAN BLE layer (services, characteristics, notifications)
        │
  Gan251Session        ← decrypt → decode → update Virtual2x2Cube
        │
   PacketRow[]         ← rendered in the packet table (App.tsx)
        │
  ┌─────┴─────┐
  │           │
AlgTracker  AlgMatcher
(known alg)  (ambiguous stream → hypothesis branches)
```

Key source files:

| File | What it does |
|---|---|
| `src/gan251/gan251Crypto.ts` | V3-2 AES/CBC decryption, MAC-based key derivation, CRC16 |
| `src/gan251/gan251PacketDecoder.ts` | Packet dispatch — move, state, history, telemetry |
| `src/gan251/virtual2x2Cube.ts` | 2×2 corner model, move application, facelet encoding |
| `src/gan251/gan251MoveRecovery.ts` | Serial-aware FIFO, gap detection, history request |
| `src/lib/algTracker.ts` | 3×3 rotation-matrix frame model, deterministic step tracking |
| `src/lib/gan251AlgMatcher.ts` | Hypothesis engine — score/prune branches per reported move |
| `src/gan/ganBle.ts` | Raw BLE: connect, discover services, enable notifications |
| `src/lib/gyro.ts` | Quaternion remapping, Three.js display orientation |
| `src/lib/orientation.ts` | Semantic face detection from calibrated gyro |

---

## Manual MAC note

Web Bluetooth does not expose hardware MAC addresses — `device.id` is a browser opaque token. The MAC you enter manually stays in memory only and is used for V3-2 key/IV derivation and exported local logs. It is never transmitted anywhere.

---

## Technical deep-dive

See [`docs/wiki.md`](docs/wiki.md) for a complete explanation of the anchor-corner frame model, the AES/CBC encryption scheme, the hypothesis engine, and every module in depth.
