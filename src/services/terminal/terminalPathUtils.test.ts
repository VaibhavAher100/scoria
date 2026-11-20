import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectTerminalReferenceCandidatePaths,
  fileUriToPlatformPath,
  findUniqueTerminalEntryByBasename,
  getVaultRelativePathFromAbsolute,
  isAbsoluteTerminalPath,
  isExternallyOpenableFile,
  isNetworkTerminalPath,
  joinTerminalPaths,
  normalizeDroppedEntryPath,
  normalizeDroppedEntryReference,
  normalizeTerminalRawToken,
  normalizeTerminalReferencePath,
  normalizeTerminalToken,
  normalizeVaultPath,
  obsidianUriToVaultPath,
  quoteShellArgument,
  scanWikilinkRanges,
  shellQuoteStyleFor,
  stripShellControlChars,
  terminalStringIndexToBufferColumn,
} from './terminalPathUtils.ts';

test('quoteShellArgument: quotes plain paths for each shell', () => {
  assert.equal(quoteShellArgument('notes/a b.md', 'posix'), `'notes/a b.md'`);
  assert.equal(quoteShellArgument('C:\\v\\a b (1).md', 'powershell'), `'C:\\v\\a b (1).md'`);
  assert.equal(quoteShellArgument('C:\\v\\a b.md', 'cmd'), `"C:\\v\\a b.md"`);
  assert.equal(quoteShellArgument('日本語ノート.md', 'posix'), `'日本語ノート.md'`);
});

test('quoteShellArgument: refuses characters any supported shell interprets', () => {
  for (const style of ['posix', 'powershell', 'cmd'] as const) {
    assert.equal(quoteShellArgument('$(rm -rf ~).md', style), null);
    assert.equal(quoteShellArgument("it's.md", style), null);
    assert.equal(quoteShellArgument('a;b.md', style), null);
    assert.equal(quoteShellArgument('a`b`.md', style), null);
    assert.equal(quoteShellArgument('a&calc.md', style), null);
    assert.equal(quoteShellArgument('a|b.md', style), null);
    assert.equal(quoteShellArgument('%PATH%.md', style), null);
    assert.equal(quoteShellArgument('a!b.md', style), null);
    assert.equal(quoteShellArgument('it\u2019s.md', style), null);
    assert.equal(quoteShellArgument('a\uff02b.md', style), null);
    assert.equal(quoteShellArgument('a\u00a5b.md', style), null);
    assert.equal(quoteShellArgument('a\u202eb.md', style), null);
  }
});

test('quoteShellArgument: refuses a leading dash (option injection)', () => {
  assert.equal(quoteShellArgument('-rf.md', 'posix'), null);
});

test('quoteShellArgument: refuses empty values and control characters', () => {
  assert.equal(quoteShellArgument('', 'posix'), null);
  assert.equal(quoteShellArgument('a\rb.md', 'posix'), null);
  assert.equal(quoteShellArgument('a\nb.md', 'powershell'), null);
  assert.equal(quoteShellArgument('a\u001b[2Jb.md', 'cmd'), null);
});

test('shellQuoteStyleFor maps known shells and refuses custom shells', () => {
  assert.equal(shellQuoteStyleFor('bash'), 'posix');
  assert.equal(shellQuoteStyleFor('gitbash'), 'posix');
  assert.equal(shellQuoteStyleFor('pwsh'), 'powershell');
  assert.equal(shellQuoteStyleFor('cmd'), 'cmd');
  assert.equal(shellQuoteStyleFor('custom'), null);
});

test('isExternallyOpenableFile allows passive documents only', () => {
  assert.equal(isExternallyOpenableFile('C:\\Users\\me\\report.PDF'), true);
  assert.equal(isExternallyOpenableFile('/home/me/photo.png'), true);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\setup.exe'), false);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\run.bat'), false);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\link.lnk'), false);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\page.hta'), false);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\script.py'), false);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\a.exe.'), false);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\a.pdf '), false);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\noext'), false);
  assert.equal(isExternallyOpenableFile('/home/me/.bashrc'), false);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\invoice.docx'), false);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\doc.rtf'), false);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\data.xml'), false);
  assert.equal(isExternallyOpenableFile('C:\\tmp\\sheet.csv'), false);
});

test('isNetworkTerminalPath detects UNC and device paths', () => {
  assert.equal(isNetworkTerminalPath('\\\\host\\share\\x.pdf'), true);
  assert.equal(isNetworkTerminalPath('//host/share/x.pdf'), true);
  assert.equal(isNetworkTerminalPath('\\\\?\\UNC\\host\\share'), true);
  assert.equal(isNetworkTerminalPath('C:\\Users\\me\\x.pdf'), false);
  assert.equal(isNetworkTerminalPath('/home/me/x.pdf'), false);
});

test('stripShellControlChars removes CR, LF, ESC and DEL', () => {
  assert.equal(stripShellControlChars('a\r\nb\u001b\u007fc'), 'abc');
});

