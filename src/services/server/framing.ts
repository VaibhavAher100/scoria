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

/** Reassembles frames from a stream of arbitrarily-chunked reads. */
export class FrameDecoder {
  private buf = new Uint8Array(0);

  /** Append freshly-read bytes to the internal buffer. */
  feed(data: Uint8Array): void {
    if (this.buf.length === 0) {
      this.buf = data.slice();
      return;
    }
    const next = new Uint8Array(this.buf.length + data.length);
    next.set(this.buf, 0);
    next.set(data, this.buf.length);
    this.buf = next;
  }

  /**
   * Pop the next complete frame, or `null` if not enough bytes are buffered.
   * Throws {@link FrameError} on a protocol violation.
   */
  next(): Frame | null {
    if (this.buf.length < HEADER_LEN) {
      return null;
    }
    const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);
    const len = view.getUint32(0, true);
    if (len > MAX_FRAME_LEN) {
      throw new FrameError(`frame length ${len} exceeds max ${MAX_FRAME_LEN}`);
    }
    const total = HEADER_LEN + len;
    if (this.buf.length < total) {
      return null;
    }
    const typeTag = this.buf[4];
    const payload = this.buf.slice(HEADER_LEN, total);
    this.buf = this.buf.slice(total);
    if (typeTag !== FrameType.Text && typeTag !== FrameType.Binary) {
      throw new FrameError(`unknown frame type tag ${typeTag}`);
    }
    return { kind: typeTag as FrameType, payload };
  }
}
