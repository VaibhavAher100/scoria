import test from 'node:test';
import assert from 'node:assert/strict';
import { getHomeDir, getPlatform, isLinux, isMacOS, isWindows } from './platform.ts';

test('getPlatform mirrors the current Node platform', () => {
  assert.equal(getPlatform(), process.platform);
});

test('isWindows / isMacOS / isLinux are mutually exclusive on the current host', () => {
  const flags = [isWindows(), isMacOS(), isLinux()];
  const trueCount = flags.filter(Boolean).length;
  // The host may be a platform we don't classify (e.g. freebsd), in which
  // case all flags are false. The invariant is that we never mark two
  // platforms as true at the same time.
  assert.ok(trueCount <= 1, `expected at most one platform flag, got ${trueCount}`);

  if (process.platform === 'win32') {
    assert.equal(isWindows(), true);
  } else if (process.platform === 'darwin') {
    assert.equal(isMacOS(), true);
  } else if (process.platform === 'linux') {
    assert.equal(isLinux(), true);
  }
});

test('getHomeDir prefers HOME, falls back to USERPROFILE, and never throws', () => {
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;

  try {
    process.env.HOME = '/Users/example';
    process.env.USERPROFILE = 'C:\\Users\\example';
    assert.equal(getHomeDir(), '/Users/example');

    delete process.env.HOME;
    assert.equal(getHomeDir(), 'C:\\Users\\example');

    delete process.env.USERPROFILE;
    assert.equal(getHomeDir(), '');
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = originalUserProfile;
    }
  }
});
