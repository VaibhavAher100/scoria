import test from 'node:test';
import assert from 'node:assert/strict';
import * as net from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { encodeFrame, FrameDecoder, FrameType } from './framing.ts';
import { PipeTransport, WebSocketTransport, type TransportMessage } from './transport.ts';

/** Spin up a named-pipe echo server that replies to each frame it receives. */
function startEchoPipe(): Promise<{ path: string; server: net.Server }> {
  const path = `\\\\.\\pipe\\termy-test-${randomUUID()}`;
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      decoder.feed(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      let frame = decoder.next();
      while (frame !== null) {
        // Reply with a text frame describing what arrived.
        const reply = new TextEncoder().encode(`got ${frame.kind}:${frame.payload.length}`);
        socket.write(encodeFrame(FrameType.Text, reply));
        frame = decoder.next();
      }
    });
    socket.on('error', () => {
      /* client tore down; ignore */
    });
  });
  return new Promise((resolve) => {
    server.listen(path, () => resolve({ path, server }));
  });
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
      } else {
        setTimeout(tick, 10);
      }
    };
    tick();
  });
}

test('PipeTransport connects, frames a send, and decodes the framed reply', async () => {
  const { path, server } = await startEchoPipe();
  const transport = new PipeTransport(path, (p) => net.connect(p));
  const messages: TransportMessage[] = [];

  await transport.connect({
    onMessage: (msg) => messages.push(msg),
    onClose: () => {},
    onError: () => {},
  });
  assert.equal(transport.isConnected, true);

  transport.sendBinary(new Uint8Array([1, 2, 3]));
  await waitFor(() => messages.length >= 1);

  const reply = messages[0];
  assert.equal(reply.kind, 'text');
  // Binary frame is type 2 with 3 bytes of payload.
  assert.equal(reply.kind === 'text' ? reply.data : '', 'got 2:3');

  transport.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('PipeTransport rejects when the pipe does not exist', async () => {
  const path = `\\\\.\\pipe\\termy-test-missing-${randomUUID()}`;
  const transport = new PipeTransport(path, (p) => net.connect(p), 1000);
  await assert.rejects(
    transport.connect({ onMessage: () => {}, onClose: () => {}, onError: () => {} })
  );
  assert.equal(transport.isConnected, false);
});

test('PipeTransport does not send after close', async () => {
  const { path, server } = await startEchoPipe();
  const transport = new PipeTransport(path, (p) => net.connect(p));
  await transport.connect({ onMessage: () => {}, onClose: () => {}, onError: () => {} });

  transport.close();
  assert.equal(transport.isConnected, false);
  // Must not throw even though the socket is gone.
  transport.send('ignored');
  transport.sendBinary(new Uint8Array([9]));

  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Start a loopback WebSocket server that records every text message it gets. */
function startRecordingWsServer(): Promise<{ port: number; wss: WebSocketServer; received: string[] }> {
  const received: string[] = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (socket) => {
    socket.on('message', (data: Buffer) => received.push(data.toString()));
  });
  return new Promise((resolve) => {
    wss.on('listening', () => {
      const port = (wss.address() as { port: number }).port;
      resolve({ port, wss, received });
    });
  });
}

test('WebSocketTransport sends the auth token as its first frame', async () => {
  const { port, wss, received } = await startRecordingWsServer();
  const transport = new WebSocketTransport(`ws://127.0.0.1:${port}`, 'secret-token');

  await transport.connect({ onMessage: () => {}, onClose: () => {}, onError: () => {} });
  // App message must arrive AFTER the auth frame.
  transport.send(JSON.stringify({ module: 'pty', type: 'init' }));
  await waitFor(() => received.length >= 2);

  assert.deepEqual(JSON.parse(received[0]), { type: 'auth', token: 'secret-token' });
  assert.deepEqual(JSON.parse(received[1]), { module: 'pty', type: 'init' });

  transport.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

test('WebSocketTransport sends no auth frame when no token is set', async () => {
  const { port, wss, received } = await startRecordingWsServer();
  const transport = new WebSocketTransport(`ws://127.0.0.1:${port}`);

  await transport.connect({ onMessage: () => {}, onClose: () => {}, onError: () => {} });
  transport.send(JSON.stringify({ module: 'pty', type: 'init' }));
  await waitFor(() => received.length >= 1);

  // First (and only) message is the app message, never an auth frame.
  assert.deepEqual(JSON.parse(received[0]), { module: 'pty', type: 'init' });

  transport.close();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});
