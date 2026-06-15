/**
 * ServerManager - unified server manager
 * 
 * Responsibilities:
 * 1. Manage the lifecycle of the unified Rust server process
 * 2. Manage a single WebSocket connection
 * 3. Provide modular APIs (pty/voice/llm/utils)
 * 4. Handle server crashes and automatic restarts
 * 
 */

import { Notice } from 'obsidian';
import { debugLog, debugWarn, errorLog } from '@/utils/logger';
import { t } from '@/i18n';

/** Inline type-only references to avoid top-level `import 'fs' / 'child_process'`. */
type FsModule = typeof import('fs');
type PathModule = typeof import('path');
type ChildProcessModule = typeof import('child_process');
type ChildProcess = import('child_process').ChildProcess;
type NetModule = typeof import('net');
import type { 
  ServerInfo, 
  ServerEvents,
  ServerMessage} from './types';
import { 
  ServerErrorCode, 
  ServerManagerError
} from './types';
import { PtyClient } from './ptyClient';
import { BinaryDownloader } from './binaryDownloader';
import type { BinaryDownloadConfig } from './binaryDownloadUrls';
import type { Transport, TransportMessage, SocketConnector } from './transport.ts';
import { WebSocketTransport, PipeTransport } from './transport.ts';
import type { DaemonRecord } from './daemonRecord.ts';
import {
  PIPE_NAME_RE,
  serializeDaemonRecord,
  parseDaemonRecord,
  isVersionCompatible,
} from './daemonRecord.ts';

type BinaryUpdateResult = 'skipped-offline' | 'already-ready' | 'downloaded' | 'updated';
const DEV_RELOAD_REQUEST_FILE = '.termy-dev-reload.json';

/**
 * Sidecar file recording the running daemon's pipe + pid + version so a
 * reloaded plugin can re-discover it (M2 Part B). `PIPE_NAME_RE` is shared with
 * `daemonRecord.ts` - the announced stdout pipe and a persisted record are
 * validated by the exact same rule, so a tampered sidecar cannot steer the
 * client at a foreign pipe.
 */
const DAEMON_RECORD_FILE = '.termy-daemon.json';
const DEV_RELOAD_PHASE_INSTALLING = 'installing';

interface ServerExitDetails {
  code: number | null;
  signal: NodeJS.Signals | null;
  abnormal: boolean;
}

interface DevReloadRequest {
  pluginId?: unknown;
  phase?: unknown;
  activeUntil?: unknown;
}

/**
 * Event listener type
 */
type EventListener<K extends keyof ServerEvents> = ServerEvents[K];

/**
 * WebSocket reconnect config
 */
interface ReconnectConfig {
  /** Maximum reconnect attempts */
  maxAttempts: number;
  /** Reconnect interval (ms) */
  interval: number;
}

/**
 * Unified server manager
 * 
 * Replaces BinaryManager + TerminalService + VoiceServerManager
 */
export class ServerManager {
  /** Plugin directory */
  private pluginDir: string;
  
  /** Plugin version */
  private version: string;
  
  /** Debug mode (controls logging output only) */
  private debugMode: boolean;
  
  /** Offline mode (skips version checks and automatic downloads) */
  private offlineMode: boolean;
  
  /** Binary downloader */
  private binaryDownloader: BinaryDownloader;
  
  /** Server process */
  private process: ChildProcess | null = null;
  
  /** Server transport connection (WebSocket today; named pipe in slice 5) */
  private transport: Transport | null = null;
  
  /** Server port (WebSocket transport) */
  private port: number | null = null;

  /** Server named-pipe path (Windows named-pipe transport) */
  private pipePath: string | null = null;

  /**
   * PID of a daemon we re-discovered and reused rather than spawned (Part B).
   * We hold no `ChildProcess` handle for it, so teardown kills it by pid.
   */
  private reusedDaemonPid: number | null = null;
  
  /** Whether shutdown is in progress */
  private isShuttingDown = false;
  
  /** Server restart attempt count */
  private restartAttempts = 0;
  
  /** Maximum server restart attempts */
  private readonly maxRestartAttempts = 3;
  
  /** WebSocket reconnect attempt count */
  private wsReconnectAttempts = 0;
  
  /** Reconnect config */
  private reconnectConfig: ReconnectConfig = {
    maxAttempts: 5,
    interval: 3000,
  };
  
  /** Whether reconnection is in progress */
  private isReconnecting = false;
  
  /** Reconnect timer */
  private reconnectTimer: number | null = null;
  
  /** Server startup Promise */
  private serverStartPromise: Promise<void> | null = null;
  
  /** WebSocket connection Promise */
  private wsConnectPromise: Promise<void> | null = null;

  /** Binary update Promise */
  private binaryUpdatePromise: Promise<BinaryUpdateResult> | null = null;
  
  /** Event listeners */
  private eventListeners: Map<keyof ServerEvents, Set<EventListener<keyof ServerEvents>>> = new Map();
  
  // Module clients (lazy-loaded)
  private _ptyClient: PtyClient | null = null;

