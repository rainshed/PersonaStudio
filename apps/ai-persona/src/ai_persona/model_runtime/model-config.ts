export type AuthMethod = 'api_key' | 'oauth' | 'none';
export type ModelTask = 'activation' | 'maintenance' | 'conversation_learning' | 'material' | 'conversation_signal' | 'conversation_candidate';
export const REQUEST_TASKS: ModelTask[] = ['activation', 'maintenance', 'conversation_learning', 'material', 'conversation_signal', 'conversation_candidate'];
export function taskGroup(task: ModelTask, routingVersion = 3): ModelTask {
  if (task === 'material') return 'maintenance';
  if (task === 'conversation_candidate' || (task === 'conversation_signal' && routingVersion === 2)) return 'conversation_learning';
  return task;
}
export type ConnectionStatus =
  | 'untested'
  | 'ready'
  | 'auth_required'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'error';
export type ModelEntry = {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input?: string[];
};
export type ProviderInfo = {
  id: string;
  name: string;
  mark: string;
  color: string;
  auth: AuthMethod[];
  billing: string;
  description: string;
  models: ModelEntry[];
};
export type ModelConnection = {
  id: string;
  name: string;
  providerId: string;
  authType: AuthMethod;
  modelId: string;
  baseUrl: string;
  api: string;
  contextWindow: number;
  maxTokens: number;
  status: ConnectionStatus;
  checkedAt?: string;
  hasCredential?: boolean;
  imageModelIds?: string[];
};
export type ModelSettings = {
  routingVersion: 1 | 2 | 3;
  connections: ModelConnection[];
  defaultConnectionId: string | null;
  defaultModelId: string | null;
  overrides: Record<ModelTask, string | null>;
  overrideModelIds: Record<ModelTask, string | null>;
  overrideReasoning?: Partial<Record<ModelTask, string | null>>;
  fallback: { enabled: boolean; connectionId: string | null; modelId?: string };
};
export const TASKS: { id: ModelTask; name: string; description: string }[] = [
  { id: 'maintenance', name: 'AI 维护助手', description: '理解论文、notes 与截图，检索已有信息，生成有依据的维护候选。' },
  { id: 'conversation_learning', name: '对话学习生成', description: '结合对话原文与已有数据，审慎生成知识、偏好与关系候选。' },
  { id: 'conversation_signal', name: '对话学习判定', description: '判断对话是否包含值得学习的信息，优先速度与成本，同时避免漏判。' },
  {
    id: 'activation',
    name: '偏好场景判定',
    description: '判断当前输入匹配哪些已启用的偏好场景。',
  },
];
export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai',
    name: 'OpenAI API',
    mark: 'O',
    color: '#14695a',
    auth: ['api_key'],
    billing: 'API 按量计费',
    description: '使用 OpenAI 开发者平台的 API Key。',
    models: [],
  },
  {
    id: 'openai-codex',
    name: 'ChatGPT / Codex',
    mark: 'C',
    color: '#263d54',
    auth: ['oauth'],
    billing: '账号计划与额度',
    description: '通过 Pi 的 Codex 账号授权连接；可用模型与额度由账号决定。',
    models: [],
  },
  {
    id: 'anthropic',
    name: 'Claude',
    mark: 'A',
    color: '#a86543',
    auth: ['api_key'],
    billing: 'API 按量计费',
    description:
      '使用 Claude Console API Key；不将 Pro / Max 订阅视为通用 API 额度。',
    models: [],
  },
  {
    id: 'google',
    name: 'Gemini',
    mark: 'G',
    color: '#4472c4',
    auth: ['api_key'],
    billing: 'API 套餐 / 按量计费',
    description: '使用 Gemini API Key，额度以平台账号为准。',
    models: [],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    mark: 'D',
    color: '#4351b3',
    auth: ['api_key'],
    billing: 'API 按量计费',
    description: '连接 DeepSeek 开放平台。',
    models: [],
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    mark: 'R',
    color: '#76509f',
    auth: ['api_key', 'oauth'],
    billing: 'OpenRouter 余额',
    description: '密钥或账号授权均使用平台余额，不代表免费订阅用量。',
    models: [],
  },
  {
    id: 'moonshotai',
    name: 'Kimi · 开放平台',
    mark: 'K',
    color: '#263647',
    auth: ['api_key'],
    billing: 'API 按量计费',
    description: 'Moonshot 国际服务，与 Kimi For Coding 的密钥和额度分开。',
    models: [],
  },
  {
    id: 'moonshotai-cn',
    name: 'Kimi · 开放平台（中国）',
    mark: 'K',
    color: '#263647',
    auth: ['api_key'],
    billing: 'API 按量计费',
    description: 'Moonshot 中国服务，使用对应区域的 API Key。',
    models: [],
  },
  {
    id: 'kimi-coding',
    name: 'Kimi For Coding',
    mark: 'K',
    color: '#263647',
    auth: ['api_key', 'oauth'],
    billing: 'Kimi Code 计划与额度',
    description:
      '使用 Kimi Code 专用密钥或账号授权。实际可用性以平台对该账号与用途的支持为准。',
    models: [],
  },
  {
    id: 'custom',
    name: '自定义兼容服务',
    mark: '+',
    color: '#657384',
    auth: ['api_key', 'none'],
    billing: '由服务提供方决定',
    description: '连接兼容接口、代理或本地模型。',
    models: [],
  },
];
export const STATUS_LABELS: Record<ConnectionStatus, string> = {
  untested: '待测试',
  ready: '测试通过',
  auth_required: '需要认证',
  rate_limited: '暂时限流',
  quota_exceeded: '额度不足',
  error: '连接异常',
};
export const AUTH_LABELS: Record<AuthMethod, string> = {
  api_key: 'API Key',
  oauth: '账号授权',
  none: '无需认证',
};
export const MODEL_STORAGE_KEY = 'ai-persona.models.v1';
export function emptyModelSettings(): ModelSettings {
  return {
    routingVersion: 3,
    connections: [],
    defaultConnectionId: null,
    defaultModelId: null,
    overrides: { activation: null, maintenance: null, material: null,
      conversation_signal: null, conversation_candidate: null, conversation_learning: null },
    overrideModelIds: { activation: null, maintenance: null, material: null,
      conversation_signal: null, conversation_candidate: null, conversation_learning: null },
    fallback: { enabled: false, connectionId: null },
  };
}
export function validateConnection(input: unknown): string | null {
  if (!input || typeof input !== 'object') return '连接配置不完整';
  const c = input as ModelConnection;
  const provider = PROVIDERS.find((p) => p.id === c.providerId);
  if (!provider || !provider.auth.includes(c.authType))
    return '平台或认证方式无效';
  if (
    typeof c.id !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(c.id) ||
    ['__proto__', 'constructor', 'prototype'].includes(c.id)
  )
    return '连接标识无效';
  if (typeof c.name !== 'string' || !c.name.trim() || c.name.length > 60)
    return '请填写 1–60 字的连接名称';
  if (
    typeof c.modelId !== 'string' ||
    !c.modelId.trim() ||
    c.modelId.length > 200
  )
    return '请选择或填写模型 ID';
  if (
    !Number.isInteger(c.contextWindow) ||
    c.contextWindow < 1024 ||
    c.contextWindow > 10000000
  )
    return '上下文长度应为 1024–10000000 的整数';
  if (
    !Number.isInteger(c.maxTokens) ||
    c.maxTokens < 128 ||
    c.maxTokens > c.contextWindow
  )
    return '输出上限应至少为 128，且不超过上下文长度';
  if (c.providerId === 'custom') {
    if (c.imageModelIds !== undefined && (!Array.isArray(c.imageModelIds) || c.imageModelIds.length > 50 ||
        c.imageModelIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 200)))
      return '请填写有效的图片模型 ID，每行一个，最多 50 个';
    if (
      ![
        'openai-completions',
        'openai-responses',
        'anthropic-messages',
      ].includes(c.api)
    )
      return '请选择兼容协议';
    try {
      const url = new URL(c.baseUrl);
      if (url.username || url.password || url.search || url.hash)
        return '地址中不能包含凭据、查询参数或片段';
      if (
        url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        )
      )
        return '远程服务使用 HTTPS；本地服务可使用 HTTP';
    } catch {
      return '请填写完整的服务地址';
    }
  }
  return null;
}
// Whitelist public fields. Credentials must never enter demo browser storage.
export function publicConnection(c: ModelConnection): ModelConnection {
  return {
    id: c.id,
    name: c.name.trim(),
    providerId: c.providerId,
    authType: c.authType,
    modelId: c.modelId.trim(),
    baseUrl: c.providerId === 'custom' ? c.baseUrl : '',
    api: c.providerId === 'custom' ? c.api : '',
    contextWindow: c.contextWindow,
    maxTokens: c.maxTokens,
    ...(c.providerId === 'custom' ? { imageModelIds: [...new Set((c.imageModelIds ?? []).map(id => id.trim()))] } : {}),
    status: Object.hasOwn(STATUS_LABELS, c.status) ? c.status : 'untested',
    ...(c.checkedAt ? { checkedAt: c.checkedAt } : {}),
  };
}
export function hydrateModelSettings(value: unknown): ModelSettings | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as ModelSettings;
  if (
    !Array.isArray(raw.connections) ||
    raw.connections.length > 30 ||
    raw.connections.some((c) => validateConnection(c))
  )
    return null;
  const connections = raw.connections.map(publicConnection),
    ids = new Set(connections.map((c) => c.id));
  if (ids.size !== connections.length) return null;
  const ref = (id: unknown) =>
    typeof id === 'string' && ids.has(id) ? id : null;
  const modelIds = [raw.defaultModelId, ...REQUEST_TASKS.map(id => raw.overrideModelIds?.[id]), raw.fallback?.modelId];
  if (modelIds.some(id => id != null &&
      (typeof id !== 'string' || !id.trim() || id.length > 200))) return null;
  const modelRef = (connectionId: unknown, modelId: string | null | undefined) =>
    ref(connectionId) && modelId ? modelId.trim() : null;
  if (raw.overrideReasoning && Object.values(raw.overrideReasoning).some(v =>
      v != null && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(v))) return null;
  return {
    routingVersion: raw.routingVersion === 3 ? 3 : raw.routingVersion === 2 ? 2 : 1,
    connections,
    defaultConnectionId: ref(raw.defaultConnectionId),
    defaultModelId: modelRef(raw.defaultConnectionId, raw.defaultModelId),
    overrides: {
      activation: ref(raw.overrides?.activation),
      maintenance: ref(raw.overrides?.maintenance),
      material: ref(raw.overrides?.material),
      conversation_signal: ref(raw.overrides?.conversation_signal),
      conversation_candidate: ref(raw.overrides?.conversation_candidate),
      conversation_learning: ref(raw.overrides?.conversation_learning),
    },
    overrideModelIds: Object.fromEntries(REQUEST_TASKS.map(id =>
      [id, modelRef(raw.overrides?.[id], raw.overrideModelIds?.[id])])) as Record<ModelTask, string | null>,
    ...(raw.overrideReasoning ? { overrideReasoning: Object.fromEntries(REQUEST_TASKS.map(id =>
      [id, raw.overrideReasoning?.[id] ?? null])) } : {}),
    fallback: {
      enabled:
        raw.fallback?.enabled === true && !!ref(raw.fallback?.connectionId),
      connectionId: ref(raw.fallback?.connectionId),
      ...(modelRef(raw.fallback?.connectionId, raw.fallback?.modelId)
        ? { modelId: raw.fallback.modelId!.trim() } : {}),
    },
  };
}
export function withoutConnection(
  settings: ModelSettings,
  id: string,
): ModelSettings {
  return hydrateModelSettings({
    ...settings,
    connections: settings.connections.filter((c) => c.id !== id),
  })!;
}
export function resolveConnection(
  settings: ModelSettings,
  task: ModelTask,
): ModelConnection | undefined {
  if (settings.routingVersion >= 2) task = taskGroup(task, settings.routingVersion);
  const id = settings.overrides[task] ?? settings.defaultConnectionId;
  const connection = settings.connections.find((c) => c.id === id);
  const modelId = settings.overrides[task]
    ? settings.overrideModelIds?.[task] : settings.defaultModelId;
  return connection && modelId ? { ...connection, modelId } : connection;
}

