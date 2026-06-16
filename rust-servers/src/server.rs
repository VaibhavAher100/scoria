// WebSocket server implementation
// WebSocket server for the terminal server that handles PTY module messages

use tokio::net::TcpListener;
use tokio_tungstenite::accept_hdr_async;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::StatusCode;
use futures_util::{StreamExt, SinkExt};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex as TokioMutex;
use async_trait::async_trait;

use crate::auth;
use crate::router::{MessageRouter, ModuleType, RouterError, ServerResponse};
use crate::transport::{MessageSink, OutMessage, Sender, SinkError};

/// How long a freshly-opened WebSocket has to present a valid auth token before
/// it is dropped. The legitimate client authenticates immediately on open.
const AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// Logging macro
macro_rules! log_info {
    ($($arg:tt)*) => {
        eprintln!("[INFO] {}", format!($($arg)*));
    };
}

macro_rules! log_error {
    ($($arg:tt)*) => {
        eprintln!("[ERROR] {}", format!($($arg)*));
    };
}

macro_rules! log_debug {
    ($($arg:tt)*) => {
        if cfg!(debug_assertions) {
            eprintln!("[DEBUG] {}", format!($($arg)*));
        }
    };
}

// ============================================================================
// Server configuration and implementation
// ============================================================================

/// WebSocket server configuration
pub struct ServerConfig {
    pub port: u16,
}

/// WebSocket server
pub struct Server {
    config: ServerConfig,
    /// Per-daemon capability token clients must present before any PTY command.
    token: String,
}

impl Server {
    pub fn new(config: ServerConfig) -> Self {
        Self {
            config,
            token: auth::generate_token(),
        }
    }

    /// Start the server
    pub async fn start(&self) -> Result<u16, Box<dyn std::error::Error>> {
        let addr = format!("127.0.0.1:{}", self.config.port);
        let listener = TcpListener::bind(&addr).await?;
        let local_addr = listener.local_addr()?;
        let port = local_addr.port();

        log_info!("服务器绑定到 {}", local_addr);

        // Write connection info to stdout in JSON format. The TypeScript side
        // parses this to learn the port and the capability token. stdout is the
        // child's piped channel, readable only by the parent plugin - the same
        // trust channel the named-pipe name uses. The token never goes in the URL.
        println!(
            r#"{{"port": {}, "pid": {}, "token": {}}}"#,
            port,
            std::process::id(),
            serde_json::to_string(&self.token)?,
        );

        // Main loop: accept WebSocket connections
        let token = self.token.clone();
        tokio::spawn(async move {
            log_info!("正在监听 WebSocket 连接...");
            while let Ok((stream, addr)) = listener.accept().await {
                log_debug!("接受来自 {} 的连接", addr);
                let token = token.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_connection(stream, token).await {
                        log_error!("连接处理错误: {}", e);
                    }
                });
            }
        });

        Ok(port)
    }
}

// ============================================================================
// Connection handling
// ============================================================================

/// WebSocket sender type alias
pub type WsSender = Arc<TokioMutex<futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    Message
>>>;

/// Adapts a raw WebSocket sink to the transport-agnostic [`MessageSink`].
/// Maps each [`OutMessage`] to its WebSocket frame; ping/pong stays in the
/// read loop since it is a WebSocket-level concern, not an app message.
pub struct WebSocketSink {
    inner: WsSender,
}

impl WebSocketSink {
    pub fn new(inner: WsSender) -> WebSocketSink {
        WebSocketSink { inner }
    }
}

#[async_trait]
impl MessageSink for WebSocketSink {
    async fn send(&self, msg: OutMessage) -> Result<(), SinkError> {
        let frame = match msg {
            OutMessage::Text(text) => Message::Text(text.into()),
            OutMessage::Binary(data) => Message::Binary(data.into()),
        };
        let mut sink = self.inner.lock().await;
        sink.send(frame).await.map_err(|e| SinkError::new(e.to_string()))
    }
}