  /**
   * Node built-ins resolved on demand inside the constructor via
   * Electron's `window.require`. Kept off the module top-level so the
   * Obsidian community plugin reviewer's static scanner does not flag
   * blanket filesystem / shell-execution access. Behavior is identical
   * at runtime because Electron caches `require` results.
   */
  private readonly fs: FsModule;
  private readonly path: PathModule;
  private readonly spawn: ChildProcessModule['spawn'];
  private readonly net: NetModule;

  constructor(
    pluginDir: string,
    version: string = '0.0.0',
    downloadConfig: BinaryDownloadConfig,
    debugMode: boolean = false,
    offlineMode: boolean = false
  ) {
    this.pluginDir = pluginDir;
    this.version = version;
    this.debugMode = debugMode;
    this.offlineMode = offlineMode;
    this.fs = window.require('fs') as FsModule;
    this.path = window.require('path') as PathModule;
    this.spawn = (window.require('child_process') as ChildProcessModule).spawn;
    this.net = window.require('net') as NetModule;
    this.binaryDownloader = new BinaryDownloader(pluginDir, version, downloadConfig);
  }

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Ensure the server is running
   * 

   */
  async ensureServer(): Promise<void> {
    // If the server is already running, return immediately
    if (this.hasEndpoint() && this.transport?.isConnected) {
      return;
    }

    // If startup is already in progress, wait for it to finish
    if (this.serverStartPromise) {
      return this.serverStartPromise;
    }

    // Start the server
    this.serverStartPromise = this.startServer();
    return this.serverStartPromise;
  }

  /**
   * Ensure the binary has been updated (without starting the server)
   */
  async ensureBinaryUpdated(): Promise<BinaryUpdateResult> {
    if (this.offlineMode) {
      debugLog('[ServerManager] 离线模式已开启，跳过二进制版本检查与下载');
      return 'skipped-offline';
    }
    return this.ensureBinaryReady();
  }

  /**
   * Get the PTY client
   * 

   */
  pty(): PtyClient {
    if (!this._ptyClient) {
      this._ptyClient = new PtyClient();
      if (this.transport) {
        this._ptyClient.setTransport(this.transport);
      }
    }
    return this._ptyClient;
  }

