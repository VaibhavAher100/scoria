// End-to-end proof (Unix only): a shell survives a simulated Obsidian reload and
// reattaches over the UDS transport with NO duplicate shell.
//
// Drives the REAL built server binary over a real Unix domain socket using the
// production frame codec (src/services/server/framing.ts). It exercises the same
// wire path the plugin uses: spawn `--socket`, parse the stdout endpoint, send a
// framed `init`, run a shell, drop the connection (reload), reconnect, send
// `reattach`, and assert the original shell (its process + its variables) is back.
//
// Run on Linux/WSL:  node --experimental-strip-types scripts/e2e-uds-reattach.ts <server-binary>
//
// Exit 0 = proven, non-zero = failed.
import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { encodeFrame, FrameDecoder, FrameType } from "../src/services/server/framing.ts";

const bin = process.argv[2];
if (!bin) {
  console.error("usage: e2e-uds-reattach.ts <server-binary>");
  process.exit(2);
}

const td = new TextDecoder();
const te = new TextEncoder();

function ctrl(obj: Record<string, unknown>): Uint8Array {
  return encodeFrame(FrameType.Text, te.encode(JSON.stringify({ module: "pty", ...obj })));
}

// PTY input frame: Binary [sid_len:u8][sid][data].
function ptyInput(sessionId: string, data: string): Uint8Array {
  const sid = te.encode(sessionId);
  const body = te.encode(data);
  const buf = new Uint8Array(1 + sid.length + body.length);
  buf[0] = sid.length;
  buf.set(sid, 1);
  buf.set(body, 1 + sid.length);
  return encodeFrame(FrameType.Binary, buf);
}

// A live client over the socket: decodes frames, exposes accumulated PTY text and
// a way to await a control reply of a given type.
class Client {
  sock: Socket;
  private decoder = new FrameDecoder();
  text = "";
  private waiters: { type: string; resolve: (v: Record<string, unknown>) => void }[] = [];

  constructor(path: string) {
    this.sock = connect(path);
    this.sock.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.decoder.feed(new Uint8Array(chunk));
    for (let f = this.decoder.next(); f; f = this.decoder.next()) {
      if (f.kind === FrameType.Binary) {
        // Live or replayed PTY output: [sid_len][sid][data] -> keep the data.
        const sidLen = f.payload[0];
        this.text += td.decode(f.payload.subarray(1 + sidLen));
      } else {
        const msg = JSON.parse(td.decode(f.payload)) as Record<string, unknown>;
        const i = this.waiters.findIndex((w) => w.type === msg.type);
        if (i !== -1) this.waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  }

  ready(): Promise<void> {
    return new Promise((res, rej) => {
      this.sock.once("connect", () => res());
      this.sock.once("error", rej);
    });
  }

  send(frame: Uint8Array): void {
    this.sock.write(Buffer.from(frame));
  }

  await(type: string, ms = 8000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
      this.waiters.push({ type, resolve: (v) => { clearTimeout(t); resolve(v); } });
    });
  }

  // Poll the accumulated PTY text until it matches, or reject on timeout. Avoids
  // fixed sleeps so a loaded box slows the test down rather than failing it.
  matchText(re: RegExp, ms = 6000): Promise<RegExpMatchArray> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        const m = this.text.match(re);
        if (m) return resolve(m);
        if (Date.now() - start > ms) return reject(new Error(`timeout waiting for ${re} in:\n${this.text}`));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  close(): void {
    this.sock.destroy();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

async function main(): Promise<void> {
  // 1. Spawn the daemon in socket mode and read its endpoint off stdout.
  const srv = spawn(bin, ["--socket"], { stdio: ["ignore", "pipe", "inherit"] });
  const socketPath = await new Promise<string>((resolve, reject) => {
    let acc = "";
    const to = setTimeout(() => reject(new Error("server printed no endpoint")), 8000);
    srv.stdout.on("data", (d: Buffer) => {
      acc += d.toString();
      const line = acc.split("\n").find((l) => l.includes("\"socket\""));
      if (line) { clearTimeout(to); resolve((JSON.parse(line) as { socket: string }).socket); }
    });
    srv.on("exit", (c) => reject(new Error(`server exited early (${c})`)));
  });
  console.log("server socket:", socketPath);

  let ok = false;
  try {
    // 2. Client A: init a session, capture the shell PID + set a marker variable.
    const a = new Client(socketPath);
    await a.ready();
    a.send(ctrl({ type: "init", cols: 80, rows: 24 }));
    const initMsg = await a.await("init_complete");
    const sessionId = String(initMsg.session_id);
    if (!sessionId) fail("init returned no session_id");
    console.log("session:", sessionId);

    // Establish identity: a shell variable + the live PID. A respawned/duplicate
    // shell would have neither.
    a.send(ptyInput(sessionId, "MARKER=survivor_$$\n"));
    a.send(ptyInput(sessionId, "echo PIDLINE=$$\n"));
    const originalPid = (await a.matchText(/PIDLINE=(\d+)/))[1];
    console.log("original shell pid:", originalPid);

    // 3. Queue output that lands AFTER A disconnects, then simulate the reload by
    //    dropping the connection. The daemon must detach (not kill) the session.
    a.send(ptyInput(sessionId, "sleep 2; echo DETACHED=$MARKER FROM=$$\n"));
    await sleep(150); // let the write reach the PTY before we cut the socket
    a.close();
    console.log("client A dropped (reload simulated)");

    // 4. The shell keeps running detached; its output (after the in-shell sleep)
    //    is retained in the replay buffer until a client reattaches.

    // 5. Client B reconnects and reattaches by session_id (no new init = no respawn).
    const b = new Client(socketPath);
    await b.ready();
    b.send(ctrl({ type: "reattach", session_id: sessionId }));
    await b.await("reattach_complete");
    console.log("reattached");

    // Replay must deliver the output produced while detached (poll past the sleep 2).
    const detachedPid = (await b.matchText(/DETACHED=survivor_\d+ FROM=(\d+)/))[1];

    // 6. Prove SAME shell (no duplicate): the marker variable still resolves on the
    //    reattached session, and the PID never changed across the reload.
    b.send(ptyInput(sessionId, "echo AFTER=$MARKER PID=$$\n"));
    const afterMatch = await b.matchText(/AFTER=(survivor_\d+) PID=(\d+)/);
    if (afterMatch[2] !== originalPid || detachedPid !== originalPid) {
      fail(`pid changed across reload: orig=${originalPid} detached=${detachedPid} after=${afterMatch[2]}`);
    }

    console.log(`PASS: shell pid ${originalPid} survived reload, replay delivered detached output, marker intact, no duplicate`);
    b.close();
    ok = true;
  } finally {
    srv.kill("SIGTERM");
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => fail(String(e)));
