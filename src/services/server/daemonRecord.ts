/**
 * Daemon sidecar record (`.termy-daemon.json`).
 *
 * Persisted next to the plugin when the native daemon starts so a reloaded
 * plugin can re-discover an already-running daemon instead of spawning a new
 * one (M2 Part B - full-reload survival). This module is the pure layer:
 * serialize / parse / validate / version-compare. The actual file I/O (atomic
 * write, read) and the liveness probe live in ServerManager, which has the
 * injected `fs`/`net` handles - keeping this module DOM- and Obsidian-free so
 * it is unit-testable under `node --test`.
 */

/**
 * Shape the persisted (and announced) pipe path must match: `\\.\pipe\termy-<uuid>`.
 * Single source of truth - ServerManager imports this rather than redeclaring it,
 * so the sidecar and the live stdout path are validated by the exact same rule.
 * A tampered sidecar therefore cannot steer the client at a foreign-*named*
 * pipe; reaching a pipe owned by a *different user* is separately blocked by the
 * pipe's user-only DACL. (A same-user process squatting a `termy-<uuid>` name is
 * inside the trusted same-user threat model.)
 */
export const PIPE_NAME_RE = /^\\\\\.\\pipe\\termy-[0-9a-f-]{36}$/i;

/**
 * Shape the persisted (and announced) Unix-socket path must match:
 * `<base>/termy-<uuid>/daemon.sock`, the structure `unix.rs::new_socket_path`
 * always produces (a per-start GUID-named 0700 directory under
 * `$XDG_RUNTIME_DIR` or the temp dir, with a fixed `daemon.sock` node). The
 * variable `<base>` is matched loosely (any non-empty, slash/NUL/newline-free
 * components, but no bare `..` traversal segment), while the GUID directory +
 * fixed filename are pinned - the socket analogue of `PIPE_NAME_RE`. So a
 * tampered sidecar cannot steer the client to `connect()` a path outside this
 * shape; reaching a socket owned by a *different user* is separately blocked by
 * the 0600 socket inside the 0700 dir (a same-user squatter is inside the
 * trusted threat model, same as the pipe).
 */
export const SOCKET_PATH_RE =
  /^\/(?:(?!\.\.\/)[^/\0\n]+\/)*termy-[0-9a-f-]{36}\/daemon\.sock$/i;

export interface DaemonRecord {
  /** The daemon's named-pipe path (Windows). Exactly one of pipe/socket is set. */
  pipe?: string;
  /** The daemon's Unix domain socket path (macOS/Linux). Exactly one of pipe/socket is set. */
  socket?: string;
  /** The daemon process id (used only for kill-on-version-skew, never blind-killed). */
  pid: number;
  /** The binary version the daemon was started with. Reattach across versions is refused. */
  binaryVersion: string;
  /** ISO timestamp of when the record was written. Advisory. */
  startedAt: string;
}

/** Serialize a record for atomic write. */
export function serializeDaemonRecord(record: DaemonRecord): string {
  return JSON.stringify(record, null, 2);
}

/**
 * Parse + validate a sidecar file's contents. Returns null on any malformed or
 * out-of-contract input (bad JSON, wrong types, an endpoint that fails its
 * pattern, a non-positive pid). A record must carry EXACTLY ONE endpoint - a
 * pipe (Windows) or a socket (Unix); both-or-neither is rejected as ambiguous.
 * Treated as a trust boundary: the file is same-user but may be stale or
 * doctored, so every field is checked before use.
 */
export function parseDaemonRecord(raw: string): DaemonRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) {
    return null;
  }
  const r = data as Record<string, unknown>;

  const hasPipe = typeof r.pipe === 'string';
  const hasSocket = typeof r.socket === 'string';
  // Exactly one endpoint. `===` rejects both (ambiguous) and neither (no target).
  if (hasPipe === hasSocket) {
    return null;
  }
  if (hasPipe && !PIPE_NAME_RE.test(r.pipe as string)) {
    return null;
  }
  if (hasSocket && !SOCKET_PATH_RE.test(r.socket as string)) {
    return null;
  }
  if (typeof r.pid !== 'number' || !Number.isInteger(r.pid) || r.pid <= 0) {
    return null;
  }
  if (typeof r.binaryVersion !== 'string' || r.binaryVersion.length === 0) {
    return null;
  }
  if (typeof r.startedAt !== 'string') {
    return null;
  }
  return {
    ...(hasPipe ? { pipe: r.pipe as string } : { socket: r.socket as string }),
    pid: r.pid,
    binaryVersion: r.binaryVersion,
    startedAt: r.startedAt,
  };
}

/**
 * Whether a persisted daemon may be reused by a plugin running `currentVersion`.
 * A mismatch means the daemon speaks an older protocol and must be replaced
 * (kill + respawn) rather than reattached - never reattach across versions.
 */
export function isVersionCompatible(record: DaemonRecord, currentVersion: string): boolean {
  return record.binaryVersion === currentVersion;
}
