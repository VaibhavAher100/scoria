import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDaemonRecord,
  serializeDaemonRecord,
  isVersionCompatible,
  type DaemonRecord,
} from './daemonRecord.ts';

const VALID_PIPE = '\\\\.\\pipe\\termy-12345678-1234-1234-1234-1234567890ab';

function validRecord(): DaemonRecord {
  return {
    pipe: VALID_PIPE,
    pid: 4242,
    binaryVersion: '1.3.0',
    startedAt: '2026-06-15T12:00:00.000Z',
  };
}

test('round-trips a valid record', () => {
  const record = validRecord();
  const parsed = parseDaemonRecord(serializeDaemonRecord(record));
  assert.deepEqual(parsed, record);
});

test('rejects malformed JSON', () => {
  assert.equal(parseDaemonRecord('not json'), null);
  assert.equal(parseDaemonRecord(''), null);
});

test('rejects non-object JSON', () => {
  assert.equal(parseDaemonRecord('42'), null);
  assert.equal(parseDaemonRecord('null'), null);
  assert.equal(parseDaemonRecord('"a string"'), null);
  assert.equal(parseDaemonRecord('[]'), null);
});

test('rejects a pipe path that fails PIPE_NAME_RE', () => {
  const bad = { ...validRecord(), pipe: '\\\\.\\pipe\\evil-pipe' };
  assert.equal(parseDaemonRecord(JSON.stringify(bad)), null);
});

test('rejects a foreign-named pipe even with a uuid', () => {
  const bad = { ...validRecord(), pipe: '\\\\.\\pipe\\other-12345678-1234-1234-1234-1234567890ab' };
  assert.equal(parseDaemonRecord(JSON.stringify(bad)), null);
});

test('rejects a non-positive or non-integer pid', () => {
  assert.equal(parseDaemonRecord(JSON.stringify({ ...validRecord(), pid: 0 })), null);
  assert.equal(parseDaemonRecord(JSON.stringify({ ...validRecord(), pid: -1 })), null);
  assert.equal(parseDaemonRecord(JSON.stringify({ ...validRecord(), pid: 1.5 })), null);
  assert.equal(parseDaemonRecord(JSON.stringify({ ...validRecord(), pid: 'x' })), null);
});

test('rejects an empty or non-string binaryVersion', () => {
  assert.equal(parseDaemonRecord(JSON.stringify({ ...validRecord(), binaryVersion: '' })), null);
  assert.equal(parseDaemonRecord(JSON.stringify({ ...validRecord(), binaryVersion: 3 })), null);
});

test('rejects a missing field', () => {
  const { pid: _pid, ...noPid } = validRecord();
  assert.equal(parseDaemonRecord(JSON.stringify(noPid)), null);
});

test('isVersionCompatible matches exact versions only', () => {
  const record = validRecord();
  assert.equal(isVersionCompatible(record, '1.3.0'), true);
  assert.equal(isVersionCompatible(record, '1.3.1'), false);
  assert.equal(isVersionCompatible(record, '1.2.0'), false);
});
