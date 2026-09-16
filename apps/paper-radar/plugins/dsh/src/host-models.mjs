import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { BridgeError, PROTOCOL } from './transport.mjs';
import { TASKS, selectRoute } from './routing.mjs';

const failureMessages = {
  AUTH: 'DSH 模型认证失效，请在宿主设置中重新授权。', MISSING_CREDENTIAL: '请在 DSH 中完成模型认证。',
  NO_ADAPTER: 'DSH 中的模型连接已移除或尚未启用。', RATE_LIMIT: 'DSH 模型当前请求过多，请稍后重试。',
  CONTEXT_WINDOW_EXCEEDED: '论文与个人材料超过所选模型的上下文容量。',
  INVALID_REASONING_EFFORT: '所选模型不支持该思考强度，请重新选择。',
  UNSUPPORTED_REASONING_EFFORT: '所选模型不支持该思考强度，请重新选择或恢复继承。',
};
export function modelFailure(e) {
  if (e instanceof BridgeError) return e;
  const code = e?.code ?? 'PROVIDER_ERROR';
  return new BridgeError(code, failureMessages[code] ?? 'DSH 模型调用未完成，请检查宿主模型状态。', ['RATE_LIMIT', 'PROVIDER_ERROR'].includes(code), 502);
}
export class HostModels {
  constructor(ctx, { usagePath, settingsUrl } = {}) {
    this.ctx = ctx; this.usagePath = usagePath; this.settingsUrl = settingsUrl;
    this.runtimeId = randomUUID(); this.requests = new Map(); this.preparing = new Set(); this.controllers = new Set();
  }
  selection(sessionId) {
    if (!sessionId) return null;
    const agent = this.ctx.agents?.get(sessionId);
    if (!agent) throw new BridgeError('session_unavailable', '发起任务的 DSH 会话不可用，请从原会话重试。');
    const projected = this.ctx.sessionProjections?.stateOf(agent.session, 'modelSelection');
    const selected = projected?.pending ?? agent.session.requestHeader()?.config ?? this.ctx.agentDefaultModel.currentSelection();
    return { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}) };
  }
  async catalog() {
    const defaults = this.ctx.agentDefaultModel.currentSelection();
    const groups = await Promise.all(this.ctx.llm.listProviders().map(async (provider) => {
      try {
        const listed = [...await this.ctx.llm.listModels(provider.id)];
        if (defaults.provider === provider.id && !listed.some((m) => m.id === defaults.model)) listed.push({ id: defaults.model, name: defaults.model });
        return { ...provider, models: await Promise.all(listed.map(async (m) => {
          try {
            const info = await this.ctx.llm.resolveModelInfo(provider.id, m.id);
            return { provider: provider.id, model: m.id, name: m.name, reasoning: info.reasoning ?? null, contextWindow: info.context?.contextWindow ?? null, maxTokens: info.defaultMaxTokens ?? null };
          } catch { return { provider: provider.id, model: m.id, name: m.name, unavailable: true }; }
        })) };
      } catch { return { ...provider, models: [], unavailable: true }; }
    }));
    return { protocol: PROTOCOL, runtimeId: this.runtimeId, defaults, groups, settingsUrl: this.settingsUrl ?? null };
  }
  async resolve(selection, signal) {
    try {
      const config = await this.ctx.llm.resolveCallConfig({ provider: selection.provider, model: selection.model, ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }, signal);
      const info = await this.ctx.llm.resolveModelInfo(config.provider, config.model, signal);
      return { ...config, source: selection.source, contextWindow: info.context?.contextWindow ?? null, maxTokens: info.defaultMaxTokens ?? 8192, reasoning: info.reasoning ?? null };
    } catch (e) { throw modelFailure(e); }
  }
  async snapshot({ routes, sessionId, explicit, parent }, signal) {
    const defaults = this.ctx.agentDefaultModel.currentSelection(), session = this.selection(sessionId);
    const entries = await Promise.all(TASKS.map(async ({ id }) => [id, await this.resolve(selectRoute(id, routes, defaults, { session, explicit, parent }), signal)]));
    const fallback = routes.fallback?.enabled ? await this.resolve({ ...routes.fallback.model, ...(routes.fallback.reasoningEffort ? { reasoningEffort: routes.fallback.reasoningEffort } : {}), source: { model: '明确备用设置', reasoningEffort: '明确备用设置' } }, signal) : null;
    return { protocol: PROTOCOL, runtimeId: this.runtimeId, sessionId: sessionId ?? null, selections: Object.fromEntries(entries), fallback };
  }
  async generate(input, signal) {
    if (typeof input.id !== 'string' || !/^[\w-]{8,120}$/.test(input.id)) throw new BridgeError('invalid_request', '缺少模型请求标识。');
    // Never replay an ambiguous provider request on a transport reconnect.
    if (this.requests.has(input.id) || this.preparing.has(input.id)) throw new BridgeError('duplicate_request', '该模型请求已提交，请查询原业务任务，不要重复调用。', false, 409);
    if (typeof input.prompt !== 'string' || input.prompt.length > 300000 || typeof input.systemPrompt !== 'string' || input.systemPrompt.length > 10000) throw new BridgeError('context_length', '完整提示词超过接口长度上限，原样重试无法解决。');
    if (!input.selection?.provider || !input.selection?.model || !Number.isInteger(input.maxTokens) || input.maxTokens < 128 || input.maxTokens > 64000) throw new BridgeError('invalid_request', '模型调用参数无效。');
    const controller = new AbortController(); this.controllers.add(controller);
    const combined = AbortSignal.any([signal, controller.signal]);
    const selected = input.selection;
    let output = '', usage = null, finish, failure;
    const started = new Date().toISOString();
    this.preparing.add(input.id);
    try {
      const prepared = await this.ctx.llm.prepareCall({ provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}), maxTokens: input.maxTokens }, combined);
      if ((prepared.config.reasoningEffort ?? null) !== (selected.reasoningEffort ?? null)) throw new BridgeError('model_changed', '宿主默认思考强度已变化，请明确重新发起任务。');
      if (prepared.context && Math.ceil(Buffer.byteLength(input.prompt + input.systemPrompt) / 2) + input.maxTokens + 2000 > prepared.context.contextWindow) throw new BridgeError('context_length', '当前模型容量不足以容纳论文证据。');
      this.requests.set(input.id, { status: 'running', started });
      for await (const chunk of prepared.stream({ ...prepared.config, system: input.systemPrompt, messages: [createUserMessage({ source: { kind: 'plugin', plugin: 'paper-radar' }, content: [{ type: 'text', text: input.prompt }] })], signal: combined, ...(input.sessionId ? { sessionId: input.sessionId } : {}) })) {
        if (chunk.type === 'text-delta') output += chunk.text;
        if (chunk.type === 'usage') usage = chunk.usage;
        if (chunk.type === 'finish') finish = chunk.reason;
      }
      combined.throwIfAborted();
      if (!finish || ['error', 'aborted'].includes(finish.kind)) throw modelFailure(finish?.failure);
      if (finish.kind === 'max-tokens') throw new BridgeError('output_truncated', '模型输出达到长度上限，结果尚未完整。');
      return { text: output, providerId: selected.provider, modelId: selected.model, reasoningEffort: prepared.config.reasoningEffort ?? null, requestId: input.id, runtimeId: this.runtimeId, usage: usage ? { input: usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0), output: usage.outputTokens, cost: null, raw: usage } : null };
    } catch (e) {
      failure = combined.aborted ? new BridgeError('cancelled', '任务已取消。') : modelFailure(e);
      throw failure;
    } finally {
      this.preparing.delete(input.id);
      this.controllers.delete(controller);
      if (this.requests.has(input.id)) {
        const record = { id: input.id, runtimeId: this.runtimeId, sessionId: input.sessionId ?? null, businessTask: input.businessTask ?? null, provider: selected.provider, model: selected.model, reasoningEffort: selected.reasoningEffort ?? null, started, finished: new Date().toISOString(), status: failure?.code ?? 'succeeded', usage };
        this.requests.set(input.id, record);
        if (this.usagePath) await appendFile(this.usagePath, JSON.stringify(record) + '\n', { mode: 0o600 });
      }
    }
  }
  close() { for (const c of this.controllers) c.abort(); }
}
