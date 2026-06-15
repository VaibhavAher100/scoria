// PTY module
// Provides terminal session management

mod session;
mod shell;
mod osc_scanner;
mod replay;

pub use session::{PtySession, PtyReader, PtyWriter};
pub use shell::{get_shell_by_type, get_default_shell};

use crate::router::{ModuleHandler, ModuleMessage, ModuleType, RouterError, ServerResponse};
use crate::pty::osc_scanner::{OscEvent, OscScanner};
use crate::pty::replay::ReplayBuffer;
use crate::transport::{OutMessage, Sender};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as TokioMutex;
use tokio::time::{self, Duration, Instant};
use uuid::Uuid;

/// Logging macros
macro_rules! log_info {
    ($($arg:tt)*) => {
        eprintln!("[INFO] [PTY] {}", format!($($arg)*));
    };
}

macro_rules! log_error {
    ($($arg:tt)*) => {
        eprintln!("[ERROR] [PTY] {}", format!($($arg)*));
    };
}

macro_rules! log_debug {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            eprintln!("[DEBUG] [PTY] {}", format!($($arg)*));
        }
    };
}

// ============================================================================
// PTY session context
// ============================================================================

/// Max bytes of detached output retained per session for replay on reattach.
/// Past this the oldest bytes are dropped (the buffer flags itself truncated).
const REPLAY_CAP: usize = 256 * 1024;

/// Context for a single PTY session
///
/// Contains all resources required for one PTY session
struct PtySessionContext {
    /// PTY session
    session: Arc<TokioMutex<PtySession>>,
    /// PTY writer
    writer: Arc<Mutex<PtyWriter>>,
    /// Read task handle
    read_task: Option<tokio::task::JoinHandle<()>>,
    /// Bounded buffer of output produced while no client is attached. The read
    /// task pushes here when the sender slot is `None`; a reattach drains it
    /// (M2 persistence). Shared with the read task.
    replay: Arc<TokioMutex<ReplayBuffer>>,
}

impl PtySessionContext {
    /// Create a new session context
    fn new(
        session: Arc<TokioMutex<PtySession>>,
        writer: Arc<Mutex<PtyWriter>>,
    ) -> Self {
        Self {
            session,
            writer,
            read_task: None,
            replay: Arc::new(TokioMutex::new(ReplayBuffer::new(REPLAY_CAP))),
        }
    }
}

// ============================================================================
// PTY handler
// ============================================================================

/// PTY module handler
///
/// Manages the lifecycle of multiple PTY sessions and handles terminal-related messages
pub struct PtyHandler {
    /// Session registry: session_id -> PtySessionContext
    sessions: TokioMutex<HashMap<String, PtySessionContext>>,
    /// Re-bindable message sink slot used to send PTY output to the current
    /// client. `Arc` so the slot itself (not a one-shot snapshot) is shared
    /// into each read task: a reconnect re-points it and output follows the
    /// live connection; while `None` the handler is detached (M2 persistence).
    sender: Arc<TokioMutex<Option<Sender>>>,
}

impl PtyHandler {
    /// Create a new PTY handler
    pub fn new() -> Self {
        Self {
            sessions: TokioMutex::new(HashMap::new()),
            sender: Arc::new(TokioMutex::new(None)),
        }
    }

    /// Set the message sink
    pub async fn set_sender(&self, sender: Sender) {
        let mut guard = self.sender.lock().await;
        *guard = Some(sender);
    }

    /// Detach the current client without tearing sessions down.
    ///
    /// Called when a connection closes. The sender is cleared so nothing tries
    /// to write to the dead socket, but the PTY processes keep running so a
    /// reconnect can re-attach (M2 persistence). Unclaimed sessions are reaped
    /// by the orphan timeout (M2 S5), not here. This is the replacement for
    /// [`Self::cleanup_all`] on the daemon-owned transports.
    ///
    /// Until S5 lands this is UNBOUNDED: each detached session keeps a live
    /// shell, an async read task, and a blocked `spawn_blocking` thread. Repeated
    /// connect/init/disconnect (same user) grows that without a cap. S5's orphan
    /// timeout closes the gap.
    pub async fn detach(&self) {
        let mut guard = self.sender.lock().await;
        *guard = None;
    }

