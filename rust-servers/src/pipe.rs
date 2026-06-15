// Windows named-pipe transport.
//
// This replaces Termy's loopback WebSocket as the primary transport on Windows.
// The key difference is authentication: Termy's server accepted any local
// connection on 127.0.0.1 and went straight to spawning a shell. Here the
// operating system does the auth. The pipe is created with a DACL that grants
// access only to the current user's SID (and LocalSystem); any other local
// account cannot open it, so no capability token is needed on the wire.
//
// Gated behind `--pipe`; the default transport stays WebSocket until the
// TypeScript client learns to speak framed pipe (M1 slice 4).

#![cfg(windows)]

use std::sync::Arc;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::Mutex as TokioMutex;
use uuid::Uuid;

use crate::framing::{Frame, FrameDecoder, FrameType};
use crate::router::{MessageRouter, ModuleType, ServerResponse};
use crate::transport::{MessageSink, OutMessage, Sender, SinkError};

macro_rules! log_info {
    ($($arg:tt)*) => { eprintln!("[INFO] [pipe] {}", format!($($arg)*)); };
}
macro_rules! log_error {
    ($($arg:tt)*) => { eprintln!("[ERROR] [pipe] {}", format!($($arg)*)); };
}

const READ_BUFFER_SIZE: usize = 8192;

/// Generate an unguessable pipe name. The GUID is defense in depth: the DACL
/// already restricts who may open the pipe, but a random name avoids any
/// fixed target a co-resident process could race to pre-create.
pub fn new_pipe_name() -> String {
    format!(r"\\.\pipe\termy-{}", Uuid::new_v4())
}

/// The connected pipe's write half, adapted to the transport-agnostic sink.
/// Every outbound message is length-prefix framed (see [`crate::framing`]).
struct PipeSink {
    writer: TokioMutex<tokio::io::WriteHalf<NamedPipeServer>>,
}

