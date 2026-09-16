import appPackage from '../../../package.json' with { type: 'json' };
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { BridgeError } from '../transport.mjs';

const unavailable = (message, cause) => {
  const error = new BridgeError(
    'codex_unavailable',
    message ?? '无法启动 Codex，请确认本机已经安装 Codex。',
    true,
    503,
  );
  error.cause = cause;
  return error;
};

export class CodexAppServerClient {
  constructor({ binary = 'codex', runtimeHome, spawnProcess = spawn } = {}) {
    this.binary = binary;
    this.runtimeHome = runtimeHome;
    this.spawnProcess = spawnProcess;
    this.pending = new Map();
    this.listeners = new Set();
    this.sequence = 0;
    this.stderr = [];
    this.closed = false;
  }

  async open() {
    if (this.process && !this.process.killed) return this;
    if (this.opening) return this.opening;
    this.opening = this.start().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  async start() {
    if (this.closed) throw unavailable('Codex 服务已经关闭。');
    let child;
    try {
      child = this.spawnProcess(
        this.binary,
        [
          'app-server',
          '--listen',
          'stdio://',
          '--disable',
          'hooks',
          '--disable',
          'apps',
          '--disable',
          'shell_tool',
          '--disable',
          'unified_exec',
          '--disable',
          'skill_mcp_dependency_install',
          '--config',
          'web_search="disabled"',
          '--config',
          'agents.enabled=false',
        ],
        {
          env: {
            ...process.env,
            CODEX_HOME: this.runtimeHome,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
    } catch (error) {
      throw unavailable(undefined, error);
    }
    this.process = child;
    child.once('error', (error) => this.onExit(unavailable(undefined, error)));
    child.once('exit', (code, signal) => {
      if (this.process !== child) return;
      this.onExit(
        unavailable(
          `Codex App Server 已退出${signal ? `（${signal}）` : `（状态 ${code ?? '未知'}）`}。`,
        ),
      );
    });
    createInterface({ input: child.stdout }).on('line', (line) =>
      this.onLine(line),
    );
    createInterface({ input: child.stderr }).on('line', (line) => {
      this.stderr.push(String(line).slice(0, 2000));
      this.stderr = this.stderr.slice(-30);
    });
    await this.request(
      'initialize',
      {
        clientInfo: {
          name: 'paper_radar',
          title: 'Paper Radar',
          version: appPackage.version,
        },
        capabilities: null,
      },
      { timeout: 15000, skipOpen: true },
    );
    this.notify('initialized', {});
    return this;
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      pending.cleanup();
      if (message.error) {
        const error = new BridgeError(
          'codex_rpc_error',
          message.error.message ?? 'Codex 请求未完成。',
          false,
          400,
        );
        error.rpcCode = message.error.code;
        error.rpcData = message.error.data;
        pending.reject(error);
      } else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.write({
        id: message.id,
        error: {
          code: -32601,
          message: 'Paper Radar 不允许此交互请求。',
        },
      });
    }
    for (const listener of this.listeners) listener(message);
  }

  onExit(error) {
    const child = this.process;
    this.process = null;
    if (child) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners)
      listener({ method: '$paperRadar/appServerExited', error });
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  write(message) {
    if (!this.process?.stdin?.writable)
      throw unavailable('Codex App Server 尚未连接。');
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.write({ method, params });
  }

  async request(
    method,
    params,
    { signal, timeout = 30000, skipOpen = false } = {},
  ) {
    if (!skipOpen) await this.open();
    signal?.throwIfAborted();
    const id = String(++this.sequence);
    return new Promise((resolve, reject) => {
      let timer;
      const abort = () => {
        this.pending.delete(id);
        cleanup();
        reject(
          new BridgeError(
            'cancelled',
            signal?.reason?.message ?? 'Codex 任务已取消。',
            false,
          ),
        );
      };
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      if (timeout !== null)
        timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(
            new BridgeError('codex_timeout', 'Codex 请求等待超时。', true, 504),
          );
        }, timeout);
      signal?.addEventListener('abort', abort, { once: true });
      this.pending.set(id, { resolve, reject, cleanup });
      try {
        this.write({ method, id, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        this.pending.delete(id);
        cleanup();
        reject(error);
      }
    });
  }

  async close() {
    this.closed = true;
    const child = this.process;
    this.process = null;
    if (!child) return;
    child.stdin?.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        resolve();
      }, 1500);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async terminate(message = 'Codex App Server 无法中断任务，已强制停止。') {
    const child = this.process;
    if (!child) return;
    let exited = false;
    const stopped = new Promise((resolve) => {
      child.once('exit', () => {
        exited = true;
        resolve();
      });
    });
    this.onExit(unavailable(message));
    child.kill('SIGTERM');
    await Promise.race([
      stopped,
      new Promise((resolve) => setTimeout(resolve, 1500)),
    ]);
    if (!exited) child.kill('SIGKILL');
  }
}
