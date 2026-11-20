// Wiki-link `[[` autocomplete for the terminal buffer.
//
// When the user types `[[` in the terminal, an overlay dropdown lists vault
// notes. Arrow keys navigate, Tab / Enter accept, Escape dismisses. Keystrokes
// are intercepted at the xterm layer so it works inside TUIs too. The class is
// UI/state only: the host injects the vault snapshot and the insertion string
// (so shell quoting and wikilink-vs-path semantics stay with the host).
//
// Adapted for this project from lean-obsidian-terminal's wiki-link autocomplete
// (MIT (c) sdkasper / contributors), itself ported from
// internetvin/internetvin-terminal (MIT (c) 2025 Vin Verma). See NOTICE.
// Differences here: host-injected entry/insertion callbacks (no direct vault or
// App dependency), standard DOM (no Obsidian element helpers), lazy container
// resolution, and the note-preview pane intentionally omitted.

import type { Terminal, IDisposable } from '@xterm/xterm';

export interface AutocompleteEntry {
  /** Display name (file basename, without extension). */
  name: string;
  /** Display folder (parent path, '' for vault root). */
  folder: string;
  /** Vault-relative path including extension, '' for unresolved entries. */
  path: string;
  isFile: boolean;
  mtime: number;
}

/**
 * Resolves the string written to the PTY when a suggestion is accepted. The
 * `[[` already echoed to the shell; for path modes the host prefixes DEL
 * characters to erase those brackets before writing the resolved path.
 */
export type WikilinkResolveInsertion = (entry: AutocompleteEntry | null, query: string) => string;

export interface WikilinkAutocompleteHost {
  isEnabled: () => boolean;
  /** Fresh vault snapshot, pre-sorted by mtime descending. */
  listEntries: () => AutocompleteEntry[];
  resolveInsertion: WikilinkResolveInsertion;
  /** Write input to the shell (PTY). */
  writeToShell: (data: string) => void;
  /** The element hosting the xterm screen; resolved lazily (set on attach). */
  getContainer: () => HTMLElement | null;
}

const MAX_RESULTS = 10;
const FILTER_DEBOUNCE_MS = 16;
const DROPDOWN_WIDTH = 300;
const DROPDOWN_HEIGHT = 220;

export class WikilinkAutocomplete {
  private active = false;
  private query = '';
  private results: AutocompleteEntry[] = [];
  private selectedIndex = 0;
  private lastCharWasBracket = false;
  private dropdownEl: HTMLElement | null = null;
  private filterTimer: number | null = null;
  private cachedEntries: AutocompleteEntry[] | null = null;
  private resizeDisposable: IDisposable | null = null;

  private readonly terminal: Terminal;
  private readonly host: WikilinkAutocompleteHost;

  constructor(terminal: Terminal, host: WikilinkAutocompleteHost) {
    this.terminal = terminal;
    this.host = host;
    this.resizeDisposable = this.terminal.onResize(() => {
      if (this.active && this.dropdownEl) this.positionDropdown();
    });
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Observe the host's `onData` (input headed to the PTY). Detects `[[` and
   * activates. Never consumes; the brackets still reach the shell.
   */
  handleData(data: string): void {
    if (!this.host.isEnabled() || this.active) return;

    if (data.length > 1) {
      // A completed paste has already been sent to the PTY. Activating for a
      // `[[` in the middle would capture later keys with an empty query and
      // could append the wrong note. Only activate when the chunk itself ends
      // at the autocomplete boundary.
      if (data.endsWith('[[')) {
        this.lastCharWasBracket = false;
        this.activate();
      } else {
        this.lastCharWasBracket = data.endsWith('[');
      }
      return;
    }

    if (data === '[') {
      if (this.lastCharWasBracket) {
        this.lastCharWasBracket = false;
        this.activate();
      } else {
        this.lastCharWasBracket = true;
      }
    } else {
      this.lastCharWasBracket = false;
    }
  }

  /**
   * Call from the host's `attachCustomKeyEventHandler` before other handling.
   * Returns true when the key was consumed (host should suppress the default).
   */
  handleKey(e: KeyboardEvent): boolean {
    if (!this.active) return false;
    // Only consume keydown; keypress/keyup must flow through for IME etc.
    if (e.type !== 'keydown') return false;

    if (e.metaKey || e.ctrlKey || e.altKey) {
      // Restore captured text before the terminal handles the shortcut. This
      // keeps shell input consistent for shortcuts such as paste and lets
      // interrupt/navigation shortcuts close the overlay immediately.
      this.dismiss();
      return false;
    }

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        this.selectedIndex = Math.max(0, this.selectedIndex - 1);
        this.renderDropdown();
        return true;
      case 'ArrowDown':
        e.preventDefault();
        this.selectedIndex = Math.min(this.results.length - 1, this.selectedIndex + 1);
        this.renderDropdown();
        return true;
      case 'Enter':
      case 'Tab':
        e.preventDefault();
        this.accept();
        return true;
      case 'Escape':
        e.preventDefault();
        this.dismiss();
        return true;
      case 'Backspace':
        e.preventDefault();
        if (this.query.length > 0) {
          this.query = this.query.slice(0, -1);
          this.filterResults();
        } else {
          this.dismiss();
        }
        return true;
      default:
        if (e.key.length === 1) {
          e.preventDefault();
          this.query += e.key;
          this.filterResults();
          return true;
        }
        return true;
    }
  }

  dispose(): void {
    if (this.filterTimer !== null) {
      window.clearTimeout(this.filterTimer);
      this.filterTimer = null;
    }
    this.resizeDisposable?.dispose();
    this.resizeDisposable = null;
    this.removeDropdown();
    this.active = false;
  }

