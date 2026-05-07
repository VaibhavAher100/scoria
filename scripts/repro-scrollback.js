/**
 * Scrollback reproduction helper for xterm.js-based terminals.
 *
 * Usage:
 *   node scripts/repro-scrollback.js
 *   node scripts/repro-scrollback.js --mode full --lines 180
 *   node scripts/repro-scrollback.js --mode ed2
 *   node scripts/repro-scrollback.js --mode ed3
 *   node scripts/repro-scrollback.js --mode sync-ed2
 *   node scripts/repro-scrollback.js --mode sync-ed3
 *
 * Modes:
 *   full     Emit a realistic AI-TUI-like redraw block: DEC 2026 + ED2 + ED3.
 *   ed2      Emit only ED2 after filling scrollback.
 *   ed3      Emit only ED3 after filling scrollback.
 *   sync-ed2 Emit DEC 2026 + ED2 after filling scrollback. Best for comparing
 *            xterm.js-style behavior against terminals that scroll on ED2.
 *   sync-ed3 Emit DEC 2026 + ED3 after filling scrollback. This intentionally
 *            purges scrollback in most terminals and is mainly useful for
 *            verifying Termy's compatibility filter.
 */

const ESC = '\x1b';
const DEFAULT_LINES = 150;

function parseArgs(argv) {
  const options = {
    mode: 'sync-ed2',
    lines: DEFAULT_LINES,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const nextValue = argv[index + 1];

    if (arg === '--mode' && nextValue) {
      options.mode = nextValue;
      index += 1;
      continue;
    }

    if (arg === '--lines' && nextValue) {
      const parsed = Number.parseInt(nextValue, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --lines value: ${nextValue}`);
      }
      options.lines = parsed;
      index += 1;
      continue;
    }
  }

  if (!['full', 'ed2', 'ed3', 'sync-ed2', 'sync-ed3'].includes(options.mode)) {
    throw new Error(`Unsupported --mode value: ${options.mode}`);
  }

  return options;
}

export function buildScrollbackPrelude(lineCount = DEFAULT_LINES) {
  const lines = [];
  for (let index = 1; index <= lineCount; index += 1) {
    lines.push(`before ${index}`);
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function buildScrollbackReproSequence(mode = 'full') {
  switch (mode) {
    case 'ed2':
      return `${ESC}[H${ESC}[2Jafter ed2\r\n`;
    case 'ed3':
      return `${ESC}[3Jafter ed3\r\n`;
    case 'sync-ed2':
      return `${ESC}[?2026h${ESC}[H${ESC}[2J${ESC}[Hafter sync ed2\r\n${ESC}[?2026l`;
    case 'sync-ed3':
      return `${ESC}[?2026h${ESC}[3Jafter sync ed3\r\n${ESC}[?2026l`;
    case 'full':
      return `${ESC}[?2026h${ESC}[H${ESC}[2J${ESC}[3J${ESC}[Hafter full clear\r\n${ESC}[?2026l`;
    default:
      throw new Error(`Unsupported repro mode: ${mode}`);
  }
}

export function buildScrollbackReproOutput(options = {}) {
  const lines = options.lines ?? DEFAULT_LINES;
  const mode = options.mode ?? 'full';
  return `${buildScrollbackPrelude(lines)}${buildScrollbackReproSequence(mode)}`;
}

function isDirectInvocation() {
  if (!process.argv[1]) {
    return false;
  }

  const scriptPath = process.argv[1].replace(/\\/g, '/');
  const scriptUrlSuffix = scriptPath.startsWith('/') ? scriptPath : `/${scriptPath}`;
  return import.meta.url === `file://${scriptUrlSuffix}`;
}

if (isDirectInvocation()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.stdout.write(buildScrollbackReproOutput(options));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to generate scrollback reproduction output: ${message}\n`);
    process.exit(1);
  }
}
