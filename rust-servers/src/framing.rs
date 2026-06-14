// Length-prefixed message framing for stream transports (named pipe / UDS).
//
// Wired into the named-pipe transport in M1 slice 3; until a stream transport
// consumes it, the binary build sees these items as unused.
#![allow(dead_code)]
//
// WebSocket gives us message boundaries for free; raw byte streams do not.
// Every message is framed as:
//
//   [len: u32 LE][type: u8][payload: len bytes]
//
// `len` counts the payload only (not the type tag). The decoder is fed
// arbitrary chunks (a pipe read may split or merge frames) and yields whole
// frames as they complete.

use std::fmt;

/// Header is a 4-byte little-endian length plus a 1-byte type tag.
const HEADER_LEN: usize = 5;

/// Hard cap on a single frame's payload. A stream peer controls `len`, so an
/// uncapped value lets a malicious or corrupt sender request a multi-GiB
/// allocation. PTY output batches are a few KiB and control JSON is small, so
/// 64 MiB is far above any legitimate frame while bounding the blast radius.
pub const MAX_FRAME_LEN: usize = 64 * 1024 * 1024;

/// Wire type tag. Mirrors the two WebSocket message kinds Termy already uses:
/// text carries control JSON, binary carries PTY bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameType {
    Text = 1,
    Binary = 2,
}

impl FrameType {
    fn from_u8(b: u8) -> Option<FrameType> {
        match b {
            1 => Some(FrameType::Text),
            2 => Some(FrameType::Binary),
            _ => None,
        }
    }
}

/// A decoded (or to-be-encoded) message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: FrameType,
    pub payload: Vec<u8>,
}

impl Frame {
    pub fn text(payload: impl Into<Vec<u8>>) -> Frame {
        Frame {
            kind: FrameType::Text,
            payload: payload.into(),
        }
    }

    pub fn binary(payload: impl Into<Vec<u8>>) -> Frame {
        Frame {
            kind: FrameType::Binary,
            payload: payload.into(),
        }
    }

    /// Serialize to the wire format. Fails if the payload exceeds
    /// [`MAX_FRAME_LEN`] so the encoder rejects what the decoder would.
    pub fn encode(&self) -> Result<Vec<u8>, FrameError> {
        if self.payload.len() > MAX_FRAME_LEN {
            return Err(FrameError::TooLarge(self.payload.len()));
        }
        let mut out = Vec::with_capacity(HEADER_LEN + self.payload.len());
        // len fits in u32: bounded by MAX_FRAME_LEN (64 MiB) above.
        out.extend_from_slice(&(self.payload.len() as u32).to_le_bytes());
        out.push(self.kind as u8);
        out.extend_from_slice(&self.payload);
        Ok(out)
    }
}

/// A framing protocol violation. Both variants are fatal for the connection:
/// the stream is desynchronized or the peer is misbehaving, so the caller
/// should drop the transport rather than try to resync.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameError {
    /// Declared (or requested) payload length exceeds [`MAX_FRAME_LEN`].
    TooLarge(usize),
    /// Type tag is not a known [`FrameType`].
    UnknownType(u8),
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameError::TooLarge(n) => {
                write!(f, "frame payload {} exceeds max {}", n, MAX_FRAME_LEN)
            }
            FrameError::UnknownType(b) => write!(f, "unknown frame type tag {}", b),
        }
    }
}

impl std::error::Error for FrameError {}