test('normalizeTerminalToken strips wrappers and decodes escaped drag payload text', () => {
  assert.equal(
    normalizeTerminalToken('  <file:///C:/Program%20Files/Termy>  '),
    'file:///C:/Program Files/Termy'
  );
  assert.equal(normalizeTerminalToken('"[[Folder/File.md]]"'), '[[Folder/File.md]]');
});

test('scanWikilinkRanges finds links and strips alias/heading/block from the target', () => {
  assert.deepEqual(scanWikilinkRanges('see [[Note]] now'), [
    { startIndex: 4, endIndex: 12, linkpath: 'Note' },
  ]);

  const aliased = scanWikilinkRanges('[[Folder/Note|Display]]');
  assert.equal(aliased.length, 1);
  assert.equal(aliased[0].linkpath, 'Folder/Note');
  assert.equal(aliased[0].startIndex, 0);
  assert.equal(aliased[0].endIndex, 23);

  assert.equal(scanWikilinkRanges('[[Note#Heading]]')[0].linkpath, 'Note');
  assert.equal(scanWikilinkRanges('[[Note^block]]')[0].linkpath, 'Note');
});

test('scanWikilinkRanges handles multiple links and ignores incomplete/empty ones', () => {
  const multi = scanWikilinkRanges('[[A]] and [[B]]');
  assert.deepEqual(multi.map((r) => r.linkpath), ['A', 'B']);
  assert.equal(multi[1].startIndex, 10);

  assert.deepEqual(scanWikilinkRanges('no links here'), []);
  assert.deepEqual(scanWikilinkRanges('[[]] empty'), []);
  assert.deepEqual(scanWikilinkRanges('[[unterminated'), []);
});

test('terminalStringIndexToBufferColumn maps UTF-16 indexes onto wide terminal cells', () => {
  const makeCell = (chars: string, width: number) => ({
    getChars: () => chars,
    getWidth: () => width,
  });
  const cells = [
    makeCell('你', 2),
    makeCell('', 0),
    makeCell(' ', 1),
    ...Array.from('[[N]]', (char) => makeCell(char, 1)),
  ];
  const range = scanWikilinkRanges('你 [[N]]')[0];

  assert.equal(
    terminalStringIndexToBufferColumn(range.startIndex, cells.length, (column) => cells[column]),
    3
  );
  assert.equal(
    terminalStringIndexToBufferColumn(range.endIndex, cells.length, (column) => cells[column]),
    8
  );
});

test('terminalStringIndexToBufferColumn handles surrogate-pair emoji', () => {
  const makeCell = (chars: string, width: number) => ({
    getChars: () => chars,
    getWidth: () => width,
  });
  const cells = [
    makeCell('🙂', 2),
    makeCell('', 0),
    makeCell(' ', 1),
    ...Array.from('[[N]]', (char) => makeCell(char, 1)),
  ];
  const range = scanWikilinkRanges('🙂 [[N]]')[0];

  assert.equal(
    terminalStringIndexToBufferColumn(range.startIndex, cells.length, (column) => cells[column]),
    3
  );
});

test('normalizeTerminalRawToken strips wrappers without decoding URL separators', () => {
  assert.equal(
    normalizeTerminalRawToken('  <file:///C:/repo/A%26B%23C.md>  '),
    'file:///C:/repo/A%26B%23C.md'
  );
});

test('normalizeVaultPath canonicalizes vault-style separators and relative segments', () => {
  assert.equal(normalizeVaultPath(' /folder\\child/../note.md '), 'folder/note.md');
  assert.equal(normalizeVaultPath('\\folder\\nested\\file.ts'), 'folder/nested/file.ts');
});

test('normalizeTerminalReferencePath removes diff prefixes and matches the target platform', () => {
  assert.equal(normalizeTerminalReferencePath('b/src/services/file.ts', 'win32'), 'src\\services\\file.ts');
  assert.equal(normalizeTerminalReferencePath('a\\src\\services\\file.ts', 'linux'), 'src/services/file.ts');
});

test('fileUriToPlatformPath converts file URIs into local platform paths', () => {
  assert.equal(
    fileUriToPlatformPath('file:///Users/example/Documents/Notes/%E7%A4%BA%E4%BE%8B%E7%AC%94%E8%AE%B0.md', 'darwin'),
    '/Users/example/Documents/Notes/示例笔记.md'
  );
  assert.equal(
    fileUriToPlatformPath('file:///C:/Users/test/Documents/Note%20One.md', 'win32'),
    'C:\\Users\\test\\Documents\\Note One.md'
  );
  assert.equal(
    fileUriToPlatformPath('file://server/share/folder/file.txt', 'win32'),
    '\\\\server\\share\\folder\\file.txt'
  );
  assert.equal(
    fileUriToPlatformPath('file:///Users/test/Note%20One.md', 'linux'),
    '/Users/test/Note One.md'
  );
  assert.equal(
    fileUriToPlatformPath('file://localhost/Users/test/Note%20One.md', 'darwin'),
    '/Users/test/Note One.md'
  );
  assert.equal(
    fileUriToPlatformPath('file:///C:/Users/test/Hash%23Note.md#line=3', 'win32'),
    'C:\\Users\\test\\Hash#Note.md'
  );
  assert.equal(fileUriToPlatformPath('obsidian://open?file=Folder%2FNote.md', 'win32'), null);
  assert.equal(fileUriToPlatformPath('vscode://file/C:/repo/src/main.ts', 'win32'), null);
  assert.equal(fileUriToPlatformPath('C:\\repo\\src\\main.ts', 'win32'), null);
});

