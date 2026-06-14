// Bounded replay buffer for a detached PTY session.
//
// While a session has no attached client (the user reloaded Obsidian, the
// socket is gone), the PTY keeps producing output. That output is appended
// here so it can be replayed when a client re-attaches. The buffer is capped:
// past the cap the oldest bytes are dropped and `truncated` is set, so the
// client knows the replay it receives is only the tail of what it missed.
//
// Pure data structure - no I/O, no session wiring. Wired into the PTY read
// path in a later M2 slice.

#![allow(dead_code)] // consumed by a later M2 slice

use std::collections::VecDeque;

/// A bounded FIFO byte buffer holding the most recent PTY output while detached.
pub struct ReplayBuffer {
    buf: VecDeque<u8>,
    cap: usize,
    truncated: bool,
}

impl ReplayBuffer {
    /// Create a buffer that retains at most `cap` bytes.
    pub fn new(cap: usize) -> Self {
        Self {
            buf: VecDeque::new(),
            cap,
            truncated: false,
        }
    }

    /// Append output. If the total would exceed the cap, the oldest bytes are
    /// dropped to fit and `truncated` becomes true.
    pub fn push(&mut self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        if self.cap == 0 {
            // Nothing can be retained; record that data was lost.
            self.truncated = true;
            return;
        }
        // A chunk at least as large as the cap collapses to its tail; whatever
        // was already buffered is dropped. Only flag truncation if bytes were
        // actually lost (prior content, or the chunk overflowing the cap).
        if data.len() >= self.cap {
            let dropped = !self.buf.is_empty() || data.len() > self.cap;
            self.buf.clear();
            self.buf.extend(&data[data.len() - self.cap..]);
            if dropped {
                self.truncated = true;
            }
            return;
        }
        self.buf.extend(data);
        if self.buf.len() > self.cap {
            let overflow = self.buf.len() - self.cap;
            self.buf.drain(..overflow);
            self.truncated = true;
        }
    }

    /// The retained bytes, oldest first.
    pub fn snapshot(&self) -> Vec<u8> {
        self.buf.iter().copied().collect()
    }

    /// Drop all retained bytes and reset the truncation flag.
    pub fn clear(&mut self) {
        self.buf.clear();
        self.truncated = false;
    }

    /// Number of retained bytes.
    pub fn len(&self) -> usize {
        self.buf.len()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    /// Whether any output was dropped to stay within the cap (replay is partial).
    pub fn truncated(&self) -> bool {
        self.truncated
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_empty() {
        let b = ReplayBuffer::new(16);
        assert!(b.is_empty());
        assert_eq!(b.len(), 0);
        assert!(!b.truncated());
        assert_eq!(b.snapshot(), Vec::<u8>::new());
    }

    #[test]
    fn accumulates_under_cap_in_order() {
        let mut b = ReplayBuffer::new(16);
        b.push(b"abc");
        b.push(b"def");
        assert_eq!(b.snapshot(), b"abcdef");
        assert_eq!(b.len(), 6);
        assert!(!b.truncated());
    }

    #[test]
    fn exactly_cap_is_not_truncated() {
        let mut b = ReplayBuffer::new(4);
        b.push(b"wxyz");
        assert_eq!(b.snapshot(), b"wxyz");
        assert!(!b.truncated());
    }

    #[test]
    fn drops_oldest_across_pushes() {
        let mut b = ReplayBuffer::new(4);
        b.push(b"ab");
        b.push(b"cde"); // total "abcde" -> keep last 4 "bcde"
        assert_eq!(b.snapshot(), b"bcde");
        assert_eq!(b.len(), 4);
        assert!(b.truncated());
    }

    #[test]
    fn single_chunk_larger_than_cap_keeps_tail() {
        let mut b = ReplayBuffer::new(3);
        b.push(b"abcdefg");
        assert_eq!(b.snapshot(), b"efg");
        assert_eq!(b.len(), 3);
        assert!(b.truncated());
    }

    #[test]
    fn clear_resets_contents_and_flag() {
        let mut b = ReplayBuffer::new(2);
        b.push(b"abcd"); // truncates
        assert!(b.truncated());
        b.clear();
        assert!(b.is_empty());
        assert!(!b.truncated());
        assert_eq!(b.snapshot(), Vec::<u8>::new());
    }

    #[test]
    fn zero_cap_retains_nothing_but_records_loss() {
        let mut b = ReplayBuffer::new(0);
        b.push(b"data");
        assert!(b.is_empty());
        assert!(b.truncated());
    }

    #[test]
    fn empty_push_is_a_noop() {
        let mut b = ReplayBuffer::new(4);
        b.push(b"");
        assert!(b.is_empty());
        assert!(!b.truncated());
    }
}
