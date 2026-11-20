/**
 * Look up the *latest published* version of an AI launcher CLI from its
 * upstream registry (npm or GitHub Releases).
 *
 * Scoria treats this as an *opt-in* feature gated by the
 * `checkAiLauncherUpdates` setting. Without that opt-in we do NOT touch
 * the network — the README's "no extra outbound traffic by default"
 * promise is preserved. When the user opts in, the README is updated to
 * disclose the additional registry endpoints; see
 * `README.md` → "Privacy and Network Access".
 *
 * Results are cached in-memory for {@link LATEST_VERSION_CACHE_TTL_MS} so
 * a re-render does not re-fetch.
 */

import { debugWarn } from '../../utils/logger.ts';
import type { LatestVersionRegistry } from './aiLauncherCatalog';

export interface LatestVersionLookupResult {
  /** Version string fetched from the registry, or null on any failure. */
  version: string | null;
  /** Filled when the lookup failed. Used by the diagnostics modal. */
  error?: string;
}

interface CacheEntry {
  result: LatestVersionLookupResult;
  expiresAt: number;
}

const LATEST_VERSION_CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const FETCH_TIMEOUT_MS = 5_000;

const cache = new Map<string, CacheEntry>();

interface NodeHttpsLike {
  get(
    url: URL,
    options: { headers?: Record<string, string> },
    callback: (response: NodeHttpResponseLike) => void,
  ): NodeHttpRequestLike;
}

interface NodeHttpRequestLike {
  on(event: 'error', listener: (error: Error) => void): this;
  destroy(): void;
}

interface NodeHttpResponseLike {
  statusCode?: number;
  headers: Record<string, string | string[] | undefined>;
  resume(): void;
  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

function loadHttps(): NodeHttpsLike | null {
  try {
    return window.require('https') as NodeHttpsLike;
  } catch (error) {
    debugWarn('[latestVersionRegistry] https module unavailable:', error);
    return null;
  }
}

/**
 * Look up the latest version for one launcher. Returns immediately from
 * the cache when the entry is still fresh.
 */
export async function fetchLatestVersion(
  registry: LatestVersionRegistry,
): Promise<LatestVersionLookupResult> {
  const cacheKey = describeRegistry(registry);
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const result = registry.kind === 'npm'
    ? await fetchNpmLatest(registry.package)
    : await fetchGithubReleaseLatest(registry.repo);

  cache.set(cacheKey, { result, expiresAt: Date.now() + LATEST_VERSION_CACHE_TTL_MS });
  return result;
}

/**
 * Drop cached lookups so the next call re-fetches. Used by an explicit
 * "Refresh" action in the install modal.
 */
export function clearLatestVersionCache(): void {
  cache.clear();
}

function describeRegistry(registry: LatestVersionRegistry): string {
  return registry.kind === 'npm' ? `npm:${registry.package}` : `gh:${registry.repo}`;
}

async function fetchNpmLatest(packageName: string): Promise<LatestVersionLookupResult> {
  // npm's lightweight per-package endpoint; returns a JSON document with
  // `dist-tags.latest` pointing at the most recent stable release.
  const url = new URL(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
  const json = await fetchJson(url, {
    Accept: 'application/json',
    'User-Agent': 'scoria-obsidian-plugin',
  });
  if (!json) {
    return { version: null, error: 'Registry request failed or timed out' };
  }
  const distTags = json['dist-tags'];
  const latest = isRecord(distTags) ? distTags.latest : undefined;
  if (typeof latest === 'string' && latest.length > 0) {
    return { version: latest };
  }
  return { version: null, error: 'Registry response missing dist-tags.latest' };
}

async function fetchGithubReleaseLatest(repo: string): Promise<LatestVersionLookupResult> {
  // GitHub's anonymous releases API is rate-limited (60 req/h per IP),
  // which is fine for our 12-hour cache TTL.
  const url = new URL(`https://api.github.com/repos/${repo}/releases/latest`);
  const json = await fetchJson(url, {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'scoria-obsidian-plugin',
  });
  if (!json) {
    return { version: null, error: 'GitHub releases request failed or timed out' };
  }
  const tag = json.tag_name;
  if (typeof tag !== 'string' || tag.length === 0) {
    return { version: null, error: 'GitHub release missing tag_name' };
  }
  // Strip any leading "v" so the result lines up with the local probe
  // output (which never carries a leading "v").
  const trimmed = tag.replace(/^v/, '');
  return { version: trimmed };
}

function fetchJson(
  url: URL,
  headers: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const https = loadHttps();
    if (!https) {
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let request: NodeHttpRequestLike;
    try {
      request = https.get(url, { headers }, (response) => {
        const statusCode = response.statusCode ?? 0;
        const location = response.headers.location;
        if (
          statusCode >= 300
          && statusCode < 400
          && typeof location === 'string'
          && location.length > 0
        ) {
          // Follow a single redirect — the npm endpoint sometimes redirects
          // through a CDN. A second redirect would suggest something is
          // wrong; we bail in that case rather than recursing.
          response.resume();
          const next = new URL(location, url);
          fetchJson(next, headers).then(finish).catch(() => finish(null));
          return;
        }

        if (statusCode !== 200) {
          response.resume();
          debugWarn(`[latestVersionRegistry] HTTP ${statusCode} for ${url.toString()}`);
          finish(null);
          return;
        }

        let buffer = '';
        response.on('data', (chunk) => {
          buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(buffer) as unknown;
            if (isRecord(parsed)) {
              finish(parsed);
              return;
            }
            finish(null);
          } catch (error) {
            debugWarn('[latestVersionRegistry] failed to parse response JSON:', error);
            finish(null);
          }
        });
        response.on('error', (error) => {
          debugWarn('[latestVersionRegistry] response error:', error);
          finish(null);
        });
      });
    } catch (error) {
      debugWarn('[latestVersionRegistry] request setup failed:', error);
      finish(null);
      return;
    }

    request.on('error', (error) => {
      debugWarn('[latestVersionRegistry] request error:', error);
      finish(null);
    });

    window.setTimeout(() => {
      try {
        request.destroy();
      } catch (error) {
        debugWarn('[latestVersionRegistry] failed to abort request:', error);
      }
      finish(null);
    }, FETCH_TIMEOUT_MS);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
