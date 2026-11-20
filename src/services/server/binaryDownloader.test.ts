import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBinaryAssetUrls, GITHUB_RELEASE_REPOSITORY } from './binaryDownloadUrls.ts';
import PINNED_HASHES from './pinnedHashes.json' with { type: 'json' };

test('resolveBinaryAssetUrls builds GitHub Release URLs for Unix binaries', () => {
  const urls = resolveBinaryAssetUrls({ version: '1.3.0', platform: 'linux', arch: 'x64', source: 'github-release' });
  assert.equal(urls.url, 'https://github.com/VaibhavAher100/scoria/releases/download/1.3.0/termy-server-linux-x64');
});

test('resolveBinaryAssetUrls builds GitHub Release URLs for Windows binaries', () => {
  const urls = resolveBinaryAssetUrls({ version: '1.3.0', platform: 'win32', arch: 'x64', source: 'github-release' });
  assert.equal(urls.url, 'https://github.com/VaibhavAher100/scoria/releases/download/1.3.0/termy-server-win32-x64.exe');
});

// The committed pin file stays empty; only the release workflow fills it. A dev
// build therefore has no pin, and the downloader refuses to fetch.
test('the committed pin file is empty, so dev builds have no expected hash', () => {
  assert.deepEqual(PINNED_HASHES, {});
  const urls = resolveBinaryAssetUrls({ version: '1.3.0', platform: 'linux', arch: 'x64', source: 'github-release' });
  assert.equal(urls.expectedHash, undefined);
});

// Provenance guard: the binary must only ever come from our own GitHub host, never
// Termy's upstream or any third-party host. Covers every platform/arch.
test('resolveBinaryAssetUrls never points at a third-party host', () => {
  assert.equal(GITHUB_RELEASE_REPOSITORY, 'VaibhavAher100/scoria');
  const ourHost = 'https://github.com/VaibhavAher100/scoria/';
  for (const platform of ['linux', 'win32', 'darwin'] as NodeJS.Platform[]) {
    for (const arch of ['x64', 'arm64']) {
      const urls = resolveBinaryAssetUrls({ version: '9.9.9', platform, arch, source: 'github-release' });
      assert.ok(urls.url.startsWith(ourHost), `url leaked host: ${urls.url}`);
    }
  }
});