#[async_trait]
impl MessageSink for PipeSink {
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

/// Create the pipe restricted to the current user and serve clients on it.
///
/// The daemon owns a single shared [`MessageRouter`] for the whole process
/// lifetime; clients attach to it, they do not build their own. When a client
/// disconnects the daemon *detaches* (drops that client's sender) rather than
/// destroying the sessions, then loops to accept the next client on the same
/// pipe name — so a reload reconnects to the same live shells (M2 persistence).
/// Sessions are only reaped by the orphan timeout (M2 S5).
///
/// Connections are sequential: the next pipe instance is created only after the
/// current client disconnects, so at most one client is served at a time (the
/// M2 single-session MVP).
pub async fn serve(pipe_name: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let router = Arc::new(MessageRouter::new());
    let shutdown = router.pty_handler().shutdown_signal();

    let mut first_instance = true;
    loop {
        let server = create_server(pipe_name, first_instance)?;
        first_instance = false;

        log_info!("listening: {}", pipe_name);

        // Await the next client, but bail if the orphan reaper has meanwhile
        // killed the last session with no client attached — there is then
        // nothing left to serve, so the daemon exits instead of accepting
        // forever (B5 no-zombie backstop). `biased` checks shutdown first so a
        // pending signal always wins over a just-arriving connection.
        tokio::select! {
            biased;
            _ = shutdown.notified() => {
                // The signal is ADVISORY: `notify_one` leaves a permit that can
                // outlive the instant it was meant for. A client can reconnect
                // and repopulate sessions in the narrow connect->set_sender
                // window at reaper time, so re-check the authoritative state and
                // only exit when the registry is genuinely empty - otherwise a
                // stale permit would kill live, reattach-eligible shells.
                if router.pty_handler().session_count().await == 0 {
                    log_info!("no sessions and no client; daemon exiting");
                    return Ok(());
                }
                log_info!("idle signal but sessions remain; continuing to serve");
                continue;
            }
            res = server.connect() => res?,
        }
        log_info!("client connected");

        serve_connection(server, &router).await?;

        // The client is gone. Detach (clear the sender) but keep the sessions
        // alive for reconnect; loop to accept the next client on the same name.
        // detach() arms the orphan timer; if no client returns before it fires,
        // the reaper drains the sessions (even an already-empty registry) and
        // signals `shutdown`, so the select above exits the daemon then. A
        // reconnect within the window bumps the attach epoch and cancels it.
        router.detach().await;
        log_info!("client detached; awaiting reconnect");
    }
}

/// Create one instance of the user-only pipe.
///
/// `first_instance` maps to `FILE_FLAG_FIRST_PIPE_INSTANCE`: the very first
/// instance sets it so creation fails if the name is already taken (anti-squat).
/// Later instances clear it, because the loop drops the old instance before
/// creating the next, so the name is briefly released between connections and
/// `FIRST_PIPE_INSTANCE` would spuriously fail.
///
/// Note what actually prevents substitution across that name-free gap: it is
/// NOT the DACL persisting (a pipe's security descriptor lives with the pipe
/// object, not the name, so during the gap the name is unprotected). It is that
/// the pipe name is an unguessable per-process GUID emitted only to the daemon's
/// own stdout, which a foreign account cannot read. If the name were ever made
/// fixed or predictable, this gap would become a real squatting/MITM vector.
fn create_server(
    pipe_name: &str,
    first_instance: bool,
) -> Result<NamedPipeServer, Box<dyn std::error::Error + Send + Sync>> {
    // The security descriptor is only consulted while the pipe is created; the
    // kernel copies it into the pipe object. Scope it so the non-Send raw
    // pointers it holds are dropped before returning.
    let security = security::user_only_security_attributes()?;
    // SAFETY: `security` owns a SECURITY_ATTRIBUTES whose descriptor stays
    // alive across this call; the OS only reads it during pipe creation.
    let server = unsafe {
        ServerOptions::new()
            .first_pipe_instance(first_instance)
            .reject_remote_clients(true) // local connections only
            .create_with_security_attributes_raw(
                pipe_name,
                security.as_ptr() as *mut std::ffi::c_void,
            )?
    };
    Ok(server)
}

/// Serve a single connected client until it disconnects. Session lifecycle is
/// the caller's concern: this only binds the sender, pumps frames, and returns
/// when the connection ends (clean EOF or a framing desync).
async fn serve_connection(
    server: NamedPipeServer,
    router: &Arc<MessageRouter>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let (mut reader, writer) = tokio::io::split(server);
    let sender: Sender = Arc::new(PipeSink {
        writer: TokioMutex::new(writer),
    });

    router.set_sender(Arc::clone(&sender)).await;

    let mut decoder = FrameDecoder::new();
    let mut buf = vec![0u8; READ_BUFFER_SIZE];

    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break; // client closed the pipe
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

/// Handle a binary PTY write: `[sid_len: u8][sid][data]`, same inner format the
/// WebSocket transport used.
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

/// Builds a SECURITY_ATTRIBUTES granting pipe access to the current user only.
mod security {
    use std::io;
    use std::ptr;

    use windows_sys::core::PWSTR;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows_sys::Win32::Security::Authorization::{
        ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        SDDL_REVISION_1,
    };
    use windows_sys::Win32::Security::{
        GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY,
        TOKEN_USER,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// Owns the security descriptor and the attributes that reference it. The
    /// descriptor is freed on drop, so callers must keep this alive until the
    /// pipe has been created.
    pub struct UserOnlySecurity {
        sa: SECURITY_ATTRIBUTES,
        descriptor: PSECURITY_DESCRIPTOR,
    }

    impl UserOnlySecurity {
        pub fn as_ptr(&self) -> *const SECURITY_ATTRIBUTES {
            &self.sa
        }
    }

    impl Drop for UserOnlySecurity {
        fn drop(&mut self) {
            if !self.descriptor.is_null() {
                // SAFETY: `descriptor` was allocated by
                // ConvertStringSecurityDescriptorToSecurityDescriptorW, which
                // documents LocalFree as the matching deallocator.
                unsafe {
                    LocalFree(self.descriptor as HLOCAL);
                }
            }
        }
    }

    /// The pipe's access-control policy as an SDDL string.
    ///
    /// `D:P` -> a protected DACL (do not inherit ACEs from a parent).
    /// `FA`  -> full access. Grant only the current user and LocalSystem (SY);
    /// with no other ACEs, every other principal is implicitly denied.
    pub fn user_only_sddl(sid: &str) -> String {
        format!("D:P(A;;FA;;;{sid})(A;;FA;;;SY)")
    }

    pub fn user_only_security_attributes() -> io::Result<UserOnlySecurity> {
        let sid = current_user_sid_string()?;
        let sddl = user_only_sddl(&sid);
        let descriptor = descriptor_from_sddl(&sddl)?;

        let sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor,
            bInheritHandle: 0,
        };
        Ok(UserOnlySecurity { sa, descriptor })
    }

    fn current_user_sid_string() -> io::Result<String> {
        // SAFETY: each Win32 call below is checked for failure; handles and
        // allocations are released before returning. `GetCurrentProcess`
        // returns a pseudo-handle that does not need closing.
        unsafe {
            let mut token: HANDLE = ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(io::Error::last_os_error());
            }
            let result = sid_string_from_token(token);
            CloseHandle(token);
            result
        }
    }

    /// # Safety
    /// `token` must be a valid, open access token handle.
    unsafe fn sid_string_from_token(token: HANDLE) -> io::Result<String> {
        // First call sizes the buffer; it is expected to fail with
        // ERROR_INSUFFICIENT_BUFFER and set `len`.
        let mut len: u32 = 0;
        GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut len);
        if len == 0 {
            return Err(io::Error::last_os_error());
        }

        let mut buf = vec![0u8; len as usize];
        if GetTokenInformation(token, TokenUser, buf.as_mut_ptr() as *mut _, len, &mut len) == 0 {
            return Err(io::Error::last_os_error());
        }

        // `buf` is a Vec<u8> (1-byte aligned), so read the struct unaligned.
        // The copied-out TOKEN_USER's `User.Sid` still points into `buf`, which
        // stays alive through the ConvertSidToStringSidW call below.
        let token_user = ptr::read_unaligned(buf.as_ptr() as *const TOKEN_USER);
        let mut sid_str: PWSTR = ptr::null_mut();
        if ConvertSidToStringSidW(token_user.User.Sid, &mut sid_str) == 0 {
            return Err(io::Error::last_os_error());
        }

        let s = wide_to_string(sid_str);
        LocalFree(sid_str as HLOCAL);
        Ok(s)
    }

