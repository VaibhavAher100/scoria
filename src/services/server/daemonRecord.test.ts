import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDaemonRecord,
  serializeDaemonRecord,
  isVersionCompatible,
  isAcceptableEndpoint,
  type DaemonRecord,
} from './daemonRecord.ts';

const VALID_PIPE = '\\\\.\\pipe\\scoria-12345678-1234-1234-1234-1234567890ab';
const VALID_SOCKET = '/run/user/1000/scoria-123456781234123412341234567890ab/daemon.sock';

function validRecord(): DaemonRecord {
  return {
    pipe: VALID_PIPE,
    pid: 4242,
    binaryVersion: '1.3.0',
    startedAt: '2026-06-15T12:00:00.000Z',
  };
}

function validSocketRecord(): DaemonRecord {
  return {
    socket: VALID_SOCKET,
    pid: 4242,
    binaryVersion: '1.3.0',
    startedAt: '2026-06-15T12:00:00.000Z',
  };
}

test('round-trips a valid pipe record', () => {
  const record = validRecord();
  const parsed = parseDaemonRecord(serializeDaemonRecord(record));
  assert.deepEqual(parsed, record);
});

test('round-trips a valid socket record', () => {
  const record = validSocketRecord();
  const parsed = parseDaemonRecord(serializeDaemonRecord(record));
  assert.deepEqual(parsed, record);
});

test('accepts a socket under the system temp dir (no XDG_RUNTIME_DIR)', () => {
  const record = {
    ...validSocketRecord(),
    socket: '/var/folders/ab/T/scoria-123456781234123412341234567890ab/daemon.sock',
  };
  assert.deepEqual(parseDaemonRecord(JSON.stringify(record)), record);
});

test('rejects a socket path that fails SOCKET_PATH_RE', () => {
  // Wrong filename, wrong dir prefix, relative path, and a traversal attempt.
  for (const socket of [
    '/run/user/1000/scoria-123456781234123412341234567890ab/evil.sock',
    '/run/user/1000/other-12345678-1234-1234-1234-1234567890ab/daemon.sock',
    '/tmp/daemon.sock',
    'scoria-123456781234123412341234567890ab/daemon.sock',
    '/tmp/scoria-123456781234123412341234567890ab/../../evil/daemon.sock',
    // A `..` traversal segment in the variable base is rejected, so a doctored
    // sidecar cannot escape the matched shape onto an arbitrary path.
    '/home/victim/.config/../../../tmp/attacker/scoria-123456781234123412341234567890ab/daemon.sock',
    // The hyphenated 36-char form and the pre-rename prefix are not what unix.rs produces.
    '/run/user/1000/scoria-12345678-1234-1234-1234-1234567890ab/daemon.sock',
    '/run/user/1000/termy-123456781234123412341234567890ab/daemon.sock',
  ]) {
    assert.equal(parseDaemonRecord(JSON.stringify({ ...validSocketRecord(), socket })), null, socket);
  }
});

test('rejects a record carrying BOTH a pipe and a socket', () => {
  const both = { ...validRecord(), socket: VALID_SOCKET };
  assert.equal(parseDaemonRecord(JSON.stringify(both)), null);
});

test('rejects a record carrying NEITHER a pipe nor a socket', () => {
  const { pipe: _pipe, ...neither } = validRecord();
  assert.equal(parseDaemonRecord(JSON.stringify(neither)), null);
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

test('isAcceptableEndpoint: accepts only the requested transport', () => {
  assert.equal(isAcceptableEndpoint({ pipe: VALID_PIPE }, 'pipe'), true);
  assert.equal(isAcceptableEndpoint({ socket: VALID_SOCKET }, 'socket'), true);
  assert.equal(isAcceptableEndpoint({ port: 4000, token: 'abc' }, 'websocket'), true);
});

test('isAcceptableEndpoint: refuses a port when a pipe or socket was requested', () => {
  assert.equal(isAcceptableEndpoint({ port: 4000, token: 'abc' }, 'pipe'), false);
  assert.equal(isAcceptableEndpoint({ port: 4000, token: 'abc' }, 'socket'), false);
  assert.equal(isAcceptableEndpoint({ port: 4000 }, 'pipe'), false);
});

test('isAcceptableEndpoint: refuses a WebSocket endpoint with no token', () => {
  assert.equal(isAcceptableEndpoint({ port: 4000 }, 'websocket'), false);
  assert.equal(isAcceptableEndpoint({ port: 4000, token: '' }, 'websocket'), false);
  assert.equal(isAcceptableEndpoint({ port: 0, token: 'abc' }, 'websocket'), false);
  assert.equal(isAcceptableEndpoint({ port: 70000, token: 'abc' }, 'websocket'), false);
});

test('isAcceptableEndpoint: refuses malformed pipe and socket paths', () => {
  assert.equal(isAcceptableEndpoint({ pipe: '\\\\.\\pipe\\evil' }, 'pipe'), false);
  assert.equal(isAcceptableEndpoint({ socket: '/tmp/evil.sock' }, 'socket'), false);
  assert.equal(isAcceptableEndpoint({ socket: VALID_SOCKET }, 'pipe'), false);
});