    /// Snapshot of a session's replay buffer (retained detached output). Test
    /// hook for the S3 buffering behavior; the drain path lands in S4.
    #[cfg(test)]
    async fn test_replay_snapshot(&self, session_id: &str) -> Option<Vec<u8>> {
        let replay = {
            let sessions = self.sessions.lock().await;
            Arc::clone(&sessions.get(session_id)?.replay)
        };
        let snapshot = replay.lock().await.snapshot();
        Some(snapshot)
    }

    /// Handle the init message and create a PTY session
    async fn handle_init(
        &self,
        shell_type: Option<String>,
        shell_args: Option<Vec<String>>,
        cwd: Option<String>,
        env: Option<HashMap<String, String>>,
        cols: Option<u16>,
        rows: Option<u16>,
    ) -> Result<Option<ServerResponse>, RouterError> {
        // Generate a unique session_id
        let session_id = Uuid::new_v4().to_string();
        let cols = cols.filter(|value| *value > 0).unwrap_or(80);
        let rows = rows.filter(|value| *value > 0).unwrap_or(24);
        
        log_info!(
            "初始化 PTY 会话: session_id={}, shell_type={:?}, cwd={:?}, size={}x{}",
            session_id,
            shell_type,
            cwd,
            cols,
            rows
        );
        
        // Create the PTY session
        let (pty_session, pty_reader, pty_writer) = PtySession::new(
            cols,
            rows,
            shell_type.as_deref(),
            shell_args.as_ref().map(|v| v.as_slice()),
            cwd.as_deref(),
            env.as_ref(),
        ).map_err(|e| RouterError::ModuleError(format!("创建 PTY 会话失败: {}", e)))?;
        
        // Create the session context
        let pty_session = Arc::new(TokioMutex::new(pty_session));
        let pty_reader = Arc::new(Mutex::new(pty_reader));
        let pty_writer = Arc::new(Mutex::new(pty_writer));

        let mut context = PtySessionContext::new(
            Arc::clone(&pty_session),
            Arc::clone(&pty_writer),
        );

        // Start the PTY output reader task. It shares this session's replay
        // buffer so output produced while detached is retained for reattach.
        let replay = Arc::clone(&context.replay);
        let read_task = self.start_read_task(session_id.clone(), pty_reader, pty_writer, shell_type, replay).await?;
        context.read_task = Some(read_task);
        
        // Store the session context
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(session_id.clone(), context);
        }
        
        log_info!("PTY 会话创建成功: session_id={}", session_id);
        
