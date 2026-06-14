import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFrame, FrameDecoder, FrameError, FrameType, MAX_FRAME_LEN } from './framing.ts';

function drain(decoder: FrameDecoder): Frame[] {
  const frames: Frame[] = [];
  let frame: Frame | null;
  while ((frame = decoder.next()) !== null) {
    frames.push(frame);
  }
  return frames;
}

type Frame = { kind: FrameType; payload: Uint8Array };

test('roundtrips a text frame', () => {
  const payload = new TextEncoder().encode('{"module":"pty"}');
  const decoder = new FrameDecoder();
  decoder.feed(encodeFrame(FrameType.Text, payload));
  const frames = drain(decoder);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, FrameType.Text);
  assert.deepEqual(frames[0].payload, payload);
});

test('roundtrips a binary frame', () => {
  const payload = new Uint8Array([0, 1, 2, 255, 128]);
  const decoder = new FrameDecoder();
  decoder.feed(encodeFrame(FrameType.Binary, payload));
  const frames = drain(decoder);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].kind, FrameType.Binary);
  assert.deepEqual(frames[0].payload, payload);
});

test('roundtrips an empty payload', () => {
  const wire = encodeFrame(FrameType.Binary, new Uint8Array(0));
  assert.equal(wire.length, 5);
  const decoder = new FrameDecoder();
  decoder.feed(wire);
  const frames = drain(decoder);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.length, 0);
});

test('decodes multiple frames from one chunk', () => {
  const a = encodeFrame(FrameType.Text, new TextEncoder().encode('first'));
  const b = encodeFrame(FrameType.Binary, new Uint8Array([9, 9, 9]));
  const wire = new Uint8Array(a.length + b.length);
  wire.set(a, 0);
  wire.set(b, a.length);

  const decoder = new FrameDecoder();
  decoder.feed(wire);
  const frames = drain(decoder);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].kind, FrameType.Text);
  assert.equal(frames[1].kind, FrameType.Binary);
});

test('reassembles a frame split across reads', () => {
  const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const wire = encodeFrame(FrameType.Binary, payload);
  const decoder = new FrameDecoder();

  for (let i = 0; i < wire.length; i++) {
    decoder.feed(wire.subarray(i, i + 1));
    const frame = decoder.next();
    if (i + 1 === wire.length) {
      assert.notEqual(frame, null);
      assert.deepEqual(frame!.payload, payload);
    } else {
      assert.equal(frame, null);
    }
  }
});

test('returns null on a partial header', () => {
  const decoder = new FrameDecoder();
  decoder.feed(new Uint8Array([0, 0]));
  assert.equal(decoder.next(), null);
});

test('throws on an unknown type tag', () => {
  const decoder = new FrameDecoder();
  decoder.feed(new Uint8Array([0, 0, 0, 0, 7])); // len 0, type 7
  assert.throws(() => decoder.next(), FrameError);
});

test('throws on an oversized length', () => {
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(0, MAX_FRAME_LEN + 1, true);
  header[4] = FrameType.Binary;
  const decoder = new FrameDecoder();
  decoder.feed(header);
  assert.throws(() => decoder.next(), FrameError);
});

test('keeps a trailing partial frame buffered without erroring', () => {
  const a = encodeFrame(FrameType.Text, new TextEncoder().encode('done'));
  const wire = new Uint8Array(a.length + 2);
  wire.set(a, 0);
  wire.set([0, 0], a.length); // partial next header

  const decoder = new FrameDecoder();
  decoder.feed(wire);
  assert.notEqual(decoder.next(), null);
  assert.equal(decoder.next(), null);
});
