// Unix domain socket transport (macOS / Linux).
//
// The non-Windows counterpart to pipe.rs. Replaces Termy's unauthenticated
// loopback WebSocket as the primary transport on Unix. Authentication is done
// by the operating system via filesystem permissions: the socket lives inside a
// user-only (0700) directory and is itself mode 0600, so only the owning user
// can connect(). No capability token is needed on the wire (the WebSocket
// fallback in server.rs still uses one, because a TCP port carries no such OS
// identity).
//
// Like pipe.rs, the daemon owns ONE shared MessageRouter for the whole process
// lifetime: a client attaches to it, and on disconnect the daemon detaches
// (clearing that client's sender) rather than destroying the sessions, then
// loops to accept the next client on the SAME socket - so an Obsidian reload
// reconnects to the same live shells (M2 persistence). Sessions are only reaped
// by the orphan timeout (M2 S5); an idle daemon with no sessions self-exits (B5).
//
// Connections are sequential (the M2 single-session MVP): the next client is
// accepted only after the current one disconnects and the daemon detaches.
//
// Gated behind `--socket`; the socket path is emitted to stdout as
// {"socket": "...", "pid": N}, mirroring the pipe transport.

#![cfg(unix)]

use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex as TokioMutex;
use uuid::Uuid;

use crate::framing::{Frame, FrameDecoder, FrameType};
use crate::router::{MessageRouter, ModuleType, ServerResponse};
use crate::transport::{MessageSink, OutMessage, Sender, SinkError};

macro_rules! log_info {
    ($($arg:tt)*) => { eprintln!("[INFO] [uds] {}", format!($($arg)*)); };
}
macro_rules! log_error {
    ($($arg:tt)*) => { eprintln!("[ERROR] [uds] {}", format!($($arg)*)); };
}

const READ_BUFFER_SIZE: usize = 8192;

/// Create a user-only (0700) directory and return the socket path inside it.
///
/// The 0700 directory is the real access boundary: even in the brief window
/// between binding the socket and chmod-ing it to 0600, no other local user can
/// traverse into the directory to reach the socket. Base is `$XDG_RUNTIME_DIR`
/// (per-user, already private on Linux) when set, otherwise the system temp dir
/// (which is world-traversable, so the private subdirectory is essential there).
/// The directory name carries a random GUID - defense in depth, like the pipe
/// name - and is removed on daemon exit.
pub fn new_socket_path() -> std::io::Result<PathBuf> {
    let base = pick_base_dir();
    let dir = base.join(format!("termy-{}", Uuid::new_v4()));
    // mode(0o700) is masked by umask, which can only CLEAR bits; 0700 has no
    // group/other bits to begin with, so the result is 0700 under any umask.
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    Ok(dir.join("daemon.sock"))
}

/// Choose the base directory the private socket dir is created under.
///
/// Prefer `$XDG_RUNTIME_DIR`, but only if it is genuinely the caller's private
/// runtime dir: a directory owned by the current user with no group/other access
/// (the canonical contract is 0700). A poisoned env var pointing at a
/// world-writable or attacker-owned location is rejected so we never plant the
/// socket dir somewhere another user could race on its parent. On failure (or an
/// unset var, the normal case on macOS) fall back to the system temp dir, where
/// the 0700 subdirectory we create is the boundary.
fn pick_base_dir() -> PathBuf {
    if let Some(xdg) = std::env::var_os("XDG_RUNTIME_DIR") {
        let p = PathBuf::from(xdg);
        if is_private_owned_dir(&p) {
            return p;
        }
    }
    std::env::temp_dir()
}

/// True if `p` resolves to a directory owned by the current effective uid with
/// no group/other permission bits set.
fn is_private_owned_dir(p: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match std::fs::metadata(p) {
        // SAFETY: geteuid is always safe; it reads the process's effective uid.
        Ok(m) => m.is_dir() && m.uid() == unsafe { libc::geteuid() } && (m.mode() & 0o077) == 0,
        Err(_) => false,
    }
}

/// Bind a fresh Unix socket at `path` and serve clients until the daemon exits.
pub async fn serve(path: &Path) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let listener = UnixListener::bind(path)?;
    // Restrict the socket node itself to the owner. The 0700 parent directory
    // already blocks other users; this is belt-and-suspenders on the socket.
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;

    let router = Arc::new(MessageRouter::new());
    let shutdown = router.pty_handler().shutdown_signal();

    log_info!("listening: {}", path.display());

    let result = accept_loop(&listener, &router, &shutdown).await;

    // Best-effort cleanup: drop the socket node and its private directory so a
    // crashed predecessor does not litter the runtime dir.
    cleanup(path);
    result
}

