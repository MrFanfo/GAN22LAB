import type { Gan251Face, Gan251HistoryMove, Gan251MoveDirection } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// GAN251 missed-move recovery — port of the GAN Gen4 protocol driver logic from
// smartcube-web-bluetooth (gan-cube-protocol.ts, GanGen4ProtocolDriver).
//
// Every move carries a serial number (0..255, wraps). BLE notifications can be
// dropped, leaving gaps in the serial sequence. This machine keeps a FIFO buffer
// and only EVICTS (emits) moves whose serial is contiguous with the last emitted
// one. When it sees a gap it asks the cube for its move history; the recovered
// moves are injected ahead of the blocked move, and the buffer drains in order.
//
// Serial arithmetic is mod-256 throughout, matching the firmware/library, and the
// history request addresses moves by an 8-bit serial.
// ─────────────────────────────────────────────────────────────────────────────

export type RecoveredMove = {
  serial: number;
  face: Gan251Face;
  direction: Gan251MoveDirection;
  cubeTimestamp: number | null;
  /** Host timestamp; null means this move was missed and recovered from history. */
  localTimestamp: number | null;
};

export type Gan251MoveRecoveryOptions = {
  /** Send a move-history request to the cube for `count` moves ending at `serial`. */
  requestHistory: (serial: number, count: number) => void;
  /** Emit a move in correct serial order (live or recovered). */
  emitMove: (move: RecoveredMove) => void;
  /** Called when the buffer is hopelessly stuck (mirrors the library's safety disconnect). */
  onBufferOverflow?: () => void;
  now?: () => number;
};

const FACELET_DEBOUNCE_MS = 500;

export class Gan251MoveRecovery {
  private serial = -1; // latest serial observed (from a move or state packet)
  private lastSerial = -1; // serial of the last move evicted/emitted
  private lastLocalTimestamp: number | null = null;
  private moveBuffer: RecoveredMove[] = [];
  private readonly now: () => number;

  constructor(private readonly opts: Gan251MoveRecoveryOptions) {
    this.now = opts.now ?? (() => Date.now());
  }

  reset(): void {
    this.serial = -1;
    this.lastSerial = -1;
    this.lastLocalTimestamp = null;
    this.moveBuffer = [];
  }

  /** Number of moves currently held back waiting on a gap to be filled. */
  get pendingCount(): number {
    return this.moveBuffer.length;
  }

  /** Feed a live move packet (event 0x01). */
  ingestMove(
    serial: number,
    face: Gan251Face,
    direction: Gan251MoveDirection,
    cubeTimestamp: number | null,
    timestamp: number = this.now(),
  ): void {
    // The library only accepts moves after the first state packet. We don't want
    // to drop the very first move in raw mode, so seed lastSerial on first sight.
    if (this.lastSerial === -1) this.lastSerial = (serial - 1) & 0xff;

    this.serial = serial & 0xff;
    this.lastLocalTimestamp = timestamp;
    this.moveBuffer.push({
      serial: serial & 0xff,
      face,
      direction,
      cubeTimestamp,
      localTimestamp: timestamp,
    });
    this.evictMoveBuffer();
  }

  /** Feed a periodic state packet (event 0xED) so gaps are caught even when idle. */
  ingestState(serial: number, timestamp: number = this.now()): void {
    this.serial = serial & 0xff;
    if (this.lastSerial !== -1) {
      // Debounce while the user is actively turning to avoid spurious requests.
      if (this.lastLocalTimestamp != null && timestamp - this.lastLocalTimestamp > FACELET_DEBOUNCE_MS) {
        this.checkIfMoveMissed();
      }
    }
    if (this.lastSerial === -1) this.lastSerial = serial & 0xff;
  }

  /** Feed a decoded move-history response (event 0xD1), newest-first. */
  ingestHistory(moves: Gan251HistoryMove[]): void {
    for (const m of moves) {
      this.injectMissedMoveToBuffer({
        serial: m.serial & 0xff,
        face: m.face,
        direction: m.direction,
        cubeTimestamp: null,
        localTimestamp: null,
      });
    }
    this.evictMoveBuffer();
  }

  /**
   * Safety valve for cubes that don't answer history requests: emit everything
   * buffered in serial order, accepting the gap, so the live stream never stalls.
   * Returns the serials that were force-flushed across an unrecovered gap.
   */
  forceFlush(): number[] {
    const gapped: number[] = [];
    while (this.moveBuffer.length > 0) {
      const head = this.moveBuffer.shift()!;
      const diff = this.lastSerial === -1 ? 1 : (head.serial - this.lastSerial) & 0xff;
      if (diff > 1) gapped.push(head.serial);
      this.lastSerial = head.serial;
      this.opts.emitMove(head);
    }
    return gapped;
  }

  private evictMoveBuffer(): void {
    while (this.moveBuffer.length > 0) {
      const head = this.moveBuffer[0]!;
      const diff = this.lastSerial === -1 ? 1 : (head.serial - this.lastSerial) & 0xff;
      if (diff > 1) {
        this.requestMoveHistory(head.serial, diff);
        break;
      }
      this.moveBuffer.shift();
      this.lastSerial = head.serial;
      this.opts.emitMove(head);
    }
    if (this.moveBuffer.length > 16) {
      this.opts.onBufferOverflow?.();
    }
  }

  private checkIfMoveMissed(): void {
    const diff = (this.serial - this.lastSerial) & 0xff;
    if (diff > 0 && this.serial !== 0) {
      const head = this.moveBuffer[0];
      const startSerial = head ? head.serial : (this.serial + 1) & 0xff;
      this.requestMoveHistory(startSerial, diff + 1);
    }
  }

  private requestMoveHistory(serial: number, count: number): void {
    // History data is byte-aligned and always begins on an odd, near-ceil serial,
    // returning an even number of moves — adjust to that window.
    if (serial % 2 === 0) serial = (serial - 1) & 0xff;
    if (count % 2 === 1) count++;
    // Never read past the serial-cycle edge (firmware spoofs those as 'D').
    count = Math.min(count, serial + 1);
    this.opts.requestHistory(serial, count);
  }

  /** True if circular serial fits in the (start, end) range, mod 256. */
  private isSerialInRange(start: number, end: number, serial: number, closedStart = false, closedEnd = false): boolean {
    return (
      ((end - start) & 0xff) >= ((serial - start) & 0xff) &&
      (closedStart || ((start - serial) & 0xff) > 0) &&
      (closedEnd || ((end - serial) & 0xff) > 0)
    );
  }

  private injectMissedMoveToBuffer(move: RecoveredMove): void {
    if (this.moveBuffer.length > 0) {
      const head = this.moveBuffer[0]!;
      if (this.moveBuffer.some((e) => e.serial === move.serial)) return;
      if (!this.isSerialInRange(this.lastSerial, head.serial, move.serial)) return;
      if (move.serial === ((head.serial - 1) & 0xff)) {
        this.moveBuffer.unshift(move);
      }
    } else if (this.isSerialInRange(this.lastSerial, this.serial, move.serial, false, true)) {
      this.moveBuffer.unshift(move);
    }
  }
}
