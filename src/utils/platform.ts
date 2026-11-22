import { homedir } from 'os';

/** Returns the Node platform identifier (e.g. `win32`, `darwin`, `linux`). */
export function getPlatform(): NodeJS.Platform {
  return process.platform;
}

/** True when running on Windows. */
export function isWindows(): boolean {
  return process.platform === 'win32';
}

/** True when running on macOS. */
export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

/** True when running on Linux. */
export function isLinux(): boolean {
  return process.platform === 'linux';
}

/**
 * Use forward slashes in an absolute OS path. Obsidian's `normalizePath` is for
 * vault-relative paths: it strips the leading `/`, which turns a Unix path such
 * as `/home/me/vault` into a relative one.
 */
export function toSlashPath(absolutePath: string): string {
  return absolutePath.replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
}

/** Returns the user's home directory, or an empty string when unavailable. */
export function getHomeDir(): string {
  return homedir();
}
