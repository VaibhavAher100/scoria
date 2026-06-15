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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tokio::sync::{Mutex as TokioMutex, Notify};
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

/// How long a detached daemon may keep its sessions alive with no client before
/// they are reaped. A reload reconnects in seconds; this is the cap on a client
/// that never comes back, so the shells + tasks don't leak forever.
const ORPHAN_TIMEOUT: Duration = Duration::from_secs(300);

/// Shared session registry. `Arc` so the orphan-timeout task (spawned from
/// `detach`) can reap it after the timeout without borrowing `self`.
type Sessions = Arc<TokioMutex<HashMap<String, PtySessionContext>>>;

/// Kill every session's PTY and drain the registry. Shared by `cleanup_all`
/// (WS disconnect) and the orphan-timeout reaper.
///
/// The read task is `abort`ed, not awaited: after `kill` the ConPTY master read
/// may not return EOF until its handle is dropped (which happens as `context`
/// drops here), so awaiting the task inline would block this function — and the
/// `sessions` lock it holds — until then. Aborting releases the lock at once;
/// the blocked reader thread exits when the dropped master closes its pipe.
async fn reap_sessions(sessions: &Sessions) {
    let mut guard = sessions.lock().await;
    for (session_id, mut context) in guard.drain() {
        log_info!("清理会话: {}", session_id);
        if let Ok(mut session) = context.session.try_lock() {
            let _ = session.kill();
        }
        if let Some(task) = context.read_task.take() {
            task.abort();
        }
    }
}

/// Wrap PTY output bytes in the client's binary frame:
/// `[session_id_len: u8][session_id: bytes][data: bytes]`. Used for both live
/// output and replayed (buffered) output so the client can't tell them apart.
fn frame_pty_output(session_id: &str, data: &[u8]) -> Vec<u8> {
    let id = session_id.as_bytes();
    let mut frame = Vec::with_capacity(1 + id.len() + data.len());
    frame.push(id.len() as u8);
    frame.extend_from_slice(id);
    frame.extend_from_slice(data);
    frame
}

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
    /// Signalled on reattach to wake the read task so it flushes `replay` to the
    /// new client even when the shell is idle (no PTY output to wake it). Shared
    /// with the read task.
    reattach: Arc<Notify>,
    /// Set by the read task when it terminates (shell EOF/exit/read error). A
    /// session whose shell exited while detached lingers in the registry until
    /// the orphan reaper runs; `reattach` checks this so it reports the dead
    /// shell as gone (SESSION_NOT_FOUND → client respawns) instead of adopting a
    /// corpse that will never deliver output or an exit event. Shared with the
    /// read task.
    exited: Arc<AtomicBool>,
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
            reattach: Arc::new(Notify::new()),
            exited: Arc::new(AtomicBool::new(false)),
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
    sessions: Sessions,
    /// Re-bindable message sink slot used to send PTY output to the current
    /// client. `Arc` so the slot itself (not a one-shot snapshot) is shared
    /// into each read task: a reconnect re-points it and output follows the
    /// live connection; while `None` the handler is detached (M2 persistence).
    sender: Arc<TokioMutex<Option<Sender>>>,
    /// Bumped every time a client attaches (`set_sender`). The orphan-timeout
    /// task captures the value at `detach` and only reaps if it is unchanged
    /// when the timer fires — so a reconnect (which bumps it) cancels a pending
    /// reap, and a stale timer from an earlier detach can't kill a session that
    /// a newer client has since claimed (attach epochs, M2 S5).
    attach_epoch: Arc<AtomicU64>,
    /// How long sessions survive with no client before the orphan reaper kills
    /// them. Field (not the `ORPHAN_TIMEOUT` const directly) so tests can shrink
    /// it.
    orphan_timeout: Duration,
    /// The one in-flight orphan-timeout timer, if any. `detach` aborts the prior
    /// timer before arming a new one and `set_sender` aborts it on attach, so at
    /// most one reaper task is ever live — without this a flaky transport that
    /// detaches repeatedly would accumulate one sleeping task per disconnect for
    /// the full timeout window (the epoch check already makes the extras no-ops,
    /// this just stops them piling up). `std::sync::Mutex` because the critical
    /// section is a non-blocking abort + store, never held across an await.
    orphan_timer: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
}

