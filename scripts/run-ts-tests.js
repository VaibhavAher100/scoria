import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function collectTests(directory) {
  const tests = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(path));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      tests.push(path);
    }
  }
  return tests;
}

const tests = collectTests('src').sort();
if (tests.length === 0) {
  throw new Error('No TypeScript tests found under src');
}

const result = spawnSync(
  process.execPath,
  [
    '--experimental-strip-types',
    '--experimental-specifier-resolution=node',
    '--test',
    ...tests,
  ],
  { stdio: 'inherit' }
);

if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