/// Accept clients one at a time, detaching (not destroying) sessions between
/// connections so a reload reconnects. Exits when the orphan reaper signals
/// shutdown and no sessions remain (B5 no-zombie backstop); `biased` checks the
/// signal before a just-arriving connection.
async fn accept_loop(
    listener: &UnixListener,
    router: &Arc<MessageRouter>,
    shutdown: &Arc<tokio::sync::Notify>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    loop {
        tokio::select! {
            biased;
            _ = shutdown.notified() => {
                // The signal is ADVISORY (notify_one leaves a permit that can
                // outlive its moment): a client may have reconnected in the
                // reaper's connect->set_sender window, so re-check the
                // authoritative count and only exit when truly empty.
                if router.pty_handler().session_count().await == 0 {
                    log_info!("no sessions and no client; daemon exiting");
                    return Ok(());
                }
                log_info!("idle signal but sessions remain; continuing to serve");
                continue;
            }
            res = listener.accept() => {
                let (stream, _addr) = res?;
                log_info!("client connected");
                serve_connection(stream, router).await?;
                // The client is gone. Detach (clear the sender) but keep the
                // sessions alive for reconnect; detach() arms the orphan timer.
                router.detach().await;
                log_info!("client detached; awaiting reconnect");
            }
        }
    }
}

/// Remove the socket node and its (now-empty) private directory. Best-effort:
/// failures only leave a stale entry, which a future GUID-named start ignores.
fn cleanup(path: &Path) {
    let _ = std::fs::remove_file(path);
    if let Some(dir) = path.parent() {
        let _ = std::fs::remove_dir(dir);
    }
}

/// The connected socket's write half, adapted to the transport-agnostic sink.
/// Every outbound message is length-prefix framed (see [`crate::framing`]).
struct UnixSink {
    writer: TokioMutex<tokio::io::WriteHalf<UnixStream>>,
}

#[async_trait]
impl MessageSink for UnixSink {
    async fn send(&self, msg: OutMessage) -> Result<(), SinkError> {
        let frame = match msg {
            OutMessage::Text(text) => Frame::text(text.into_bytes()),
            OutMessage::Binary(data) => Frame::binary(data),
        };
        let bytes = frame.encode().map_err(|e| SinkError::new(e.to_string()))?;
        let mut writer = self.writer.lock().await;
        writer
            .write_all(&bytes)
            .await
            .map_err(|e| SinkError::new(e.to_string()))?;
        writer
            .flush()
            .await
            .map_err(|e| SinkError::new(e.to_string()))?;
        Ok(())
    }
}

/// Serve a single connected client until it disconnects. Session lifecycle is
/// the caller's concern: this binds the sender, pumps frames, and returns when
/// the connection ends (clean EOF or a framing desync).
async fn serve_connection(
    stream: UnixStream,
    router: &Arc<MessageRouter>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (mut reader, writer) = tokio::io::split(stream);
    let sender: Sender = Arc::new(UnixSink {
        writer: TokioMutex::new(writer),
    });

    router.set_sender(Arc::clone(&sender)).await;

    let mut decoder = FrameDecoder::new();
    let mut buf = vec![0u8; READ_BUFFER_SIZE];

    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break; // client closed the socket
        }
        decoder.feed(&buf[..n]);
        loop {
            match decoder.next() {
                Ok(Some(frame)) => dispatch(router, &sender, frame).await,
                Ok(None) => break,
                Err(e) => {
                    // Protocol desync. Drop the connection; the caller detaches
                    // and waits for a fresh client (sessions survive).
                    log_error!("framing error, dropping connection: {}", e);
                    return Ok(());
                }
            }
        }
    }

    log_info!("client disconnected");
    Ok(())
}

// Frame dispatch mirrors pipe.rs (and the WebSocket text/binary paths in
// server.rs): the wire protocol is transport-neutral, and each transport module
// owns its own thin copy, consistent with how pipe.rs and server.rs are split.

async fn dispatch(router: &Arc<MessageRouter>, sender: &Sender, frame: Frame) {
    match frame.kind {
        FrameType::Text => {
            let text = String::from_utf8_lossy(&frame.payload);
            handle_control(router, sender, &text).await;
        }
        FrameType::Binary => handle_pty_write(router, &frame.payload).await,
    }
}

/// Handle a control message (JSON), mirroring the WebSocket text path.
async fn handle_control(router: &Arc<MessageRouter>, sender: &Sender, text: &str) {
    match router.parse_message(text) {
        Ok(msg) => {
            let module = msg.module;
            match router.route(msg).await {
                Ok(Some(response)) => send_response(sender, &response).await,
                Ok(None) => {}
                Err(e) => {
                    log_error!("module error: {}", e);
                    send_response(sender, &router.create_error_response(module, &e)).await;
                }
            }
        }
        Err(e) => {
            log_error!("parse error: {}", e);
            let module = router.try_parse_module(text).unwrap_or(ModuleType::Pty);
            let response =
                ServerResponse::error(module, "PARSE_ERROR", &format!("parse failed: {}", e));
            send_response(sender, &response).await;
        }
    }
}