    fn descriptor_from_sddl(sddl: &str) -> io::Result<PSECURITY_DESCRIPTOR> {
        let wide: Vec<u16> = sddl.encode_utf16().chain(std::iter::once(0)).collect();
        let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
        // SAFETY: `wide` is a NUL-terminated UTF-16 string valid for the call.
        // On success the OS allocates a descriptor we take ownership of.
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(descriptor)
    }

    /// # Safety
    /// `p` must point to a NUL-terminated UTF-16 string.
    unsafe fn wide_to_string(p: PWSTR) -> String {
        let mut len = 0usize;
        while *p.add(len) != 0 {
            len += 1;
        }
        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::windows::named_pipe::ClientOptions;
    use tokio::time::{sleep, Duration};

    #[test]
    fn security_attributes_build() {
        let security = security::user_only_security_attributes().expect("build SA");
        assert!(!security.as_ptr().is_null());
    }

    #[test]
    fn sddl_denies_unauthorized_principals() {
        let sddl = security::user_only_sddl("S-1-5-21-1-2-3-1001");
        // Protected DACL: a parent ACL cannot inherit in to widen access.
        assert!(sddl.starts_with("D:P"), "DACL must be protected: {sddl}");
        // Full access for exactly the owner SID and LocalSystem.
        assert!(sddl.contains("(A;;FA;;;S-1-5-21-1-2-3-1001)"));
        assert!(sddl.contains("(A;;FA;;;SY)"));
        // No ACE for Everyone (S-1-1-0 / "WD") or Authenticated Users ("AU"):
        // an unauthorized local process is denied by the absence of any ACE.
        assert!(!sddl.contains("S-1-1-0"), "must not grant Everyone: {sddl}");
        assert!(!sddl.contains(";WD)"), "must not grant Everyone: {sddl}");
        assert!(
            !sddl.contains(";AU)"),
            "must not grant Authenticated Users: {sddl}"
        );
    }

    #[tokio::test]
    async fn pipe_round_trips_a_control_error() {
        let name = new_pipe_name();
        let server_name = name.clone();
        let server = tokio::spawn(async move { serve(&server_name).await });

        // Connect once the server has created the pipe.
        let client = loop {
            match ClientOptions::new().open(&name) {
                Ok(client) => break client,
                Err(_) => sleep(Duration::from_millis(20)).await,
            }
        };

        let (mut reader, mut writer) = tokio::io::split(client);

        // Invalid JSON exercises the full path (framing -> dispatch -> sink)
        // without spawning a shell: the server must reply with a PARSE_ERROR.
        let bad = Frame::text(b"this is not json".to_vec()).encode().unwrap();
        writer.write_all(&bad).await.unwrap();

        let mut decoder = FrameDecoder::new();
        let mut buf = vec![0u8; 4096];
        let response = loop {
            let n = reader.read(&mut buf).await.unwrap();
            assert!(n > 0, "server closed without replying");
            decoder.feed(&buf[..n]);
            if let Some(frame) = decoder.next().unwrap() {
                break frame;
            }
        };

        assert_eq!(response.kind, FrameType::Text);
        let text = String::from_utf8_lossy(&response.payload);
        assert!(text.contains("PARSE_ERROR"), "unexpected reply: {text}");

        server.abort();
    }

    /// Open the pipe, retrying until the server has created the instance.
    async fn connect_client(name: &str) -> tokio::net::windows::named_pipe::NamedPipeClient {
        loop {
            match ClientOptions::new().open(name) {
                Ok(client) => break client,
                Err(_) => sleep(Duration::from_millis(20)).await,
            }
        }
    }

    /// The S2 deliverable: the daemon serves a second client on the same pipe
    /// name after the first disconnects. The pre-M2 code served exactly one
    /// client then returned, so a reload could not reconnect.
    #[tokio::test]
    async fn pipe_accepts_a_second_client_after_disconnect() {
        let name = new_pipe_name();
        let server_name = name.clone();
        let server = tokio::spawn(async move { serve(&server_name).await });

        // First client connects, then disconnects.
        let c1 = connect_client(&name).await;
        drop(c1);

        // A second client must be able to connect on the SAME name — only
        // possible because the daemon looped to create a new pipe instance.
        let c2 = connect_client(&name).await;
        let (mut reader, mut writer) = tokio::io::split(c2);

        // Round-trip a parse error to prove the second connection is served.
        let bad = Frame::text(b"still not json".to_vec()).encode().unwrap();
        writer.write_all(&bad).await.unwrap();

        let mut decoder = FrameDecoder::new();
        let mut buf = vec![0u8; 4096];
        let response = loop {
            let n = reader.read(&mut buf).await.unwrap();
            assert!(n > 0, "server closed without replying to the second client");
            decoder.feed(&buf[..n]);
            if let Some(frame) = decoder.next().unwrap() {
                break frame;
            }
        };

        let text = String::from_utf8_lossy(&response.payload);
        assert!(text.contains("PARSE_ERROR"), "unexpected reply: {text}");

        server.abort();
    }
}
