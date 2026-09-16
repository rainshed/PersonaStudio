import { PriorityAdmission, waitForCompletion } from '../../agents/admission.mjs';
import { taskPriority } from '../../tasks/context.mjs';
import { hostCapabilities } from '../execution.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConnection } from '../../../lib/host-models.ts';
import { MAX_CONCURRENCY, validConcurrency } from '../../../lib/concurrency.ts';
import {
  HOST_TASKS,
  materializeRoutes,
  taskChoice,
  upgradeRoutes,
} from '../../../lib/host-settings.ts';
import {
  TASKS,
  emptyRoutes,
  validateChoice,
} from '@paper-radar/host-contract/routing';
import { BridgeError } from '../transport.mjs';
import { CodexAppServerClient } from './app-server.mjs';
import { CodexToolBridge } from './tool-bridge.mjs';
import { CODEX_BASE_INSTRUCTIONS, SUBMISSION_RECEIPT_SCHEMA, hostContext } from '@paper-radar/host-contract/context';

const RUNTIME_VERSION = 'paper-radar-codex/v1';
const taskServer = fileURLToPath(new URL('./tool-server.mjs', import.meta.url));
const disabledFeatures = [
  'hooks',
  'apps',
  'auth_elicitation',
  'goals',
  'memories',
  'multi_agent',
  'remote_plugin',
  'shell_tool',
  'unified_exec',
  'skill_mcp_dependency_install',
  'tool_suggest',
];
const fallbackCodes = new Set([
  'RATE_LIMIT',
  'rate_limited',
  'codex_rate_limited',
  'provider_error',
]);
const allowedItemTypes = new Set([
  'userMessage',
  'agentMessage',
  'reasoning',
  'plan',
  'contextCompaction',
  'mcpToolCall',
]);

function runtimeConfig() {
  return `approval_policy = "never"
sandbox_mode = "read-only"
web_search = "disabled"

[features]
hooks = false
apps = false
auth_elicitation = false
goals = false
memories = false
multi_agent = false
remote_plugin = false
shell_tool = false
unified_exec = false
skill_mcp_dependency_install = false
tool_suggest = false

[agents]
enabled = false

[tools]
view_image = false

[feedback]
enabled = false

[mcp_servers.ai-persona]
enabled = false
command = "/usr/bin/false"
`;
}

function modelRef(model) {
  return { provider: 'codex', model: model.model ?? model.id };
}

function catalogFrom(models) {
  const visible = models.filter((model) => !model.hidden);
  const selected = visible.find((model) => model.isDefault) ?? visible[0];
  if (!selected) return null;
  return {
    defaults: {
      ...modelRef(selected),
      reasoningEffort: selected.defaultReasoningEffort,
    },
    groups: [
      {
        id: 'codex',
        name: 'Codex',
        models: visible.map((model) => ({
          ...modelRef(model),
          name: model.displayName ?? model.model ?? model.id,
          reasoning: {
            efforts: (model.supportedReasoningEfforts ?? []).map((effort) => ({
              id: effort.reasoningEffort,
              name: effort.reasoningEffort,
            })),
            defaultEffort: model.defaultReasoningEffort,
          },
        })),
      },
    ],
    settingsUrl: null,
  };
}

function findCatalogModel(catalog, ref) {
  if (!ref) return null;
  return catalog?.groups
    .flatMap((group) => group.models)
    .find(
      (model) => model.provider === ref.provider && model.model === ref.model,
    );
}