/// Handle a single WebSocket connection
// `ErrorResponse` is a large `http::Response`; the `accept_hdr_async` callback
// signature forces returning it by value, so the lint is unavoidable here.
#[allow(clippy::result_large_err)]
async fn handle_connection(
    stream: tokio::net::TcpStream,
    token: String,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Upgrade to WebSocket, rejecting disallowed Origins during the handshake
    // (defense-in-depth: blocks real browser pages before the upgrade completes).
    let ws_stream = accept_hdr_async(stream, |req: &Request, resp: Response| {
        let origin = req.headers().get("origin").and_then(|v| v.to_str().ok());
        if auth::origin_allowed(origin) {
            Ok(resp)
        } else {
            log_error!("拒绝来源: {:?}", origin);
            let mut err = ErrorResponse::new(Some("origin not allowed".to_string()));
            *err.status_mut() = StatusCode::FORBIDDEN;
            Err(err)
        }
    }).await?;

    log_info!("WebSocket 连接已建立");

    // Split the read and write streams
    let (ws_sender, mut ws_receiver) = ws_stream.split();
    let ws_sender: WsSender = Arc::new(TokioMutex::new(ws_sender));

    // Authenticate BEFORE creating a router or routing any message: the first
    // app message must be a valid `{"type":"auth","token":...}`. A wrong token,
    // a non-auth first message, a timeout, or an early close all drop the
    // connection without spawning or touching a PTY.
    if !authenticate(&token, &mut ws_receiver, &ws_sender).await {
        log_error!("认证失败，关闭连接");
        let mut sink = ws_sender.lock().await;
        let _ = sink.send(Message::Close(None)).await;
        return Ok(());
    }
    log_info!("客户端认证成功");

    // Wrap the raw sink in the transport-agnostic sink for app messages.
    let sender: Sender = Arc::new(WebSocketSink::new(Arc::clone(&ws_sender)));

    // Create the message router
    let router = Arc::new(MessageRouter::new());

    // Set the message sink (used for PTY output)
    router.set_sender(Arc::clone(&sender)).await;

    // Message handling loop
    while let Some(msg_result) = ws_receiver.next().await {
        match msg_result {
            Ok(msg) => {
                log_debug!("收到消息类型: {:?}", std::mem::discriminant(&msg));
                
                match msg {
                    Message::Text(text) => {
                        // Handle text messages
                        if let Err(e) = handle_text_message(
                            &text,
                            &router,
                            &sender
                        ).await {
                            log_error!("消息处理错误: {}", e);
                        }
                    }
                    Message::Binary(data) => {
                        // Binary data, written to the PTY
                        // Format: [session_id_length: u8][session_id: bytes][data: bytes]
                        log_debug!("收到二进制数据: {} 字节", data.len());
                        
                        if data.len() < 2 {
                            log_error!("二进制数据格式错误: 数据太短");
                            continue;
                        }
                        
                        let session_id_len = data[0] as usize;
                        if data.len() < 1 + session_id_len {
                            log_error!("二进制数据格式错误: session_id 长度不足");
                            continue;
                        }
                        
                        let session_id = match std::str::from_utf8(&data[1..1 + session_id_len]) {
                            Ok(s) => s,
                            Err(e) => {
                                log_error!("二进制数据格式错误: session_id 不是有效 UTF-8: {}", e);
                                continue;
                            }
                        };
                        
                        let pty_data = &data[1 + session_id_len..];
                        log_debug!("写入 PTY: session_id={}, {} 字节", session_id, pty_data.len());
                        
                        if let Err(e) = router.pty_handler().write_data(session_id, pty_data).await {
                            log_error!("写入 PTY 失败: session_id={}, {}", session_id, e);
                        }
                    }
                    Message::Close(_) => {
                        log_info!("客户端关闭连接");
                        break;
                    }
                    Message::Ping(data) => {
                        // Reply to Ping
                        let mut sender = ws_sender.lock().await;
                        sender.send(Message::Pong(data)).await?;
                    }
                    Message::Pong(_) => {
                        // Ignore Pong
                    }
                    _ => {
                        log_debug!("忽略的消息类型");
                    }
                }
            }
            Err(e) => {
                log_error!("消息接收错误: {}", e);
                break;
            }
        }
    }
    
    log_info!("WebSocket 连接已关闭");
    
    // Clean up all PTY sessions
    router.pty_handler().cleanup_all().await;
    
    Ok(())
}

