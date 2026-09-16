import { backendFromSettings, hostCapabilities } from './execution.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BridgeError } from './transport.mjs';

const BACKENDS = new Set(['dsh', 'codex']);

export class HostModelService {
  constructor({ directory, dsh, codex, defaultBackend = 'dsh' }) {
    this.isHostRouter = true;
    this.supportsAgents = true;
    this.managesConcurrency = true;
    this.directory = directory;
    this.hosts = { dsh, codex };
    this.activeBackend = BACKENDS.has(defaultBackend)
      ? defaultBackend
      : 'dsh';
    this.revision = 0;
    this.requestContext = new AsyncLocalStorage();
    this.listeners = new Set();
    this.unsubscribers = [];
    const self = this;
    this.store = {
      state: {
        get settings() {
          return self.currentHost.store.state.settings;
        },
      },
    };
  }

  get currentBackend() {
    return this.requestContext.getStore()?.backend ?? this.activeBackend;
  }

  get currentHost() {
    return (
      this.requestContext.getStore()?.host ?? this.hosts[this.activeBackend]
    );
  }

  get mode() {
    return this.currentHost.mode;
  }

  get context() {
    return this.currentHost.context;
  }

  get concurrency() {
    return this.currentHost.concurrency;
  }

  get running() {
    return this.currentHost.running;
  }

  concurrencyForSettings(settings) {
    const backend = this.executionPoolForSettings(settings);
    return this.hosts[backend]?.concurrency ?? 1;
  }

  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(
        await readFile(join(this.directory, 'backend.json'), 'utf8'),
      );
      // Read the former identifier without changing the selected host.
      if (saved.activeBackend === 'harness') saved.activeBackend = 'dsh';
      if (!BACKENDS.has(saved.activeBackend))
        throw new BridgeError('invalid_settings', '分析宿主设置无效。');
      this.activeBackend = saved.activeBackend;
      this.revision = Number.isInteger(saved.revision) ? saved.revision : 0;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await Promise.all(Object.values(this.hosts).map((host) => host.open()));
    this.unsubscribers = Object.values(this.hosts).map((host) =>
      host.onConcurrencyChange?.(() => {
        for (const listener of this.listeners) listener();
      }),
    );
    return this;
  }

  onConcurrencyChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async config() {
    const [dsh, codex] = await Promise.all([
      this.hosts.dsh.config(),
      this.hosts.codex.config(),
    ]);
    return {
      mode: 'host-router',
      activeBackend: this.activeBackend,
      revision: this.revision,
      backends: { dsh, codex },
    };
  }

  backendConfig(backend) {
    const host = this.hosts[backend];
    if (!host) throw new BridgeError('not_found', '分析宿主不存在。');
    return host.config();
  }

  async selectBackend({ backend, revision }) {
    if (!BACKENDS.has(backend))
      throw new BridgeError('invalid_settings', '请选择有效的分析宿主。');
    if (revision !== this.revision)
      throw new BridgeError(
        'conflict',
        '分析宿主设置已改变，请刷新后重试。',
        false,
        409,
      );
    const config = await this.hosts[backend].config();
    if (!config.connected)
      throw new BridgeError(
        config.error?.code ?? 'host_unavailable',
        config.error?.message ?? '所选分析宿主当前不可用。',
        false,
        503,
      );
    const next = { activeBackend: backend, revision: this.revision + 1 };
    const file = join(this.directory, 'backend.json');
    const temporary = `${file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, file);
    this.activeBackend = backend;
    this.revision = next.revision;
    for (const listener of this.listeners) listener();
    return this.config();
  }

  executionPoolForSettings(settings) {
    return backendFromSettings(settings, this.currentBackend);
  }

  capabilitiesForSettings(settings) {
    const host = this.backendForSettings(settings);
    return host.capabilities ?? hostCapabilities(this.executionPoolForSettings(settings), {
      concurrency: host.concurrency,
      supportsAgents: host.supportsAgents !== false,
      managesConcurrency: host.managesConcurrency !== false,
    });
  }

  backendForSettings(settings) {
    const backend = this.executionPoolForSettings(settings);
    const host = this.hosts[backend];
    if (!host) throw new BridgeError('legacy_model_snapshot', '该任务的模型宿主当前不可用，请保留历史并明确重新发起。');
    return host;
  }

  withRequest(req, operation) {
    const backend = this.activeBackend;
    const host = this.hosts[backend];
    return this.requestContext.run({ backend, host }, () =>
      host.withRequest ? host.withRequest(req, operation) : operation(),
    );
  }

  withContext(context, operation) {
    const host = this.currentHost;
    return host.withContext
      ? host.withContext(context, operation)
      : operation();
  }

  run(request, options = {}) {
    return this.backendForSettings(options.settings).run(request, options);
  }

  runAgent(request, options = {}) {
    return this.backendForSettings(options.settings).runAgent(request, options);
  }

  routing(raw, backend = this.currentBackend) {
    const host = this.hosts[backend];
    if (!host) throw new BridgeError('not_found', '分析宿主不存在。');
    return host.routing(raw);
  }

  startCodexLogin() {
    return this.hosts.codex.startLogin();
  }

  logoutCodex() {
    return this.hosts.codex.logout();
  }

  async close() {
    for (const unsubscribe of this.unsubscribers) unsubscribe?.();
    await Promise.allSettled(
      Object.values(this.hosts).map((host) => host.close()),
    );
  }
}