        // Return a success response that includes the session_id
        Ok(Some(ServerResponse::new(
            ModuleType::Pty,
            "init_complete",
            serde_json::json!({
                "success": true,
                "session_id": session_id
            }),
        )))
    }
    
    /// Start the PTY output reader task
    ///
    /// Returns the task handle, which the caller stores
    async fn start_read_task(
        &self,
        session_id: String,
        reader: Arc<Mutex<PtyReader>>,
        _writer: Arc<Mutex<PtyWriter>>,
        _shell_type: Option<String>,
        replay: Arc<TokioMutex<ReplayBuffer>>,
    ) -> Result<tokio::task::JoinHandle<()>, RouterError> {
        const OUTPUT_BATCH_INTERVAL_MS: u64 = 4;
        const READ_BUFFER_SIZE: usize = 8192;

        // Share the sender SLOT (not a snapshot) into the task. The task reads
        // the current sender per output batch, so a reconnect re-binds output
        // to the new client; while the slot is `None` the session is detached
        // and output is retained in `replay` (M2 persistence).
        let sender_slot = Arc::clone(&self.sender);

        // Start the reader task
        let task = tokio::spawn(async move {
            enum ReadEvent {
                Data(Vec<u8>),
                Eof,
                Error(String),
            }

            let (read_tx, mut read_rx) = tokio::sync::mpsc::channel::<ReadEvent>(32);
            let reader_for_thread = Arc::clone(&reader);

            tokio::task::spawn_blocking(move || {
                loop {
                    let mut reader = match reader_for_thread.lock() {
                        Ok(guard) => guard,
                        Err(_) => break,
                    };
                    let mut local_buf = vec![0u8; READ_BUFFER_SIZE];
                    match reader.read(&mut local_buf) {
                        Ok(0) => {
                            let _ = read_tx.blocking_send(ReadEvent::Eof);
                            break;
                        }
                        Ok(n) => {
                            local_buf.truncate(n);
                            if read_tx.blocking_send(ReadEvent::Data(local_buf)).is_err() {
                                break;
                            }
                        }
                        Err(e) => {
                            let _ = read_tx.blocking_send(ReadEvent::Error(e.to_string()));
                            break;
                        }
                    }
                }
            });

            let mut batch_buffer: Vec<u8> = Vec::new();
            let mut osc_scanner = OscScanner::new();
            let mut pending_shell_events: Vec<OscEvent> = Vec::new();

            loop {
                let first_event = match read_rx.recv().await {
                    Some(event) => event,
                    None => break,
                };

                let mut pending_exit = false;
                let mut pending_error: Option<String> = None;

                match first_event {
                    ReadEvent::Data(data) => {
                        pending_shell_events.extend(osc_scanner.scan(&data));
                        batch_buffer.extend_from_slice(&data);
                    }
                    ReadEvent::Eof => pending_exit = true,
                    ReadEvent::Error(e) => pending_error = Some(e),
                }

                if pending_error.is_none() && !pending_exit {
                    let deadline = Instant::now() + Duration::from_millis(OUTPUT_BATCH_INTERVAL_MS);
                    loop {
                        match time::timeout_at(deadline, read_rx.recv()).await {
                            Ok(Some(ReadEvent::Data(data))) => {
                                pending_shell_events.extend(osc_scanner.scan(&data));
                                batch_buffer.extend_from_slice(&data);
                            }
                            Ok(Some(ReadEvent::Eof)) => {
                                pending_exit = true;
                                break;
                            }
                            Ok(Some(ReadEvent::Error(e))) => {
                                pending_error = Some(e);
                                break;
                            }
                            Ok(None) => {
                                break;
                            }
                            Err(_) => {
                                break;
                            }
                        }
                    }
                }

                // Read the current sender once per flush. A reconnect re-binds
                // this slot, so output follows the live connection; while it is
                // `None` we are detached and retain output for replay (M2).
                let current_sender = { sender_slot.lock().await.clone() };

                if !batch_buffer.is_empty() {
                    log_debug!(
                        "读取 PTY 输出(批处理): session_id={}, {} 字节",
                        session_id,
                        batch_buffer.len()
                    );

                    match &current_sender {
                        Some(sender) => {
                            // Build a binary frame prefixed with the session_id
                            // Format: [session_id_length: u8][session_id: bytes][data: bytes]
                            let session_id_bytes = session_id.as_bytes();
                            let session_id_len = session_id_bytes.len() as u8;

                            let mut frame =
                                Vec::with_capacity(1 + session_id_bytes.len() + batch_buffer.len());
                            frame.push(session_id_len);
                            frame.extend_from_slice(session_id_bytes);
                            frame.extend_from_slice(&batch_buffer);

                            if let Err(e) = sender.send(OutMessage::Binary(frame)).await {
                                // The socket died mid-batch (detach not yet
                                // processed). Don't drop the output or kill the
                                // task — retain it so the reattach can replay it.
                                log_error!(
                                    "发送 PTY 输出失败,缓存以待重连: session_id={}, {}",
                                    session_id,
                                    e
                                );
                                replay.lock().await.push(&batch_buffer);
                            }
                        }
                        None => {
                            // Detached: no client. Retain output for replay.
                            replay.lock().await.push(&batch_buffer);
                        }
                    }
                }

                if !pending_shell_events.is_empty() {
                    if let Some(sender) = &current_sender {
                        for event in pending_shell_events.drain(..) {
                            let event_payload = serde_json::json!({
                                "session_id": session_id,
                                "event": event.event_name(),
                                "source": event.source_name(),
                                "exit_code": event.exit_code(),
                            });
                            let response = ServerResponse::new(
                                ModuleType::Pty,
                                "shell_event",
                                event_payload,
                            );
                            if let Err(e) = sender.send(OutMessage::Text(response.to_json())).await {
                                log_error!("发送 shell_event 失败: session_id={}, {}", session_id, e);
                                break;
                            }
                        }
                    } else {
                        // Detached: shell events (cwd/title hints) are re-emitted
                        // by the next prompt, so dropping them is safe.
                        pending_shell_events.clear();
                    }
                }

                batch_buffer.clear();

                if let Some(e) = pending_error {
                    log_error!("PTY 输出读取错误: session_id={}, {}", session_id, e);
                    break;
                }

                if pending_exit {
                    // EOF: the process has exited
                    log_info!("PTY 输出结束: session_id={}", session_id);

                    // Send the exit event if a client is attached. If detached,
                    // the dead session is surfaced on reattach (S4) or reaped by
                    // the orphan timeout (S5).
                    if let Some(sender) = &current_sender {
                        let exit_response = ServerResponse::new(
                            ModuleType::Pty,
                            "exit",
                            serde_json::json!({
                                "session_id": session_id,
                                "code": 0
                            }),
                        );
                        if let Err(e) = sender.send(OutMessage::Text(exit_response.to_json())).await {
                            log_error!("发送 exit 事件失败: session_id={}, {}", session_id, e);
                        }
                    }
                    break;
                }
            }
        });
        
        Ok(task)
    }
    
    /// Handle the resize message and resize the terminal
    async fn handle_resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<Option<ServerResponse>, RouterError> {
        log_info!("调整终端尺寸: session_id={}, {}x{}", session_id, cols, rows);
        
        let sessions = self.sessions.lock().await;
        let context = sessions.get(session_id)
            .ok_or_else(|| RouterError::ModuleError(format!("SESSION_NOT_FOUND: {}", session_id)))?;
        
        let mut pty = context.session.lock().await;
        pty.resize(cols, rows)
            .map_err(|e| RouterError::ModuleError(format!("调整终端尺寸失败: {}", e)))?;
        
        Ok(None) // resize does not require a response
    }
    
    /// Write data to the PTY for the specified session
    pub async fn write_data(&self, session_id: &str, data: &[u8]) -> Result<(), RouterError> {
        let sessions = self.sessions.lock().await;
        let context = sessions.get(session_id)
            .ok_or_else(|| RouterError::ModuleError(format!("SESSION_NOT_FOUND: {}", session_id)))?;
        
        let mut w = context.writer.lock().unwrap();
        w.write(data)
            .map_err(|e| RouterError::ModuleError(format!("写入 PTY 失败: {}", e)))?;
        
        Ok(())
    }
    
    /// Destroy the specified session
    pub async fn handle_destroy(&self, session_id: &str) -> Result<(), RouterError> {
        log_info!("销毁 PTY 会话: session_id={}", session_id);
        
        let mut sessions = self.sessions.lock().await;
        if let Some(mut context) = sessions.remove(session_id) {
            // Terminate the PTY process
            if let Ok(mut session) = context.session.try_lock() {
                let _ = session.kill();
            }
            
            // End the reader task asynchronously without waiting for completion
            if let Some(task) = context.read_task.take() {
                tokio::spawn(async move {
                    let _ = task.await;
                    log_debug!("读取任务已终止");
                });
            }
            
            log_info!("PTY 会话已销毁: session_id={}", session_id);
            Ok(())
        } else {
            Err(RouterError::ModuleError(format!("SESSION_NOT_FOUND: {}", session_id)))
        }
    }
    
    /// Clean up all sessions (called when the connection closes)
    pub async fn cleanup_all(&self) {
        log_info!("清理所有 PTY 会话");
        
        let mut sessions = self.sessions.lock().await;
        for (session_id, mut context) in sessions.drain() {
            log_info!("清理会话: {}", session_id);
            
            // Terminate the PTY process
            if let Ok(mut session) = context.session.try_lock() {
                let _ = session.kill();
            }
            
            // Wait for the reader task to finish
            if let Some(task) = context.read_task.take() {
                let _ = task.await;
            }
        }
        
        log_info!("所有 PTY 会话已清理");
    }
    
    /// Check whether any sessions are active
    pub async fn has_sessions(&self) -> bool {
        let sessions = self.sessions.lock().await;
        !sessions.is_empty()
    }
}

