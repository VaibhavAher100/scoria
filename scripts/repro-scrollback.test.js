import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScrollbackPrelude,
  buildScrollbackReproOutput,
  buildScrollbackReproSequence,
} from './repro-scrollback.js';

test('buildScrollbackPrelude emits the requested number of lines', () => {
  const output = buildScrollbackPrelude(3);

  assert.equal(output, 'before 1\r\nbefore 2\r\nbefore 3\r\n');
});

test('buildScrollbackReproSequence full mode matches the synchronized clear pattern', () => {
  const output = buildScrollbackReproSequence('full');

  assert.match(output, /\x1b\[\?2026h/);
  assert.match(output, /\x1b\[2J/);
  assert.match(output, /\x1b\[3J/);
  assert.match(output, /after full clear\r\n/);
  assert.match(output, /\x1b\[\?2026l$/);
});

test('buildScrollbackReproSequence sync-ed2 mode emits synchronized ED2 without ED3', () => {
  const output = buildScrollbackReproSequence('sync-ed2');

  assert.match(output, /\x1b\[\?2026h/);
  assert.match(output, /\x1b\[2J/);
  assert.doesNotMatch(output, /\x1b\[3J/);
  assert.match(output, /after sync ed2\r\n/);
  assert.match(output, /\x1b\[\?2026l$/);
});

test('buildScrollbackReproOutput combines scrollback prelude with the selected mode', () => {
  const output = buildScrollbackReproOutput({ mode: 'ed3', lines: 2 });

  assert.equal(output, 'before 1\r\nbefore 2\r\n\x1b[3Jafter ed3\r\n');
});

test('buildScrollbackReproSequence rejects unsupported modes', () => {
  assert.throws(
    () => buildScrollbackReproSequence('unknown'),
    /Unsupported repro mode: unknown/,
  );
});
