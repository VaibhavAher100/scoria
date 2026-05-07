import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSynchronizedOutputCompatibilityState,
  filterSynchronizedOutputScrollbackPurge,
} from './aiTuiCompatibility.ts';

test('filterSynchronizedOutputScrollbackPurge strips ED3 only while synchronized output is active', () => {
  const state = createSynchronizedOutputCompatibilityState();
  const output = filterSynchronizedOutputScrollbackPurge(
    'before\x1b[?2026h\x1b[3Jafter\x1b[?2026l',
    state,
  );

  assert.equal(output, 'before\x1b[?2026hafter\x1b[?2026l');
  assert.equal(state.synchronizedOutputActive, false);
  assert.equal(state.pendingText, '');
});

test('filterSynchronizedOutputScrollbackPurge preserves ED3 outside synchronized output', () => {
  const state = createSynchronizedOutputCompatibilityState();
  const output = filterSynchronizedOutputScrollbackPurge('before\x1b[3Jafter', state);

  assert.equal(output, 'before\x1b[3Jafter');
  assert.equal(state.pendingText, '');
});

test('filterSynchronizedOutputScrollbackPurge handles tracked sequences split across chunks', () => {
  const state = createSynchronizedOutputCompatibilityState();

  const first = filterSynchronizedOutputScrollbackPurge('x\x1b[?20', state);
  const second = filterSynchronizedOutputScrollbackPurge('26h\x1b[3', state);
  const third = filterSynchronizedOutputScrollbackPurge('Jdone\x1b[?2026l', state);

  assert.equal(first, 'x');
  assert.equal(second, '\x1b[?2026h');
  assert.equal(third, 'done\x1b[?2026l');
  assert.equal(state.synchronizedOutputActive, false);
  assert.equal(state.pendingText, '');
});