impl Default for PtyHandler {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ModuleHandler for PtyHandler {
    fn module_type(&self) -> ModuleType {
        ModuleType::Pty
    }
    
    async fn handle(&self, msg: &ModuleMessage) -> Result<Option<ServerResponse>, RouterError> {
        log_debug!("处理 PTY 消息: {}", msg.msg_type);
        
        match msg.msg_type.as_str() {
            "init" => {
                let shell_type: Option<String> = msg.get_field("shell_type");
                let shell_args: Option<Vec<String>> = msg.get_field("shell_args");
                let cwd: Option<String> = msg.get_field("cwd");
                let env: Option<HashMap<String, String>> = msg.get_field("env");
                let cols: Option<u16> = msg.get_field("cols");
                let rows: Option<u16> = msg.get_field("rows");
                
                self.handle_init(shell_type, shell_args, cwd, env, cols, rows).await
            }
            "resize" => {
                // resize requires a session_id
                let session_id: Option<String> = msg.get_field("session_id");
                let session_id = session_id.ok_or_else(|| {
                    RouterError::ModuleError("SESSION_ID_REQUIRED".to_string())
                })?;
                
                let cols: u16 = msg.get_field("cols").unwrap_or(80);
                let rows: u16 = msg.get_field("rows").unwrap_or(24);
                
                self.handle_resize(&session_id, cols, rows).await
            }
            "destroy" => {
                // destroy requires a session_id
                let session_id: Option<String> = msg.get_field("session_id");
                let session_id = session_id.ok_or_else(|| {
                    RouterError::ModuleError("SESSION_ID_REQUIRED".to_string())
                })?;
                
                self.handle_destroy(&session_id).await?;
                Ok(None)
            }
            "env" => {
                // In the original implementation, the env command only logged data; actual environment variables are set during init
                let cwd: Option<String> = msg.get_field("cwd");
                let env: Option<HashMap<String, String>> = msg.get_field("env");
                log_info!("收到 env 命令: cwd={:?}, env={:?}", cwd, env);
                Ok(None)
            }
            _ => {
                log_debug!("未知的 PTY 消息类型: {}", msg.msg_type);
                Err(RouterError::ModuleError(format!("未知的 PTY 消息类型: {}", msg.msg_type)))
            }
        }
    }
}

// Real-PTY tests spawn cmd.exe, so they are Windows-only.
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::transport::{MessageSink, OutMessage, Sender, SinkError};
    use std::sync::Mutex as StdMutex;
    use tokio::time::{sleep, Duration, Instant};

