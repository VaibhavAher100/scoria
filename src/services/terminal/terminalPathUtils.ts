import { posix as posixPath, win32 as win32Path } from 'node:path';

export type TerminalPlatform = NodeJS.Platform;
export interface TerminalNamedPathEntry {
  name: string;
  path: string;
  kind?: 'file' | 'folder';
}

function isWindowsPlatform(platform: TerminalPlatform): boolean {
  return platform === 'win32';
}

function getPathModule(platform: TerminalPlatform) {
  return isWindowsPlatform(platform) ? win32Path : posixPath;
}

function normalizeFilesystemPath(
  value: string,
  platform: TerminalPlatform = process.platform,
  decodeEscapes = true
): string {
  let normalized = decodeEscapes
    ? normalizeTerminalToken(value)
    : normalizeTerminalRawToken(value);
  if (!normalized) {
    return '';
  }

  if (isWindowsPlatform(platform)) {
    normalized = normalized.replace(/^\/(?=[A-Za-z]:[\\/])/, '');
  }

  return getPathModule(platform).normalize(normalized);
}

export function normalizeTerminalRawToken(value: string): string {
  let normalized = value.trim().replace(/^<|>$/g, '');
  if (
    (normalized.startsWith('"') && normalized.endsWith('"'))
    || (normalized.startsWith('\'') && normalized.endsWith('\''))
  ) {
    normalized = normalized.slice(1, -1);
  }

  return normalized.trim();
}

export function normalizeTerminalToken(value: string): string {
  let normalized = normalizeTerminalRawToken(value);

  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Ignore malformed percent-encoding and use the raw token.
  }

  return normalized.trim();
}