/// Read half of a split WebSocket stream over a TCP connection.
type WsReceiver = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
>;

/// Run the pre-routing auth handshake. Returns `true` only if the peer sends a
/// valid `{"type":"auth","token":...}` whose token matches (constant-time)
/// within [`AUTH_TIMEOUT`]. Ping is answered during the wait; any other first
/// app message, a wrong token, an early close, an error, or a timeout fails.
async fn authenticate(expected: &str, receiver: &mut WsReceiver, ws_sender: &WsSender) -> bool {
    let result = tokio::time::timeout(AUTH_TIMEOUT, async {
        while let Some(msg) = receiver.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    return match auth::parse_auth_token(text.as_str()) {
                        Some(tok) => auth::constant_time_eq(tok.as_bytes(), expected.as_bytes()),
                        None => false,
                    };
                }
                Ok(Message::Ping(data)) => {
                    let mut sink = ws_sender.lock().await;
                    let _ = sink.send(Message::Pong(data)).await;
                }
                Ok(Message::Pong(_)) => {}
                // Binary before auth, a close, or a receive error ends the attempt.
                Ok(_) => return false,
                Err(_) => return false,
            }
        }
        false
    }).await;
    result.unwrap_or(false)
}

/// Handle a text message
async fn handle_text_message(
    text: &str,
    router: &Arc<MessageRouter>,
    sender: &Sender,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Parse the message
    match router.parse_message(text) {
        Ok(msg) => {
            let module = msg.module;

            // Route the message to the matching module
            match router.route(msg).await {
                Ok(Some(response)) => {
                    // Send the response
                    send_response(sender, &response).await?;
                }
                Ok(None) => {
                    // The module handled the message successfully and no response is needed
                    log_debug!("模块处理完成，无响应");
                }
                Err(e) => {
                    // Module handling failed, so send an error response
                    log_error!("模块处理错误: {}", e);
                    let error_response = router.create_error_response(module, &e);
                    send_response(sender, &error_response).await?;
                }
            }
        }
        Err(e) => {
            // Message parsing failed
            log_error!("消息解析错误: {}", e);

            // Try to extract the module field from the raw JSON for the error response
            let module = extract_module_from_json(text);
            let error_response = create_parse_error_response(module, &e);
            send_response(sender, &error_response).await?;
        }
    }

    Ok(())
}

/// Extract the module field from JSON
fn extract_module_from_json(text: &str) -> ModuleType {
    // Try to parse the JSON and extract the module field
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(module_str) = value.get("module").and_then(|v| v.as_str()) {
            if module_str == "pty" {
                return ModuleType::Pty;
            }
        }
    }
    
    // Default to the Pty module
    ModuleType::Pty
}

/// Create a parse error response
fn create_parse_error_response(module: ModuleType, error: &RouterError) -> ServerResponse {
    ServerResponse::error(
        module,
        "PARSE_ERROR",
        &format!("消息解析失败: {}", error)
    )
}

/// Send a response message
pub async fn send_response(
    sender: &Sender,
    response: &ServerResponse,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let json = serde_json::to_string(response)?;
    sender.send(OutMessage::Text(json)).await?;
    Ok(())
}

/// Send a raw JSON message
#[allow(dead_code)]
pub async fn send_json(
    ws_sender: &WsSender,
    json: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut sender = ws_sender.lock().await;
    sender.send(Message::Text(json.to_string().into())).await?;
    Ok(())
}

