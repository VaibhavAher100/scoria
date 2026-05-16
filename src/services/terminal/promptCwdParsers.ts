/**
 * Pure helpers for extracting the current working directory from
 * shell-prompt echoes in PTY output.
 *
 * The implementation is intentionally regex-based because Termy
 * supports a long tail of shells (cmd, PowerShell, Git Bash, WSL bash,
 * zsh under WSL, etc.) and the cleanest signal we get from PTY chunks
 * is the prompt itself. Each parser:
 *   - strips ANSI/CSI control sequences from `data` before matching,
 *     using a caller-provided pre-stripped `cleanData` buffer,
 *   - returns the cwd captured from the LAST match in the buffer,
 *     because a single chunk can contain stale history echo before
 *     the freshest prompt,
 *   - returns `null` when the chunk does not contain a prompt.
 */

/** PowerShell prompt: `PS C:\path>` (CR-tolerant, matches anywhere). */
export function extractPowerShellCwd(cleanData: string): string | null {
  const matches = Array.from(cleanData.matchAll(/PS ([A-Za-z]:[^>\r\n]*)>/g));
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].trimEnd() || null;
}

/**
 * CMD prompt: `C:\path>`.
 *
 * Anchored to line start in multiline mode so a stray `>` mid-line
 * (`echo foo > bar`) does not match. Allows optional trailing
 * whitespace before EOL because conpty sometimes pads the prompt
 * line. The freshest prompt may sit at end-of-string with no
 * trailing newline (cmd parks the cursor right after `>`); the `m`
 * flag's `$` matches both `\n` and end-of-string, which covers it.
 */
export function extractCmdCwd(cleanData: string): string | null {
  const matches = Array.from(
    cleanData.matchAll(/^([A-Za-z]:\\[^>\r\n]*)>\s*$/gm)
  );
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1].trimEnd() || null;
}

/**
 * Git Bash window-title path: `\x1b]0;MINGW64:/c/path\x07`.
 *
 * Caller passes the raw chunk so we can match the OSC 0 sequence
 * before ANSI stripping (CSI removal would not affect OSC, but the
 * scan is centralized here for clarity).
 */
export function extractGitBashWindowTitleCwd(rawData: string): string | null {
  // eslint-disable-next-line no-control-regex -- need OSC 0 sequence
  const match = rawData.match(/\x1b\]0;(?:MINGW(?:64|32)|MSYS):([^\x07]+)\x07/);
  if (!match) return null;
  return convertGitBashPath(match[1]);
}

/**
 * Git Bash prompt line: `user@host MINGW64 /c/path`.
 */
export function extractGitBashPromptCwd(
  cleanData: string,
  userProfileDir: string
): string | null {
  const matches = Array.from(
    cleanData.matchAll(/(?:MINGW(?:64|32)|MSYS)\s+([/~][^\r\n$]*)/g)
  );
  if (matches.length === 0) return null;
  const raw = matches[matches.length - 1][1].trimEnd();
  return convertGitBashPath(raw, userProfileDir);
}

/**
 * WSL prompt: `user@host:/mnt/c/path$` or `user@host:~$`.
 */
export function extractWslPromptCwd(cleanData: string): string | null {
  const matches = Array.from(
    cleanData.matchAll(/:\s*(\/[^\s$#>\r\n]+)\s*[$#]/g)
  );
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1] || null;
}

/**
 * Convert `/c/foo/bar` → `C:\foo\bar` (Git Bash convention) and
 * expand a leading `~` against the supplied home directory.
 */
function convertGitBashPath(rawPath: string, userProfileDir = ''): string {
  if (/^\/[a-zA-Z]\//.test(rawPath)) {
    const driveLetter = rawPath[1].toUpperCase();
    return `${driveLetter}:${rawPath.substring(2).replace(/\//g, '\\')}`;
  }
  if (rawPath.startsWith('~') && userProfileDir) {
    return rawPath.replace('~', userProfileDir);
  }
  return rawPath;
}


/**
 * Extract a cwd from one or two contiguous prompt lines that have
 * already been rendered to the terminal screen.
 *
 * Conpty (Windows pseudo-console) emits cursor-positioning escape
 * sequences instead of plain prompt strings, so streaming chunks
 * frequently never contain a full `Drive:\path>` line. The screen
 * itself, however, always shows the rendered prompt at the cursor
 * location. Pass the cursor line (and optionally the previous line,
 * for shells that wrap a long prompt onto two rows) and we return
 * the cwd if any of the supported prompt formats matches.
 *
 * Supports cmd, PowerShell, Git Bash, and WSL prompt shapes.
 */
export function extractCwdFromPromptLines(
  cursorLine: string,
  previousLine: string | null,
  userProfileDir: string
): string | null {
  // Try the cursor line first; fall back to the previous line for
  // shells whose prompt header lives on its own row (Git Bash).
  const candidates: string[] = [];
  const trimmedCursor = cursorLine.trimEnd();
  if (trimmedCursor.length > 0) candidates.push(trimmedCursor);
  if (previousLine !== null) {
    const trimmedPrev = previousLine.trimEnd();
    if (trimmedPrev.length > 0) candidates.push(trimmedPrev);
  }

  for (const candidate of candidates) {
    // CMD: `Drive:\path>`
    const cmdMatch = candidate.match(/([A-Za-z]:\\[^>\r\n]*)>\s*$/);
    if (cmdMatch) {
      return cmdMatch[1].trimEnd();
    }

    // PowerShell: `PS Drive:\path>`
    const psMatch = candidate.match(/PS ([A-Za-z]:[^>\r\n]*)>\s*$/);
    if (psMatch) {
      return psMatch[1].trimEnd();
    }

    // Git Bash header: `... MINGW64 /c/path` (often the line above
    // the actual `$ ` prompt line, hence the previous-line fallback).
    const gitBashMatch = candidate.match(
      /(?:MINGW(?:64|32)|MSYS)\s+([/~][^\r\n]*?)\s*$/
    );
    if (gitBashMatch) {
      const raw = gitBashMatch[1].trimEnd();
      if (/^\/[a-zA-Z]\//.test(raw)) {
        const driveLetter = raw[1].toUpperCase();
        return `${driveLetter}:${raw.substring(2).replace(/\//g, '\\')}`;
      }
      if (raw.startsWith('~') && userProfileDir) {
        return raw.replace('~', userProfileDir);
      }
      return raw;
    }

    // WSL: `user@host:/mnt/c/path$` or `user@host:~$`.
    const wslMatch = candidate.match(/:\s*(\/[^\s$#>\r\n]+)\s*[$#]\s*$/);
    if (wslMatch) {
      return wslMatch[1];
    }
  }

  return null;
}
