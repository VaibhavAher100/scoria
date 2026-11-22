import test from 'node:test';
import assert from 'node:assert/strict';
import { extractChangelogSection, renderReleaseBody } from './release-notes.js';

const SAMPLE_CHANGELOG = `# Changelog

## [1.3.0] - 2026-04-23

### Added
- Embedded changelog support.

## [1.2.3]

### Fixed
- Previous release.
`;

test('extractChangelogSection returns the requested version notes', () => {
  const section = extractChangelogSection(SAMPLE_CHANGELOG, '1.3.0');

  assert.equal(section, [
    '### Added',
    '- Embedded changelog support.',
  ].join('\n'));
});

test('renderReleaseBody describes the package without requiring CHANGELOG.md as an asset', () => {
  const body = renderReleaseBody({
    version: '1.3.0',
    changelogSection: '### Added\n- Embedded changelog support.',
    repository: 'VaibhavAher100/scoria',
  });

  assert.match(body, /Download `scoria-1\.3\.0\.zip` \(includes plugin files and all platform binaries\)/);
  assert.doesNotMatch(body, /Download `scoria\.zip`/);
  assert.doesNotMatch(body, /includes all platform binaries and `CHANGELOG\.md`/);
  assert.doesNotMatch(body, /t\.me\//);
  assert.doesNotMatch(body, /\[Discussions\]\(/);
  assert.ok(body.startsWith('## Changelog\n\n### Added\n- Embedded changelog support.\n\n## Installation'));

  // Scoria is not in the Community Plugins directory yet: BRAT first, then manual install.
  const bratIndex = body.indexOf('### BRAT (Beta)');
  const manualIndex = body.indexOf('### Manual Installation');
  assert.ok(bratIndex !== -1, 'BRAT section should be present');
  assert.ok(manualIndex !== -1, 'Manual Installation section should be present');
  assert.ok(bratIndex < manualIndex, 'BRAT should come before Manual Installation');
  assert.doesNotMatch(body, /Community Plugins \(Recommended\)|search for `Scoria`/);
  assert.match(body, /add the beta plugin `VaibhavAher100\/scoria`/);
  assert.match(body, /checks it against the SHA-256 pinned in the plugin/);
});
