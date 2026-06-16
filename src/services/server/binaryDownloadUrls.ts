import type { BinaryDownloadSource } from '../../settings/settings';

// Our own fork's release host. The binaries served here are built from this
// repository's authenticated Rust server (M1-M3); the upstream Termy binaries are
// unauthenticated, so we never fetch from Termy's host or any third-party host we
// do not control.
export const GITHUB_RELEASE_REPOSITORY = 'VaibhavAher100/obsidian-terminal';

interface BinaryInfo {
  filename: string;
  url: string;
  checksumUrl: string;
}

export interface BinaryDownloadConfig {
  source: BinaryDownloadSource;
}

export interface ResolveBinaryAssetUrlsOptions extends BinaryDownloadConfig {
  version: string;
  platform?: NodeJS.Platform;
  arch?: string;
  releaseChannel?: 'version' | 'latest';
}

function buildBinaryFilename(platform: string, arch: string): string {
  const ext = platform === 'win32' ? '.exe' : '';
  return `termy-server-${platform}-${arch}${ext}`;
}

export function resolveBinaryAssetUrls(options: ResolveBinaryAssetUrlsOptions): BinaryInfo {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const filename = buildBinaryFilename(platform, arch);

  // Only our GitHub release host is ever used; there is no third-party fallback.
  const releaseBaseUrl = options.releaseChannel === 'latest'
    ? `https://github.com/${GITHUB_RELEASE_REPOSITORY}/releases/latest/download`
    : `https://github.com/${GITHUB_RELEASE_REPOSITORY}/releases/download/${options.version}`;

  return {
    filename,
    url: `${releaseBaseUrl}/${filename}`,
    checksumUrl: `${releaseBaseUrl}/${filename}.sha256`,
  };
}