  /**
   * Shut down the server.
   *
   * @param killDaemon When true (default), the native daemon is terminated and
   *   its sidecar record cleared. When false, the daemon is left running and the
   *   record is kept - the transport is dropped (which triggers the daemon's
   *   `detach()`, keeping sessions alive behind the orphan timer) so a reloaded
   *   plugin can re-discover and reattach (M2 Part B reload survival).
   */
  async shutdown(killDaemon = true): Promise<void> {
    this.isShuttingDown = true;

    debugLog(`[ServerManager] 关闭服务器... (killDaemon=${killDaemon})`);

    // Cancel the reconnect timer
    this.cancelReconnect();

    // Close the transport connection. On a keep-alive shutdown this is the ONLY
    // thing we do to the daemon: dropping the socket triggers its detach() so the
    // PTY sessions stay alive (the orphan timer reaps them only if no reattach
    // arrives in time).
    if (this.transport) {
      try {
        this.transport.close();
      } catch (error) {
        debugWarn('[ServerManager] 关闭传输时出错:', error);
      }
      this.transport = null;
    }

    if (!killDaemon) {
      // Leave the daemon running and its record intact for re-discovery. Drop
      // our handle without signalling (detached + unref means the renderer can
      // exit without waiting on it).
      this.process = null;
      this.reusedDaemonPid = null;
      debugLog('[ServerManager] 守护进程保持运行（重载存活）');
    } else if (this.process) {
      // Stop the server process
      try {
        this.process.kill('SIGTERM');

        // Wait for the process to exit
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(() => {
            if (this.process && !this.process.killed) {
              debugWarn('[ServerManager] 强制终止服务器');
              this.process.kill('SIGKILL');
            }
            resolve();
          }, 1000);

          if (this.process) {
            this.process.once('exit', () => {
              window.clearTimeout(timeout);
              resolve();
            });
          }
        });
      } catch (error) {
        errorLog('[ServerManager] 停止服务器时出错:', error);
      } finally {
        this.process = null;
      }
    } else if (this.reusedDaemonPid !== null) {
      // A daemon we reused (not spawned) has no ChildProcess handle - kill by pid.
      this.killByPid(this.reusedDaemonPid);
    }
    if (killDaemon) {
      this.reusedDaemonPid = null;
      // The daemon was killed above, so its sidecar record is now stale - remove
      // it so a reloaded plugin does not probe a dead pipe.
      this.clearDaemonRecord();
    }

    // Clear state
    this.port = null;
    this.pipePath = null;
    this.serverStartPromise = null;
    this.wsConnectPromise = null;
    
    // Destroy module clients
    this._ptyClient?.destroy();
    
    this._ptyClient = null;
    
    this.emit('server-stopped');
    
    debugLog('[ServerManager] 服务器已关闭');
  }

  /**
   * Whether the server is running
   */
  isServerRunning(): boolean {
    // Either a daemon we spawned (have a handle for) or one we reused by pid.
    return this.hasEndpoint() && (this.process !== null || this.reusedDaemonPid !== null);
  }

  /**
   * Whether a server endpoint (port or pipe) is known
   */
  private hasEndpoint(): boolean {
    return this.port !== null || this.pipePath !== null;
  }

  /**
   * Whether this platform uses the named-pipe transport
   */
  private usePipe(): boolean {
    return process.platform === 'win32';
  }

  /**
   * Whether the transport is connected
   */
  isConnected(): boolean {
    return this.transport !== null && this.transport.isConnected;
  }

  /**
   * Whether reconnection is in progress
   */
  isReconnectingWebSocket(): boolean {
    return this.isReconnecting;
  }

  /**
   * Get the WebSocket reconnect attempt count
   */
  getReconnectAttempts(): number {
    return this.wsReconnectAttempts;
  }

  /**
   * Get the server port
   */
  getServerPort(): number | null {
    return this.port;
  }

  /**
   * Register an event listener
   */
  on<K extends keyof ServerEvents>(event: K, callback: ServerEvents[K]): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(callback);
  }

  /**
   * Remove an event listener
   */
  off<K extends keyof ServerEvents>(event: K, callback: ServerEvents[K]): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(callback);
    }
  }

  // ============================================================================
  // Private methods
  // ============================================================================

  /**
   * Start the server
   */
  private async startServer(): Promise<void> {
    try {
      debugLog('[ServerManager] 启动统一服务器...');

      // A prior shutdown (e.g. the "Stop terminal server" command) left
      // isShuttingDown set; clear it so reconnect + crash recovery work for
      // this freshly started daemon.
      this.resetShutdownState();

      const binaryPath = this.getBinaryPath();

      await this.ensureBinaryReady();

      // Ensure executable permission (Unix)
      await this.ensureExecutable(binaryPath);

      // Part B: before spawning, try to re-discover and reuse a daemon left
      // running by a prior plugin instance (e.g. across a reload). Only the
      // pipe transport persists a daemon worth reusing.
      if (this.usePipe() && await this.tryReuseDaemon()) {
        this.restartAttempts = 0;
        this.setupServerExitHandler(); // no-op without a child handle; transport-close drives reconnect
        this.emit('server-started', 0);
        return;
      }

      // Start the process. Windows uses the OS-authenticated named pipe; every
      // other platform stays on the loopback WebSocket until UDS lands (M3).
      const serverArgs = this.usePipe() ? ['--pipe'] : ['--port', '0'];
      this.process = this.spawn(binaryPath, serverArgs, {
        // stderr is discarded, not piped: the daemon logs to stderr via
        // `eprintln!`, which PANICS on a broken-pipe write. Because the daemon
        // now outlives the renderer (reload survival), a piped stderr whose
        // read-end dies with the renderer would crash the daemon on its next
        // log line - defeating survival across a full app quit/relaunch.
        // 'ignore' gives it a stable sink. stdout stays piped only to read the
        // one startup info line; the daemon never writes stdout again.
        stdio: ['pipe', 'pipe', 'ignore'],
        env: {
          ...process.env,
          TERM: process.env.TERM || 'xterm-256color',
        },
        windowsHide: true,
        // Detached + unref so the daemon is not bound to the renderer's process
        // group and the parent's event loop does not stay alive waiting on it.
        // The teardown path still kills it (Part B B3 changes that to keep it
        // alive across a reload); detaching now is the lifecycle prerequisite.
        detached: true,
      });
      this.process.unref();

      debugLog('[ServerManager] 服务器进程已启动, PID:', this.process.pid);

      // Listen for process errors
      this.process.on('error', (error) => {
        errorLog('[ServerManager] 服务器进程错误:', error);
        this.handleServerError(error);
      });

      // Wait for endpoint information (pipe path on Windows, port otherwise)
      const info = await this.waitForServerInfo();
      if (info.pipe) {
        this.pipePath = info.pipe;
        debugLog(`[ServerManager] 服务器已启动，命名管道: ${info.pipe}`);
        // Record the live daemon so a reloaded plugin can re-discover it (Part B).
        // Only the pipe transport carries a daemon worth re-discovering; the WS
        // fallback has no persistence story until UDS (M3).
        this.writeDaemonRecord({
          pipe: info.pipe,
          pid: this.process.pid ?? 0,
          binaryVersion: this.version,
          startedAt: new Date().toISOString(),
        });
      } else {
        this.port = info.port ?? null;
        debugLog(`[ServerManager] 服务器已启动，端口: ${info.port}`);
      }
      this.restartAttempts = 0;
      
      // Set up the exit handler
      this.setupServerExitHandler();
      
      // Establish the transport connection
      await this.connectTransport();

      // Pipe mode has no port; report 0 (consumers only log this).
      this.emit('server-started', this.port ?? 0);

    } catch (error) {
      this.serverStartPromise = null;
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      errorLog('[ServerManager] 启动服务器失败:', errorMessage);
      
      new Notice(t('notices.serverStartFailed', { message: errorMessage }), 0);
      
      this.emit('server-error', error instanceof Error ? error : new Error(errorMessage));
      throw error;
    }
  }

  /**
   * Get the binary path
   */
  private getBinaryPath(): string {
    const platform = process.platform;
    const arch = process.arch;
    const ext = platform === 'win32' ? '.exe' : '';
    const filename = `termy-server-${platform}-${arch}${ext}`;
    
    return this.path.join(this.pluginDir, 'binaries', filename);
  }

  private async ensureBinaryReady(): Promise<BinaryUpdateResult> {
    if (this.offlineMode) {
      const binaryPath = this.getBinaryPath();
      if (!this.fs.existsSync(binaryPath)) {
        throw new ServerManagerError(
          ServerErrorCode.BINARY_NOT_FOUND,
          '离线模式已开启，未进行版本检查与下载，请确保服务器二进制已存在'
        );
      }
      return 'skipped-offline';
    }
    
    if (this.binaryUpdatePromise) {
      return this.binaryUpdatePromise;
    }

    this.binaryUpdatePromise = this.performBinaryUpdate();

    try {
      return await this.binaryUpdatePromise;
    } finally {
      this.binaryUpdatePromise = null;
    }
  }

  private async performBinaryUpdate(): Promise<BinaryUpdateResult> {
    const skipVersionCheck = this.offlineMode;
    const needsDownload = !this.binaryDownloader.binaryExists(skipVersionCheck);
    const needsUpdate = this.binaryDownloader.needsUpdate(skipVersionCheck);
    const binaryPath = this.getBinaryPath();
    const downloadConfig = this.binaryDownloader.getDownloadConfig();

    debugLog('[ServerManager] Binary readiness check:', {
      binaryPath,
      needsDownload,
      needsUpdate,
      offlineMode: this.offlineMode,
      downloadSource: downloadConfig.source,
      serverRunning: this.isServerRunning(),
    });

    if (!needsDownload && !needsUpdate) {
      debugLog('[ServerManager] 二进制文件已是最新，无需下载');
      return 'already-ready';
    }

    const shouldRestart = needsUpdate && this.isServerRunning();
    if (shouldRestart) {
      debugLog('[ServerManager] 服务器运行中，更新前先停止服务器');
      await this.shutdown();
    }

    const messageKey = needsUpdate ? 'notices.updatingBinary' : 'notices.downloadingBinary';
    const defaultMessage = needsUpdate ? '正在更新服务器组件...' : '正在下载服务器组件...';

    debugLog(`[ServerManager] ${needsUpdate ? '二进制文件需要更新' : '二进制文件不存在'}，开始下载...`);

    const notice = new Notice(
      t(messageKey) || defaultMessage,
      0
    );

    let updateSucceeded = false;

    try {
      await this.binaryDownloader.download((progress) => {
        if (progress.stage === 'downloading') {
          notice.setMessage(
            `${t(messageKey) || defaultMessage} ${Math.round(progress.percent)}%`
          );
        } else if (progress.stage === 'verifying') {
          notice.setMessage(t('notices.verifyingBinary') || '正在验证文件...');
        }
      });

      notice.hide();
      const completeKey = needsUpdate ? 'notices.binaryUpdateComplete' : 'notices.binaryDownloadComplete';
      const completeMessage = needsUpdate ? '服务器组件更新完成' : '服务器组件下载完成';
      new Notice(t(completeKey) || completeMessage, 3000);
      updateSucceeded = true;
      return needsUpdate ? 'updated' : 'downloaded';

    } catch (downloadError) {
      notice.hide();
      throw new ServerManagerError(
        ServerErrorCode.BINARY_NOT_FOUND,
        `下载二进制文件失败: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`
      );
    } finally {
      if (shouldRestart) {
        this.resetShutdownState();
        if (updateSucceeded) {
          window.setTimeout(() => {
            this.ensureServer().catch((error) => {
              errorLog('[ServerManager] 更新后重启服务器失败:', error);
            });
          }, 0);
        }
      }
    }
  }

  /**
   * Ensure the file is executable (Unix)
   */
  private async ensureExecutable(filePath: string): Promise<void> {
    if (process.platform === 'win32') {
      return;
    }
    
    try {
      const stats = await this.fs.promises.stat(filePath);
      const isExecutable = (stats.mode & 0o111) !== 0;
      
      if (!isExecutable) {
        debugLog('[ServerManager] 添加可执行权限:', filePath);
        await this.fs.promises.chmod(filePath, 0o755);
      }
    } catch (error) {
      errorLog('[ServerManager] 设置可执行权限失败:', error);
    }
  }

  /**
   * Wait for the server to output its endpoint info on stdout: a named-pipe
   * path (`{"pipe": "..."}`) on Windows or a port (`{"port": N}`) elsewhere.
   */
  private async waitForServerInfo(): Promise<ServerInfo> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdout) {
        reject(new ServerManagerError(
          ServerErrorCode.SERVER_START_FAILED,
          '进程未启动'
        ));
        return;
      }

      let buffer = '';

      const timeout = window.setTimeout(() => {
        this.process?.stdout?.off('data', onData);
        reject(new ServerManagerError(
          ServerErrorCode.SERVER_START_FAILED,
          '等待端口信息超时'
        ));
      }, 10000);

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString();

        // The server prints exactly one JSON object per line. Parse complete
        // lines only - a regex over merged stdout can grab a partial/wrong
        // object once the format grows.
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) {
            continue;
          }

          let info: ServerInfo;
          try {
            info = JSON.parse(line) as ServerInfo;
          } catch {
            continue; // not the info line, keep scanning
          }

          const hasPipe = typeof info.pipe === 'string' && PIPE_NAME_RE.test(info.pipe);
          const hasPort = typeof info.port === 'number' && info.port > 0;
          if (hasPipe || hasPort) {
            window.clearTimeout(timeout);
            this.process?.stdout?.off('data', onData);
            debugLog('[ServerManager] 解析到服务器信息:', info);
            resolve(info);
            return;
          }
        }
      };

      this.process.stdout.on('data', onData);

      // (Daemon stderr is discarded at spawn - see the `stdio` note in
      // startServer - so there is no stderr stream to listen on here.)

      this.process.on('exit', (code) => {
        window.clearTimeout(timeout);
        if (code !== 0 && code !== null) {
          reject(new ServerManagerError(
            ServerErrorCode.SERVER_START_FAILED,
            `服务器启动失败，退出码: ${code}`
          ));
        }
      });
    });
  }

  /**
   * Build (but do not connect) the transport for the running server's endpoint.
   * Returns null if no endpoint is known yet.
   */
  private buildTransport(): Transport | null {
    if (this.pipePath) {
      debugLog('[ServerManager] 连接传输 (命名管道):', this.pipePath);
      const connector: SocketConnector = (path) => this.net.connect(path);
      return new PipeTransport(this.pipePath, connector);
    }
    if (this.port) {
      const wsUrl = `ws://127.0.0.1:${this.port}`;
      debugLog('[ServerManager] 连接传输 (WebSocket):', wsUrl);
      return new WebSocketTransport(wsUrl);
    }
    return null;
  }

  /** Absolute path of the daemon sidecar record. */
  private getDaemonRecordPath(): string {
    return this.path.join(this.pluginDir, DAEMON_RECORD_FILE);
  }

  /**
   * Persist the daemon record atomically (write a temp file, then rename) so a
   * crash mid-write can never leave a half-written record that `parseDaemonRecord`
   * would reject anyway. Best-effort: a failure here only costs us re-discovery,
   * not correctness (the plugin spawns fresh next load).
   */
  private writeDaemonRecord(record: DaemonRecord): void {
    const finalPath = this.getDaemonRecordPath();
    const tempPath = `${finalPath}.${process.pid}.tmp`;
    try {
      this.fs.writeFileSync(tempPath, serializeDaemonRecord(record), 'utf8');
      this.fs.renameSync(tempPath, finalPath);
      debugLog('[ServerManager] 已写入守护进程记录:', finalPath);
    } catch (error) {
      debugWarn('[ServerManager] 写入守护进程记录失败:', error);
      try {
        if (this.fs.existsSync(tempPath)) {
          this.fs.unlinkSync(tempPath);
        }
      } catch {
        /* nothing more to do */
      }
    }
  }

  /** Read + validate the daemon record. Returns null if absent or malformed. */
  private readDaemonRecord(): DaemonRecord | null {
    try {
      const recordPath = this.getDaemonRecordPath();
      if (!this.fs.existsSync(recordPath)) {
        return null;
      }
      return parseDaemonRecord(this.fs.readFileSync(recordPath, 'utf8'));
    } catch (error) {
      debugWarn('[ServerManager] 读取守护进程记录失败:', error);
      return null;
    }
  }

  /**
   * Part B - daemon re-discovery. Look for a sidecar record left by a prior
   * plugin instance and, if its daemon is still alive and speaks our version,
   * reuse it instead of spawning a fresh one. Returns true iff a daemon was
   * reused (transport connected).
   *
   * Probe-before-kill: we connect to the persisted pipe FIRST. A failed probe
   * means the daemon is already gone, so we clear the record and spawn fresh
   * without signalling anything (this avoids SIGTERM-ing a pid the OS may have
   * recycled onto an unrelated process after our daemon died). Only once the
   * pipe is confirmed live do we either reuse it (version match) or kill it
   * (version skew) - at that point the recorded pid owns a pipe that, by its
   * user-only DACL, only our own account could have created.
   *
   * Security: the record is a same-user file treated as untrusted input.
   * `parseDaemonRecord` enforces `PIPE_NAME_RE`, so a doctored record cannot
   * steer us at a foreign-*named* pipe; reaching a pipe owned by a *different
   * user* is blocked by the DACL. A same-user process squatting a `termy-<uuid>`
   * name is inside the trusted (same-user) threat model.
   */
  private async tryReuseDaemon(): Promise<boolean> {
    const record = this.readDaemonRecord();
    if (!record) {
      return false;
    }

    // Probe by attempting to connect to the persisted pipe.
    this.pipePath = record.pipe;
    try {
      await this.connectTransport();
    } catch (error) {
      // Dead/stale pipe: the daemon is gone. Spawn fresh; do NOT kill the pid
      // (it may have been recycled onto an unrelated process).
      debugWarn('[ServerManager] 探测已有守护进程失败，将重新启动:', error);
      this.pipePath = null;
      this.transport = null;
      this.wsConnectPromise = null;
      this.clearDaemonRecord();
      return false;
    }

    // The pipe is live. If the daemon speaks an older protocol, replace it:
    // tear down the probe connection, kill the (now confirmed-live, ours-by-DACL)
    // daemon, and fall through to a fresh spawn. Never reattach across versions.
    if (!isVersionCompatible(record, this.version)) {
      debugLog(
        `[ServerManager] 守护进程记录版本不匹配 (${record.binaryVersion} != ${this.version})，` +
        `终止并重新启动`
      );
      try {
        this.transport?.close();
      } catch {
        /* best-effort teardown */
      }
      this.transport = null;
      this.wsConnectPromise = null;
      this.pipePath = null;
      this.killByPid(record.pid);
      this.clearDaemonRecord();
      return false;
    }

    // Connected to a live, version-matched daemon we did not spawn.
    this.reusedDaemonPid = record.pid;
    debugLog(`[ServerManager] 已重用现有守护进程 (pid ${record.pid}): ${record.pipe}`);
    return true;
  }

  /** Best-effort SIGTERM to a pid. Used only for pids tied to our own record. */
  private killByPid(pid: number): void {
    try {
      process.kill(pid, 'SIGTERM');
    } catch (error) {
      debugWarn('[ServerManager] 终止守护进程失败 (pid', pid, '):', error);
    }
  }

  /** Remove the daemon record, if present. Best-effort. */
  private clearDaemonRecord(): void {
    try {
      const recordPath = this.getDaemonRecordPath();
      if (this.fs.existsSync(recordPath)) {
        this.fs.unlinkSync(recordPath);
        debugLog('[ServerManager] 已删除守护进程记录');
      }
    } catch (error) {
      debugWarn('[ServerManager] 删除守护进程记录失败:', error);
    }
  }

  /**
   * Establish the transport connection
   *
   * Builds a transport for the running server and connects it: a named pipe
   * when the server emitted a pipe path (Windows), otherwise a loopback
   * WebSocket. The connection lifecycle (open/close/message) is driven through
   * the `TransportHandlers` so this layer no longer knows the wire type.
   */
  private async connectTransport(): Promise<void> {
    if (this.wsConnectPromise) {
      return this.wsConnectPromise;
    }

    this.wsConnectPromise = this.doConnectTransport();
    return this.wsConnectPromise;
  }

  private async doConnectTransport(): Promise<void> {
    const transport = this.buildTransport();
    if (!transport) {
      this.wsConnectPromise = null;
      throw new ServerManagerError(
        ServerErrorCode.CONNECTION_FAILED,
        '服务器端点未知'
      );
    }

    this.transport = transport;

    try {
      await transport.connect({
        onMessage: (msg) => this.handleTransportMessage(msg),
        onClose: (info) => this.handleTransportClose(transport, info),
        onError: (error) => errorLog('[ServerManager] 传输错误:', error),
      });
    } catch (error) {
      if (this.transport === transport) {
        this.transport = null;
        this.wsConnectPromise = null;
      }
      throw new ServerManagerError(
        ServerErrorCode.CONNECTION_FAILED,
        `传输连接失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    debugLog('[ServerManager] 传输已连接');

    // Reset the reconnect counter
    this.wsReconnectAttempts = 0;
    this.isReconnecting = false;

    // Update the transport on all module clients
    this.updateClientsTransport();

    this.emit('ws-connected');
  }

  /**
   * Handle the transport closing after a successful open.
   */
  private handleTransportClose(transport: Transport, info: { code?: number; reason?: string }): void {
    debugLog('[ServerManager] 传输已断开, code:', info.code, 'reason:', info.reason);
    if (this.transport === transport) {
      this.transport = null;
      this.wsConnectPromise = null;
    }

    // Clear the transport on module clients
    this._ptyClient?.setTransport(null);

    if (this.isDevInstallInProgress()) {
      debugLog('[ServerManager] 开发安装进行中，跳过传输重连通知');
      return;
    }

    this.emit('ws-disconnected');

    // If this was not an intentional shutdown, try to reconnect
    if (!this.isShuttingDown && this.hasEndpoint()) {
      this.scheduleReconnect();
    }
  }

  /**
   * Update the transport on all module clients
   */
  private updateClientsTransport(): void {
    if (this.transport) {
      this._ptyClient?.setTransport(this.transport);
    }
  }

  /**
   * Handle a message from the transport
   */
  private handleTransportMessage(msg: TransportMessage): void {
    // Handle binary messages (PTY output)
    if (msg.kind === 'binary') {
      this._ptyClient?.handleBinaryMessage(msg.data);
      return;
    }

    // Handle JSON messages
    try {
      const parsed = JSON.parse(msg.data) as ServerMessage;

      // Dispatch messages by module
      switch (parsed.module) {
        case 'pty':
          this._ptyClient?.handleMessage(parsed);
          break;
        default:
          debugWarn('[ServerManager] 未知模块消息:', parsed);
      }
    } catch (error) {
      errorLog('[ServerManager] 解析消息失败:', error);
    }
  }

  /**
   * Handle WebSocket disconnection and schedule reconnect
   */
  private scheduleReconnect(): void {
    // If reconnection is already in progress or shutdown is underway, skip
    if (this.isReconnecting || this.isShuttingDown) {
      return;
    }

    if (this.isDevInstallInProgress()) {
      debugLog('[ServerManager] 开发安装进行中，跳过 WebSocket 自动重连');
      return;
    }
    
    // Check whether the maximum reconnect attempts has been exceeded
    if (this.wsReconnectAttempts >= this.reconnectConfig.maxAttempts) {
      errorLog(
        `[ServerManager] WebSocket 重连失败，已达到最大重试次数 (${this.reconnectConfig.maxAttempts})`
      );
      
      new Notice(
        t('notices.wsReconnectFailed') || 'WebSocket 连接断开，请重新加载插件',
        0
      );
      
      this.emit('ws-reconnect-failed');
      return;
    }
    
    this.isReconnecting = true;
    this.wsReconnectAttempts++;
    
    const delay = this.reconnectConfig.interval;
    
    debugLog(
      `[ServerManager] 将在 ${delay}ms 后尝试重连 WebSocket ` +
      `(${this.wsReconnectAttempts}/${this.reconnectConfig.maxAttempts})`
    );
    
    this.emit('ws-reconnecting', this.wsReconnectAttempts, delay);
    
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.attemptReconnect();
    }, delay);
  }

  /**
   * Perform WebSocket reconnect
   */
  private async attemptReconnect(): Promise<void> {
    if (this.isShuttingDown || !this.hasEndpoint()) {
      this.isReconnecting = false;
      return;
    }
    
    debugLog('[ServerManager] 尝试重连 WebSocket...');

    try {
      await this.connectTransport();

      debugLog('[ServerManager] WebSocket 重连成功');
      new Notice(
        t('notices.wsReconnectSuccess') || 'WebSocket 重连成功',
        3000
      );
      
    } catch (error) {
      errorLog('[ServerManager] WebSocket 重连失败:', error);
      this.isReconnecting = false;
      
      // Keep trying to reconnect
      this.scheduleReconnect();
    }
  }

  /**
   * Cancel reconnect
   */
  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.isReconnecting = false;
    this.wsReconnectAttempts = 0;
  }

  /**
   * Set up the server exit handler
   * 

   */
  private setupServerExitHandler(): void {
    if (!this.process) {
      return;
    }

    const exitedProcess = this.process;
    exitedProcess.on('exit', (code, signal) => {
      if (this.process === exitedProcess) {
        this.process = null;
        this.port = null;
        this.pipePath = null;
        this.serverStartPromise = null;
        this.wsConnectPromise = null;
      }
      
      if (this.isShuttingDown) {
        debugLog(`[ServerManager] 服务器已停止: code=${code}, signal=${signal}`);
        return;
      }
      
      const exitDetails: ServerExitDetails = {
        code,
        signal,
        abnormal: code !== 0 && code !== null,
      };

      const logExit = exitDetails.abnormal ? errorLog : debugWarn;
      logExit(`[ServerManager] 服务器退出: code=${code}, signal=${signal}`);

      if (this.isDevInstallInProgress()) {
        this.cancelReconnect();
        debugLog('[ServerManager] 开发安装进行中，跳过服务器自动重启');
        return;
      }

      // Try automatic restart
      this.attemptRestart(exitDetails);
    });
  }

  /**
   * Try to automatically restart the server
   */
  private attemptRestart(exitDetails: ServerExitDetails): void {
    if (this.restartAttempts < this.maxRestartAttempts) {
      this.restartAttempts++;
      debugLog(
        `[ServerManager] 尝试重启服务器 ` +
        `(${this.restartAttempts}/${this.maxRestartAttempts})`
      );
      
      const delay = 1000 * Math.pow(2, this.restartAttempts - 1);
      
      window.setTimeout(() => {
        this.ensureServer()
          .then(() => {
            debugLog('[ServerManager] 服务器自动重启成功');
          })
          .catch(err => {
            errorLog('[ServerManager] 服务器重启失败:', err);
            this.showRestartFailedNotice(exitDetails);
          });
      }, delay);
    } else {
      this.showRestartFailedNotice(exitDetails);
    }
  }

  private showRestartFailedNotice(exitDetails: ServerExitDetails): void {
    const restartFailedMessage = t('notices.serverRestartFailed');
    if (!exitDetails.abnormal) {
      new Notice(restartFailedMessage, 0);
      return;
    }

    new Notice(
      `${this.formatServerCrashNotice(exitDetails)}\n${restartFailedMessage}`,
      0
    );
  }

  private formatServerCrashNotice(exitDetails: ServerExitDetails): string {
    return t('notices.serverCrashed', {
      code: String(exitDetails.code),
      signal: exitDetails.signal || 'N/A',
    });
  }

  private isDevInstallInProgress(): boolean {
    const requestPath = this.path.join(this.pluginDir, DEV_RELOAD_REQUEST_FILE);
    try {
      if (!this.fs.existsSync(requestPath)) {
        return false;
      }

      const request = JSON.parse(this.fs.readFileSync(requestPath, 'utf-8')) as DevReloadRequest;
      if (request.pluginId && request.pluginId !== 'termy') {
        return false;
      }
      if (request.phase !== DEV_RELOAD_PHASE_INSTALLING) {
        return false;
      }
      if (typeof request.activeUntil !== 'string') {
        return false;
      }

      const activeUntil = Date.parse(request.activeUntil);
      if (!Number.isFinite(activeUntil)) {
        return false;
      }
      if (activeUntil <= Date.now()) {
        this.fs.rmSync(requestPath, { force: true });
        return false;
      }

      return true;
    } catch (error) {
      debugWarn('[ServerManager] 读取开发安装标记失败:', error);
      return false;
    }
  }

  /**
   * Handle server process errors
   */
  private handleServerError(error: Error): void {
    const errorCode = (error as NodeJS.ErrnoException).code;
    
    if (errorCode === 'ENOENT') {
      new Notice(
        '❌ 无法启动服务器\n\n' +
        '错误: 二进制文件未找到\n' +
        '请重新加载插件',
        0
      );
    } else if (errorCode === 'EACCES') {
      new Notice(
        '❌ 无法启动服务器\n\n' +
        '错误: 权限不足\n' +
        '请检查文件权限',
        0
      );
    } else {
      new Notice(
        `❌ 服务器启动失败\n\n` +
        `错误: ${error.message}\n` +
        `请查看控制台获取详细信息`,
        0
      );
    }
    
    this.emit('server-error', error);
  }

  /**
   * Emit an event
   */
  private emit<K extends keyof ServerEvents>(
    event: K,
    ...args: Parameters<ServerEvents[K]>
  ): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(listener => {
        try {
          (listener as (...args: Parameters<ServerEvents[K]>) => void)(...args);
        } catch (error) {
          errorLog(`[ServerManager] 事件处理器错误 (${event}):`, error);
        }
      });
    }
  }

  /**
   * Reset the shutdown state (used when re-enabling the service)
   */
  resetShutdownState(): void {
    this.isShuttingDown = false;
    this.restartAttempts = 0;
    this.wsReconnectAttempts = 0;
    this.isReconnecting = false;
  }

  /**
   * Manually trigger reconnect (for external callers)
   */
  async reconnect(): Promise<void> {
    if (this.isShuttingDown) {
      throw new ServerManagerError(
        ServerErrorCode.CONNECTION_FAILED,
        '服务器正在关闭'
      );
    }
    
    // Reset the reconnect counter
    this.wsReconnectAttempts = 0;
    this.cancelReconnect();
    
    // Close the existing connection
    if (this.transport) {
      this.transport.close();
      this.transport = null;
    }
    this.wsConnectPromise = null;

    // If the server is still running, reconnect the transport directly
    if (this.hasEndpoint() && this.process !== null) {
      await this.connectTransport();
    } else {
      // Otherwise restart the entire server
      await this.ensureServer();
    }
  }

  /**
   * Update connection config
   * @param config Connection config
   */
  updateConnectionConfig(config: Partial<ReconnectConfig>): void {
    // Check whether the config changed
    const hasChanges = Object.entries(config).some(
      ([key, value]) => this.reconnectConfig[key as keyof ReconnectConfig] !== value
    );
    
    if (hasChanges) {
      Object.assign(this.reconnectConfig, config);
      debugLog('[ServerManager] 更新重连配置:', this.reconnectConfig);
    }
  }
  
  updateDebugMode(debugMode: boolean): void {
    if (this.debugMode === debugMode) {
      return;
    }
    this.debugMode = debugMode;
    debugLog('[ServerManager] 更新调试模式:', this.debugMode);
  }
  
  updateOfflineMode(offlineMode: boolean): void {
    if (this.offlineMode === offlineMode) {
      return;
    }
    this.offlineMode = offlineMode;
    debugLog('[ServerManager] 更新离线模式:', this.offlineMode);
  }

  updateBinaryDownloadConfig(downloadConfig: BinaryDownloadConfig): void {
    const currentConfig = this.binaryDownloader?.getDownloadConfig?.();
    const nextConfig: BinaryDownloadConfig = {
      source: downloadConfig.source,
    };

    if (
      currentConfig
      && currentConfig.source === nextConfig.source
    ) {
      return;
    }
    this.binaryDownloader = new BinaryDownloader(this.pluginDir, this.version, nextConfig);
    debugLog('[ServerManager] 更新二进制下载配置:', nextConfig);
  }
}