// A legacy vault keeps its actual routing until the user saves the four selections.
// Suggestions reuse explicit choices; conflicting old stages remain visible for review.
export function groupedRoutes(settings: ModelSettings) {
  return TASKS.map(task => {
    const stages: ModelTask[] = settings.routingVersion >= 2 ? [task.id] :
      task.id === 'maintenance' ? ['maintenance', 'material'] :
      task.id === 'conversation_learning' ? ['conversation_candidate'] : [task.id];
    const sources = stages.map(id => settings.routingVersion >= 2 ? taskGroup(id, settings.routingVersion) : id);
    const preferred = sources.find(id => settings.overrides[id]) ?? sources[0];
    const connectionId = settings.overrides[preferred];
    const connection = settings.connections.find(c => c.id === connectionId);
    const previous = stages.map(id => {
      const c = resolveConnection(settings, id);
      return { task: id, connectionId: c?.id ?? null, connectionName: c?.name ?? null, modelId: c?.modelId ?? null };
    });
    return { ...task, connectionId, reasoning: settings.overrideReasoning?.[preferred] ?? null, modelId: connectionId ? settings.overrideModelIds[preferred] ?? connection?.modelId ?? null : null,
      previous, conflict: new Set(previous.map(r => JSON.stringify([r.connectionId, r.modelId]))).size > 1 };
  });
}
