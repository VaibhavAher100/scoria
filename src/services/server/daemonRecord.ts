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
 * A tampered sidecar therefore cannot steer the client at a foreign pipe.
 */
export const PIPE_NAME_RE = /^\\\\\.\\pipe\\termy-[0-9a-f-]{36}$/i;

export interface DaemonRecord {
  /** The daemon's named-pipe path. */
  pipe: string;
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
 * out-of-contract input (bad JSON, wrong types, a pipe path that fails
 * `PIPE_NAME_RE`, a non-positive pid). Treated as a trust boundary: the file is
 * same-user but may be stale or doctored, so every field is checked before use.
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
  if (typeof r.pipe !== 'string' || !PIPE_NAME_RE.test(r.pipe)) {
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
    pipe: r.pipe,
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
