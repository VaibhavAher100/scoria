import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCmdCwd,
  extractCwdFromPromptLines,
  extractGitBashPromptCwd,
  extractGitBashWindowTitleCwd,
  extractPowerShellCwd,
  extractWslPromptCwd,
} from './promptCwdParsers.ts';

// Regression: the user reported that after `cd Clippings` in a cmd
// terminal, the "open in file manager" action still pointed at the
// parent directory because the previous `match()`-based parser
// returned the FIRST match in a chunk and missed the freshest prompt.
test('extractCmdCwd returns the latest prompt after `cd` into a subdirectory', () => {
  const chunk =
    'F:\\example-vault\\notes>cd Clippings\r\n\r\nF:\\example-vault\\notes\\Clippings>';

  assert.equal(extractCmdCwd(chunk), 'F:\\example-vault\\notes\\Clippings');
});

test('extractCmdCwd handles a chunk that is just the bare new prompt', () => {
  assert.equal(
    extractCmdCwd('F:\\example-vault\\notes\\Clippings>'),
    'F:\\example-vault\\notes\\Clippings'
  );
});

test('extractCmdCwd handles a chunk that ends with a trailing newline', () => {
  assert.equal(
    extractCmdCwd('F:\\example-vault\\notes\\Clippings>\r\n'),
    'F:\\example-vault\\notes\\Clippings'
  );
});

test('extractCmdCwd ignores stray ">" in the middle of command output', () => {
  // `echo foo > bar` and similar must not produce a false-positive cwd.
  const chunk = 'echo foo > bar\r\nF:\\example-vault\\notes\\Clippings>';
  assert.equal(extractCmdCwd(chunk), 'F:\\example-vault\\notes\\Clippings');
});

test('extractCmdCwd prefers the LAST prompt when a chunk contains stale history', () => {
  // Earlier prompt (older cwd) appears first; the freshest one wins.
  const chunk =
    'F:\\old-dir>echo hello\r\nhello\r\nF:\\example-vault\\notes\\Clippings>';
  assert.equal(extractCmdCwd(chunk), 'F:\\example-vault\\notes\\Clippings');
});

test('extractCmdCwd returns null when no cmd prompt is present', () => {
  assert.equal(extractCmdCwd('Microsoft Windows banner only\r\n'), null);
});

test('extractPowerShellCwd captures the latest PS prompt', () => {
  const chunk =
    'PS F:\\example-vault\\notes> cd Clippings\r\nPS F:\\example-vault\\notes\\Clippings>';
  assert.equal(
    extractPowerShellCwd(chunk),
    'PS F:\\example-vault\\notes\\Clippings'.replace(/^PS /, '')
  );
});

test('extractGitBashWindowTitleCwd converts /c/foo paths to Windows format', () => {
  // OSC 0 sequence produced by Git Bash's PROMPT_COMMAND.
  const raw = '\x1b]0;MINGW64:/f/example-vault/notes/Clippings\x07';
  assert.equal(
    extractGitBashWindowTitleCwd(raw),
    'F:\\example-vault\\notes\\Clippings'
  );
});

test('extractGitBashPromptCwd expands ~ against the supplied home directory', () => {
  const chunk = 'user@host MINGW64 ~/projects/demo';
  assert.equal(
    extractGitBashPromptCwd(chunk, 'F:\\Users\\example'),
    'F:\\Users\\example/projects/demo'
  );
});

test('extractWslPromptCwd captures /mnt/<drive> style paths', () => {
  const chunk = 'user@host:/mnt/f/example-vault/notes/Clippings$ ';
  assert.equal(
    extractWslPromptCwd(chunk),
    '/mnt/f/example-vault/notes/Clippings'
  );
});


// Regression: when conpty rewrites the screen with cursor-positioning
// escape sequences, no streaming chunk ever contains a complete
// `Drive:\path>` line. We must therefore be able to recover the cwd
// from the rendered screen buffer (the line at the cursor position).
test('extractCwdFromPromptLines recovers cmd cwd from a single screen line', () => {
  assert.equal(
    extractCwdFromPromptLines(
      'F:\\example-vault\\notes\\Clippings>',
      null,
      ''
    ),
    'F:\\example-vault\\notes\\Clippings'
  );
});

test('extractCwdFromPromptLines tolerates trailing whitespace from conpty padding', () => {
  assert.equal(
    extractCwdFromPromptLines(
      'F:\\example-vault\\notes\\Clippings>     ',
      null,
      ''
    ),
    'F:\\example-vault\\notes\\Clippings'
  );
});

test('extractCwdFromPromptLines reads PowerShell prompts from a single screen line', () => {
  assert.equal(
    extractCwdFromPromptLines(
      'PS F:\\example-vault\\notes\\Clippings>',
      null,
      ''
    ),
    'F:\\example-vault\\notes\\Clippings'
  );
});

test('extractCwdFromPromptLines combines a Git Bash MINGW header with the next-line prompt', () => {
  // Git Bash typically prints two lines: the header (with cwd) and a
  // line starting with `$ `. The cursor is on the `$ ` line, so we
  // must look at the previous line for the cwd.
  assert.equal(
    extractCwdFromPromptLines(
      '$ ',
      'user@host MINGW64 /f/example-vault/notes/Clippings',
      ''
    ),
    'F:\\example-vault\\notes\\Clippings'
  );
});

test('extractCwdFromPromptLines reads WSL cwd from the prompt line', () => {
  assert.equal(
    extractCwdFromPromptLines(
      'user@host:/mnt/f/example-vault/notes/Clippings$ ',
      null,
      ''
    ),
    '/mnt/f/example-vault/notes/Clippings'
  );
});

test('extractCwdFromPromptLines returns null when neither line looks like a prompt', () => {
  assert.equal(
    extractCwdFromPromptLines('arbitrary command output', null, ''),
    null
  );
});

test('extractCwdFromPromptLines expands ~ against the supplied home directory', () => {
  assert.equal(
    extractCwdFromPromptLines(
      '$ ',
      'user@host MINGW64 ~/projects/demo',
      'F:\\Users\\example'
    ),
    'F:\\Users\\example/projects/demo'
  );
});
