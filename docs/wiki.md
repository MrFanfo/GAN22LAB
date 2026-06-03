# GAN 251 Lab — Complete Technical Wiki

This document is a first-principles technical walkthrough of the entire codebase. It is written to build a full mental model of the system: not just what each file does, but *why* it exists, what problem it solves, and how all the pieces fit together. Read it top-to-bottom once to understand the design, then use it as a reference.

---

## 1. The Problem Space

The GAN 251 is a 2×2 Rubik's cube with embedded electronics. It reports every turn over Bluetooth Low Energy (BLE), so a connected browser can track the cube's state in real time. This sounds simple — the cube moves, the browser sees a notification, done. In practice there are four hard problems stacked on top of each other:

**Problem 1: Encryption.** The GAN 251 UI V3-2 firmware encrypts every BLE notification with AES-128-CBC using a key derived from the device's MAC address. Without the key you see only random-looking bytes.

**Problem 2: Only three axes.** A 3×3 cube has six independent face centers; a 2×2 does not. The GAN 251 hardware describes every move relative to a single fixed corner, the anchor corner. This means the hardware only ever reports `U`, `R`, or `F` (and their primes and doubles) — yet there are physically six face layers that can be turned. A reported `U` could be a physical `U` *or* a physical `D`. A reported `R` could be a physical `R` *or* a physical `L`. There is a many-to-one mapping from physical moves to reported tokens.

**Problem 3: Frame drift.** The anchor corner is in the cube, not in space. When you perform a move that rotates the layer containing the anchor, the anchor moves with it, and the reference frame the hardware uses shifts. After a physical `D` turn, what was the anchor's "up" axis is now a different axis. A subsequent physical `F` is reported as `R`. The reported stream is a function of the entire move history, not just the latest move.

**Problem 4: Packet loss.** BLE is a lossy channel. During fast turning, notifications can be dropped. The hardware assigns a sequence number (serial) to each move, but there is no built-in retransmission. A gap in serials means moves were silently lost.

This app exists to solve all four problems, expose the internals for debugging, and provide a verified algorithm-tracking surface for the GAN 251 specifically.

---

## 2. The 2×2 Cube Model

Before touching BLE or encryption it helps to have a clear model of what the cube state *is*.

A 2×2 cube has 8 corners and no edges. Each corner is a physical piece with three stickers. The cube's state is fully described by:

- **Corner permutation**: which of the 8 physical corner pieces is sitting at each of the 8 corner positions. An array `cornerPermutation[8]` where `cornerPermutation[i]` is the index (0–7) of the piece currently at position `i`.
- **Corner orientation**: each corner piece can be twisted into one of 3 orientations (0, 1, 2) — the number of clockwise 120° twists relative to solved. `cornerOrientation[8]`.

The positions are labeled by face membership: URF, ULF, ULB, URB, DRF, DLF, DLB, DRB. The solved state is `cornerPermutation = [0,1,2,3,4,5,6,7]`, all orientations 0.

A face move (say, `R`) acts on a specific subset of corners: it cycles 4 corners through 4 positions, and it changes their orientations by fixed amounts that depend on which layer is being turned and in which direction. These permutation and orientation deltas are hardcoded per move — there is no simpler description because they depend on the physical geometry of the cube.

### `src/gan251/virtual2x2Cube.ts`

This file implements the cube model. The core class is `Virtual2x2Cube`:

```ts
class Virtual2x2Cube {
  cornerPermutation: number[8]
  cornerOrientation: number[8]

  applyMove(face: Face, direction: Direction): void
  toFacelets24(): string   // "UUUURRRRFFFFDDDDLLLLBBBB" for solved
  clone(): Virtual2x2Cube
}
```

`applyMove` dispatches to a table of hardcoded 4-cycles and orientation deltas. Each entry encodes which 4 corner positions are cycled (clockwise) and what the orientation delta is for each corner in the cycle. Primes reverse the cycle direction. Doubles apply the cycle twice.

`toFacelets24` walks each of the 6 faces, identifies which 4 corners contribute a sticker to that face, and looks up the sticker color from the corner's current position and orientation. The face order is `U R F D L B`, 4 stickers per face: `UUUURRRRFFFFDDDDLLLLBBBB`.