/// Handle a binary PTY write: `[sid_len: u8][sid][data]`, the same inner format
/// the WebSocket and pipe transports use.
async fn handle_pty_write(router: &Arc<MessageRouter>, data: &[u8]) {
    if data.is_empty() {
        return;
    }
    let sid_len = data[0] as usize;
    if data.len() < 1 + sid_len {
        log_error!("binary frame too short for session id");
        return;
    }
    let session_id = match std::str::from_utf8(&data[1..1 + sid_len]) {
        Ok(s) => s,
        Err(_) => {
            log_error!("session id is not valid UTF-8");
            return;
        }
    };
    if let Err(e) = router
        .pty_handler()
        .write_data(session_id, &data[1 + sid_len..])
        .await
    {
        log_error!("pty write failed: session_id={}, {}", session_id, e);
    }
}

async fn send_response(sender: &Sender, response: &ServerResponse) {
    if let Err(e) = sender.send(OutMessage::Text(response.to_json())).await {
        log_error!("failed to send response: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::time::{sleep, Duration};

    /// Connect to the socket, retrying until the server has bound it.
    async fn connect_client(path: &Path) -> UnixStream {
        loop {
            match UnixStream::connect(path).await {
                Ok(client) => break client,
                Err(_) => sleep(Duration::from_millis(20)).await,
            }
        }
    }

    /// Read a single framed reply from the client side.
    async fn read_one_frame(reader: &mut (impl AsyncReadExt + Unpin)) -> Frame {
        let mut decoder = FrameDecoder::new();
        let mut buf = vec![0u8; 4096];
        loop {
            let n = reader.read(&mut buf).await.unwrap();
            assert!(n > 0, "server closed without replying");
            decoder.feed(&buf[..n]);
            if let Some(frame) = decoder.next().unwrap() {
                break frame;
            }
        }
    }

    #[tokio::test]
    async fn socket_round_trips_a_control_error() {
        let path = new_socket_path().unwrap();
        let server_path = path.clone();
        let server = tokio::spawn(async move { serve(&server_path).await });

        let client = connect_client(&path).await;
        let (mut reader, mut writer) = tokio::io::split(client);

        // Invalid JSON exercises framing -> dispatch -> sink without spawning a
        // shell: the server must reply with a PARSE_ERROR.
        let bad = Frame::text(b"this is not json".to_vec()).encode().unwrap();
        writer.write_all(&bad).await.unwrap();

        let response = read_one_frame(&mut reader).await;
        assert_eq!(response.kind, FrameType::Text);
        let text = String::from_utf8_lossy(&response.payload);
        assert!(text.contains("PARSE_ERROR"), "unexpected reply: {text}");

        server.abort();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    /// The S2 persistence deliverable: the daemon serves a second client on the
    /// same socket after the first disconnects (sessions survive a reconnect).
    #[tokio::test]
    async fn accepts_a_second_client_after_disconnect() {
        let path = new_socket_path().unwrap();
        let server_path = path.clone();
        let server = tokio::spawn(async move { serve(&server_path).await });

        // First client connects, then disconnects.
        let c1 = connect_client(&path).await;
        drop(c1);

        // A second client must be able to connect and be served on the SAME
        // socket - only possible because the daemon looped to accept again.
        let c2 = connect_client(&path).await;
        let (mut reader, mut writer) = tokio::io::split(c2);

        let bad = Frame::text(b"still not json".to_vec()).encode().unwrap();
        writer.write_all(&bad).await.unwrap();

        let response = read_one_frame(&mut reader).await;
        let text = String::from_utf8_lossy(&response.payload);
        assert!(text.contains("PARSE_ERROR"), "unexpected reply: {text}");

        server.abort();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn private_dir_check_accepts_0700_rejects_world_writable() {
        let base = std::env::temp_dir().join(format!("termy-test-{}", Uuid::new_v4()));
        std::fs::create_dir(&base).unwrap();

        // Owned by us and 0700 -> accepted as a private runtime dir.
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(is_private_owned_dir(&base));

        // Group/other bits set -> rejected (a poisoned XDG_RUNTIME_DIR).
        std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(!is_private_owned_dir(&base));

        // Nonexistent -> rejected.
        std::fs::remove_dir_all(&base).unwrap();
        assert!(!is_private_owned_dir(&base));
    }

    /// The auth mechanism: the socket is mode 0600 inside a 0700 directory, so
    /// only the owning user can connect (no other local account can reach it).
    #[tokio::test]
    async fn socket_and_dir_are_owner_only() {
        let path = new_socket_path().unwrap();
        let server_path = path.clone();
        let server = tokio::spawn(async move { serve(&server_path).await });

        // Connect first so the server is provably past bind + chmod.
        let client = connect_client(&path).await;

        let sock_mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        let dir_mode = std::fs::metadata(path.parent().unwrap())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(sock_mode, 0o600, "socket must be owner rw only");
        assert_eq!(dir_mode, 0o700, "socket directory must be owner only");

        drop(client);
        server.abort();
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