test('obsidianUriToVaultPath preserves encoded separators and ampersands inside file query values', () => {
  assert.equal(
    obsidianUriToVaultPath('obsidian://open?vault=example-vault&file=notes%2FResearch%26Search%20Result.md'),
    'notes/Research&Search Result.md'
  );
  assert.equal(
    obsidianUriToVaultPath('obsidian://open?path=folders%2FTopic%26Details'),
    'folders/Topic&Details'
  );
  assert.equal(obsidianUriToVaultPath('file:///Users/example/Documents/Notes/Example.md'), null);
});

test('joinTerminalPaths and getVaultRelativePathFromAbsolute share one canonical path shape', () => {
  const absolutePath = joinTerminalPaths('C:\\vault', 'src/services/file.ts', 'win32');

  assert.equal(absolutePath, 'C:\\vault\\src\\services\\file.ts');
  assert.equal(
    getVaultRelativePathFromAbsolute(absolutePath, 'C:\\vault', 'win32'),
    'src/services/file.ts'
  );
  assert.equal(
    joinTerminalPaths('/Users/test/vault', './folder/../Note.md', 'darwin'),
    '/Users/test/vault/Note.md'
  );
  assert.equal(
    getVaultRelativePathFromAbsolute('/Users/test/vault/folder/../Note.md', '/Users/test/vault', 'linux'),
    'Note.md'
  );
});

test('collectTerminalReferenceCandidatePaths builds stable absolute candidates from multiple roots', () => {
  assert.deepEqual(
    collectTerminalReferenceCandidatePaths(
      'src/services/file.ts',
      ['C:\\repo\\current', 'C:\\repo', 'C:\\repo'],
      'win32'
    ),
    [
      'C:\\repo\\current\\src\\services\\file.ts',
      'C:\\repo\\src\\services\\file.ts',
    ]
  );
  assert.deepEqual(
    collectTerminalReferenceCandidatePaths(
      './folder/../Note.md',
      ['/Users/test/current', '/Users/test/vault'],
      'darwin'
    ),
    [
      '/Users/test/current/Note.md',
      '/Users/test/vault/Note.md',
    ]
  );
});

test('isAbsoluteTerminalPath detects absolute paths using the target platform rules', () => {
  assert.equal(isAbsoluteTerminalPath('C:\\vault\\file.ts', 'win32'), true);
  assert.equal(isAbsoluteTerminalPath('\\\\server\\share\\file.ts', 'win32'), true);
  assert.equal(isAbsoluteTerminalPath('/home/user/file.ts', 'linux'), true);
  assert.equal(isAbsoluteTerminalPath('C:\\vault\\file.ts', 'linux'), false);
  assert.equal(isAbsoluteTerminalPath('src/file.ts', 'linux'), false);
});

test('normalizeDroppedEntryPath normalizes POSIX drop paths without forcing Windows rules', () => {
  assert.equal(
    normalizeDroppedEntryPath('/Users/test/vault/folder/../Note.md', 'darwin'),
    '/Users/test/vault/Note.md'
  );
  assert.equal(
    normalizeDroppedEntryPath('/home/test/vault//nested/file.ts', 'linux'),
    '/home/test/vault/nested/file.ts'
  );
});

test('normalizeDroppedEntryReference preserves vault-relative directory entry paths on Windows', () => {
  assert.deepEqual(
    normalizeDroppedEntryReference('/examples/12345', 'win32'),
    {
      absolutePath: null,
      vaultPath: 'examples/12345',
    }
  );
  assert.deepEqual(
    normalizeDroppedEntryReference('F:\\example-vault\\examples\\12345', 'win32'),
    {
      absolutePath: 'F:\\example-vault\\examples\\12345',
      vaultPath: null,
    }
  );
});

test('findUniqueTerminalEntryByBasename resolves a unique basename and rejects ambiguous matches', () => {
  assert.deepEqual(
    findUniqueTerminalEntryByBasename('App.tsx', [
      { name: 'App.tsx', path: 'src/App.tsx', kind: 'file' },
    ]),
    { name: 'App.tsx', path: 'src/App.tsx', kind: 'file' },
  );

  assert.equal(
    findUniqueTerminalEntryByBasename('App.tsx', [
      { name: 'App.tsx', path: 'src/App.tsx', kind: 'file' },
      { name: 'App.tsx', path: 'packages/ui/App.tsx', kind: 'file' },
    ]),
    null,
  );

  assert.deepEqual(
    findUniqueTerminalEntryByBasename('assets', [
      { name: 'assets', path: 'docs/assets', kind: 'folder' },
      { name: 'assets', path: 'src/assets.ts', kind: 'file' },
    ]),
    { name: 'assets', path: 'docs/assets', kind: 'folder' },
  );
});
