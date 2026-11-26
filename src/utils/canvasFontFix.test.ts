import test from 'node:test';
import assert from 'node:assert/strict';
import { installCanvasFontFix } from './canvasFontFix.ts';

function makeContextClass() {
  return class FakeContext2D {
    stored = '10px sans-serif';
    get font(): string {
      return this.stored;
    }
    set font(value: string) {
      // Model Chromium 150: a value with leading whitespace is rejected.
      if (/^\s/.test(value)) return;
      this.stored = value;
    }
  };
}

test('installCanvasFontFix trims the leading space that xterm.js adds', () => {
  const Ctx = makeContextClass();
  const before = new Ctx();
  before.font = ' normal 26px Menlo';
  assert.equal(before.font, '10px sans-serif');

  installCanvasFontFix({ CanvasRenderingContext2D: Ctx });

  const after = new Ctx();
  after.font = ' normal 26px Menlo';
  assert.equal(after.font, 'normal 26px Menlo');
  after.font = 'italic bold 13px Fira Code';
  assert.equal(after.font, 'italic bold 13px Fira Code');
});

test('installCanvasFontFix patches each window once and skips missing classes', () => {
  const Ctx = makeContextClass();
  const win = { CanvasRenderingContext2D: Ctx };
  installCanvasFontFix(win);
  const setter = Object.getOwnPropertyDescriptor(Ctx.prototype, 'font')?.set;
  installCanvasFontFix(win);
  assert.equal(Object.getOwnPropertyDescriptor(Ctx.prototype, 'font')?.set, setter);

  assert.doesNotThrow(() => installCanvasFontFix({}));
});
