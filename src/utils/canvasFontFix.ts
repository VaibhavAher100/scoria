/**
 * Workaround for Chromium 150 (Obsidian installer 1.15.1, Electron 43).
 *
 * The canvas font parser now rejects a `font` value with leading whitespace and
 * keeps the old font (10px sans-serif). xterm.js builds glyph fonts as
 * `${italic} ${weight} ${size}px ${family}`, so a non-italic glyph starts with a
 * space and renders tiny in a full-size cell. See Termy #32 and xterm.js #6297.
 *
 * shortcut: the patch stays on the window until it reloads; remove it when the
 * bundled xterm.js builds the font string without the empty italic slot.
 */

const PATCHED = Symbol.for('scoria.canvasFontTrim');

type FontHost = { prototype: object };

function patchFontSetter(ctor: FontHost | undefined): void {
  if (!ctor) return;
  const proto = ctor.prototype as Record<symbol, unknown>;
  if (proto[PATCHED]) return;

  const descriptor = Object.getOwnPropertyDescriptor(proto, 'font');
  if (!descriptor?.get || !descriptor.set) return;
  const original = descriptor;

  Object.defineProperty(proto, 'font', {
    configurable: true,
    enumerable: original.enumerable ?? true,
    get(this: unknown): unknown {
      return original.get?.call(this);
    },
    set(this: unknown, value: unknown) {
      original.set?.call(this, typeof value === 'string' ? value.trimStart() : value);
    },
  });
  proto[PATCHED] = true;
}

/** Install the font trim on the canvas contexts of one window (main or popout). */
export function installCanvasFontFix(win: object): void {
  const scope = win as Record<string, FontHost | undefined>;
  patchFontSetter(scope.CanvasRenderingContext2D);
  patchFontSetter(scope.OffscreenCanvasRenderingContext2D);
}
