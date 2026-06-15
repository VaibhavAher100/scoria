/**
 * Length-prefixed message framing for stream transports (named pipe / UDS).
 *
 * Mirrors the Rust server's `framing.rs`. A WebSocket gives message boundaries
 * for free; a raw byte stream does not. Every message is framed as:
 *
 *   [len: u32 LE][type: u8][payload: len bytes]
 *
 * `len` counts the payload only (not the type tag). The decoder is fed
 * arbitrarily-chunked reads and yields whole frames as they complete.
 *
 * This must stay byte-for-byte compatible with `rust-servers/src/framing.rs`.
 */

/** 4-byte little-endian length plus a 1-byte type tag. */
const HEADER_LEN = 5;

/**
 * Hard cap on a single frame's payload. The peer controls `len`, so an uncapped
 * value would let a malicious or corrupt sender request a huge allocation. Must
 * match `MAX_FRAME_LEN` on the Rust side.
 */
export const MAX_FRAME_LEN = 64 * 1024 * 1024;

/**
 * Wire type tag: text carries control JSON, binary carries PTY bytes. A const
 * object rather than a TS `enum` so the file works under Node's strip-types
 * loader (enums need codegen).
 */
export const FrameType = {
  Text: 1,
  Binary: 2,
} as const;
// Same name for the value and its type is intentional (enum-like); the base
// no-redeclare rule does not model TS value/type merging.
// eslint-disable-next-line no-redeclare
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
  kind: FrameType;
  payload: Uint8Array;
}

/** A framing protocol violation. Fatal for the connection - the caller should
 * drop the transport rather than try to resync. */
export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

/** Serialize one message to the wire format. */
export function encodeFrame(kind: FrameType, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_FRAME_LEN) {
    throw new FrameError(`frame payload ${payload.length} exceeds max ${MAX_FRAME_LEN}`);
  }
  const out = new Uint8Array(HEADER_LEN + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, true); // little-endian
  out[4] = kind;
  out.set(payload, HEADER_LEN);
  return out;
}

/**
 * Reassembles frames from a stream of arbitrarily-chunked reads.
 *
 * Uses a growable backing buffer with a read cursor instead of rebuilding the
 * whole buffer on every chunk. The previous version reallocated and copied the
 * entire accumulated buffer on each `feed` and rebuilt the remainder on each
 * `next`, which is O(n^2) when one large frame arrives across many small pipe
 * reads (a 64 MiB frame in 64 KiB chunks copies tens of GiB). Here `feed`
 * appends in place and grows geometrically, and `next` advances `start` rather
 * than slicing the tail, so reassembly is amortized linear. Per-frame payload
 * is still capped at MAX_FRAME_LEN, which bounds total buffering.
 */
export class FrameDecoder {
  /** Backing store; live bytes are buf[start..end). May have spare capacity. */
  private buf = new Uint8Array(0);
  private start = 0;
  private end = 0;

  /** Append freshly-read bytes to the internal buffer. */
  feed(data: Uint8Array): void {
    if (data.length === 0) {
      return;
    }
    const live = this.end - this.start;

    if (live + data.length > this.buf.length) {
      // Not enough total capacity: grow geometrically and compact to the front.
      let cap = this.buf.length === 0 ? HEADER_LEN : this.buf.length;
      while (cap < live + data.length) {
        cap *= 2;
      }
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(this.start, this.end), 0);
      this.buf = next;
      this.start = 0;
      this.end = live;
    } else if (this.end + data.length > this.buf.length) {
      // Enough total capacity but not at the tail: slide live bytes to the front.
      this.buf.copyWithin(0, this.start, this.end);
      this.start = 0;
      this.end = live;
    }

    this.buf.set(data, this.end);
    this.end += data.length;
  }

  /**
   * Pop the next complete frame, or `null` if not enough bytes are buffered.
   * Throws {@link FrameError} on a protocol violation.
   */
  next(): Frame | null {
    const available = this.end - this.start;
    if (available < HEADER_LEN) {
      return null;
    }
    const view = new DataView(this.buf.buffer, this.buf.byteOffset + this.start, available);
    const len = view.getUint32(0, true);
    if (len > MAX_FRAME_LEN) {
      throw new FrameError(`frame length ${len} exceeds max ${MAX_FRAME_LEN}`);
    }
    const total = HEADER_LEN + len;
    if (available < total) {
      return null;
    }
    const typeTag = this.buf[this.start + 4];
    // Copy the payload out: the backing buffer is reused across reads.
    const payload = this.buf.slice(this.start + HEADER_LEN, this.start + total);
    this.start += total;
    if (this.start === this.end) {
      // Fully drained: reset the cursor so capacity is reused from the front.
      this.start = 0;
      this.end = 0;
    }
    if (typeTag !== FrameType.Text && typeTag !== FrameType.Binary) {
      throw new FrameError(`unknown frame type tag ${typeTag}`);
    }
    return { kind: typeTag as FrameType, payload };
  }
}