In `Gan251Session`, two instances of this cube are maintained in parallel:
- `moveDrivenCube`: updated only from decoded move packets (`0x01`). Represents the app's running model of the cube state from the move stream alone.
- `stateDrivenCube`: overwritten wholesale from state packets (`0xED`). Always reflects what the hardware last confirmed as ground truth.

Keeping them separate lets the debug UI show both views and compare them — a mismatch indicates either a dropped move or a decoding bug.

---

## 3. The Encryption Layer

### Why there is one

The GAN 251 UI V3-2 firmware encrypts its BLE notifications to prevent easy reverse engineering. The key material is derived from the device's MAC address, which means every cube has a unique key — you cannot capture packets from one device and replay them on another.

### Key derivation (`src/gan251/gan251Crypto.ts`)

The derivation is simple but non-standard:

```
BASE_KEY = [0x01, 0x02, 0x42, 0x28, 0x31, 0x91, ...]  (16 bytes, hardcoded)
BASE_IV  = [0x11, 0x03, 0x32, 0x28, 0x21, 0x76, ...]  (16 bytes, hardcoded)
salt     = reverse(MAC bytes)   // e.g. MAC E4:66:E5:04:FA:06 → [0x06, 0xFA, 0x04, 0xE5, 0x66, 0xE4]

key[i] = (BASE_KEY[i] + salt[i]) % 0xff   for i in 0..5
key[i] = BASE_KEY[i]                       for i in 6..15
iv[i]  = (BASE_IV[i]  + salt[i]) % 0xff   for i in 0..5
iv[i]  = BASE_IV[i]                        for i in 6..15
```

Only the first 6 bytes of the key and IV are modified by the salt. This is a firmware implementation detail.

### Decryption

The firmware uses AES-128-CBC with a non-standard block arrangement. Notifications are 20 bytes. Standard CBC would process two non-overlapping 10-byte blocks, but the firmware instead processes two overlapping 16-byte windows:

```
if (length > 16) {
  decrypt bytes [length-16 .. length]   // window starting at byte 4
}
decrypt bytes [0 .. 16]                 // window starting at byte 0
```

The two windows overlap in the middle 12 bytes (bytes 4–15). Both use the same key and IV. This is an implementation quirk in the firmware that the app must replicate exactly — using standard CBC padding would produce wrong output.

### CRC validation

After decryption, the last 2 bytes of the plaintext are a CRC16-CCITT-False checksum over all preceding bytes. The app computes the CRC independently and compares. A mismatch means either the MAC is wrong (key derivation failed) or the packet is corrupted.

One subtlety: state packets (`0xED`) sometimes have trailing zero bytes added as padding before the CRC was computed. The app tries both the trimmed and untrimmed versions if the first CRC check fails.

### MAC sourcing

Web Bluetooth does not expose hardware MAC addresses on most platforms — `device.id` is a browser-specific opaque token that cannot be reversed to recover the MAC. The app has two strategies:

1. **Advertisement data capture**: during BLE scanning, the GAP advertisement sometimes includes the MAC in a vendor-specific field. `src/gan/mac.ts` parses this if available.
2. **Manual entry**: the user types the MAC (found on the cube's sticker or a companion app). `preferManualMac` can force the app to use this over the parsed advertisement MAC.

Without a valid MAC, the key derivation produces a wrong key and every packet fails CRC validation.

---

## 4. The BLE Layer

### `src/gan/ganBle.ts` — `GanBleLab`

This class wraps Web Bluetooth at a level just above raw GATT. It handles:

- **Device request**: `navigator.bluetooth.requestDevice()` with GAN's service UUIDs as filters, or `acceptAllDevices: true` as a fallback for devices that don't broadcast the right service UUIDs.
- **Service discovery**: connects to the primary GAN service (`FFF0`) and enumerates characteristics `FFF1`–`FFF7`.
- **Characteristic inspection**: reads the `properties` bitmask of each characteristic to determine which are readable, writable, notifiable, or indicatable.
- **Initial reads**: reads all readable characteristics on connect to populate the initial state.
- **Notifications**: starts `startNotifications()` on all notifiable/indicatable characteristics. Every incoming notification fires `handleNotification(uuid, rawData)`.
- **Writes**: exposes `writeCharacteristic(uuid, data)` for sending history-request commands back to the cube.

The MAC is extracted from advertisement data in the `advertisementreceived` event handler before `connect()` completes. `GanBleLab` stores the best available MAC and exposes it for the crypto layer.

### Generation detection

GAN hardware spans multiple generations with different service UUIDs and crypto schemes. `src/gan/ganConstants.ts` lists the service/characteristic UUID sets for Gen1–4. The app currently targets Gen4 (the GAN251 UI V3-2), but the same `GanBleLab` class works for earlier generations by swapping constants.

`src/gan/ganCrypto.ts` handles the older crypto schemes:
- **Gen1**: AES-ECB with a key derived from a compressed blob.
- **Gen2/3**: AES-CBC with different base key/IV constants.
- **Gen4**: AES-CBC as described above (the current GAN251 UI path uses `gan251Crypto.ts` instead, which is a specialized reimplementation with the same math).

---

## 5. Packet Decoding

### `src/gan251/gan251PacketDecoder.ts`

Once a notification is decrypted, `decodeGan251DecryptedPacket(plaintext)` dispatches on the first byte (the opcode):

| Opcode | Packet type | Content |
|--------|-------------|---------|
| `0x01` | Move | Which layer moved and in which direction |
| `0xED` | State | Full cube state: 8 corner permutation bytes + 8 orientation bytes |
| `0xD1` | Move history | Packed 4-bit moves (recovered missed moves) |
| `0xEC`, `0xEE` | Gyro | Quaternion data |
| `0xEF` | Battery | Battery percentage |
| `0xF5`–`0xFF` | Hardware info | Device name, firmware version, etc. |

The return type is a discriminated union `Gan251DecodedPacket` with `kind` as the discriminant:

```ts
type Gan251DecodedPacket =
  | Gan251MovePacket      // kind: "move"
  | Gan251StatePacket     // kind: "state"
  | Gan251HistoryPacket   // kind: "history"
  | Gan251GenericPacket   // kind: "battery" | "gyro" | "hardware" | ...
  | Gan251InvalidPacket   // kind: "invalid"
```

### Move decoding

Move packets carry a single byte (byte 3 of the plaintext) that encodes both the axis and direction:

```
moveByte >> 1  → axis index (0=U, 1=R, 2=F)
moveByte & 1   → direction (0=clockwise, 1=counterclockwise)
```

Doubles are inferred from two consecutive same-axis packets arriving within a short time window (not from a separate byte), or from the state packet mismatch.

The decoded result is `{ face: "U"|"R"|"F", direction: "clockwise"|"counterclockwise", notation: "U"|"U'"|... }`.

Note: the hardware only ever reports `U`, `R`, or `F` on the reported axis — never `D`, `L`, or `B` directly. This is the axis-collapsing described in the Problem Space section.

### State decoding

State packets (`0xED`) carry 8 bytes of corner permutation followed by 8 bytes of corner orientation, plus a serial number. The decoder maps these directly into a `Virtual2x2Cube`:

```ts
stateDrivenCube.cornerPermutation = Array.from(bytes.slice(1, 9));
stateDrivenCube.cornerOrientation = Array.from(bytes.slice(9, 17));
```

The facelet string is computed with `toFacelets24()` after the update.

### History decoding

History packets (`0xD1`) contain up to N missed moves packed as 4-bit nibbles, newest first. Each nibble encodes a move as `(axis << 1) | direction` — same scheme as the move byte, just 4 bits instead of 8. The decoder reverses the order (to get chronological sequence) and emits one synthetic `Gan251MovePacket` per move.

---

## 6. Missed-Move Recovery

### The problem

BLE is connectionless at the notification layer — the cube fires-and-forgets each notification. If the browser is busy or the radio has a collision, notifications are silently dropped. During fast turning (many moves per second), gaps are common.

The GAN251 UI V3-2 supports a move-history command: if you send the cube a request packet via characteristic `FFF5`, it replies with a `0xD1` packet containing the most recent N moves from its internal ring buffer.

### `src/gan251/gan251MoveRecovery.ts` — `Gan251MoveRecovery`

The recovery system is a serial-aware FIFO:

**Every move has a serial number** (0–255, wrapping). The cube increments the serial for each move. The app tracks `lastEmittedSerial`.

**On each received move:**
1. Push it into an internal buffer sorted by serial.
2. Check whether the buffer's head serial is `lastEmittedSerial + 1` (mod 256).
3. If yes: emit the head, advance `lastEmittedSerial`, repeat.
4. If no (gap): do not emit yet; request history.

**History request:**
```
command = [0xD1, 0x04, serial, 0x00, count, 0x00]
```
This is encrypted with `encryptGan251CommandPacket()` — the inverse of the notification decrypt, using the same key/IV — and written to `FFF5`.

**On receiving the `0xD1` history reply:**
1. Decode the packed moves (newest-first nibbles, reversed to chronological).
2. For each recovered move, create a `RecoveredMove` with `recovered: true`.
3. Insert them into the FIFO at the right serial positions.
4. Drain the FIFO from `lastEmittedSerial + 1` onward.

**Safety timeout:** if no history reply arrives within 1.5 seconds (some firmware variants do not support the command), the FIFO is force-flushed with a logged warning. The app never stalls indefinitely waiting for a reply.

**State packets as serial checkpoints:** State packets (`0xED`) also carry the most recent move serial. Even if no moves are coming in (idle), a state packet can reveal that earlier serials were missed, triggering recovery.

Recovered moves are flagged with `recovered: true` and shown with a `↺` indicator in the packet table UI.

---

## 7. The Anchor-Corner Frame Model

This is the central algorithmic insight of the project. Understanding it is the key to understanding everything else.

### Why the GAN 251 "lies"

A 3×3 cube has fixed center pieces. No matter what moves you make, the center of the white face always stays white. The hardware can report `U` and always mean "the layer adjacent to the white center." The reference frame is fixed.

A 2×2 has no centers. Every piece is a corner. The GAN 251 resolves this by picking one corner as the anchor: the **DLB corner** (Down-Left-Back in the home orientation, the orange/blue/yellow corner — opposite the solved URF corner which is white/red/green). In the home pose (white top, green front):

- The anchor's "up" sticker is yellow (`D` face's center color) → hardware's `U` axis
- The anchor's "right" sticker is orange (`L` face's center color) → hardware's `R` axis  
- The anchor's "front" sticker is blue (`B` face's center color) → hardware's `F` axis