export function toPlatformPath(
  value: string,
  platform: TerminalPlatform = process.platform
): string {
  const normalized = normalizeTerminalToken(value);
  if (!normalized) {
    return '';
  }

  return isWindowsPlatform(platform)
    ? normalized.replace(/\//g, '\\')
    : normalized;
}

export function normalizeVaultPath(value: string): string {
  const normalized = normalizeTerminalToken(value)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (!normalized) {
    return '';
  }

  const canonical = posixPath.normalize(normalized);
  return canonical === '.' ? '' : canonical;
}

export function isAbsoluteTerminalPath(
  value: string,
  platform: TerminalPlatform = process.platform
): boolean {
  const normalized = normalizeTerminalToken(value);
  if (!normalized) {
    return false;
  }

  return getPathModule(platform).isAbsolute(normalized);
}

export function isBasenameOnlyTerminalToken(
  value: string,
  platform: TerminalPlatform = process.platform
): boolean {
  const normalized = normalizeTerminalToken(value);
  if (!normalized || normalized.includes('\n')) {
    return false;
  }

  if (
    (normalized.startsWith('[[') && normalized.endsWith(']]'))
    || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(normalized)
  ) {
    return false;
  }

  if (isAbsoluteTerminalPath(normalized, platform)) {
    return false;
  }

  return !normalized.includes('/') && !normalized.includes('\\');
}

export function normalizeDroppedEntryPath(
  value: string,
  platform: TerminalPlatform = process.platform
): string | null {
  const normalized = normalizeFilesystemPath(value, platform);
  if (!normalized) {
    return null;
  }

  return isAbsoluteTerminalPath(normalized, platform) ? normalized : null;
}

export function normalizeDroppedEntryReference(
  value: string,
  platform: TerminalPlatform = process.platform
): { absolutePath: string | null; vaultPath: string | null } {
  const rawNormalized = normalizeTerminalToken(value);
  const absolutePath = isWindowsPlatform(platform) && /^\/(?![A-Za-z]:[\\/])/.test(rawNormalized)
    ? null
    : normalizeDroppedEntryPath(value, platform);
  if (absolutePath) {
    return {
      absolutePath,
      vaultPath: null,
    };
  }

  const vaultPath = normalizeVaultPath(value);
  return {
    absolutePath: null,
    vaultPath: vaultPath || null,
  };
}

export function normalizeTerminalReferencePath(
  pathLike: string,
  platform: TerminalPlatform = process.platform
): string {
  const normalized = normalizeTerminalToken(pathLike)
    .replace(/^[ab][\\/](?=.+\.[A-Za-z0-9]+$)/, '');

  return isWindowsPlatform(platform)
    ? normalized.replace(/\//g, '\\')
    : normalized.replace(/\\/g, '/');
}

export function fileUriToPlatformPath(
  uri: string,
  platform: TerminalPlatform = process.platform
): string | null {
  const normalizedUri = normalizeTerminalRawToken(uri);
  if (!normalizedUri.toLowerCase().startsWith('file://')) {
    return null;
  }

  try {
    const url = new URL(normalizedUri);
    if (url.protocol !== 'file:') {
      return null;
    }

    let pathname = decodeURIComponent(url.pathname);

    if (isWindowsPlatform(platform)) {
      if (/^\/[A-Za-z]:/.test(pathname)) {
        pathname = pathname.slice(1);
      }

      const platformPath = normalizeFilesystemPath(pathname, platform, false);
      if (url.host) {
        const normalizedPath = platformPath.startsWith('\\') ? platformPath : `\\${platformPath}`;
        return `\\\\${url.host}${normalizedPath}`;
      }

      return platformPath;
    }

    const localHost = url.hostname.toLowerCase() === 'localhost';
    return normalizeFilesystemPath(localHost || !url.host ? pathname : `//${url.host}${pathname}`, platform, false);
  } catch {
    return null;
  }
}

export function obsidianUriToVaultPath(uri: string): string | null {
  const normalizedUri = normalizeTerminalRawToken(uri);
  if (!normalizedUri.toLowerCase().startsWith('obsidian://')) {
    return null;
  }

  try {
    const url = new URL(normalizedUri);
    if (url.protocol !== 'obsidian:') {
      return null;
    }

    return url.searchParams.get('file')
      ?? url.searchParams.get('path')
      ?? url.searchParams.get('linkpath');
  } catch {
    return null;
  }
}

export interface WikilinkRange {
  /** 0-based index of the first `[` of the `[[...]]` token in the line. */
  startIndex: number;
  /** Exclusive end index (just past the closing `]]`). */
  endIndex: number;
  /** Link target with any `|alias`, `#heading`, or `^block` stripped. */
  linkpath: string;
}

export interface TerminalBufferCellLike {
  getChars(): string;
  getWidth(): number;
}

/**
 * Convert a JavaScript string index into a 0-based xterm buffer column.
 * JavaScript indexes UTF-16 code units while xterm columns follow rendered
 * cell widths, so they diverge for emoji, CJK, and combining characters.
 */
export function terminalStringIndexToBufferColumn(
  stringIndex: number,
  cellCount: number,
  getCell: (column: number) => TerminalBufferCellLike | undefined
): number {
  const targetIndex = Math.max(0, stringIndex);
  let currentIndex = 0;
  let column = 0;

  while (column < cellCount) {
    if (currentIndex >= targetIndex) {
      return column;
    }

    const cell = getCell(column);
    if (!cell) {
      currentIndex += 1;
      column += 1;
      continue;
    }

    const width = cell.getWidth();
    const chars = cell.getChars();
    currentIndex += chars.length > 0 ? chars.length : width === 1 ? 1 : 0;
    column += Math.max(1, width);
  }

  return cellCount;
}

const WIKILINK_PATTERN = /\[\[([^[\]\n]+?)\]\]/g;

/**
 * Find `[[wiki-link]]` tokens in a single line of terminal output. Returns the
 * character ranges (for building xterm link decorations) and the resolved link
 * target. Display aliases (`|`), headings (`#`), and block refs (`^`) are
 * stripped from the target. Pure and synchronous so it is unit-testable.
 */
export function scanWikilinkRanges(line: string): WikilinkRange[] {
  const ranges: WikilinkRange[] = [];
  if (!line.includes('[[')) {
    return ranges;
  }

  WIKILINK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK_PATTERN.exec(line)) !== null) {
    const target = match[1].split('|')[0].split('#')[0].split('^')[0].trim();
    if (!target) {
      continue;
    }
    ranges.push({
      startIndex: match.index,
      endIndex: match.index + match[0].length,
      linkpath: target,
    });
  }
  return ranges;
}

export function joinTerminalPaths(
  basePath: string,
  relativePath: string,
  platform: TerminalPlatform = process.platform
): string {
  const pathModule = getPathModule(platform);
  const normalizedBasePath = normalizeTerminalToken(basePath);
  const normalizedRelativePath = normalizeTerminalToken(relativePath);

  if (!normalizedBasePath) {
    return normalizeFilesystemPath(normalizedRelativePath, platform);
  }

  if (!normalizedRelativePath) {
    return normalizeFilesystemPath(normalizedBasePath, platform);
  }

  if (pathModule.isAbsolute(normalizedRelativePath)) {
    return normalizeFilesystemPath(normalizedRelativePath, platform);
  }

  return pathModule.normalize(pathModule.join(normalizedBasePath, normalizedRelativePath));
}

export function collectTerminalReferenceCandidatePaths(
  relativePath: string,
  basePaths: Array<string | null | undefined>,
  platform: TerminalPlatform = process.platform
): string[] {
  const normalizedRelativePath = normalizeTerminalToken(relativePath);
  if (!normalizedRelativePath) {
    return [];
  }

  const candidates: string[] = [];
  const seen = new Set<string>();

  for (const basePath of basePaths) {
    const normalizedBasePath = normalizeTerminalToken(basePath ?? '');
    if (!normalizedBasePath) {
      continue;
    }

    const candidate = joinTerminalPaths(normalizedBasePath, normalizedRelativePath, platform);
    if (!candidate) {
      continue;
    }

    const key = isWindowsPlatform(platform) ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    candidates.push(candidate);
  }

  return candidates;
}

