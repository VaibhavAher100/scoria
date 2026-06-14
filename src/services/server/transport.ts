/**
 * Transport abstraction for the terminal server connection.
 *
 * The client used to talk to the server over a raw browser `WebSocket`. To add
 * the Windows named pipe (and later UDS) without rewriting the PTY/message
 * layer, both wire types implement this single interface. Outbound app messages
 * are either text (control JSON) or binary (PTY bytes); how they reach the
 * server - WebSocket frames or length-prefixed pipe frames - is the transport's
 * concern.
 *
 * Mirrors the Rust server's `MessageSink` seam.
 */

import type { Socket } from 'node:net';
import { encodeFrame, FrameDecoder, FrameType } from './framing.ts';

/** A message received from the server, normalized across transports. */
export type TransportMessage =
  | { kind: 'text'; data: string }
  | { kind: 'binary'; data: ArrayBuffer };

/** Callbacks for the lifetime of a connection, registered at connect time. */
export interface TransportHandlers {
  /** A whole message arrived from the server. */
  onMessage: (msg: TransportMessage) => void;
  /** The connection closed (after a successful connect). */
  onClose: (info: { code?: number; reason?: string }) => void;
  /** A transport-level error occurred on an open connection. */
  onError: (error: Error) => void;
}

export interface Transport {
  /**
   * Open the connection. Resolves once it is established; rejects on failure or
   * timeout. The handlers fire for everything after a successful open.
   */
  connect(handlers: TransportHandlers): Promise<void>;
  /** Send a text (control JSON) message. */
  send(text: string): void;
  /** Send a binary (PTY) message. */
  sendBinary(data: Uint8Array | ArrayBuffer): void;
  /** Close the connection. Safe to call more than once. */
  close(): void;
  /** Whether the connection is currently open. */
  readonly isConnected: boolean;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // slice() copies into a buffer sized exactly to the payload.
  return bytes.slice().buffer;
}

function toUint8Array(data: Uint8Array | ArrayBuffer): Uint8Array {
  return data instanceof ArrayBuffer ? new Uint8Array(data) : data;
}

/** WebSocket transport: a thin adapter over the existing `ws://` connection. */
export class WebSocketTransport implements Transport {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly connectTimeoutMs: number;

  constructor(url: string, connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS) {
    this.url = url;
    this.connectTimeoutMs = connectTimeoutMs;
  }

  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(handlers: TransportHandlers): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('WebSocket connect timeout'));
        }
      }, this.connectTimeoutMs);

      ws.onopen = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
      };

      ws.onerror = () => {
        // Let onclose drive rejection/teardown; onerror carries no useful info.
      };

      ws.onclose = (event) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket closed before open (code ${event.code})`));
        } else {
          handlers.onClose({ code: event.code, reason: event.reason });
        }
      };

      ws.onmessage = (event) => {
        const data = event.data;
        if (data instanceof ArrayBuffer) {
          handlers.onMessage({ kind: 'binary', data });
        } else if (typeof data === 'string') {
          handlers.onMessage({ kind: 'text', data });
        } else if (data instanceof Blob) {
          void data
            .arrayBuffer()
            .then((buffer) => handlers.onMessage({ kind: 'binary', data: buffer }))
            .catch((error) => handlers.onError(error instanceof Error ? error : new Error(String(error))));
        }
      };
    });
  }

  send(text: string): void {
    if (this.isConnected) {
      this.ws!.send(text);
    }
  }

  sendBinary(data: Uint8Array | ArrayBuffer): void {
    if (this.isConnected) {
      this.ws!.send(data);
    }
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close(1000, 'Shutdown');
      } catch {
        // Already closing/closed; nothing to do.
      }
      this.ws = null;
    }
  }
}

/** Connects a socket to a pipe/UDS path. Injected so it can be stubbed in
 * tests and resolved via `window.require('net')` in the Obsidian renderer. */
export type SocketConnector = (path: string) => Socket;

/**
 * Named-pipe (and UDS) transport. Frames every message with the shared
 * length-prefixed codec and reassembles incoming frames from arbitrary chunks.
 */
export class PipeTransport implements Transport {
  private socket: Socket | null = null;
  private readonly decoder = new FrameDecoder();
  private connected = false;
  private readonly pipePath: string;
  private readonly connectSocket: SocketConnector;
  private readonly connectTimeoutMs: number;

  constructor(
    pipePath: string,
    connectSocket: SocketConnector,
    connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS
  ) {
    this.pipePath = pipePath;
    this.connectSocket = connectSocket;
    this.connectTimeoutMs = connectTimeoutMs;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  connect(handlers: TransportHandlers): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = this.connectSocket(this.pipePath);
      this.socket = socket;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error('pipe connect timeout'));
        }
      }, this.connectTimeoutMs);

      socket.on('ready', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          this.connected = true;
          resolve();
        }
      });

      socket.on('data', (chunk: Buffer) => {
        this.decoder.feed(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        try {
          let frame = this.decoder.next();
          while (frame !== null) {
            if (frame.kind === FrameType.Text) {
              handlers.onMessage({ kind: 'text', data: new TextDecoder().decode(frame.payload) });
            } else {
              handlers.onMessage({ kind: 'binary', data: toArrayBuffer(frame.payload) });
            }
            frame = this.decoder.next();
          }
        } catch (error) {
          // Framing protocol violation: the stream is desynchronized. Drop it.
          handlers.onError(error instanceof Error ? error : new Error(String(error)));
          this.close();
        }
      });

      socket.on('error', (error: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(error);
        } else {
          handlers.onError(error);
        }
      });

      socket.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(new Error('pipe closed before ready'));
        } else if (wasConnected) {
          handlers.onClose({});
        }
      });
    });
  }

  send(text: string): void {
    this.writeFrame(FrameType.Text, new TextEncoder().encode(text));
  }

  sendBinary(data: Uint8Array | ArrayBuffer): void {
    this.writeFrame(FrameType.Binary, toUint8Array(data));
  }

  close(): void {
    this.connected = false;
    if (this.socket) {
      try {
        this.socket.destroy();
      } catch {
        // Already destroyed; nothing to do.
      }
      this.socket = null;
    }
  }

  private writeFrame(kind: FrameType, payload: Uint8Array): void {
    if (this.socket && this.connected) {
      this.socket.write(encodeFrame(kind, payload));
    }
  }
}