function settingsFrom(routes, catalog, isolation) {
  const connections = [];
  const overrides = {};
  for (const { id } of TASKS) {
    const choice = taskChoice(routes, id);
    const selected = choice.model ?? catalog?.defaults ?? null;
    if (!selected) {
      overrides[id] = null;
      continue;
    }
    const found = findCatalogModel(catalog, selected);
    const effort =
      choice.reasoningEffort ??
      (choice.model
        ? found?.reasoning?.defaultEffort
        : catalog.defaults.reasoningEffort) ??
      null;
    const connection = {
      id: `codex:${id}`,
      name: `${TASKS.find((task) => task.id === id)?.name ?? id} · ${found?.name ?? selected.model}`,
      providerId: 'codex',
      modelId: selected.model,
        status: 'ready',
      contextWindow: 128000,
      maxTokens: 8192,
      reasoningEffort: effort,
      revision: JSON.stringify([selected.model, effort]),
      task: id,
    };
    connections.push(connection);
    overrides[id] = connection.id;
  }
  let fallback = { enabled: false, connectionId: null };
  if (routes.fallback.enabled && routes.fallback.model) {
    const ref = routes.fallback.model;
    const found = findCatalogModel(catalog, ref);
    const effort =
      routes.fallback.reasoningEffort ??
      found?.reasoning?.defaultEffort ??
      null;
    connections.push({
      id: 'codex:fallback',
      name: `${found?.name ?? ref.model} · 备用`,
      providerId: 'codex',
      modelId: ref.model,
        status: 'ready',
      contextWindow: 128000,
      maxTokens: 8192,
      reasoningEffort: effort,
      revision: JSON.stringify([ref.model, effort]),
      task: 'fallback',
    });
    fallback = { enabled: true, connectionId: 'codex:fallback' };
  }
  return {
    version: 1,
    connections,
    defaultConnectionId: overrides.single ?? overrides.summary ?? null,
    overrides,
    fallback,
    codex: {
      protocol: RUNTIME_VERSION,
      isolation,
    },
  };
}

function rpcFailure(turn) {
  const info = turn?.error?.codexErrorInfo;
  const sourceCode =
    typeof info === 'string'
      ? info
      : info && typeof info === 'object'
        ? (info.type ??
          info.kind ??
          info.code ??
          Object.keys(info).find((key) => key !== 'httpStatusCode'))
        : turn?.error?.code;
  const detail =
    info && typeof info === 'object' && sourceCode ? info[sourceCode] : null;
  const rawHttpStatus =
    (info && typeof info === 'object' ? info.httpStatusCode : null) ??
    (detail && typeof detail === 'object' ? detail.httpStatusCode : null);
  const httpStatus =
    rawHttpStatus == null || !Number.isFinite(Number(rawHttpStatus))
      ? null
      : Number(rawHttpStatus);
  let code = sourceCode ?? 'codex_failed';
  if (/usageLimitExceeded|rateLimitExceeded/i.test(code) || httpStatus === 429)
    code = 'rate_limited';
  else if (/Unauthorized/i.test(code) || httpStatus === 401)
    code = 'codex_auth_required';
  else if (/ContextWindowExceeded/i.test(code)) code = 'context_length';
  else if (
    /ResponseStreamConnectionFailed|ResponseStreamDisconnected|ResponseTooManyFailedAttempts|InternalServerError|ServerOverloaded/i.test(
      code,
    ) ||
    (/HttpConnectionFailed/i.test(code) &&
      (httpStatus == null || httpStatus >= 500)) ||
    (httpStatus != null && httpStatus >= 500)
  )
    code = 'provider_error';
  return new BridgeError(
    String(code),
    turn?.error?.message ?? 'Codex 未能完成本次任务。',
    /rate|limit|overload|unavailable/i.test(String(code)),
    502,
  );
}

export class CodexModelService {
  constructor({
    directory,
    binary = process.env.PAPER_RADAR_CODEX_BIN ?? 'codex',
    client,
  }) {
    this.mode = 'codex';
    this.supportsAgents = true;
    this.managesConcurrency = true;
    this.directory = directory;
    this.runtimeHome = join(directory, 'runtime-home');
    this.workspace = join(directory, 'workspace');
    this.routes = upgradeRoutes(emptyRoutes());
    this.admission = new PriorityAdmission({ limit: () => this.concurrency });
    this.jobs = new Set();
    this.runs = [];
    this.write = Promise.resolve();
    this.shutdown = new AbortController();
    this.listeners = new Set();
    this.client =
      client ??
      new CodexAppServerClient({
        binary,
        runtimeHome: this.runtimeHome,
      });
    this.bridge = new CodexToolBridge(join(directory, 'tasks'));
    this.isolation = null;
    this.catalog = null;
    this.account = null;
    const self = this;
    this.store = {
      state: {
        get settings() {
          if (!self.isolation?.ok)
            throw new BridgeError(
              'codex_isolation_failed',
              'Codex 隔离检查未通过，任务没有启动。',
              false,
              503,
            );
          if (!self.account)
            throw new BridgeError(
              'codex_auth_required',
              '请先在 Paper Radar 模型设置中登录 Codex。',
              false,
              401,
            );
          const settings = settingsFrom(
            self.routes,
            self.catalog,
            self.isolation,
          );
          for (const connection of settings.connections)
            self.validateConnection(connection);
          return settings;
        },
      },
    };
  }