export function getVaultRelativePathFromAbsolute(
  absolutePath: string,
  vaultBasePath: string,
  platform: TerminalPlatform = process.platform
): string | null {
  const pathModule = getPathModule(platform);
  const normalizedBasePath = normalizeFilesystemPath(vaultBasePath, platform);
  const normalizedAbsolutePath = normalizeFilesystemPath(absolutePath, platform);

  if (!normalizedBasePath || !normalizedAbsolutePath) {
    return null;
  }

  const relativePath = pathModule.relative(normalizedBasePath, normalizedAbsolutePath);
  if (relativePath.startsWith('..') || pathModule.isAbsolute(relativePath)) {
    return null;
  }

  return relativePath.replace(/\\/g, '/');
}

export function findUniqueTerminalEntryByBasename<T extends TerminalNamedPathEntry>(
  name: string,
  entries: T[],
): T | null {
  const normalizedName = normalizeTerminalToken(name);
  if (!normalizedName || normalizedName.includes('/') || normalizedName.includes('\\')) {
    return null;
  }

  const folderMatches = entries.filter((entry) => entry.kind === 'folder' && entry.name === normalizedName);
  const candidateEntries = folderMatches.length > 0
    ? folderMatches
    : entries.filter((entry) => entry.name === normalizedName);

  if (candidateEntries.length !== 1) {
    return null;
  }

  return candidateEntries[0];
}

// Passive file types that the OS default app opens without running code.
// Anything else (executables, scripts, shortcuts, installers, source files
// that a launcher may run, and Office/RTF/XML documents, which have a history
// of parser exploits and get no Mark-of-the-Web when a terminal creates them)
// is only revealed in the file manager.
const EXTERNALLY_OPENABLE_EXTENSIONS = new Set([
  'pdf', 'txt', 'md', 'log', 'json', 'yaml', 'yml', 'toml',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'mp4', 'mkv', 'webm', 'mov', 'avi',
]);

/**
 * Whether a path is a network path (UNC `\\host\share`, `//host/share`, or a
 * `\\?\` / `\\.\` device path). Terminal output must never make the plugin
 * touch one: any file system call on a UNC path authenticates over SMB.
 */
export function isNetworkTerminalPath(filePath: string): boolean {
  return /^[\\/]{2}/.test(filePath);
}

/** Whether a non-vault file may be opened with its default app on a click. */
export function isExternallyOpenableFile(filePath: string): boolean {
  const base = filePath.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return false;
  }
  // Windows ignores trailing dots and spaces, so "a.exe." runs as "a.exe".
  if (/[. ]$/.test(base)) {
    return false;
  }
  return EXTERNALLY_OPENABLE_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

/** How a shell parses a quoted argument. */
export type ShellQuoteStyle = 'posix' | 'powershell' | 'cmd';

/**
 * The quote style for a configured shell type, or null when no safe rule is
 * known (a custom shell). Callers must not insert a raw path for null.
 */
export function shellQuoteStyleFor(shellType: string): ShellQuoteStyle | null {
  switch (shellType) {
    case 'bash':
    case 'zsh':
    case 'gitbash':
    case 'wsl':
    case 'tmux':
      return 'posix';
    case 'powershell':
    case 'pwsh':
      return 'powershell';
    case 'cmd':
      return 'cmd';
    default:
      return null;
  }
}

// C0 and C1 control characters, DEL included. A CR or LF in inserted text
// would submit the command line before the user sees it.
// eslint-disable-next-line no-control-regex
const SHELL_CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** Remove control characters from text that goes to the shell as typed input. */
export function stripShellControlChars(value: string): string {
  return value.replace(SHELL_CONTROL_CHARS_RE, '');
}

// Characters that any supported shell (bash/zsh/fish, PowerShell, cmd)
// interprets inside or around quotes, plus the typographic quotes PowerShell
// treats as quote marks, the characters that Windows "best fit" conversion
// maps to ASCII metacharacters (fullwidth forms, U+02BA, U+2033, U+3003,
// U+00A5), and bidi controls that can hide text on the command line.
const SHELL_UNSAFE_CHARS_RE =
  /[$`'"%!&|<>^;¥ʺ‘-‟″‪-‮⁦-⁩〃！＂＄-＇；＜＞＼＾｀｜]/;

/**
 * Quote a value as one literal shell argument. The value must be safe in
 * every supported shell, not only in `style`: the configured shell type can
 * differ from the program that reads the input (the user may have started
 * bash inside cmd). Returns null when the value is empty, starts with `-`
 * (option injection), or holds a control or shell-unsafe character. The
 * caller then falls back to the plain `[[name]]` form.
 */
export function quoteShellArgument(value: string, style: ShellQuoteStyle): string | null {
  if (value.length === 0 || value.startsWith('-')) {
    return null;
  }
  if (stripShellControlChars(value) !== value || SHELL_UNSAFE_CHARS_RE.test(value)) {
    return null;
  }
  return style === 'cmd' ? `"${value}"` : `'${value}'`;
}