  private activate(): void {
    this.active = true;
    this.query = '';
    this.results = [];
    this.selectedIndex = 0;
    this.cachedEntries = null;
    this.filterResults();
  }

  private accept(): void {
    const entry =
      this.results.length > 0 && this.selectedIndex < this.results.length
        ? this.results[this.selectedIndex]
        : null;
    this.host.writeToShell(this.host.resolveInsertion(entry, this.query));
    this.deactivate();
  }

  private dismiss(): void {
    // The query chars were consumed (never sent); send them on cancel so the
    // shell input matches what the user typed.
    if (this.query.length > 0) this.host.writeToShell(this.query);
    this.deactivate();
  }

  private deactivate(): void {
    this.active = false;
    this.query = '';
    this.results = [];
    this.selectedIndex = 0;
    this.cachedEntries = null;
    if (this.filterTimer !== null) {
      window.clearTimeout(this.filterTimer);
      this.filterTimer = null;
    }
    this.removeDropdown();
  }

  private filterResults(): void {
    if (this.filterTimer !== null) window.clearTimeout(this.filterTimer);
    this.filterTimer = window.setTimeout(() => {
      // A late timer must not resurrect a dropdown dismissed in the meantime.
      if (!this.active) return;
      if (!this.cachedEntries) this.cachedEntries = this.host.listEntries();
      const all = this.cachedEntries;
      const q = this.query.toLowerCase();

      if (q.length === 0) {
        this.results = all.slice(0, MAX_RESULTS);
      } else {
        const prefix: AutocompleteEntry[] = [];
        const contains: AutocompleteEntry[] = [];
        for (const entry of all) {
          const name = entry.name.toLowerCase();
          if (name.startsWith(q)) prefix.push(entry);
          else if (name.includes(q)) contains.push(entry);
        }
        this.results = [...prefix, ...contains].slice(0, MAX_RESULTS);
      }

      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.results.length - 1));
      this.renderDropdown();
    }, FILTER_DEBOUNCE_MS);
  }

  private renderDropdown(): void {
    const container = this.host.getContainer();
    if (!container) return;
    const doc = container.ownerDocument;
    const win = doc.defaultView ?? window;

    if (win.getComputedStyle(container).position === 'static') {
      container.setCssProps({ position: 'relative' });
    }

    if (!this.dropdownEl || this.dropdownEl.ownerDocument !== doc) {
      this.removeDropdown();
      this.dropdownEl = doc.createElement('div');
      this.dropdownEl.className = 'terminal-wikilink-dropdown';
      container.appendChild(this.dropdownEl);
    }

    this.positionDropdown();
    this.dropdownEl.replaceChildren();

    const header = doc.createElement('div');
    header.className = 'terminal-wikilink-header';
    header.textContent = `[[${this.query}`;
    this.dropdownEl.appendChild(header);

    if (this.results.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'terminal-wikilink-empty';
      empty.textContent = 'No matches';
      this.dropdownEl.appendChild(empty);
      return;
    }

    const list = doc.createElement('div');
    list.className = 'terminal-wikilink-list';
    this.results.forEach((entry, i) => {
      const item = doc.createElement('div');
      item.className = 'terminal-wikilink-item';
      if (i === this.selectedIndex) item.classList.add('is-selected');
      if (!entry.isFile) item.classList.add('is-unresolved');

      const name = doc.createElement('span');
      name.className = 'terminal-wikilink-name';
      name.textContent = entry.name;
      item.appendChild(name);

      if (entry.isFile && entry.folder && entry.folder !== '/') {
        const folder = doc.createElement('span');
        folder.className = 'terminal-wikilink-path';
        folder.textContent = entry.folder;
        item.appendChild(folder);
      } else if (!entry.isFile) {
        const note = doc.createElement('span');
        note.className = 'terminal-wikilink-path';
        note.textContent = 'No file yet';
        item.appendChild(note);
      }

      item.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.selectedIndex = i;
        this.accept();
      });
      list.appendChild(item);
    });
    this.dropdownEl.appendChild(list);
  }

  private positionDropdown(): void {
    const container = this.host.getContainer();
    if (!this.dropdownEl || !container) return;

    const buf = this.terminal.buffer.active;
    const cursorX = buf.cursorX;
    const cursorY = buf.cursorY;

    const screen = container.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return;

    const screenRect = screen.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    const cellW = screenRect.width / this.terminal.cols;
    const cellH = screenRect.height / this.terminal.rows;
    const offsetX = screenRect.left - containerRect.left;
    const offsetY = screenRect.top - containerRect.top;
    const containerHeight = containerRect.height;

    let left = offsetX + cursorX * cellW;
    if (left + DROPDOWN_WIDTH > containerRect.width) {
      left = Math.max(4, containerRect.width - DROPDOWN_WIDTH - 4);
    }
    this.dropdownEl.setCssProps({ left: `${left}px` });

    const cursorBottom = offsetY + (cursorY + 1) * cellH;
    if (containerHeight - cursorBottom > DROPDOWN_HEIGHT || cursorY < this.terminal.rows / 2) {
      this.dropdownEl.setCssProps({
        top: `${cursorBottom}px`,
        bottom: '',
      });
    } else {
      this.dropdownEl.setCssProps({
        bottom: `${containerHeight - (offsetY + cursorY * cellH)}px`,
        top: '',
      });
    }
  }

  private removeDropdown(): void {
    if (this.dropdownEl) {
      this.dropdownEl.remove();
      this.dropdownEl = null;
    }
  }
}
