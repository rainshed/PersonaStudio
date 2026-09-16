import { requireHostSettings } from '../execution.mjs';
import { PriorityAdmission } from '../../agents/admission.mjs';
import { taskPriority } from '../../tasks/context.mjs';
import { hostCapabilities } from '../execution.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveConnection } from '../../../lib/host-models.ts';
import {
  bridgeRequest,
  BridgeError,
  PROTOCOL,
} from '../transport.mjs';
import {
  TASKS,
  emptyRoutes,
  validateChoice,
} from '@paper-radar/host-contract/routing';
import { AgentClient } from './agent-client.mjs';
import { MAX_CONCURRENCY, validConcurrency } from '../../../lib/concurrency.ts';
import {
  upgradeRoutes,
  materializeRoutes,
  HOST_TASKS,
} from '../../../lib/host-settings.ts';

function settingsFrom(snapshot) {
  const connections = Object.entries(snapshot.selections).map(([task, c]) => ({
    id: `dsh:${task}`,
    name: `${TASKS.find((t) => t.id === task)?.name ?? task} · ${c.model} · ${c.reasoningEffort ?? '宿主默认'}`,
    providerId: c.provider,
    modelId: c.model,
    status: 'ready',
    contextWindow: c.contextWindow ?? 32768,
    maxTokens: c.maxTokens,
    reasoningEffort: c.reasoningEffort ?? null,
    source: c.source,
    revision: JSON.stringify([c.provider, c.model, c.reasoningEffort ?? null]),
    task,
  }));
  if (snapshot.fallback)
    connections.push({
      id: 'dsh:fallback',
      name: snapshot.fallback.model,
      providerId: snapshot.fallback.provider,
      modelId: snapshot.fallback.model,
        status: 'ready',
      contextWindow: snapshot.fallback.contextWindow ?? 32768,
      maxTokens: snapshot.fallback.maxTokens,
      reasoningEffort: snapshot.fallback.reasoningEffort ?? null,
      revision: JSON.stringify(snapshot.fallback),
      source: snapshot.fallback.source,
    });
  return {
    version: 1,
    connections,
    defaultConnectionId: 'dsh:single',
    overrides: Object.fromEntries(TASKS.map(({ id }) => [id, `dsh:${id}`])),
    fallback: {
      enabled: !!snapshot.fallback,
      connectionId: snapshot.fallback ? 'dsh:fallback' : null,
    },
    dsh: {
      protocol: PROTOCOL,
      runtimeId: snapshot.runtimeId,
      sessionId: snapshot.sessionId,
      selections: snapshot.selections,
    },
  };
}
export class DshModelService {
  constructor({ socketPath, directory }) {
    this.mode = 'dsh';
    this.supportsAgents = true;
    this.managesConcurrency = true;
    this.socketPath = socketPath;
    this.directory = directory;
    this.routes = upgradeRoutes(emptyRoutes());
    this.context = new AsyncLocalStorage();
    this.base = null;
    this.admission = new PriorityAdmission({ limit: () => this.concurrency });
    this.jobs = new Set();
    this.shutdown = new AbortController();
    this.runs = [];
    this.agentClient = new AgentClient(this);
    this.concurrencyListeners = new Set();
    this.write = Promise.resolve();
    const self = this;
    this.store = {
      state: {
        get settings() {
          const settings = self.context.getStore()?.settings ?? self.base;
          if (!settings)
            throw new BridgeError(
              'dsh_unavailable',
              '请启动 DSH 并启用 PaperRadar 插件后再发起分析。',
              false,
              503,
            );
          return settings;
        },
      },
    };
  }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(
        await readFile(join(this.directory, 'routes.json'), 'utf8'),
      );
      this.routes = upgradeRoutes(saved);
      if (!validConcurrency(this.routes.concurrency))
        throw new BridgeError(
          'invalid_settings',
          `并行处理数量必须为 1–${MAX_CONCURRENCY} 的整数。`,
        );
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await this.refresh().catch(() => {});
    return this;
  }
  call(path, input, options = {}) {
    return bridgeRequest(this.socketPath, path, input, options);
  }
  get concurrency() {
    return this.routes.concurrency;
  }
  onConcurrencyChange(listener) {
    this.concurrencyListeners.add(listener);
    return () => this.concurrencyListeners.delete(listener);
  }
  async refresh(context = {}) {
    const snapshot = await this.call('/snapshot', {
      routes: this.routes,
      ...context,
    });
    if (snapshot.protocol !== PROTOCOL)
      throw new BridgeError('protocol_error', 'DSH 插件版本不兼容。');
    const settings = settingsFrom(snapshot);
    if (!context.sessionId && !context.explicit && !context.parent)
      this.base = settings;
    return settings;
  }
  async withContext(context, operation) {
    const settings = await this.refresh(context);
    return this.context.run(
      { settings, explicit: context.explicit },
      operation,
    );
  }
  async withRequest(req, operation) {
    const path = req.url.split('?')[0];
    const modelRequest =
      req.method === 'POST' &&
      ([
        '/api/analyses',
        '/api/daily-runs',
      ].includes(path) ||
        /^\/api\/(daily-items\/[^/]+\/analyze|discussions\/[^/]+\/messages|schedule-updates\/[^/]+\/process|prompts\/v1\/.*experiments)$/.test(
          path,
        ));
    if (!modelRequest) return operation();
    return this.withContext(
      {
        parent:
          path === '/api/analyses' || path.endsWith('/analyze')
            ? 'single'
            : undefined,
      },
      operation,
    );
  }
  async config() {
    let catalog, error;
    try {
      catalog = await this.call('/catalog', {});
    } catch (e) {
      error = { code: e.code, message: e.message };
    }
    // The existing prompt workbench consumes this credential-free settings shape.
    return {
      mode: 'dsh',
      capabilities: this.capabilities,
      connected: !!catalog,
      catalog: catalog ?? null,
      error: error ?? null,
      settings: this.base
        ? structuredClone(this.base)
        : {
            connections: [],
                    overrides: {},
            fallback: { enabled: false },
          },
      tasks: TASKS,
      routing: structuredClone(this.routes),
      runs: this.runs.slice(-20).reverse(),
    };
  }
  async routing(raw) {
    const work = this.write
      .catch(() => {})
      .then(async () => {
        if (raw.revision !== this.routes.revision)
          throw new BridgeError(
            'conflict',
            '任务设置已改变，请刷新后重试。',
            false,
            409,
          );
        if (
          !raw.tasks ||
          Object.keys(raw.tasks).some(
            (key) => !TASKS.some(({ id }) => id === key),
          )
        )
          throw new BridgeError('invalid_settings', '任务设置无效。');
        const concurrency =
          raw.concurrency === undefined ? this.concurrency : raw.concurrency;
        if (!validConcurrency(concurrency))
          throw new BridgeError(
            'invalid_settings',
            `并行处理数量必须为 1–${MAX_CONCURRENCY} 的整数。`,
          );
        let next = {
          revision: this.routes.revision + 1,
          concurrency,
          tasks: Object.fromEntries(
            TASKS.map(({ id }) => [id, validateChoice(raw.tasks[id])]),
          ),
          fallback: {
            enabled: raw.fallback?.enabled === true,
            ...validateChoice({
              model: raw.fallback?.model,
              reasoningEffort: raw.fallback?.reasoningEffort,
            }),
          },
        };
        if (raw.version !== undefined && raw.version !== 2)
          throw new BridgeError('invalid_settings', '设置版本无效。');
        if (raw.version === 2) {
          if (
            !raw.presets ||
            Object.keys(raw.presets).length !== 2 ||
            !raw.presets.fast ||
            !raw.presets.deep ||
            !raw.assignments ||
            Object.keys(raw.assignments).length !== HOST_TASKS.length ||
            HOST_TASKS.some(
              (task) =>
                !['fast', 'deep', 'custom'].includes(raw.assignments[task]),
            )
          )
            throw new BridgeError('invalid_settings', '模型方案设置无效。');
          next = materializeRoutes({
            ...next,
            version: 2,
            presets: {
              fast: validateChoice(raw.presets.fast),
              deep: validateChoice(raw.presets.deep),
            },
            assignments: { ...raw.assignments },
          });
        } else next = upgradeRoutes(next);
        if (next.fallback.enabled && !next.fallback.model)
          throw new BridgeError(
            'invalid_settings',
            '启用备用策略前请选择宿主模型。',
          );
        // Validate every combination at the host before persisting a preference.
        // Also validate unused presets so a later task assignment cannot activate a broken choice.
        const defaults = (await this.call('/catalog', {})).defaults;
        for (const choice of Object.values(next.presets)) {
          await this.call('/resolve', {
            ...(choice.model ?? defaults),
            ...(choice.reasoningEffort
              ? { reasoningEffort: choice.reasoningEffort }
              : {}),
          });
        }
        const resolved = await this.call('/snapshot', { routes: next });
        const file = join(this.directory, 'routes.json'),
          temp = `${file}.${randomUUID()}.tmp`;
        await writeFile(temp, JSON.stringify(next, null, 2) + '\n', {
          mode: 0o600,
        });
        await rename(temp, file);
        this.routes = next;
        this.base = settingsFrom(resolved);
        this.drain();
        for (const listener of this.concurrencyListeners) listener();
      });
    this.write = work;
    await work;
    return this.config();
  }
  run(request, options = {}) {
    const work = this.runTask(request, { ...options, priority: options.priority ?? taskPriority() });
    this.jobs.add(work);
    work.then(
      () => this.jobs.delete(work),
      () => this.jobs.delete(work),
    );
    return work;
  }
  async runTask(request, options = {}) {
    this.shutdown.signal.throwIfAborted();
    const settings = requireHostSettings(options.settings ?? this.store.state.settings);
    if (settings.dsh?.protocol !== PROTOCOL)
      throw new BridgeError(
        'legacy_model_snapshot',
        '此旧任务使用独立模型配置，请保留历史并明确重新发起 DSH 任务。',
      );
    const task = request.task ?? 'summary';
    const c = request.connectionId
      ? settings.connections.find((x) => x.id === request.connectionId)
      : resolveConnection(settings, task);
    if (!c)
      throw new BridgeError(
        'not_configured',
        '未找到该任务引用的 DSH 模型。',
      );
    const release = await this.acquire(
      AbortSignal.any([
        this.shutdown.signal,
        ...(options.signal ? [options.signal] : []),
      ]),
      options.priority,
    );
    try {
      try {
        return await this.runConnection(c, request, options, settings);
      } catch (e) {
        const fallback = settings.fallback.enabled
          ? settings.connections.find(
              (x) => x.id === settings.fallback.connectionId && x.id !== c.id,
            )
          : null;
        if (
          request.experiment ||
          !fallback ||
          !['RATE_LIMIT', 'PROVIDER_ERROR', 'rate_limited'].includes(e.code)
        )
          throw e;
        return {
          ...(await this.runConnection(fallback, request, options, settings)),
          fallbackFrom: c.id,
        };
      }
    } finally {
      release();
    }
  }
  get running() { return this.admission.running; }
  get waiters() { return this.admission.waiters; }
  get capabilities() { return hostCapabilities(this.mode, { concurrency: this.concurrency }); }
  executionPoolForSettings() { return this.mode; }
  capabilitiesForSettings() { return this.capabilities; }
  acquire(signal, priority = taskPriority()) { return this.admission.acquire(signal, priority); }
  drain() { this.admission.drain(); }

  runAgent(request, options = {}) {
    const work = this.runAgentTask(request, { ...options, priority: options.priority ?? taskPriority() });
    this.jobs.add(work);
    work.then(
      () => this.jobs.delete(work),
      () => this.jobs.delete(work),
    );
    return work;
  }
  async runAgentTask(request, options) {
    this.shutdown.signal.throwIfAborted();
    const settings = requireHostSettings(options.settings ?? this.store.state.settings);
    if (settings.dsh?.protocol !== PROTOCOL)
      throw new BridgeError(
        'legacy_model_snapshot',
        '请按当前宿主设置重新创建 Agent 任务。',
      );
    const c = request.connectionId
      ? settings.connections.find((x) => x.id === request.connectionId)
      : resolveConnection(settings, request.task ?? 'screen');
    if (!c)
      throw new BridgeError(
        'not_configured',
        '请在 DSH 中配置该任务使用的模型。',
      );
    try {
      return await this.agentClient.run(request, { ...options, settings }, c);
    } catch (e) {
      const fallback = settings.fallback?.enabled
        ? settings.connections.find(
            (x) => x.id === settings.fallback.connectionId && x.id !== c.id,
          )
        : null;
      if (
        request.experiment ||
        !fallback ||
        !['RATE_LIMIT', 'PROVIDER_ERROR', 'rate_limited'].includes(e.code)
      )
        throw e;
      options.onRestart?.();
      return {
        ...(await this.agentClient.run(
          request,
          { ...options, settings },
          fallback,
        )),
        fallbackFrom: c.id,
      };
    }
  }
  async runConnection(c, request, options, settings) {
    const id = randomUUID(),
      started = Date.now(),
      signal = AbortSignal.any([
        this.shutdown.signal,
        ...(options.signal ? [options.signal] : []),
      ]);
    let result,
      failure,
      attempted = false;
    try {
      signal.throwIfAborted();
      const selection = {
        provider: c.providerId,
        model: c.modelId,
        ...(c.reasoningEffort ? { reasoningEffort: c.reasoningEffort } : {}),
      };
      const resolved = await this.call('/resolve', selection, { signal });
      if ((resolved.reasoningEffort ?? null) !== (c.reasoningEffort ?? null))
        throw new BridgeError(
          'model_changed',
          '宿主默认思考强度已变化，请明确重新发起任务。',
        );
      const current = {
        ...c,
        contextWindow: resolved.contextWindow ?? c.contextWindow,
        maxTokens: resolved.maxTokens,
      };
      await options.beforeAttempt?.(current, {
        id,
        attempt_unit: 'model-attempt',
        started_at: new Date(started).toISOString(),
      });
      signal.throwIfAborted();
      attempted = true;
      result = await this.call(
        '/generate',
        {
          id,
          selection,
          prompt: request.prompt ?? 'Reply with exactly OK.',
          systemPrompt: request.systemPrompt ?? '',
          maxTokens: Math.min(request.maxTokens ?? 8192, current.maxTokens),
          sessionId: settings.dsh.sessionId,
          businessTask: request.businessTask ?? request.task,
        },
        { signal, timeout: 180000 },
      );
      signal.throwIfAborted();
      return { ...result, connectionId: c.id };
    } catch (e) {
      failure = e;
      throw e;
    } finally {
      if (attempted) {
        const attempt = {
          id,
          attempt_unit: 'model-attempt',
          request_id: id,
          task: request.task,
          provider_id: c.providerId,
          model_id: c.modelId,
          reasoning_effort: c.reasoningEffort,
          connection_id: c.id,
          runtime_id: result?.runtimeId ?? settings.dsh.runtimeId,
          session_id: settings.dsh.sessionId,
          started_at: new Date(started).toISOString(),
          duration_ms: Date.now() - started,
          status: failure?.code ?? 'succeeded',
          usage: result?.usage ?? null,
        };
        options.onAttempt?.(attempt);
        this.runs.push({
          ...attempt,
          connectionName: c.name,
          modelId: c.modelId,
          at: attempt.started_at,
          durationMs: attempt.duration_ms,
        });
        this.runs = this.runs.slice(-100);
      }
    }
  }
  async close() {
    this.shutdown.abort();
    await Promise.allSettled(this.jobs);
    await this.agentClient.close();
    await this.write.catch(() => {});
  }
}
