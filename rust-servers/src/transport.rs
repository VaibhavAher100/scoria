// Transport-agnostic outbound channel.
//
// The router and PTY layer only need to push messages at the connected client;
// they should not care whether the wire underneath is a WebSocket, a Windows
// named pipe, or a Unix domain socket. `MessageSink` is that seam: each
// transport provides its own implementation, and everything above talks to a
// `Sender` (an `Arc<dyn MessageSink>`).

use async_trait::async_trait;
use std::fmt;
use std::sync::Arc;

/// An application message bound for the client, independent of transport.
///
/// These map to the two payload kinds the protocol carries: `Text` for control
/// JSON, `Binary` for PTY bytes. Transport-level frames (WebSocket ping/pong,
/// pipe framing headers) are the transport's concern, not this enum's.
#[derive(Debug, Clone)]
pub enum OutMessage {
    Text(String),
    Binary(Vec<u8>),
}

/// A failure while sending on the underlying transport. Carries a message for
/// logging; callers treat any error as "the connection is gone".
#[derive(Debug)]
pub struct SinkError(String);

impl SinkError {
    pub fn new(msg: impl Into<String>) -> SinkError {
        SinkError(msg.into())
    }
}

impl fmt::Display for SinkError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for SinkError {}

/// Sends application messages to one connected client over some transport.
#[async_trait]
pub trait MessageSink: Send + Sync {
    async fn send(&self, msg: OutMessage) -> Result<(), SinkError>;
}

/// Shared handle to a transport's sink. Cloneable and usable from many tasks
/// (the read loop sends responses; PTY read tasks stream output).
pub type Sender = Arc<dyn MessageSink>;