/// Reassembles frames from a stream of arbitrarily-chunked reads.
///
/// Feed bytes with [`feed`](FrameDecoder::feed), then drain whole frames with
/// [`next`](FrameDecoder::next) until it returns `Ok(None)` (need more bytes).
#[derive(Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> FrameDecoder {
        FrameDecoder { buf: Vec::new() }
    }

    /// Append freshly-read bytes to the internal buffer.
    pub fn feed(&mut self, data: &[u8]) {
        self.buf.extend_from_slice(data);
    }

    /// Pop the next complete frame.
    ///
    /// - `Ok(Some(frame))` — a whole frame was available and consumed.
    /// - `Ok(None)` — not enough bytes buffered yet; feed more.
    /// - `Err(_)` — protocol violation; the caller should close the transport.
    pub fn next(&mut self) -> Result<Option<Frame>, FrameError> {
        if self.buf.len() < HEADER_LEN {
            return Ok(None);
        }

        let len = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        // Reject an oversized length before touching it as an allocation size.
        // Fatal and not drained: the buffer is untrustworthy past this point.
        if len > MAX_FRAME_LEN {
            return Err(FrameError::TooLarge(len));
        }

        let total = HEADER_LEN + len;
        if self.buf.len() < total {
            return Ok(None);
        }

        let type_tag = self.buf[4];
        // Drain the full frame first so the decoder stays usable regardless of
        // how the caller handles the result.
        let payload = self.buf[HEADER_LEN..total].to_vec();
        self.buf.drain(..total);

        match FrameType::from_u8(type_tag) {
            Some(kind) => Ok(Some(Frame { kind, payload })),
            None => Err(FrameError::UnknownType(type_tag)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_all(decoder: &mut FrameDecoder) -> Vec<Frame> {
        let mut frames = Vec::new();
        while let Some(frame) = decoder.next().expect("decode error") {
            frames.push(frame);
        }
        frames
    }

    #[test]
    fn roundtrip_text() {
        let frame = Frame::text(b"{\"module\":\"pty\"}".to_vec());
        let mut decoder = FrameDecoder::new();
        decoder.feed(&frame.encode().unwrap());
        assert_eq!(decode_all(&mut decoder), vec![frame]);
    }

    #[test]
    fn roundtrip_binary() {
        let frame = Frame::binary(vec![0u8, 1, 2, 255, 128]);
        let mut decoder = FrameDecoder::new();
        decoder.feed(&frame.encode().unwrap());
        assert_eq!(decode_all(&mut decoder), vec![frame]);
    }

    #[test]
    fn empty_payload_roundtrips() {
        let frame = Frame::binary(Vec::new());
        let wire = frame.encode().unwrap();
        assert_eq!(wire.len(), HEADER_LEN);
        let mut decoder = FrameDecoder::new();
        decoder.feed(&wire);
        assert_eq!(decode_all(&mut decoder), vec![frame]);
    }

    #[test]
    fn multiple_frames_in_one_chunk() {
        let a = Frame::text(b"first".to_vec());
        let b = Frame::binary(vec![9, 9, 9]);
        let mut wire = a.encode().unwrap();
        wire.extend_from_slice(&b.encode().unwrap());

        let mut decoder = FrameDecoder::new();
        decoder.feed(&wire);
        assert_eq!(decode_all(&mut decoder), vec![a, b]);
    }

    #[test]
    fn frame_split_across_reads() {
        let frame = Frame::binary(vec![1, 2, 3, 4, 5, 6, 7, 8]);
        let wire = frame.encode().unwrap();
        let mut decoder = FrameDecoder::new();

        // Feed one byte at a time: no frame should surface until the last byte.
        for (i, byte) in wire.iter().enumerate() {
            decoder.feed(&[*byte]);
            let popped = decoder.next().unwrap();
            if i + 1 == wire.len() {
                assert_eq!(popped, Some(frame.clone()));
            } else {
                assert_eq!(popped, None);
            }
        }
    }

    #[test]
    fn partial_header_returns_none() {
        let mut decoder = FrameDecoder::new();
        decoder.feed(&[0, 0]); // fewer than HEADER_LEN bytes
        assert_eq!(decoder.next().unwrap(), None);
    }

    #[test]
    fn unknown_type_is_error() {
        // len = 0, type = 7 (unknown)
        let mut decoder = FrameDecoder::new();
        decoder.feed(&[0, 0, 0, 0, 7]);
        assert_eq!(decoder.next(), Err(FrameError::UnknownType(7)));
    }

    #[test]
    fn oversized_length_is_rejected() {
        let bad_len = (MAX_FRAME_LEN + 1) as u32;
        let mut decoder = FrameDecoder::new();
        decoder.feed(&bad_len.to_le_bytes());
        decoder.feed(&[FrameType::Binary as u8]);
        assert_eq!(decoder.next(), Err(FrameError::TooLarge(MAX_FRAME_LEN + 1)));
    }

    #[test]
    fn decoder_recovers_after_one_frame_when_trailing_partial() {
        let a = Frame::text(b"done".to_vec());
        let mut wire = a.encode().unwrap();
        // Append a partial second header.
        wire.extend_from_slice(&[0, 0]);

        let mut decoder = FrameDecoder::new();
        decoder.feed(&wire);
        assert_eq!(decoder.next().unwrap(), Some(a));
        assert_eq!(decoder.next().unwrap(), None); // partial trailer, not an error
    }
}