impl PtyHandler {
    /// Create a new PTY handler
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(TokioMutex::new(HashMap::new())),
            sender: Arc::new(TokioMutex::new(None)),
            attach_epoch: Arc::new(AtomicU64::new(0)),
            orphan_timeout: ORPHAN_TIMEOUT,
            orphan_timer: Arc::new(Mutex::new(None)),
        }
    }

    /// Set the message sink. Bumps the attach epoch so any orphan-timeout timer
    /// pending from a prior detach sees the change and cancels its reap.
    pub async fn set_sender(&self, sender: Sender) {
        let mut guard = self.sender.lock().await;
        *guard = Some(sender);
        self.attach_epoch.fetch_add(1, Ordering::SeqCst);
        // A client is back: cancel the pending reap (the epoch bump already
        // neutralizes it; this frees the sleeping task immediately).
        if let Some(timer) = self.orphan_timer.lock().unwrap().take() {
            timer.abort();
        }
    }

    /// Detach the current client without tearing sessions down.
    ///
    /// Called when a connection closes. The sender is cleared so nothing tries
    /// to write to the dead socket, but the PTY processes keep running so a
    /// reconnect can re-attach (M2 persistence). This is the replacement for
    /// [`Self::cleanup_all`] on the daemon-owned transports.
    ///
    /// A detached session is bounded by the orphan timeout: this spawns a timer
    /// that reaps all sessions after `orphan_timeout` UNLESS a client attaches
    /// in the meantime (which bumps `attach_epoch`, so the timer sees the change
    /// and cancels). That epoch check is also what stops a stale timer from an
    /// earlier detach from killing a session a newer client has reclaimed.
    pub async fn detach(&self) {
        {
            let mut guard = self.sender.lock().await;
            *guard = None;
        }

        // Capture the epoch as of this detach. If anything attaches before the
        // timer fires, the epoch advances and the reap is skipped.
        let epoch = self.attach_epoch.load(Ordering::SeqCst);
        let sessions = Arc::clone(&self.sessions);
        let attach_epoch = Arc::clone(&self.attach_epoch);
        let timeout = self.orphan_timeout;
        let timer = tokio::spawn(async move {
            time::sleep(timeout).await;
            if attach_epoch.load(Ordering::SeqCst) == epoch {
                // Still detached on this same epoch: no client came back.
                log_info!("孤儿会话超时,清理");
                reap_sessions(&sessions).await;
            }
        });
        // Keep at most one live timer: abort any prior one before storing this.
        if let Some(prev) = self.orphan_timer.lock().unwrap().replace(timer) {
            prev.abort();
        }
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
        // buffer (output retained while detached) and reattach signal (wakes it
        // to flush that buffer to a reconnecting client).
        let replay = Arc::clone(&context.replay);
        let reattach = Arc::clone(&context.reattach);
        let exited = Arc::clone(&context.exited);
        let read_task = self
            .start_read_task(session_id.clone(), pty_reader, pty_writer, shell_type, replay, reattach, exited)
            .await?;
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
    // Setup-style task spawner: the args are independent per-session handles, not
    // worth bundling into a struct for one call site.
    #[allow(clippy::too_many_arguments)]
    async fn start_read_task(
        &self,
        session_id: String,
        reader: Arc<Mutex<PtyReader>>,
        _writer: Arc<Mutex<PtyWriter>>,
        _shell_type: Option<String>,
        replay: Arc<TokioMutex<ReplayBuffer>>,
        reattach: Arc<Notify>,
        exited: Arc<AtomicBool>,
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
                let mut pending_exit = false;
                let mut pending_error: Option<String> = None;

                // Wait for PTY output OR a reattach signal. A reattach wake
                // carries no data: it just makes the loop fall through to the
                // flush step so buffered output reaches a reconnecting client
                // even when the shell is idle. `biased` drains real output first.
                let first_event = tokio::select! {
                    biased;
                    ev = read_rx.recv() => match ev {
                        Some(event) => Some(event),
                        None => break,
                    },
                    _ = reattach.notified() => None,
                };

                if let Some(event) = first_event {
                    match event {
                        ReadEvent::Data(data) => {
                            pending_shell_events.extend(osc_scanner.scan(&data));
                            batch_buffer.extend_from_slice(&data);
                        }
                        ReadEvent::Eof => pending_exit = true,
                        ReadEvent::Error(e) => pending_error = Some(e),
                    }

                    if pending_error.is_none() && !pending_exit {
                        let deadline =
                            Instant::now() + Duration::from_millis(OUTPUT_BATCH_INTERVAL_MS);
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
                }

                // Read the current sender once per flush. A reconnect re-binds
                // this slot, so output follows the live connection; while it is
                // `None` we are detached and retain output for replay (M2).
                let current_sender = { sender_slot.lock().await.clone() };

                match &current_sender {
                    Some(sender) => {
                        // Attached. Flush any output buffered while detached
                        // FIRST, then this batch. The read task is the single
                        // writer to the sink, so draining here guarantees the
                        // client sees missed bytes ahead of live output, in
                        // order. `attached` stays false until the flush lands so
                        // a mid-flush disconnect re-buffers without reordering.
                        let buffered = {
                            let mut b = replay.lock().await;
                            if b.is_empty() {
                                Vec::new()
                            } else {
                                let snapshot = b.snapshot();
                                b.clear();
                                snapshot
                            }
                        };
                        let mut attached = true;
                        if !buffered.is_empty() {
                            let frame = frame_pty_output(&session_id, &buffered);
                            if let Err(e) = sender.send(OutMessage::Binary(frame)).await {
                                log_error!("重放缓存失败,保留以待下次重连: session_id={}, {}", session_id, e);
                                replay.lock().await.push(&buffered);
                                attached = false;
                            }
                        }

                        if !batch_buffer.is_empty() {
                            log_debug!(
                                "读取 PTY 输出(批处理): session_id={}, {} 字节",
                                session_id,
                                batch_buffer.len()
                            );
                            if attached {
                                let frame = frame_pty_output(&session_id, &batch_buffer);
                                if let Err(e) = sender.send(OutMessage::Binary(frame)).await {
                                    // The socket died mid-batch. Don't drop the
                                    // output or kill the task — retain it for the
                                    // next reattach to replay.
                                    log_error!(
                                        "发送 PTY 输出失败,缓存以待重连: session_id={}, {}",
                                        session_id,
                                        e
                                    );
                                    replay.lock().await.push(&batch_buffer);
                                    attached = false;
                                }
                            } else {
                                // Flush already failed (sender gone): buffer this
                                // batch after the re-buffered bytes, order intact.
                                replay.lock().await.push(&batch_buffer);
                            }
                        }

                        if attached && !pending_shell_events.is_empty() {
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
                                if let Err(e) =
                                    sender.send(OutMessage::Text(response.to_json())).await
                                {
                                    log_error!("发送 shell_event 失败: session_id={}, {}", session_id, e);
                                    break;
                                }
                            }
                        } else {
                            // Detached mid-flush: drop shell events (re-emitted
                            // by the next prompt).
                            pending_shell_events.clear();
                        }
                    }
                    None => {
                        // Detached: no client. Retain output; drop shell events.
                        if !batch_buffer.is_empty() {
                            replay.lock().await.push(&batch_buffer);
                        }
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
                    // the `exited` flag (set below) makes a later reattach report
                    // SESSION_NOT_FOUND so the client respawns instead of adopting
                    // a dead shell; the context is reaped by the orphan timeout.
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

            // The read loop ended (EOF / exit / read error): the shell is gone.
            // Mark the session so a reattach in the window before the orphan
            // reaper removes the context does not adopt a dead shell.
            exited.store(true, Ordering::SeqCst);
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
    
    /// Re-attach a reconnecting client to an existing session.
    ///
    /// No PTY is spawned: the session kept running while detached. This validates
    /// the session still exists (it may have been reaped by the orphan timeout)
    /// and wakes the read task to flush the session's replay buffer to the now-
    /// current client, ahead of live output. The actual replay bytes travel on
    /// the normal binary-output path (the read task is the single writer, so
    /// ordering is preserved); this only reports whether the replay was partial.
    async fn handle_reattach(
        &self,
        session_id: &str,
    ) -> Result<Option<ServerResponse>, RouterError> {
        // Clone the per-session handles out before touching the buffer, so we
        // never hold the sessions lock while locking replay (lock-order safety).
        let (notify, replay) = {
            let mut sessions = self.sessions.lock().await;
            let context = sessions
                .get(session_id)
                .ok_or_else(|| RouterError::ModuleError(format!("SESSION_NOT_FOUND: {}", session_id)))?;
            // The shell exited while detached: the read task is gone, so notifying
            // it would do nothing and no exit event will ever arrive. Drop the
            // corpse and report it gone so the client respawns (its read task
            // already set `exited`, so no kill/abort is needed here).
            if context.exited.load(Ordering::SeqCst) {
                sessions.remove(session_id);
                return Err(RouterError::ModuleError(format!(
                    "SESSION_NOT_FOUND: {}",
                    session_id
                )));
            }
            (Arc::clone(&context.reattach), Arc::clone(&context.replay))
        };

        // Advisory snapshot at request time: the actual drain happens in the
        // read task, so a few ms of live output may land between here and the
        // flush. The client treats these as hints, not guarantees. (Surfacing
        // `truncated` on the drained frame itself is deferred to S6, where the
        // TS client decides how to react to a lossy replay.)
        let (replay_bytes, truncated) = {
            let buf = replay.lock().await;
            (buf.len(), buf.truncated())
        };

        // Wake the read task to drain the buffer to the new client even if the
        // shell is idle. The read task does the send (single writer).
        notify.notify_one();

        log_info!(
            "重新连接会话: session_id={}, 待重放 {} 字节 (truncated={})",
            session_id,
            replay_bytes,
            truncated
        );

        Ok(Some(ServerResponse::new(
            ModuleType::Pty,
            "reattach_complete",
            serde_json::json!({
                "success": true,
                "session_id": session_id,
                "replay_bytes": replay_bytes,
                "truncated": truncated,
            }),
        )))
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
    
    /// Clean up all sessions (called when the WS connection closes)
    pub async fn cleanup_all(&self) {
        log_info!("清理所有 PTY 会话");
        reap_sessions(&self.sessions).await;
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
            "reattach" => {
                // reattach requires a session_id
                let session_id: Option<String> = msg.get_field("session_id");
                let session_id = session_id.ok_or_else(|| {
                    RouterError::ModuleError("SESSION_ID_REQUIRED".to_string())
                })?;

                self.handle_reattach(&session_id).await
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

    /// S4 deliverable: a client that reconnects and sends `reattach` for an
    /// existing session receives the output produced while it was detached
    /// (drained from the replay buffer), with no new PTY spawned.
    #[tokio::test]
    async fn buffered_output_is_replayed_to_a_reattached_client() {
        let handler = PtyHandler::new();

        let sink1: Sender = Arc::new(CollectSink::default());
        handler.set_sender(sink1).await;
        handler
            .handle_init(Some("cmd".into()), None, None, None, Some(80), Some(24))
            .await
            .expect("init session");
        let session_id = only_session_id(&handler).await;

        // Detach, then produce a marked line while no client is attached.
        handler.detach().await;
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut answered = 0usize;
        let mut sent = false;
        loop {
            let snap = handler
                .test_replay_snapshot(&session_id)
                .await
                .expect("session present");
            if contains(&snap, b"REPLAY_MARK") {
                break;
            }
            answered = answer_cursor_queries(&handler, &session_id, &snap, answered).await;
            if !sent && answered > 0 {
                handler
                    .write_data(&session_id, b"echo REPLAY_MARK\r\n")
                    .await
                    .expect("write while detached");
                sent = true;
            }
            assert!(
                Instant::now() < deadline,
                "marker never buffered; buffer={:?}",
                String::from_utf8_lossy(&snap)
            );
            sleep(Duration::from_millis(50)).await;
        }

        // Reconnect a new client and reattach by session_id (no respawn).
        let sink2 = Arc::new(CollectSink::default());
        handler.set_sender(sink2.clone()).await;
        let resp = handler
            .handle_reattach(&session_id)
            .await
            .expect("reattach ok")
            .expect("reattach response");
        assert!(
            resp.to_json().contains("reattach_complete"),
            "unexpected reattach reply: {}",
            resp.to_json()
        );

        // The buffered output must be replayed to the reconnected client.
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let got = sink2.binary.lock().unwrap().clone();
            if contains(&got, b"REPLAY_MARK") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "replay was not delivered to the reattached client; got={:?}",
                String::from_utf8_lossy(&got)
            );
            sleep(Duration::from_millis(50)).await;
        }

        // The buffer is drained after replay (not re-sent on a later reattach).
        let after = handler
            .test_replay_snapshot(&session_id)
            .await
            .expect("session present");
        assert!(
            !contains(&after, b"REPLAY_MARK"),
            "replay buffer was not drained: {:?}",
            String::from_utf8_lossy(&after)
        );

        handler.handle_destroy(&session_id).await.ok();
    }

    /// A session whose shell exits while detached must not be adopted by a later
    /// reattach: the read task is gone, so `reattach` reports SESSION_NOT_FOUND
    /// and drops the dead context (the client then respawns a fresh shell)
    /// instead of believing it holds a live shell that never emits again.
    #[tokio::test]
    async fn reattach_to_an_exited_session_is_rejected() {
        let handler = PtyHandler::new();

        let sink: Sender = Arc::new(CollectSink::default());
        handler.set_sender(sink).await;
        handler
            .handle_init(Some("cmd".into()), None, None, None, Some(80), Some(24))
            .await
            .expect("init session");
        let session_id = only_session_id(&handler).await;

        // Detach, then simulate the read task having ended because the shell
        // exited while no client was attached. On Windows the ConPTY master does
        // not return EOF on a clean child exit (the same reason the reaper aborts
        // rather than awaits the read task), so we set the flag directly: the
        // behavior under test is that reattach rejects an exited session, not the
        // timing of how EOF eventually arrives. Keep the PTY handle to clean up.
        handler.detach().await;
        let session_arc = {
            let sessions = handler.sessions.lock().await;
            let ctx = sessions.get(&session_id).expect("session present");
            ctx.exited.store(true, Ordering::SeqCst);
            Arc::clone(&ctx.session)
        };

        // Reattach must reject the dead shell and drop the corpse.
        let err = handler
            .handle_reattach(&session_id)
            .await
            .expect_err("reattach to an exited session must error");
        assert!(
            err.to_string().contains("SESSION_NOT_FOUND"),
            "expected SESSION_NOT_FOUND, got: {}",
            err
        );
        assert!(
            !has_session(&handler, &session_id).await,
            "exited session was not removed on reattach"
        );

        // The reattach removed the context from the registry; kill the shell we
        // spawned via the handle we kept so the test leaves no live process.
        let _ = session_arc.lock().await.kill();
    }

    async fn has_session(handler: &PtyHandler, session_id: &str) -> bool {
        handler.sessions.lock().await.contains_key(session_id)
    }

    /// S5 deliverable: a session left detached past the orphan timeout, with no
    /// client coming back, is killed and removed (no leaked shell/task).
    #[tokio::test]
    async fn detached_session_is_reaped_after_orphan_timeout() {
        let mut handler = PtyHandler::new();
        handler.orphan_timeout = Duration::from_millis(200);

        let sink: Sender = Arc::new(CollectSink::default());
        handler.set_sender(sink).await;
        handler
            .handle_init(Some("cmd".into()), None, None, None, Some(80), Some(24))
            .await
            .expect("init session");
        let session_id = only_session_id(&handler).await;
        assert!(has_session(&handler, &session_id).await);

        // No client comes back: the orphan reaper must fire.
        handler.detach().await;
        sleep(Duration::from_millis(700)).await;

        assert!(
            !has_session(&handler, &session_id).await,
            "orphaned session was not reaped after the timeout"
        );
    }

    /// S5 attach-epoch guard: a client that reconnects before the timeout keeps
    /// the session alive — the stale orphan timer from the earlier detach must
    /// see the bumped epoch and cancel its reap.
    #[tokio::test]
    async fn reconnect_before_timeout_keeps_session_alive() {
        let mut handler = PtyHandler::new();
        handler.orphan_timeout = Duration::from_millis(300);

        let sink1: Sender = Arc::new(CollectSink::default());
        handler.set_sender(sink1).await;
        handler
            .handle_init(Some("cmd".into()), None, None, None, Some(80), Some(24))
            .await
            .expect("init session");
        let session_id = only_session_id(&handler).await;

        // Detach, then reconnect within the window (bumps the attach epoch).
        handler.detach().await;
        sleep(Duration::from_millis(50)).await;
        let sink2: Sender = Arc::new(CollectSink::default());
        handler.set_sender(sink2).await;

        // Wait past the original timer's deadline: it must have cancelled.
        sleep(Duration::from_millis(600)).await;
        assert!(
            has_session(&handler, &session_id).await,
            "session was wrongly reaped despite a reconnect before the timeout"
        );

        handler.handle_destroy(&session_id).await.ok();
    }
}
