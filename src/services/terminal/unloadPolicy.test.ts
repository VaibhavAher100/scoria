import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { decideTerminalClose, shouldKeepSessionsOnUnload } from './unloadPolicy.ts';

test('keeps sessions on a reload or update unload (userDisabled false)', () => {
  assert.equal(shouldKeepSessionsOnUnload(true, false), true);
});

test('kills sessions when the user turns the plugin off in Settings', () => {
  assert.equal(shouldKeepSessionsOnUnload(true, true), false);
});

test('falls back to keep-alive when the private flag is missing or not a boolean', () => {
  assert.equal(shouldKeepSessionsOnUnload(true, undefined), true);
  assert.equal(shouldKeepSessionsOnUnload(true, 'true'), true);
  assert.equal(shouldKeepSessionsOnUnload(true, 1), true);
});

test('the kill-on-unload setting always wins', () => {
  assert.equal(shouldKeepSessionsOnUnload(false, false), false);
  assert.equal(shouldKeepSessionsOnUnload(false, undefined), false);
});

test('unload in keep mode detaches the session and leaves the server to onunload', () => {
  assert.deepEqual(decideTerminalClose(true, true, 0), { keepSession: true, shutdownServer: false });
});

test('unload in kill mode kills the session but leaves the server to onunload', () => {
  assert.deepEqual(decideTerminalClose(true, false, 0), { keepSession: false, shutdownServer: false });
});

test('unload never stops the server from a view close, whatever the terminal count', () => {
  assert.deepEqual(decideTerminalClose(true, true, 3), { keepSession: true, shutdownServer: false });
  assert.deepEqual(decideTerminalClose(true, false, 3), { keepSession: false, shutdownServer: false });
});

// The fix depends on Obsidian's LIFO cleanup order: the unload cleanup must be
// registered after registerView(TERMINAL_VIEW_TYPE) so it runs before the view
// type is unregistered. Guard against a refactor that reorders the two calls.
test('main.ts registers the unload cleanup directly after the terminal view', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8');
  const viewAt = source.search(/this\.registerView\(\s*TERMINAL_VIEW_TYPE/);
  const cleanupAt = source.indexOf('beginPluginUnload(this.keepSessionsOnUnload())');
  assert.ok(viewAt > 0, 'registerView(TERMINAL_VIEW_TYPE) not found');
  assert.ok(cleanupAt > viewAt, 'unload cleanup must come after registerView');
  const between = source.slice(viewAt, cleanupAt);
  assert.equal((between.match(/this\.register\w*\(/g) ?? []).length, 2,
    'only registerView and the cleanup register() may sit between them');
});

test('a user close of the last tab kills the shell and stops the server', () => {
  assert.deepEqual(decideTerminalClose(false, true, 0), { keepSession: false, shutdownServer: true });
});

test('a user close of one tab of several keeps the server', () => {
  assert.deepEqual(decideTerminalClose(false, true, 2), { keepSession: false, shutdownServer: false });
});