  get concurrency() {
    return this.routes.concurrency;
  }

  onConcurrencyChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.runtimeHome, { recursive: true, mode: 0o700 });
    await mkdir(this.workspace, { recursive: true, mode: 0o700 });
    await writeFile(join(this.runtimeHome, 'config.toml'), runtimeConfig(), {
      mode: 0o600,
    });
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
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await this.refresh().catch(() => {});
    return this;
  }

  async accountState() {
    const value = await this.client.request('account/read', {
      refreshToken: false,
    });
    return value.account ?? null;
  }

  async listModels() {
    const result = [];
    let cursor = null;
    do {
      const page = await this.client.request('model/list', {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      result.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return result;
  }

  async disableSkills() {
    const list = async () =>
      this.client.request('skills/list', {
        cwds: [this.workspace],
        forceReload: true,
      });
    let result = await list();
    const skills = result.data.flatMap((entry) => entry.skills ?? []);
    for (const skill of skills)
      if (skill.enabled)
        await this.client.request('skills/config/write', {
          path: skill.path,
          enabled: false,
        });
    if (skills.some((skill) => skill.enabled)) result = await list();
    return {
      skills: result.data.flatMap((entry) => entry.skills ?? []),
      errors: result.data.flatMap((entry) => entry.errors ?? []),
    };
  }

  async preflight({ threadId = null, expectedTools = null } = {}) {
    await this.client.open();
    const skillState = await this.disableSkills();
    const [config, hooks, mcp] = await Promise.all([
      this.client.request('config/read', { includeLayers: false }),
      this.client.request('hooks/list', { cwds: [this.workspace] }),
      this.client.request('mcpServerStatus/list', {
        limit: 100,
        detail: 'toolsAndAuthOnly',
        ...(threadId ? { threadId } : {}),
      }),
    ]);
    const features = config.config?.features ?? {};
    const activeHooks = hooks.data.flatMap((entry) =>
      entry.hooks.filter((hook) => hook.enabled),
    );
    const exposed = mcp.data.flatMap((server) =>
      Object.keys(server.tools ?? {}).map((tool) => ({
        server: server.name,
        tool,
      })),
    );
    const expected = new Set(expectedTools ?? []);
    const paperTools = exposed.filter((item) => item.server === 'paper-radar');
    const foreign = exposed.filter((item) => item.server !== 'paper-radar');
    const missing = expectedTools
      ? [...expected].filter(
          (name) => !paperTools.some((item) => item.tool === name),
        )
      : [];
    const unexpected = paperTools.filter((item) => !expected.has(item.tool));
    const featureFailures = disabledFeatures.filter(
      (name) => features[name] !== false,
    );
    const agentsEnabled = config.config?.agents?.enabled !== false;
    const enabledSkills = skillState.skills.filter((skill) => skill.enabled);
    const ok =
      activeHooks.length === 0 &&
      foreign.length === 0 &&
      featureFailures.length === 0 &&
      !agentsEnabled &&
      enabledSkills.length === 0 &&
      skillState.errors.length === 0 &&
      config.config?.web_search === 'disabled' &&
      (!expectedTools || (missing.length === 0 && unexpected.length === 0));
    const value = {
      ok,
      hooks_enabled: activeHooks.length,
      foreign_tools: foreign,
      feature_failures: featureFailures,
      agents_enabled: agentsEnabled,
      skills_enabled: enabledSkills.map((skill) => skill.name),
      skill_errors: skillState.errors.length,
      paper_radar_tools: paperTools.map((item) => item.tool),
      missing_tools: missing,
      unexpected_tools: unexpected.map((item) => item.tool),
      persona_mcp_callable: exposed.some(
        (item) => item.server === 'ai-persona',
      ),
    };
    if (!ok) {
      const error = new BridgeError(
        'codex_isolation_failed',
        'Codex 隔离检查未通过：Hook、内置能力或未授权 MCP 工具仍然可用。',
        false,
        503,
      );
      error.isolation = value;
      throw error;
    }
    return value;
  }

  async refresh() {
    await this.client.open();
    try {
      const isolation = await this.preflight();
      const account = await this.accountState();
      const catalog = account ? catalogFrom(await this.listModels()) : null;
      this.isolation = isolation;
      this.account = account;
      this.catalog = catalog;
      return this;
    } catch (error) {
      this.isolation = error.isolation ?? { ok: false };
      this.account = null;
      this.catalog = null;
      throw error;
    }
  }

  async config() {
    let error = null;
    try {
      await this.refresh();
    } catch (failure) {
      error = {
        code: failure.code ?? 'codex_unavailable',
        message: failure.message,
      };
    }
    let limits = null;
    if (this.account)
      limits = await this.client
        .request('account/rateLimits/read', undefined)
        .catch(() => null);
    const connected =
      !error && !!this.account && !!this.catalog && !!this.isolation?.ok;
    return {
      mode: 'codex',
      capabilities: this.capabilities,
      connected,
      account: this.account,
      limits,
      isolation: this.isolation,
      error:
        error ??
        (!this.account
          ? {
              code: 'codex_auth_required',
              message: '请登录专用于 Paper Radar 的 Codex 账号。',
            }
          : null),
      catalog: this.catalog,
      settings: connected
        ? settingsFrom(this.routes, this.catalog, this.isolation)
        : {
            connections: [],
                    overrides: {},
            fallback: { enabled: false, connectionId: null },
          },
      tasks: TASKS,
      routing: structuredClone(this.routes),
      runs: this.runs.slice(-20).reverse(),
    };
  }

  async startLogin() {
    await this.refresh();
    return this.client.request('account/login/start', {
      type: 'chatgpt',
      codexStreamlinedLogin: true,
      useHostedLoginSuccessPage: true,
      appBrand: 'codex',
    });
  }

  async logout() {
    await this.client.open();
    await this.client.request('account/logout', undefined);
    this.account = null;
    this.catalog = null;
    return this.config();
  }

  async routing(raw) {
    const work = this.write
      .catch(() => {})
      .then(async () => {
        await this.refresh();
        if (!this.account || !this.catalog)
          throw new BridgeError(
            'codex_auth_required',
            '请先在 Paper Radar 模型设置中登录 Codex。',
            false,
            401,
          );
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
        if (raw.version !== 2)
          throw new BridgeError('invalid_settings', '设置版本无效。');
        if (
          !raw.presets?.fast ||
          !raw.presets?.deep ||
          !raw.assignments ||
          HOST_TASKS.some(
            (task) =>
              !['fast', 'deep', 'custom'].includes(raw.assignments[task]),
          )
        )
          throw new BridgeError('invalid_settings', '模型方案设置无效。');
        const next = materializeRoutes({
          revision: this.routes.revision + 1,
          version: 2,
          concurrency,
          presets: {
            fast: validateChoice(raw.presets.fast),
            deep: validateChoice(raw.presets.deep),
          },
          assignments: { ...raw.assignments },
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
        });
        const choices = [
          ...Object.values(next.presets),
          ...HOST_TASKS.filter(
            (task) => next.assignments[task] === 'custom',
          ).map((task) => next.tasks[task]),
          ...(next.fallback.enabled ? [next.fallback] : []),
        ];
        if (next.fallback.enabled && !next.fallback.model)
          throw new BridgeError(
            'invalid_settings',
            '启用备用策略前请选择 Codex 模型。',
          );
        for (const choice of choices) {
          const ref = choice.model ?? this.catalog.defaults;
          const model = findCatalogModel(this.catalog, ref);
          if (!model)
            throw new BridgeError(
              'MODEL_NOT_FOUND',
              `Codex 模型 ${ref.model} 当前不可用。`,
            );
          if (
            choice.reasoningEffort &&
            !model.reasoning.efforts.some(
              (effort) => effort.id === choice.reasoningEffort,
            )
          )
            throw new BridgeError(
              'INVALID_REASONING_EFFORT',
              '所选模型不支持该思考强度。',
            );
        }
        const file = join(this.directory, 'routes.json');
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
        });
        await rename(temporary, file);
        this.routes = next;
        this.drain();
        for (const listener of this.listeners) listener();
      });
    this.write = work;
    await work;
    return this.config();
  }

  get running() { return this.admission.running; }
  get waiters() { return this.admission.waiters; }
  get capabilities() { return hostCapabilities(this.mode, { concurrency: this.concurrency }); }
  executionPoolForSettings() { return this.mode; }
  capabilitiesForSettings() { return this.capabilities; }
  acquire(signal, priority = taskPriority()) { return this.admission.acquire(signal, priority); }
  drain() { this.admission.drain(); }

  run(request, options = {}) {
    const work = this.runTask(request, { ...options, priority: options.priority ?? taskPriority() });
    this.jobs.add(work);
    work.finally(() => this.jobs.delete(work)).catch(() => {});
    return work;
  }

  runAgent(request, options = {}) {
    const work = this.runAgentTask(request, { ...options, priority: options.priority ?? taskPriority() });
    this.jobs.add(work);
    work.finally(() => this.jobs.delete(work)).catch(() => {});
    return work;
  }

  connection(request, options) {
    const settings = options.settings ?? this.store.state.settings;
    if (settings.codex?.protocol !== RUNTIME_VERSION)
      throw new BridgeError(
        'legacy_model_snapshot',
        '该任务不是使用当前 Codex 配置创建的，请明确重新发起。',
      );
    const connection = request.connectionId
      ? settings.connections.find((item) => item.id === request.connectionId)
      : resolveConnection(settings, request.task ?? 'summary');
    if (!connection)
      throw new BridgeError(
        'not_configured',
        '请在 Paper Radar 中配置该任务使用的 Codex 模型。',
      );
    return { settings, connection };
  }

  validateConnection(connection) {
    if (!this.catalog)
      throw new BridgeError(
        'MODEL_NOT_FOUND',
        '当前 Codex 账号没有可用模型。',
        false,
        503,
      );
    const model = findCatalogModel(this.catalog, {
      provider: 'codex',
      model: connection.modelId,
    });
    if (!model)
      throw new BridgeError(
        'MODEL_NOT_FOUND',
        `Codex 模型 ${connection.modelId} 当前不可用。`,
      );
    if (
      connection.reasoningEffort &&
      !model.reasoning.efforts.some(
        (effort) => effort.id === connection.reasoningEffort,
      )
    )
      throw new BridgeError(
        'INVALID_REASONING_EFFORT',
        '所选模型不再支持该思考强度。',
      );
    return model;
  }

  async runTask(request, options) {
    const { settings, connection } = this.connection(request, options);
    const release = await this.acquire(
      AbortSignal.any([
        this.shutdown.signal,
        ...(options.signal ? [options.signal] : []),
      ]),
      options.priority,
    );
    try {
      return await this.execute(request, options, settings, connection);
    } finally {
      release();
    }
  }

  async runAgentTask(request, options) {
    if (!Array.isArray(request.tools) || !request.tools.length)
      throw new BridgeError(
        'invalid_tools',
        'Codex 自主任务缺少 Paper Radar 工具定义。',
      );
    const { settings, connection } = this.connection(request, options);
    const release = await this.acquire(
      AbortSignal.any([
        this.shutdown.signal,
        ...(options.signal ? [options.signal] : []),
      ]),
      options.priority,
    );
    try {
      try {
        return await this.execute(request, options, settings, connection);
      } catch (error) {
        const fallback = settings.fallback?.enabled
          ? settings.connections.find(
              (item) =>
                item.id === settings.fallback.connectionId &&
                item.id !== connection.id,
            )
          : null;
        if (request.experiment || !fallback || !fallbackCodes.has(error.code))
          throw error;
        options.onRestart?.();
        return {
          ...(await this.execute(request, options, settings, fallback)),
          fallbackFrom: connection.id,
        };
      }
    } finally {
      release();
    }
  }

  async execute(request, options, settings, connection) {
    const started = Date.now();
    const attemptId = randomUUID();
    const timeout =
      request.executionMs == null
        ? null
        : AbortSignal.timeout(request.executionMs);
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(options.signal ? [options.signal] : []),
      ...(timeout ? [timeout] : []),
    ]);
    let registration = null;
    let threadId = null;
    let turnId = null;
    let turnFinished = false;
    let failure = null;
    let usage = null;
    let finalText = '';
    let eventFailure = null;
    let toolFailure = null;
    let unsubscribe = () => {};
    try {
      signal.throwIfAborted();
      await this.refresh();
      this.validateConnection(connection);
      await options.beforeAttempt?.(connection, {
        id: attemptId,
        attempt_unit: 'agent-turn',
        started_at: new Date(started).toISOString(),
      });
      if (request.tools)
        registration = await this.bridge.register(request, options, signal);
      const expectedTools = request.tools?.map((tool) => tool.name) ?? [];
      const completion = new Promise((resolve) => {
        unsubscribe = this.client.subscribe((message) => {
          if (message.method === '$paperRadar/appServerExited') {
            eventFailure = message.error;
            resolve({ status: 'failed', error: message.error });
            return;
          }
          if (!threadId || message.params?.threadId !== threadId) return;
          if (message.id !== undefined && message.method) {
            eventFailure = new BridgeError(
              'codex_isolation_failed',
              'Codex 任务意外请求了未授权的交互。',
              false,
              503,
            );
            if (threadId && turnId)
              void this.client
                .request('turn/interrupt', { threadId, turnId })
                .catch(() => {});
          }
          if (message.method === 'hook/started') {
            eventFailure = new BridgeError(
              'codex_isolation_failed',
              'Codex 任务意外触发了 Hook，任务已停止。',
              false,
              503,
            );
            if (threadId && turnId)
              void this.client
                .request('turn/interrupt', { threadId, turnId })
                .catch(() => {});
          }
          const item = message.params?.item;
          if (message.method === 'item/completed' && item?.type === 'contextCompaction')
            options.onContext?.({ kind: 'compaction', source: 'codex', content: { recorded: false, reason: '运行环境未提供压缩后的完整上下文。' } });
          if (
            message.method === 'item/completed' &&
            item?.type === 'mcpToolCall' &&
            item.server === 'paper-radar' &&
            (item.status === 'failed' || item.result?.isError)
          ) {
            const detail = item.error?.message ?? item.result?.content
              ?.filter((part) => part.type === 'text')
              .map((part) => part.text).join('\n');
            toolFailure = {
              tool: item.tool,
              message: String(detail || '工具调用未完成。').slice(0, 1500),
            };
          }
          const unexpectedItem =
            message.method === 'item/started' &&
            (!allowedItemTypes.has(item?.type) ||
              (item?.type === 'mcpToolCall' &&
                (item.server !== 'paper-radar' ||
                  !expectedTools.includes(item.tool))));
          if (unexpectedItem) {
            eventFailure = new BridgeError(
              'codex_isolation_failed',
              'Codex 尝试使用 Paper Radar 未授权的内置工具。',
              false,
              503,
            );
            if (threadId && turnId)
              void this.client
                .request('turn/interrupt', { threadId, turnId })
                .catch(() => {});
          }
          if (message.method === 'thread/tokenUsage/updated')
            usage = message.params.tokenUsage?.last ?? usage;
          if (
            message.method === 'item/agentMessage/delta' &&
            message.params?.delta
          ) {
            finalText += message.params.delta;
            options.onProgress?.({
              phase: 'judging',
              session_id: threadId,
              step: 'writing',
            });
          }
          if (
            message.method === 'item/completed' &&
            item?.type === 'agentMessage'
          )
            finalText = item.text ?? finalText;
          if (message.method === 'item/mcpToolCall/progress')
            options.onProgress?.({
              phase: 'judging',
              session_id: threadId,
              step: message.params?.message ?? 'tool',
            });
          if (message.method === 'turn/completed') {
            turnFinished = true;
            resolve(message.params.turn);
          }
        });
      });
      const thread = await this.client.request(
        'thread/start',
        {
          model: connection.modelId,
          cwd: this.workspace,
          approvalPolicy: 'never',
          sandbox: 'read-only',
          ephemeral: true,
          serviceName: 'Paper Radar',
          baseInstructions: CODEX_BASE_INSTRUCTIONS,
          developerInstructions: request.systemPrompt ?? '',
          config: {
            web_search: 'disabled',
            features: Object.fromEntries(
              disabledFeatures.map((name) => [name, false]),
            ),
            agents: { enabled: false },
            tools: { view_image: false },
            mcp_servers: registration
              ? {
                  'paper-radar': {
                    command: process.execPath,
                    args: [taskServer, registration.file],
                    enabled: true,
                    required: true,
                    // Starting a research task authorizes its internal tools,
                    // including saving and submitting that task's result.
                    // Keep approvalPolicy=never and the sandbox unchanged;
                    // this grant applies only to the registered task tools.
                    tools: Object.fromEntries(expectedTools.map((name) => [
                      name, { approval_mode: 'approve' },
                    ])),
                    startup_timeout_sec: 15,
                    tool_timeout_sec: 300,
                  },
                  'ai-persona': {
                    command: '/usr/bin/false',
                    enabled: false,
                  },
                }
              : {
                  'ai-persona': {
                    command: '/usr/bin/false',
                    enabled: false,
                  },
                },
          },
        },
        { signal, timeout: 30000 },
      );
      threadId = thread.thread.id;
      if (registration) await this.preflight({ threadId, expectedTools });
      else await this.preflight({ threadId });
      options.onProgress?.({
        phase: 'judging',
        session_id: threadId,
        step: 'started',
      });
      const turn = await this.client.request(
        'turn/start',
        {
          threadId,
          input: [
            {
              type: 'text',
              text: request.prompt ?? 'Reply with exactly OK.',
            },
          ],
          cwd: this.workspace,
          approvalPolicy: 'never',
          sandboxPolicy: { type: 'readOnly', networkAccess: false },
          model: connection.modelId,
          ...(connection.reasoningEffort
            ? { effort: connection.reasoningEffort }
            : {}),
          ...(request.submitTool
            ? {
                outputSchema: SUBMISSION_RECEIPT_SCHEMA,
              }
            : {}),
        },
        { signal, timeout: 30000 },
      );
      turnId = turn.turn.id;
      options.onContext?.({ kind: 'host_input', source: 'codex', delivery: 'accepted_by_host', content: { ...hostContext('codex', request), model: connection.modelId, reasoning_effort: connection.reasoningEffort ?? null, thread_id: threadId, turn_id: turnId } });
      const completed = await waitForCompletion(completion, signal);
      if (eventFailure) throw eventFailure;
      if (completed.status !== 'completed') throw rpcFailure(completed);
      if (registration && !registration.task.submitted)
        throw new BridgeError(
          'invalid_output',
          toolFailure
            ? `Codex 调用 Paper Radar 工具 ${toolFailure.tool} 失败：${toolFailure.message}`
            : 'Codex 已结束回答，但没有调用 Paper Radar 工具提交经过校验的结果。',
          true,
        );
      const result = {
        data: registration?.task.submitted,
        text: finalText,
        providerId: 'codex',
        modelId: connection.modelId,
        reasoningEffort: connection.reasoningEffort,
        connectionId: connection.id,
        requestId: attemptId,
        runtimeId: RUNTIME_VERSION,
        sessionId: threadId,
        usage: usage
          ? {
              input: usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              cost: null,
            }
          : null,
      };
      return result;
    } catch (error) {
      failure = error;
      // A terminal turn may fail validation, but it has nothing left to cancel.
      // Interrupting it can return "not active" and unnecessarily stop other turns.
      if (threadId && turnId && !turnFinished && error.code !== 'codex_unavailable') {
        const interrupted = await this.client
          .request('turn/interrupt', { threadId, turnId }, { timeout: 5000 })
          .then(() => true)
          .catch(() => false);
        if (!interrupted && !turnFinished)
          await this.client
            .terminate?.('Codex 无法确认任务中断，专属 App Server 已停止。')
            .catch(() => {});
      }
      if (
        signal.aborted &&
        (error === signal.reason ||
          error?.name === 'AbortError' ||
          error?.name === 'TimeoutError' ||
          !error.code)
      ) {
        failure = new BridgeError(
          timeout?.aborted ? 'timeout' : 'cancelled',
          timeout?.aborted
            ? 'Codex 任务超过执行时间预算。'
            : 'Codex 任务已取消。',
          !!timeout?.aborted,
        );
        throw failure;
      }
      throw error;
    } finally {
      unsubscribe();
      await registration?.close();
      const attempt = {
        id: attemptId,
        attempt_unit: 'agent-turn',
        request_id: attemptId,
        task: request.task,
        provider_id: 'codex',
        model_id: connection.modelId,
        reasoning_effort: connection.reasoningEffort,
        connection_id: connection.id,
        runtime_id: RUNTIME_VERSION,
        session_id: threadId,
        turn_id: turnId,
        started_at: new Date(started).toISOString(),
        duration_ms: Date.now() - started,
        status: failure?.code ?? 'succeeded',
        ...(toolFailure ? { tool_error: toolFailure } : {}),
        usage: usage
          ? {
              input: usage.inputTokens ?? 0,
              output: usage.outputTokens ?? 0,
              cost: null,
            }
          : null,
      };
      options.onAttempt?.(attempt);
      this.runs.push({
        ...attempt,
        connectionName: connection.name,
        modelId: connection.modelId,
        at: attempt.started_at,
        durationMs: attempt.duration_ms,
      });
      this.runs = this.runs.slice(-100);
    }
  }

  async close() {
    this.shutdown.abort();
    await Promise.allSettled(this.jobs);
    await this.bridge.close();
    await this.client.close();
    await this.write.catch(() => {});
  }
}