    /// A sink that collects everything sent so a test can assert on the stream.
    #[derive(Default)]
    struct CollectSink {
        binary: StdMutex<Vec<u8>>,
    }

    #[async_trait::async_trait]
    impl MessageSink for CollectSink {
        async fn send(&self, msg: OutMessage) -> Result<(), SinkError> {
            if let OutMessage::Binary(b) = msg {
                self.binary.lock().unwrap().extend_from_slice(&b);
            }
            Ok(())
        }
    }

    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }

    fn count(hay: &[u8], needle: &[u8]) -> usize {
        hay.windows(needle.len()).filter(|w| *w == needle).count()
    }

    async fn only_session_id(handler: &PtyHandler) -> String {
        handler
            .sessions
            .lock()
            .await
            .keys()
            .next()
            .cloned()
            .expect("a session exists")
    }

    /// cmd.exe under ConPTY queries the cursor position (`ESC[6n`) at startup
    /// and blocks until a terminal answers. A headless test has no emulator, so
    /// we answer each new query with a fixed report. ConPTY consumes the report
    /// from the input stream (it asked), so it never reaches the shell's command
    /// line. Returns the new count of answered queries.
    const DSR_QUERY: &[u8] = b"\x1b[6n";
    async fn answer_cursor_queries(
        handler: &PtyHandler,
        session_id: &str,
        output: &[u8],
        answered: usize,
    ) -> usize {
        let seen = count(output, DSR_QUERY);
        for _ in answered..seen {
            let _ = handler.write_data(session_id, b"\x1b[1;1R").await;
        }
        seen
    }

    /// S3 deliverable: while detached (sender slot is `None`), PTY output is
    /// retained in the session's replay buffer rather than dropped or killing
    /// the read task; and after the sender is re-bound, new output flows to the
    /// new client. `echo MARK` produces the marker in the shell's own output.
    #[tokio::test]
    async fn detached_output_is_buffered_then_resumes_on_rebind() {
        let handler = PtyHandler::new();

        // Attach a first client and spawn a cmd.exe session.
        let sink1: Sender = Arc::new(CollectSink::default());
        handler.set_sender(sink1).await;
        handler
            .handle_init(Some("cmd".into()), None, None, None, Some(80), Some(24))
            .await
            .expect("init session");
        let session_id = only_session_id(&handler).await;

        // Detach: the client is gone but the PTY keeps running.
        handler.detach().await;

        // While detached, drive the shell to produce a marked line. Answer its
        // cursor-position queries so it reaches a prompt, then send the command.
        // All of this output must accumulate in the replay buffer, not be lost.
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut answered = 0usize;
        let mut sent = false;
        let buffered = loop {
            let snap = handler
                .test_replay_snapshot(&session_id)
                .await
                .expect("session still present");
            if contains(&snap, b"DETACHED_MARK") {
                break snap;
            }
            answered = answer_cursor_queries(&handler, &session_id, &snap, answered).await;
            if !sent && answered > 0 {
                handler
                    .write_data(&session_id, b"echo DETACHED_MARK\r\n")
                    .await
                    .expect("write while detached");
                sent = true;
            }
            assert!(
                Instant::now() < deadline,
                "detached output was never buffered for replay; buffer={:?}",
                String::from_utf8_lossy(&snap)
            );
            sleep(Duration::from_millis(50)).await;
        };
        // Proof it was buffered while detached, not delivered to a client.
        assert!(contains(&buffered, b"DETACHED_MARK"));

        // Re-bind to a second client. Output must now follow the new sender.
        let sink2 = Arc::new(CollectSink::default());
        handler.set_sender(sink2.clone()).await;

        let deadline = Instant::now() + Duration::from_secs(20);
        let mut answered = 0usize;
        let mut sent = false;
        loop {
            let snap = sink2.binary.lock().unwrap().clone();
            if contains(&snap, b"ATTACHED_MARK") {
                break;
            }
            answered = answer_cursor_queries(&handler, &session_id, &snap, answered).await;
            if !sent {
                handler
                    .write_data(&session_id, b"echo ATTACHED_MARK\r\n")
                    .await
                    .expect("write while attached");
                sent = true;
            }
            assert!(
                Instant::now() < deadline,
                "output did not re-bind to the new client; got={:?}",
                String::from_utf8_lossy(&snap)
            );
            sleep(Duration::from_millis(50)).await;
        }

        handler.handle_destroy(&session_id).await.ok();
    }
}