/// Send a binary message
#[allow(dead_code)]
pub async fn send_binary(
    ws_sender: &WsSender,
    data: Vec<u8>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut sender = ws_sender.lock().await;
    sender.send(Message::Binary(data.into())).await?;
    Ok(())
}

// ============================================================================
// Auth handshake integration tests (the slice deliverable)
// ============================================================================

#[cfg(test)]
mod auth_integration_tests {
    use super::*;
    use tokio_tungstenite::connect_async;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;

    /// Bind an ephemeral loopback port and serve exactly one connection through
    /// the real `handle_connection` (Origin check + auth gate + routing loop).
    async fn spawn_one_connection_server(token: String) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                let _ = handle_connection(stream, token).await;
            }
        });
        port
    }

    /// Drain the client stream asserting the server never routes a PTY response:
    /// the only acceptable outcomes are a Close frame, end-of-stream, or an error.
    async fn assert_closed_without_response(
        ws: &mut tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    ) {
        loop {
            match ws.next().await {
                Some(Ok(Message::Close(_))) | None => break,
                Some(Err(_)) => break,
                Some(Ok(Message::Text(t))) => {
                    panic!("unauthenticated client received a server response: {t}")
                }
                Some(Ok(_)) => continue,
            }
        }
    }

    #[tokio::test]
    async fn rejects_client_with_wrong_token() {
        let port = spawn_one_connection_server("the-real-token".to_string()).await;
        let url = format!("ws://127.0.0.1:{port}");
        let (mut ws, _) = connect_async(&url).await.unwrap();

        // Wrong token, then an attempt to spawn a shell.
        ws.send(Message::Text(r#"{"type":"auth","token":"wrong"}"#.into()))
            .await
            .unwrap();
        ws.send(Message::Text(
            r#"{"module":"pty","type":"init","shell_type":"powershell"}"#.into(),
        ))
        .await
        .unwrap();

        assert_closed_without_response(&mut ws).await;
    }

    #[tokio::test]
    async fn rejects_client_that_skips_auth() {
        let port = spawn_one_connection_server("the-real-token".to_string()).await;
        let url = format!("ws://127.0.0.1:{port}");
        let (mut ws, _) = connect_async(&url).await.unwrap();

        // First app message is a shell spawn, not an auth - must be rejected.
        ws.send(Message::Text(
            r#"{"module":"pty","type":"init","shell_type":"powershell"}"#.into(),
        ))
        .await
        .unwrap();

        assert_closed_without_response(&mut ws).await;
    }

    #[tokio::test]
    async fn accepts_client_with_correct_token() {
        let token = "the-real-token".to_string();
        let port = spawn_one_connection_server(token.clone()).await;
        let url = format!("ws://127.0.0.1:{port}");
        let (mut ws, _) = connect_async(&url).await.unwrap();

        ws.send(Message::Text(
            format!(r#"{{"type":"auth","token":"{token}"}}"#).into(),
        ))
        .await
        .unwrap();

        // A correctly authenticated connection is NOT closed: the server enters
        // the routing loop and stays silent (auth has no ack), so the read times
        // out. A wrong-token path would have sent a Close well within this window.
        match tokio::time::timeout(Duration::from_millis(400), ws.next()).await {
            Err(_) => {} // timeout: connection stayed open => authenticated
            Ok(Some(Ok(Message::Close(_)))) => panic!("authenticated client was closed"),
            Ok(_) => {} // any non-close frame is also fine
        }
    }

    #[tokio::test]
    async fn rejects_browser_origin_at_handshake() {
        let port = spawn_one_connection_server("the-real-token".to_string()).await;
        let mut req = format!("ws://127.0.0.1:{port}")
            .into_client_request()
            .unwrap();
        req.headers_mut()
            .insert("origin", "http://evil.example".parse().unwrap());

        // The handshake itself must fail (HTTP 403), before any auth message.
        assert!(
            connect_async(req).await.is_err(),
            "a browser-origin handshake must be rejected"
        );
    }
}
