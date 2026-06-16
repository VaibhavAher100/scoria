// Capability-token authentication for the WebSocket fallback transport.
//
// The WebSocket server binds `127.0.0.1:<random>` and spawns full-privilege
// shells, so "localhost" is NOT a trust boundary: any local process or browser
// tab can connect. The primary transports (named pipe / UDS) get OS-enforced
// auth for free (DACL / fs perms); the TCP fallback has none, so it must prove
// the peer holds a per-daemon secret before any PTY command is routed.
//
// Design:
//   - Fresh >=256-bit token per daemon start, emitted on stdout (the child's
//     piped stdout is readable only by the parent plugin - same trust channel
//     the pipe name already uses). NEVER placed in the URL (log leakage).
//   - The connection starts unauthenticated; the first app message must be
//     `{"type":"auth","token":"..."}`. Anything else, or a wrong token, drops
//     the connection before a shell can be spawned or driven.
//   - Token compared in constant time.
//   - `Origin` is checked at the handshake as defense-in-depth: a real browser
//     page (http(s)/ws(s) origin) is rejected outright. It is NOT the gate - a
//     non-browser local attacker can forge any Origin, which is exactly what
//     the token defeats.

use serde::Deserialize;

/// Number of random bytes in the capability token (256 bits).
const TOKEN_BYTES: usize = 32;

/// Generate a fresh capability token: `TOKEN_BYTES` of CSPRNG output, hex.
///
/// Panics only if the OS RNG is unavailable, in which case running an
/// unauthenticated shell endpoint would be far worse than aborting.
pub fn generate_token() -> String {
    let mut buf = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut buf).expect("OS RNG unavailable - refusing to start without a token");
    let mut hex = String::with_capacity(TOKEN_BYTES * 2);
    for b in buf {
        use std::fmt::Write;
        let _ = write!(hex, "{:02x}", b);
    }
    hex
}

/// Constant-time byte comparison: no early return on the first mismatch, so the
/// number of matching leading bytes does not leak through timing.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Whether a WebSocket `Origin` header is acceptable.
///
/// Reject real browser origins (`http(s)://`, `ws(s)://`) - those are local web
/// pages that should never reach the daemon. Allow an absent Origin (non-browser
/// clients omit it) and non-web schemes such as Obsidian's `app://` renderer.
/// This is belt-and-suspenders; the token is the real gate.
pub fn origin_allowed(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(raw) => {
            let o = raw.trim().to_ascii_lowercase();
            !(o.starts_with("http://")
                || o.starts_with("https://")
                || o.starts_with("ws://")
                || o.starts_with("wss://"))
        }
    }
}

#[derive(Deserialize)]
struct AuthMessage {
    #[serde(rename = "type")]
    msg_type: String,
    token: String,
}

/// Parse a client auth message, returning the presented token if the message is
/// a well-formed `{"type":"auth","token":...}`. Any other shape returns `None`.
pub fn parse_auth_token(text: &str) -> Option<String> {
    let msg: AuthMessage = serde_json::from_str(text).ok()?;
    if msg.msg_type == "auth" {
        Some(msg.token)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_256_bit_hex_and_unique() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), TOKEN_BYTES * 2); // 64 hex chars
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b, "two tokens must not collide");
    }

    #[test]
    fn constant_time_eq_matches_only_identical() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"x"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn origin_rejects_browser_schemes_allows_app_and_absent() {
        assert!(origin_allowed(None));
        assert!(origin_allowed(Some("app://obsidian.md")));
        assert!(origin_allowed(Some("capacitor://localhost")));
        assert!(!origin_allowed(Some("http://localhost:3000")));
        assert!(!origin_allowed(Some("https://evil.example")));
        assert!(!origin_allowed(Some("ws://127.0.0.1:1234")));
        assert!(!origin_allowed(Some("  HTTPS://Evil.Example  ")));
    }

    #[test]
    fn parse_auth_extracts_token_only_for_auth_type() {
        assert_eq!(
            parse_auth_token(r#"{"type":"auth","token":"deadbeef"}"#),
            Some("deadbeef".to_string())
        );
        assert_eq!(parse_auth_token(r#"{"type":"init","token":"x"}"#), None);
        assert_eq!(parse_auth_token(r#"{"type":"auth"}"#), None);
        assert_eq!(parse_auth_token("not json"), None);
    }
}
