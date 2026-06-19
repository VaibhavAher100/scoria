import { test } from 'node:test';
import assert from 'node:assert/strict';

// The class uses window.setTimeout for its debounce; map it onto Node's globals
// so the control logic can run headless. Must precede the import.
(globalThis as unknown as { window: unknown }).window = globalThis;

import { WikilinkAutocomplete, type AutocompleteEntry, type WikilinkAutocompleteHost } from './wikilinkAutocomplete.ts';
import type { Terminal } from '@xterm/xterm';

function makeTerminal(): Terminal {
  return { onResize: () => ({ dispose: () => {} }) } as unknown as Terminal;
}

function makeHost(overrides: Partial<WikilinkAutocompleteHost> = {}): {
  host: WikilinkAutocompleteHost;
  written: string[];
} {
  const written: string[] = [];
  const host: WikilinkAutocompleteHost = {
    isEnabled: () => true,
    listEntries: () => [],
    resolveInsertion: (entry: AutocompleteEntry | null, query: string) =>
      `INSERT:${entry ? entry.name : ''}:${query}`,
    writeToShell: (data: string) => written.push(data),
    getContainer: () => null,
    ...overrides,
  };
  return { host, written };
}

function keydown(key: string): KeyboardEvent {
  let prevented = false;
  return {
    type: 'keydown',
    key,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: () => { prevented = true; },
    get defaultPrevented() { return prevented; },
  } as unknown as KeyboardEvent;
}

test('typing [[ activates the dropdown when enabled', () => {
  const { host } = makeHost();
  const ac = new WikilinkAutocomplete(makeTerminal(), host);
  ac.handleData('[');
  assert.equal(ac.isActive(), false);
  ac.handleData('[');
  assert.equal(ac.isActive(), true);
  ac.dispose();
});

test('does not activate when disabled', () => {
  const { host } = makeHost({ isEnabled: () => false });
  const ac = new WikilinkAutocomplete(makeTerminal(), host);
  ac.handleData('[');
  ac.handleData('[');
  assert.equal(ac.isActive(), false);
  ac.dispose();
});

test('a paste containing [[ activates', () => {
  const { host } = makeHost();
  const ac = new WikilinkAutocomplete(makeTerminal(), host);
  ac.handleData('echo [[note');
  assert.equal(ac.isActive(), true);
  ac.dispose();
});

test('navigation keys are consumed only while active', () => {
  const { host } = makeHost();
  const ac = new WikilinkAutocomplete(makeTerminal(), host);
  assert.equal(ac.handleKey(keydown('ArrowDown')), false);
  ac.handleData('[');
  ac.handleData('[');
  assert.equal(ac.handleKey(keydown('ArrowDown')), true);
  assert.equal(ac.handleKey(keydown('Escape')), true);
  assert.equal(ac.isActive(), false);
  ac.dispose();
});

test('accept writes the resolved insertion; the query is captured from keys', () => {
  const { host, written } = makeHost();
  const ac = new WikilinkAutocomplete(makeTerminal(), host);
  ac.handleData('[');
  ac.handleData('[');
  ac.handleKey(keydown('a'));
  ac.handleKey(keydown('b'));
  ac.handleKey(keydown('Enter'));
  assert.deepEqual(written, ['INSERT::ab']);
  assert.equal(ac.isActive(), false);
  ac.dispose();
});

test('dismiss with a query sends the typed query back to the shell', () => {
  const { host, written } = makeHost();
  const ac = new WikilinkAutocomplete(makeTerminal(), host);
  ac.handleData('[');
  ac.handleData('[');
  ac.handleKey(keydown('x'));
  ac.handleKey(keydown('Escape'));
  assert.deepEqual(written, ['x']);
  ac.dispose();
});