So in home pose:
- Physical `D` move → reported as `U` (same axis, opposite layer)
- Physical `L` move → reported as `R`
- Physical `B` move → reported as `F`
- Physical `U` → reported as `U`  ✓
- Physical `R` → reported as `R`  ✓
- Physical `F` → reported as `F`  ✓

So far there is a fixed many-to-one mapping. But here is the subtlety:

**The anchor corner moves when you turn certain layers.** If you perform a physical `D` move, the DLB corner rotates with the D layer. Its stickers now point in different directions. The reference frame the hardware uses has drifted. A subsequent physical `F` move will no longer be reported as `F` — the anchor's "front" sticker is now pointing in a different direction, so it gets reported as something else.

### Modeling frame drift with rotation matrices

`src/lib/algTracker.ts` represents the reference frame as a 3×3 integer rotation matrix (only entries from {-1, 0, 1}). This matrix maps the home-frame axis directions to the current anchor-frame axis directions.

At start, the frame is the identity matrix `I`. The three axes of the hardware (`U`, `R`, `F`) correspond to the home-frame `[0,1,0]`, `[1,0,0]`, `[0,0,1]` directions respectively.

After a move, the function `advanceFrame(frame, physicalMove)` checks whether the move turns the layer containing the anchor corner. The anchor lives at position `[-1,-1,-1]` in home-frame coordinates. A face move turns the layer in the direction of that face's normal. The layer contains the anchor if the dot product of the anchor position and the face normal is negative (anchor is in the opposite half-space from the moved face, which for a 2×2 means it moves with the face).

If the anchor is in the turned layer, the frame is updated: the 3×3 matrix is multiplied by the rotation matrix corresponding to that physical move. This is a pure matrix multiply — no lookup tables, no special cases.

