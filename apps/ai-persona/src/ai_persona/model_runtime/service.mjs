// Adapted from paper-radar's Pi model service; independent AI Persona configuration.
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  PROVIDERS,
  TASKS,
  REQUEST_TASKS,
  taskGroup,
  groupedRoutes,
  validateConnection,
  publicConnection,
  hydrateModelSettings,
  withoutConnection,
  resolveConnection,
} from './model-config.ts';
import {
  PiEngine,
  ModelError,
  normalizeError,
  providerCatalog,
} from './engine.mjs';

export const REQUEST_BUDGETS = {
  activation: { attempt: 15000, total: 15000 },
  test: { attempt: 30000, total: 30000 },
  // Foreground analysis can spend several minutes reasoning over a long source.
  // Keep the total below the Python bridge's 510-second transport timeout.
  maintenance: { attempt: 420000, total: 480000 },
  material: { attempt: 420000, total: 480000 },
  conversation_signal: { attempt: 45000, total: 60000 },
  conversation_candidate: { attempt: 120000, total: 180000 },
  conversation_learning: { attempt: 120000, total: 180000 },
};

export class ModelService {
  constructor(store, engine = new PiEngine(store)) {
    this.store = store;
    this.engine = engine;
    this.logins = new Map();
    this.running = 0;
    this.jobs = new Set();
    this.shutdown = new AbortController();
    this.activeRuns = new Map();
    this.budgets = REQUEST_BUDGETS;
  }
  config() {
    return {
      mode: 'local',
      capabilities: { promptExperiments: 1, evaluationReasoning: 1, persistentReasoning: 1, reasoningTests: 1 },
      settings: {
        ...this.store.state.settings,
        connections: this.store.state.settings.connections.map((c) => ({
          ...publicConnection(c),
          revision: c.revision,
          hasCredential: !!this.store.state.credentials[c.id],
        })),
      },
      providers: providerCatalog(),
      tasks: TASKS,
      taskRoutes: groupedRoutes(this.store.state.settings),
      runs: this.store.state.runs.slice(-20).reverse(),
    };
  }
  connection(id) {
    const c = this.store.state.settings.connections.find((c) => c.id === id);
    if (!c) throw new ModelError('not_found', '连接不存在');
    return structuredClone(c);
  }
  selectModel(connection, modelId = connection.modelId) {
    if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 200)
      throw new ModelError('invalid_model', '请选择或填写模型 ID');
    modelId = modelId.trim();
    if (connection.providerId === 'custom') return { ...connection, modelId,
      input: connection.imageModelIds?.includes(modelId) ? ['text', 'image'] : ['text'] };
    const model = providerCatalog().find(p => p.id === connection.providerId)
      ?.models.find(m => m.id === modelId);
    if (!model) throw new ModelError('invalid_model', '该模型不在此平台的目录中，请重新选择模型');
    return { ...connection, modelId, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens };
  }
  async saveConnection(raw) {
    // A connection identifies an account/endpoint. Model selection lives in task routes.
    // Keep the legacy model as its default so existing routes and clients continue to work.
    if (raw && raw.providerId !== 'custom') {
      const previous = this.store.state.settings.connections.find(c => c.id === raw.id);
      const catalog = providerCatalog().find(p => p.id === raw.providerId)?.models ?? [];
      const modelId = raw.modelId ?? (previous?.providerId === raw.providerId ? previous.modelId : catalog[0]?.id);
      const model = catalog.find(m => m.id === modelId);
      raw = { ...raw, modelId, contextWindow: model?.contextWindow, maxTokens: model?.maxTokens };
    }
    const message = validateConnection(raw);
    if (message) throw new ModelError('invalid_request', message);
    if (
      raw.apiKey !== undefined &&
      (typeof raw.apiKey !== 'string' ||
        raw.apiKey.length > 16000 ||
        /[\r\n]/.test(raw.apiKey))
    )
      throw new ModelError('invalid_request', '密钥格式无效');
    const c = publicConnection(raw);
    if (
      c.providerId !== 'custom' &&
      !providerCatalog()
        .find((p) => p.id === c.providerId)
        ?.models.some((m) => m.id === c.modelId)
    )
      throw new ModelError(
        'invalid_model',
        '请选择目录中的模型，或使用自定义兼容服务',
      );
    this.cancelFor(c.id);
    await this.store.transaction((s) => {
      const previous = s.settings.connections.find((x) => x.id === c.id);
      c.revision = randomUUID();
      if (!previous && s.settings.connections.length >= 30)
        throw new ModelError('invalid_request', '最多保存 30 个连接');
      const changedService = previous &&
        (previous.providerId !== c.providerId ||
          previous.authType !== c.authType ||
          previous.baseUrl !== c.baseUrl || previous.api !== c.api);
      if (changedService) {
        delete s.credentials[c.id];
        if (s.settings.defaultConnectionId === c.id) s.settings.defaultModelId = null;
        for (const task of REQUEST_TASKS)
          if (s.settings.overrides[task] === c.id) s.settings.overrideModelIds[task] = null;
        if (s.settings.fallback.connectionId === c.id) delete s.settings.fallback.modelId;
      }
      if (c.authType === 'api_key' && raw.apiKey?.trim())
        s.credentials[c.id] = { type: 'api_key', key: raw.apiKey.trim() };
      if (c.authType === 'none') delete s.credentials[c.id];
      c.status =
        c.authType === 'none' || s.credentials[c.id]
          ? 'untested'
          : 'auth_required';
      delete c.checkedAt;
      s.settings.connections = previous
        ? s.settings.connections.map((x) => (x.id === c.id ? c : x))
        : [...s.settings.connections, c];
      if (!s.settings.defaultConnectionId)
        s.settings.defaultConnectionId = c.id;
    });
    return this.config();
  }
  async remove(id) {
    this.connection(id);
    this.cancelFor(id);
    await this.store.transaction((s) => {
      const connections = s.settings.connections.filter((c) => c.id !== id);
      s.settings = { ...withoutConnection(s.settings, id), connections };
      delete s.credentials[id];
    });
    return this.config();
  }
  async disconnect(id) {
    this.connection(id);
    this.cancelFor(id);
    await this.store.transaction((s) => {
      delete s.credentials[id];
      const c = s.settings.connections.find((c) => c.id === id);
      c.revision = randomUUID();
      c.status = c.authType === 'none' ? 'untested' : 'auth_required';
      delete c.checkedAt;
    });
    return this.config();
  }
  async routing(raw) {
    await this.store.transaction((s) => {
      // Preserve old stage selections as dormant compatibility data after consolidation.
      const dormant = raw.routingVersion === 3 ? ['material', 'conversation_candidate'] :
        raw.routingVersion === 2 ? ['material', 'conversation_signal', 'conversation_candidate'] : [];
      raw = { ...raw,
        overrides: { ...Object.fromEntries(dormant.map(t => [t, s.settings.overrides[t]])), ...raw.overrides },
        overrideModelIds: { ...Object.fromEntries(dormant.map(t => [t, s.settings.overrideModelIds[t]])), ...raw.overrideModelIds } };
      const ids = new Set(s.settings.connections.map((c) => c.id));
      const values = [
        raw.defaultConnectionId,
        ...REQUEST_TASKS.map((t) => raw.overrides?.[t]),
        raw.fallback?.connectionId,
      ];
      if (values.some((id) => id != null && !ids.has(id)))
        throw new ModelError('invalid_request', '任务配置引用了不存在的连接');
      if (raw.fallback?.enabled && !raw.fallback.connectionId)
        throw new ModelError('invalid_request', '请先选择备用连接');
      const settings = hydrateModelSettings({
        ...raw,
        connections: s.settings.connections,
      });
      if (!settings) throw new ModelError('invalid_request', '模型配置无效');
      const routes = [
        [raw.defaultConnectionId, raw.defaultModelId],
        ...(raw.routingVersion === 3 ? TASKS.map(t => t.id) : raw.routingVersion === 2 ?
          ['maintenance', 'conversation_learning', 'activation'] : REQUEST_TASKS).map(t => [raw.overrides?.[t], raw.overrideModelIds?.[t]]),
        [raw.fallback?.connectionId, raw.fallback?.modelId],
      ];
      for (const [id, modelId] of routes) {
        if (modelId != null && !id) throw new ModelError('invalid_request', '选择模型前请先选择账号连接');
        if (id && modelId != null)
          this.selectModel(s.settings.connections.find(c => c.id === id), modelId);
      }
      for (const task of REQUEST_TASKS) {
        const effort = settings.overrideReasoning?.[task];
        if (effort == null) continue;
        const c = resolveConnection(settings, task);
        const levels = providerCatalog().find(p => p.id === c?.providerId)?.models.find(m => m.id === c?.modelId)?.reasoningLevels ?? [];
        if (!levels.includes(effort)) throw new ModelError('invalid_reasoning', '所选任务模型不支持保存的思考强度');
      }
      s.settings = { ...settings, connections: s.settings.connections };
    });
    return this.config();
  }
  async status(connection, code) {
    await this.store.transaction((s) => {
      const c = s.settings.connections.find((c) => c.id === connection.id);
      if (
        !c ||
        c.revision !== connection.revision ||
        c.modelId !== connection.modelId ||
        c.authType !== connection.authType ||
        c.baseUrl !== connection.baseUrl
      )
        return;
      c.status = [
        'ready',
        'auth_required',
        'rate_limited',
        'quota_exceeded',
      ].includes(code)
        ? code
        : 'error';
      c.checkedAt = new Date().toISOString();
    });
  }
  checkReasoning(c, reasoning) {
    if (reasoning == null) return;
    const levels = providerCatalog().find(p => p.id === c.providerId)?.models.find(m => m.id === c.modelId)?.reasoningLevels ?? [];
    if (typeof reasoning !== 'string' || !levels.includes(reasoning))
      throw new ModelError('invalid_reasoning', '当前模型不支持所选思考强度，请重新选择');
  }
  async runConnection(c, request) {
    const started = Date.now(),
      id = randomUUID();
    const metrics = {
      requestId: id, runId: request.runId ?? null, connectionId: c.id, connectionRevision: c.revision,
      modelId: c.modelId, stage: request.stage ?? request.task,
      startedAt: new Date(started).toISOString(), inputChars: request.prompt.length + (request.systemPrompt?.length ?? 0),
      maxTokens: request.maxTokens, attempts: 0, firstEventMs: null, firstContentMs: null,
      lastContentMs: null, attemptTimeoutMs: null,
      firstThinkingMs: null, firstTextMs: null, lastEventMs: null, terminalEventMs: null,
      textChars: 0, thinkingChars: 0, eventCounts: {}, providerOutputLimit: null,
      reasoning: request.reasoning ?? null,
      phase: 'waiting',
    };
    if (request.runId) this.activeRuns.set(request.runId, metrics);
    let output, failure;
    try {
      this.checkReasoning(c, request.reasoning);
      if (c.authType !== 'none' && !this.store.state.credentials[c.id])
        throw new ModelError('auth_required', '请先填写密钥或完成账号授权');
      if (request.messages?.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image')) && !c.input?.includes('image'))
        throw new ModelError('unsupported_image', '当前模型未配置图片支持，请在模型设置中选择支持图片的模型或声明自定义模型的图片能力。');
      const attempts = request.experimentSelection || request.task === 'activation' ? 1 : 2;
      for (let attempt = 0; attempt < attempts; attempt++) {
        let timer, abort;
        const controller = new AbortController();
        const signal = AbortSignal.any([
          controller.signal, this.shutdown.signal, ...(request.signal ? [request.signal] : []),
        ]);
        try {
          request.signal?.throwIfAborted();
          metrics.attempts++;
          const remaining = request.deadline - Date.now();
          if (remaining <= 0) throw new ModelError('timeout', '本次模型请求已达到总时间预算，可继续分析');
          metrics.attemptTimeoutMs = Math.min(this.budgets[request.task].attempt, remaining);
          const timeoutError = () => new ModelError('timeout',
            `模型在 ${Math.round(metrics.attemptTimeoutMs / 1000)} 秒内未完成本阶段${metrics.firstContentMs === null ? '，尚未收到模型内容' : '，已收到部分内容但尚未形成完整结果'}。`);
          timer = setTimeout(() => controller.abort(), metrics.attemptTimeoutMs);
          const expired = new Promise((_, reject) => {
            abort = () => reject(request.signal?.aborted || this.shutdown.signal.aborted
              ? new ModelError('cancelled', '请求已取消') : timeoutError());
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
          output = await Promise.race([this.engine.generate(c, {
            ...request,
            signal,
            onEvent: (type, detail = {}) => {
              if (signal.aborted || metrics.phase === 'finished') return;
              if (type === 'request_prepared') {
                metrics.providerOutputLimit = Number.isSafeInteger(detail.outputLimit) ? detail.outputLimit : null;
                return;
              }
              if (!['start', 'text_start', 'text_delta', 'text_end', 'thinking_start', 'thinking_delta', 'thinking_end', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done', 'error'].includes(type)) return;
              const elapsed = Date.now() - started;
              metrics.lastEventMs = elapsed;
              metrics.lastEventType = type;
              metrics.eventCounts[type] = (metrics.eventCounts[type] ?? 0) + 1;
              if (type === 'done' || type === 'error') metrics.terminalEventMs = elapsed;
              if (type === 'thinking_delta') {
                metrics.firstThinkingMs ??= elapsed;
                metrics.thinkingChars += Math.max(0, Number.isSafeInteger(detail.chars) ? detail.chars : 0);
              }
              if (type === 'text_delta') {
                metrics.firstTextMs ??= elapsed;
                metrics.textChars += Math.max(0, Number.isSafeInteger(detail.chars) ? detail.chars : 0);
              }
              metrics.firstEventMs ??= Date.now() - started;
              if (['text_delta', 'thinking_delta', 'toolcall_delta'].includes(type)) {
                metrics.firstContentMs ??= Date.now() - started;
                metrics.lastContentMs = Date.now() - started;
                metrics.phase = 'receiving';
              }
            },
          }), expired]);
          break;
        } catch (e) {
          if (request.signal?.aborted || this.shutdown.signal.aborted) throw new ModelError('cancelled', '请求已取消');
          const err = controller.signal.aborted
            ? new ModelError('timeout', `模型在 ${Math.round(metrics.attemptTimeoutMs / 1000)} 秒内未完成本阶段${metrics.firstContentMs === null ? '，尚未收到模型内容' : '，已收到部分内容但尚未形成完整结果'}。`) : normalizeError(e);
          if (!['rate_limited', 'connection_error'].includes(err.code) ||
              metrics.firstContentMs !== null || attempt === attempts - 1 || request.deadline - Date.now() < 2000) throw err;
          metrics.phase = 'retrying';
          await delay(1500, undefined, { signal: AbortSignal.any([
            this.shutdown.signal, ...(request.signal ? [request.signal] : []),
          ]) });
        } finally {
          clearTimeout(timer);
          if (abort) signal.removeEventListener('abort', abort);
        }
      }
      await this.status(c, 'ready');
      return { ...output, ...metrics, durationMs: Date.now() - started, phase: 'finished' };
    } catch (e) {
      failure = normalizeError(e);
      failure.modelRun = { ...metrics, durationMs: Date.now() - started, status: failure.code };
      await this.status(c, failure.code);
      throw failure;
    } finally {
      metrics.phase = 'finished';
      if (request.runId) this.activeRuns.delete(request.runId);
      await this.store.transaction((s) => {
        s.runs.push({
          id,
          ...metrics,
          connectionId: c.id,
          connectionName: c.name,
          modelId: c.modelId,
          task: request.task ?? 'test',
          taskGroup: request.task === 'test' ? 'test' : taskGroup(request.task),
          stage: request.stage ?? null,
          at: new Date().toISOString(),
          durationMs: Date.now() - started,
          status: failure?.code ?? 'succeeded',
          usage: output?.usage ?? null,
          reasoningEffort: output?.reasoningEffort ?? null,
        });
        s.runs = s.runs.slice(-100);
      });
    }
  }
  run(request) {
    const job = this.runTask(request);
    this.jobs.add(job);
    const done = () => this.jobs.delete(job);
    job.then(done, done);
    return job;
  }
  async runTask(request) {
    this.shutdown.signal.throwIfAborted();
    if (this.running >= 2)
      throw new ModelError(
        'rate_limited',
        '已有两个模型请求运行中，请稍后再试',
        true,
      );
    this.running++;
    try {
      if (request.connectionId) {
        const selected = this.selectModel(this.connection(request.connectionId), request.modelId);
        this.checkReasoning(selected, request.reasoning);
        return await this.runConnection(selected, {
          prompt: 'Reply with exactly the word OK.',
          maxTokens: 1024,
          task: 'test',
          reasoning: request.reasoning,
          signal: request.signal,
          deadline: Date.now() + this.budgets.test.total,
        });
      }
      if (
        !REQUEST_TASKS.includes(request.task) ||
        typeof request.prompt !== 'string' ||
        !request.prompt.trim() ||
        request.prompt.length > 300000
      )
        throw new ModelError(
          'invalid_request',
          '请选择任务并提供不超过 300000 字符的输入',
        );
      if (
        request.systemPrompt !== undefined &&
        (typeof request.systemPrompt !== 'string' ||
          request.systemPrompt.length > 10000)
      )
        throw new ModelError('invalid_request', '系统提示过长');
      if (request.stage !== undefined && (typeof request.stage !== 'string' || request.stage.length > 80))
        throw new ModelError('invalid_request', '阶段标识无效');
      if (request.messages !== undefined && (!Array.isArray(request.messages) ||
          request.messages.length > 160 || JSON.stringify(request.messages).length > 300000 ||
          request.messages.some(m => !m || !['user', 'assistant', 'toolResult'].includes(m.role))))
        throw new ModelError('invalid_request', '工具对话格式或长度无效');
      if (request.tools !== undefined && (!Array.isArray(request.tools) || request.tools.length > 20 ||
          JSON.stringify(request.tools).length > 100000 || request.tools.some(t =>
            !t || typeof t.name !== 'string' || typeof t.description !== 'string' ||
            !t.parameters || t.parameters.type !== 'object')))
        throw new ModelError('invalid_request', '工具定义格式或长度无效');
      if (
        request.maxTokens !== undefined &&
        (!Number.isInteger(request.maxTokens) ||
          request.maxTokens < 128 ||
          request.maxTokens > 64000)
      )
        throw new ModelError(
          'invalid_request',
          '输出上限应为 128–64000 的整数',
        );
      const settings = structuredClone(this.store.state.settings);
      let selected = resolveConnection(settings, request.task);
      if (request.experimentSelection) {
        const x = request.experimentSelection;
        const original = this.connection(x.connectionId);
        if (!x.revision || original.revision !== x.revision) throw new ModelError('connection_changed', '实验模型连接已改变，请重新开始实验');
        selected = this.selectModel(original, x.modelId);
        settings.fallback.enabled = false;
      }
      if (!selected)
        throw new ModelError('not_configured', '尚未选择该任务使用的模型');
      const c = this.selectModel(selected);
      if (!request.experimentSelection && request.reasoning === undefined) {
        const task = settings.routingVersion >= 2 ? taskGroup(request.task, settings.routingVersion) : request.task;
        request = { ...request, reasoning: settings.overrideReasoning?.[task] ?? undefined };
      }
      this.checkReasoning(c, request.reasoning);
      if (request.experimentSelection && Math.ceil(Buffer.byteLength((request.systemPrompt ?? '') + request.prompt) / 2) + Math.min(c.maxTokens, request.maxTokens ?? 4096) + 2000 > c.contextWindow) throw new ModelError('context_length', '实验输入超过当前模型容量');
      if (request.deadline !== undefined && (!Number.isSafeInteger(request.deadline) || request.deadline <= 0))
        throw new ModelError('invalid_request', '请求截止时间无效');
      if (request.task === 'activation') settings.fallback.enabled = false;
      request = { ...request, deadline: Math.min(
        request.deadline ?? Infinity, Date.now() + this.budgets[request.task].total,
      ) };
      try {
        return await this.runConnection(c, request);
      } catch (e) {
        if (request.signal?.aborted) throw new ModelError('cancelled', '请求已取消');
        const fallbackConnection = settings.fallback.enabled
          ? settings.connections.find(
              (x) => x.id === settings.fallback.connectionId,
            )
          : null;
        const alternate = fallbackConnection
          ? this.selectModel(fallbackConnection, settings.fallback.modelId) : null;
        if (
          !alternate || (alternate.id === c.id && alternate.modelId === c.modelId) ||
          ![
            'rate_limited',
            'quota_exceeded',
            'provider_error',
            'connection_error',
            'timeout',
          ].includes(e.code) || request.deadline - Date.now() < 1000
        )
          throw e;
        return {
          ...(await this.runConnection(alternate, request)),
          fallbackFrom: c.id,
        };
      }
    } finally {
      this.running--;
    }
  }
  startLogin(id) {
    const c = this.connection(id);
    if (
      c.authType !== 'oauth' ||
      !PROVIDERS.find((p) => p.id === c.providerId)?.auth.includes('oauth')
    )
      throw new ModelError('invalid_request', '该连接不支持账号授权');
    const active = this.activeLogin();
    // Starting twice (or reopening the page) resumes the same login, not a new flow.
    if (active?.connectionId === id) return active;
    if (active)
      throw new ModelError('login_busy', '请先完成或取消当前授权');
    const session = {
      id: randomUUID(),
      connectionId: id,
      status: 'pending',
      events: [],
      prompt: null,
      controller: new AbortController(),
    };
    this.logins.set(session.id, session);
    const expiry = setTimeout(() => {
      session.controller.abort();
      this.logins.delete(session.id);
    }, 15 * 60000);
    expiry.unref();
    const work = async () => {
      try {
        await this.engine.login(c, {
          signal: session.controller.signal,
          notify: (event) => {
            session.events.push(event);
            session.events = session.events.slice(-8);
          },
          prompt: (prompt) =>
            new Promise((resolve, reject) => {
              const promptId = randomUUID();
              session.prompt = { ...prompt, signal: undefined, id: promptId };
              const abort = () => {
                if (session.prompt?.id === promptId) {
                  session.prompt = null;
                  session.answer = null;
                }
                cleanup();
                reject(new Error('aborted'));
              };
              const cleanup = () => {
                prompt.signal?.removeEventListener('abort', abort);
                session.controller.signal.removeEventListener('abort', abort);
              };
              session.answer = (value, answerId) => {
                if (answerId !== promptId)
                  throw new ModelError(
                    'stale_prompt',
                    '授权步骤已变化，请刷新后重试',
                  );
                cleanup();
                session.prompt = null;
                session.answer = null;
                resolve(value);
              };
              if (prompt.signal?.aborted || session.controller.signal.aborted)
                abort();
              else {
                prompt.signal?.addEventListener('abort', abort, { once: true });
                session.controller.signal.addEventListener('abort', abort, {
                  once: true,
                });
              }
            }),
        });
        session.controller.signal.throwIfAborted();
        session.status = 'succeeded';
        await this.store.transaction((s) => {
          const current = s.settings.connections.find((x) => x.id === id);
          if (current?.revision === c.revision) {
            // Explicit reauthorization must invalidate tests for the old account.
            current.revision = randomUUID();
            current.status = 'untested';
            delete current.checkedAt;
          }
        });
      } catch (e) {
        session.status = session.controller.signal.aborted
          ? 'cancelled'
          : 'failed';
        const failure = normalizeError(e);
        session.error = failure.message;
        session.errorCode = failure.code;
      } finally {
        session.prompt = null;
        session.answer = null;
      }
    };
    session.work = work();
    return this.loginState(session.id);
  }
  loginState(id) {
    const s = this.logins.get(id);
    if (!s) throw new ModelError('not_found', '授权已过期，请重新开始');
    return {
      id: s.id,
      connectionId: s.connectionId,
      status: s.status,
      events: s.events,
      prompt: s.prompt,
      error: s.error,
      errorCode: s.errorCode,
    };
  }
  activeLogin() {
    const active = [...this.logins.values()].find(
      (s) => s.status === 'pending' && !s.controller.signal.aborted,
    );
    return active ? this.loginState(active.id) : null;
  }
  answerLogin(id, input) {
    const s = this.logins.get(id);
    if (
      !s?.answer || s.status !== 'pending' || s.controller.signal.aborted ||
      typeof input.answer !== 'string' ||
      input.answer.length > 16000
    )
      throw new ModelError('invalid_request', '当前没有需要填写的授权步骤');
    if (input.promptId !== s.prompt?.id)
      throw new ModelError('stale_prompt', '授权步骤已变化，请刷新后重试');
    if (s.prompt.type === 'select' &&
        !s.prompt.options.some((option) => option.id === input.answer))
      throw new ModelError('invalid_request', '请选择列表中的授权方式');
    s.answer(input.answer, input.promptId);
    return { ok: true };
  }
  cancelFor(id) {
    for (const s of this.logins.values())
      if (s.connectionId === id && s.status === 'pending') s.controller.abort();
  }
  cancelLogin(id) {
    const s = this.logins.get(id);
    if (s) s.controller.abort();
    return { ok: true };
  }
  async close() {
    this.shutdown.abort();
    for (const s of this.logins.values()) s.controller.abort();
    await Promise.allSettled([
      ...this.jobs,
      ...[...this.logins.values()].map((s) => s.work),
    ]);
  }
}
