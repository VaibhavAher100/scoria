import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEV_RELOAD_PHASE_INSTALLING,
  DEV_RELOAD_REQUEST_FILE,
  clearDevInstallRequest,
  createDevInstallRequest,
  writeDevInstallRequest,
} from './install-dev-reload.js';

test('createDevInstallRequest records the install-phase metadata', () => {
  const requestedAt = new Date('2026-04-26T00:00:00.000Z');
  const activeUntil = new Date('2026-04-26T00:01:30.000Z');

  const request = createDevInstallRequest({
    requestId: 'install-1',
    requestedAt,
    activeUntil,
    pid: 321,
  });

  assert.deepEqual(request, {
    pluginId: 'termy',
    requestId: 'install-1',
    phase: DEV_RELOAD_PHASE_INSTALLING,
    requestedAt: requestedAt.toISOString(),
    activeUntil: activeUntil.toISOString(),
    pid: 321,
  });
});

test('writeDevInstallRequest writes installing-phase marker into the plugin directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termy-install-dev-'));

  try {
    const { requestPath } = writeDevInstallRequest(tempDir, {
      pluginId: 'termy',
      requestId: 'install-2',
      requestedAt: new Date('2026-04-26T00:00:00.000Z'),
      activeUntil: new Date('2026-04-26T00:02:00.000Z'),
      pid: 789,
    });

    assert.equal(requestPath, path.join(tempDir, DEV_RELOAD_REQUEST_FILE));
    assert.deepEqual(JSON.parse(fs.readFileSync(requestPath, 'utf-8')), {
      pluginId: 'termy',
      requestId: 'install-2',
      phase: DEV_RELOAD_PHASE_INSTALLING,
      requestedAt: '2026-04-26T00:00:00.000Z',
      activeUntil: '2026-04-26T00:02:00.000Z',
      pid: 789,
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('clearDevInstallRequest removes the installing-phase marker', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termy-install-dev-'));

  try {
    const { requestPath } = writeDevInstallRequest(tempDir, {
      requestId: 'install-3',
      requestedAt: new Date('2026-04-26T00:00:00.000Z'),
      activeUntil: new Date('2026-04-26T00:02:00.000Z'),
    });

    clearDevInstallRequest(tempDir);
    assert.equal(fs.existsSync(requestPath), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('clearDevInstallRequest tolerates missing or malformed markers', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'termy-install-dev-'));

  try {
    // Missing file should not throw.
    clearDevInstallRequest(tempDir);

    // Malformed JSON should not throw and should leave the file in place.
    const requestPath = path.join(tempDir, DEV_RELOAD_REQUEST_FILE);
    fs.writeFileSync(requestPath, 'not-json');
    clearDevInstallRequest(tempDir);
    assert.equal(fs.existsSync(requestPath), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
