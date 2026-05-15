import * as assert from 'node:assert/strict';
import test from 'node:test';

import { ClaudeCodeSessionState } from './claudeCodeSessionState.ts';

test('Claude Code path-reference mode is inactive before observing TUI signals', () => {
  const state = new ClaudeCodeSessionState();

  assert.equal(state.isActive(), false);
  assert.equal(state.getExtendedKeyboardMode(), 'none');
});

test('Claude Code path-reference mode resets when Claude Code disables modifyOtherKeys', () => {
  const state = new ClaudeCodeSessionState();

  state.observeModifyOtherKeysMode(true);
  assert.equal(state.isActive(), true);
  assert.equal(state.getExtendedKeyboardMode(), 'modifyOtherKeys');

  state.observeModifyOtherKeysMode(false);
  assert.equal(state.isActive(), false);
  assert.equal(state.getExtendedKeyboardMode(), 'none');
});

test('Claude Code path-reference mode resets after returning to the shell prompt', () => {
  const state = new ClaudeCodeSessionState();

  state.observeXtversionQuery();
  assert.equal(state.isActive(), true);

  state.observeShellPrompt();
  assert.equal(state.isActive(), false);
  assert.equal(state.getExtendedKeyboardMode(), 'none');
});
