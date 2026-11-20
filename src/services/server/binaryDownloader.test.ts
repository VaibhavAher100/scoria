import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveBinaryAssetUrls, GITHUB_RELEASE_REPOSITORY } from './binaryDownloadUrls.ts';

test('resolveBinaryAssetUrls builds GitHub Release URLs for Unix binaries', () => {
  const urls = resolveBinaryAssetUrls({
    version: '1.3.0',
    platform: 'linux',
    arch: 'x64',
    source: 'github-release',
  });

  assert.equal(
    urls.url,
    'https://github.com/VaibhavAher100/obsidian-terminal/releases/download/1.3.0/termy-server-linux-x64'
  );
  assert.equal(
    urls.checksumUrl,
    'https://github.com/VaibhavAher100/obsidian-terminal/releases/download/1.3.0/termy-server-linux-x64.sha256'
  );
});

test('resolveBinaryAssetUrls builds GitHub Release URLs for Windows binaries', () => {
  const urls = resolveBinaryAssetUrls({
    version: '1.3.0',
    platform: 'win32',
    arch: 'x64',
    source: 'github-release',
  });

  assert.equal(
    urls.url,
    'https://github.com/VaibhavAher100/obsidian-terminal/releases/download/1.3.0/termy-server-win32-x64.exe'
  );
  assert.equal(
    urls.checksumUrl,
    'https://github.com/VaibhavAher100/obsidian-terminal/releases/download/1.3.0/termy-server-win32-x64.exe.sha256'
  );
});

test('resolveBinaryAssetUrls builds GitHub latest fallback URLs', () => {
  const urls = resolveBinaryAssetUrls({
    version: '1.3.0',
    platform: 'darwin',
    arch: 'arm64',
    source: 'github-release',
    releaseChannel: 'latest',
  });

  assert.equal(
    urls.url,
    'https://github.com/VaibhavAher100/obsidian-terminal/releases/latest/download/termy-server-darwin-arm64'
  );
  assert.equal(
    urls.checksumUrl,
    'https://github.com/VaibhavAher100/obsidian-terminal/releases/latest/download/termy-server-darwin-arm64.sha256'
  );
});

// Provenance guard: the binary must only ever come from our own GitHub host, never
// Termy's upstream or any third-party host. Covers every platform/arch/channel.
test('resolveBinaryAssetUrls never points at a third-party host', () => {
  assert.equal(GITHUB_RELEASE_REPOSITORY, 'VaibhavAher100/obsidian-terminal');
  const ourHost = 'https://github.com/VaibhavAher100/obsidian-terminal/';
  for (const platform of ['linux', 'win32', 'darwin'] as NodeJS.Platform[]) {
    for (const arch of ['x64', 'arm64']) {
      for (const releaseChannel of ['version', 'latest'] as const) {
        const urls = resolveBinaryAssetUrls({
          version: '9.9.9',
          platform,
          arch,
          source: 'github-release',
          releaseChannel,
        });
        assert.ok(urls.url.startsWith(ourHost), `url leaked host: ${urls.url}`);
        assert.ok(urls.checksumUrl.startsWith(ourHost), `checksum leaked host: ${urls.checksumUrl}`);
      }
    }
  }
});