After a frame update, `reportedMoveForPhysical(frame, physicalMove)` computes what the hardware will report for any given physical move by:
1. Looking up the physical face's home-frame normal vector.
2. Applying the inverse of the current frame matrix to find where that normal has moved in the anchor's current reference frame.
3. Finding which hardware axis (`U`, `R`, `F`) the rotated normal aligns with.
4. Checking whether the anchor is in the turned layer (to determine if it's a `U`/`D` equivalent, etc.).

This is correct by construction. There are no hand-coded tables for specific sequences like "after D, F becomes R" — the geometry figures it out.

### `trackAlg(expectedMoves, reportedStream)` — the public API

Given:
- `expectedMoves`: the algorithm you want to verify, as an array of physical move strings (`["D", "F", "U", "R"]`)
- `reportedStream`: the moves as reported by the hardware

The function walks both arrays in lockstep:

1. Initialize `frame = I`.
2. For each expected move at index `i`:
   - Compute `expectedReport = reportedMoveForPhysical(frame, expectedMoves[i])`.
   - Compare to `reportedStream[i]`.
   - If match: `status = "accepted"`, advance the frame with `advanceFrame(frame, expectedMoves[i])`.
   - If mismatch: `status = "wrong"`, stop consuming.
   - If reported stream is shorter: `status = "pending"`.
3. Return a table: `{ physicalMove, expectedReport, actualReport, status }[]`.

The UI renders this as a step-by-step confirmation table. Green checkmarks for accepted moves, red X for the first wrong move, empty rows for pending steps.

### `simulateReportsWithFrameDrift(physicalMoves)` — for teaching

This function takes a sequence of physical moves and returns the complete predicted report sequence the hardware would emit. It is used in `AlgTrackerPanel.tsx` to show users exactly what stream of tokens to expect on the hardware, before they attempt the algorithm.

---

## 8. The Hypothesis Engine

The alg tracker works when you *know* the expected algorithm in advance. But there is a different use case: you want to know which physical moves the user made, given only the hardware's reported stream, without knowing the algorithm.

This is harder because the mapping is many-to-one. A reported `U` could be a physical `U` or a physical `D`. In home-frame there are 3 axes × 2 layers = 6 physical faces, but only 3 hardware-reported axes. Each reported token eliminates half the candidates, but the surviving two are fundamentally ambiguous from the reported stream alone.

### `src/lib/gan251AlgMatcher.ts`

The matcher maintains a set of **hypotheses**. Each hypothesis is:
- `stepIndex`: how many moves of the expected algorithm have been consumed
- `physicalMoves`: which physical moves have been chosen so far under this hypothesis
- `frame`: what the current reference frame is under this hypothesis
- `qualities`: for each step, was the match `"exact"` (same physical face) or `"axis-equivalent"` (same axis, opposite layer — e.g., R reported for L)
- `score`: sum of quality scores (exact = 3 points, axis-equivalent = 1 point)

**Processing a new reported move:**

For each existing hypothesis, compute all candidate physical moves that could produce the reported token given the hypothesis's current frame. For a reported `R`, the candidates are the two physical moves whose hardware projection is the `R` axis under the current frame.

For each candidate:
1. Compare to the expected move at `hypothesis.stepIndex`.
2. If the candidate matches exactly → quality `"exact"`, score += 3.
3. If the candidate is on the same axis but opposite layer → quality `"axis-equivalent"`, score += 1.
4. If neither → prune this candidate from consideration.

After expanding all hypotheses, sort by score and keep the top N (default 8). This prevents combinatorial explosion on long algorithms.

**At any point**, `getBestHypothesis()` returns the hypothesis with the highest score. If all surviving hypotheses agree on the physical move for a given step, that move is certain. If they disagree, the step is marked ambiguous.

The matcher is used in `AlgMatcherPanel.tsx` for manual testing and in the automated hypothesis display UI.

---

## 9. Gyroscope and Orientation

The GAN 251 UI V3-2 has a gyroscope that reports orientation as a quaternion via periodic BLE notifications.

### `src/lib/gyro.ts`

**The raw quaternion problem**: the quaternion from the hardware is in the cube's sensor frame, not the Three.js world frame. `mapSmartcubeQuaternionToThree(q)` applies a fixed rotation to transform from sensor frame to display frame.

**Home orientation**: the "home" quaternion is the cube's orientation when the user clicks calibrate (white top, green front). All subsequent quaternions are expressed relative to this home orientation: `displayQuat = homeInverse * currentQuat`.

**`computeDisplayQuaternion(current, home)`**: computes the relative quaternion and converts it to a Three.js `Quaternion` for the `VirtualCube2x2` renderer.

### `src/lib/orientation.ts`

Semantic orientation detection answers "which face is currently on top / in front?" from the calibrated quaternion.

**`detectSemanticOrientation(quat)`**: projects the world-frame up vector `[0,1,0]` and front vector `[0,0,-1]` through the inverse of the current display quaternion to find which cube-frame axes they align with. Returns `{ top: Face, front: Face }`.

**Calibration**: `createSemanticCalibration(referenceQuat)` stores the reference quaternion at calibration time. All subsequent orientation queries use this reference as the identity.

This drives `OrientationCalibrationPanel.tsx`, which shows the user the detected top/front face in real time and lets them re-calibrate.

---

## 10. The Library Mode Path

In addition to the raw BLE path, the app supports a "library mode" that uses the `smartcube-web-bluetooth` npm package as a higher-level abstraction.

### `src/gan/libraryConnector.ts`

This thin wrapper:
- Calls `connectSmartCube()` from the library
- Subscribes to `MOVE`, `FACELETS`, `GYRO`, `BATTERY`, `HARDWARE` events
- Normalizes them into the same `PacketRow` format used by the raw BLE path
- Routes gyro quaternions through the same `gyro.ts` pipeline

### `src/hooks/useSmartcubeConnection.ts`

The React hook that owns the library-mode connection lifecycle:
- `connect()` / `disconnect()` control BT session state
- Exposes `cubeQuaternionRef` (a `THREE.Quaternion` ref, updated every gyro event) for `VirtualCube2x2`
- Emits connection status changes (`disconnected`, `connecting`, `connected`, `error`)

The benefit of library mode is out-of-the-box support for all cube brands the library knows about. The cost is opacity — you cannot see the raw bytes or inspect the crypto material. That is why the raw BLE path exists.

---

## 11. App Shell and UI

### `src/App.tsx`

The app is a single React 18 component tree with two top-level tabs:

- **Alg Tracker tab**: shows `AlgTrackerPanel` + the packet table filtered to moves only
- **BLE Lab tab**: shows the full `AlgMatcherPanel`, mode selector, connection controls, and the complete raw packet table

**State owned by App:**
- `packetRows: PacketRow[]` — the live packet log, displayed in the 19-column table
- `connectionStatus` — current BLE state
- `mode: "library" | "raw"` — which path is active
- `manualMac` — the user-entered MAC string
- `preferManualMac` — whether to override parsed MAC
- `cubeDriveMode: "moves" | "state"` — whether VirtualCube2x2 follows the move stream or resets from state packets
- `diagnosticLog: string[]` — developer-facing log lines

**Keyboard simulation**: a `useEffect` listens for `keydown` events. Pressing `U`, `R`, or `F` (Shift for prime) calls `syntheticGan251Input.ts` to create a properly-formed, CRC-valid encrypted move packet and feed it directly into the `Gan251Session` — same path as a real hardware notification. This makes the app fully testable without a physical cube.

### `src/components/VirtualCube2x2.tsx`

Three.js rendering of a 2×2 cube. The cube is 8 cubie objects, each with 3 visible sticker faces (and 3 invisible inner faces). Sticker colors are updated by calling `setFacelets24(str)` on the component's imperative handle.

The renderer accepts an optional `quaternionRef` for gyro-driven rotation. On each animation frame it reads the ref and applies the quaternion to the cube's root object rotation.

### `src/components/AlgTrackerPanel.tsx`

- Text input for the expected algorithm (`"D F U R"` format)
- Calls `simulateReportsWithFrameDrift` to show the predicted report sequence alongside the physical moves
- Subscribes to the live move stream and calls `trackAlg` after each move
- Renders the step table (physical move, expected report, actual report, status checkmark/X)
- Shows `VirtualCube2x2` updated from the live stream

### `src/components/AlgMatcherPanel.tsx`

- Two modes: live (uses actual reported moves from BLE) and manual (type moves to test)
- Shows best hypothesis + all alternatives with scores
- Per-step breakdown: exact vs axis-equivalent
- Useful for debugging why the matcher is confused about a particular sequence

### `src/components/OrientationCalibrationPanel.tsx`

- Connect button (library mode)
- "Calibrate" button (stores current quaternion as home)
- Live display of detected `top` and `front` face
- Raw quaternion readout for debugging

---

## 12. Synthetic Input

### `src/gan251/syntheticGan251Input.ts`

This module creates valid encrypted move packets from scratch:

1. Build the plaintext move packet bytes (opcode `0x01`, face byte, etc.)
2. Compute CRC16 and append to plaintext
3. Encrypt with the same key/IV used for real packets (MAC required)
4. Return the encrypted `Uint8Array`

This is used both for keyboard injection in `App.tsx` and for the unit tests in `scripts/`. It is the inverse of the decrypt path and validates that the crypto round-trips correctly.

### `src/gan251/gan251Examples.ts`

A small collection of known-good packet bytes (captured from a real cube with MAC `E4:66:E5:04:FA:06`) plus functions to verify them. This serves as a sanity check: if the crypto or decode logic changes, the known packets must still decode to the expected moves and states.

---

## 13. Testing

There are no Vitest/Jest unit tests in this repo — the test philosophy is **script-based integration tests** that exercise real end-to-end code paths.

### `scripts/algTracker.selftest.ts`

Tests the frame drift model with concrete sequences:

- `D F U R` from home: predicts the reported stream as `U U' R' F'` (the hardware projection of each physical move after accounting for frame changes), then verifies `trackAlg` accepts each one correctly.
- Edge cases: primes and doubles, chains that rotate the frame multiple times.

Run with esbuild to bundle (since the scripts use ESM imports from `src/`):

```bash
node_modules/.bin/esbuild scripts/algTracker.selftest.ts \
  --bundle --platform=node --format=esm --outfile=/tmp/algtest.mjs \
  && node /tmp/algtest.mjs
```

### `scripts/recovery.selftest.ts`

Tests the FIFO behavior:

- Feeds moves in out-of-order serial sequences.
- Verifies that moves with serial gaps are held and not emitted until the gap is filled.
- Verifies that force-flush releases everything after the timeout.

### `scripts/recovery-io.selftest.ts`

A more complete test that simulates the full request/response cycle:

- Feeds a move with a gap.
- Intercepts the history request the recovery module would send.
- Synthesizes a `0xD1` history reply.
- Feeds it back and verifies the FIFO drains in correct order.

---

## 14. Build and Deployment

### Vite configuration

`vite.config.ts` is minimal:

```ts
export default defineConfig({
  plugins: [react()],
  base: '/GAN22LAB/',
});
```

The `base` sets the asset prefix. This matches the GitHub Pages deployment path. If you change the repo name, change `base` accordingly.

### TypeScript configuration

`tsconfig.json` targets ES2020, uses strict mode, and sets `"noEmit": true` — Vite handles the actual transpile. The `tsc` invocation in `npm run build` is a type-check pass only.

### Dependencies

| Package | Why |
|---|---|
| `react`, `react-dom` | UI framework |
| `three` | 3D cube rendering |
| `aes-js` | AES-128-CBC encryption/decryption |
| `lz-string` | Decompress the Gen1 key blob (unused for Gen4 but part of the shared ganCrypto path) |
| `smartcube-web-bluetooth` | Library mode integration for all GAN cube generations |
| `rxjs` | Event streaming (pulled in by smartcube-web-bluetooth) |

### GitHub Pages

The repo deploys to GitHub Pages via the `gh-pages` branch (or GitHub Actions — check the repo's Actions tab). The deployed URL is `https://mrfanfo.github.io/GAN22LAB/`.

---

## 15. Key Invariants and Non-Obvious Decisions

**Why overlapping AES blocks?** The firmware encrypts 20-byte packets but AES works on 16-byte blocks. The firmware implementation processes two 16-byte windows that overlap in the middle rather than padding. The app must replicate this exactly or every packet fails CRC.

**Why two cube models?** `moveDrivenCube` and `stateDrivenCube` serve different purposes. The move-driven model lags behind when moves are missed (before recovery fills the gap). The state-driven model is always accurate but jumps discontinuously. Displaying both in the UI reveals which one is desynced and why.

**Why rotation matrices instead of quaternions for frame tracking?** The anchor corner only rotates by 90° increments around face normals. All entries are integers from {-1, 0, 1}. Integer matrix multiply is exact, no floating-point drift. Quaternions would be equivalent but introduce unnecessary complexity and rounding errors for 90° rotations.

**Why a hypothesis engine instead of just asking the user which layer they moved?** The alg tracker assumes the user is following a known algorithm — it only needs to verify. The matcher is for the case where you want to *infer* what the user did from the hardware alone, with no prior knowledge. These are different problems with different solutions.

**Why not use the library for everything?** The library abstracts away the crypto, protocol, and BLE details. This is great for production apps (like Cubyqo) but terrible for debugging. This lab exists precisely to expose those details: raw bytes, derived keys, CRC outcomes, frame-by-frame crypto material. The raw BLE path is the point of the app.

**Why keyboard injection?** Most of the interesting logic (frame drift, hypothesis engine, recovery FIFO) can be tested without a physical cube. The synthetic input path makes every code path reachable in a browser with no hardware.

---

## 16. File Map

```
gan251-lab/
├── src/
│   ├── App.tsx                       Main shell, packet table, tab routing
│   ├── main.tsx                      React entry
│   ├── App.css                       Styles
│   │
│   ├── gan/                          Generic GAN BLE abstraction (all generations)
│   │   ├── ganBle.ts                 GanBleLab: connect, discover, notify, write
│   │   ├── ganCrypto.ts              Gen1/2/3/4 crypto (ECB + CBC variants)
│   │   ├── ganConstants.ts           Service/characteristic UUIDs per generation
│   │   ├── mac.ts                    MAC parsing: advertisement data + manual
│   │   ├── hex.ts                    Hex string ↔ DataView ↔ Uint8Array utilities
│   │   ├── libraryConnector.ts       smartcube-web-bluetooth integration
│   │   └── types.ts                  PacketRow, ConnectionStatus, shared types
│   │
│   ├── gan251/                       GAN251 UI V3-2 specific logic
│   │   ├── gan251Session.ts          Stateful: decrypt → decode → update cube
│   │   ├── gan251Crypto.ts           V3-2 key/IV derivation, overlapping AES/CBC, CRC16
│   │   ├── gan251PacketDecoder.ts    Packet dispatch and decoding for all opcodes
│   │   ├── gan251MoveRecovery.ts     Serial-aware FIFO + gap detection + history request
│   │   ├── virtual2x2Cube.ts        2×2 corner model, move tables, facelet encoding
│   │   ├── syntheticGan251Input.ts   Build valid encrypted packets from scratch (keyboard/tests)
│   │   ├── gan251Examples.ts         Known-packet self-test and crypto verification
│   │   └── index.ts                  Public module exports
│   │
│   ├── lib/                          Algorithm tracking and orientation
│   │   ├── algTracker.ts             Anchor-corner frame model, deterministic tracking
│   │   ├── gan251AlgMatcher.ts       Hypothesis engine: score/prune per reported move
│   │   ├── cubeState2x2.ts           Facelet string utilities
│   │   ├── gyro.ts                   Quaternion remapping, Three.js display orientation
│   │   └── orientation.ts            Semantic face detection from calibrated quaternion
│   │
│   ├── components/
│   │   ├── VirtualCube2x2.tsx        Three.js 2×2 cube renderer
│   │   ├── AlgTrackerPanel.tsx       Algorithm follow UI + step table
│   │   ├── AlgMatcherPanel.tsx       Hypothesis display + manual move tester
│   │   └── OrientationCalibrationPanel.tsx  Gyro calibration UI
│   │
│   └── hooks/
│       └── useSmartcubeConnection.ts Library-mode connection hook
│
├── scripts/                          Node.js integration tests (esbuild bundles)
│   ├── algTracker.selftest.ts        Frame drift regression: D F U R and variants
│   ├── recovery.selftest.ts          FIFO gap handling without I/O
│   ├── recovery-io.selftest.ts       Full request/response recovery cycle
│   └── verifyLog.ts                  Log verification utilities
│
├── package.json
├── tsconfig.json
├── vite.config.ts                    base: '/GAN22LAB/'
└── index.html
```
