import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { bridgeRequest, BridgeError } from './transport.mjs';
import { modelFailure } from './host-models.mjs';
import { SCREEN_TOOLS } from '@paper-radar/host-contract/agent-contract';
import { prepareToolValue, renderToolValue } from './tool-content.mjs';
import { missingSubmissionPrompt, hostContext } from '@paper-radar/host-contract/context';

// The host owns the real agent loop. Business tools and EVERY model admission
// return through the caller's private Unix socket; long runs do not hold HTTP open.
export class HostAgents {
  constructor(ctx, models) {
    this.ctx = ctx; this.models = models; this.runs = new Map();
    this.unhook = ctx.on?.('llm/stream', (options, next) => {
      const run = [...this.runs.values()].find(r => r.sessionId === options.sessionId);
      if (run?.compact && options.purpose === 'compaction') return run.compact(options, next);
      return next();
    });
  }
  start(input) {
    if (!/^[\w-]{8,120}$/.test(input.id ?? '') || typeof input.callbackPath !== 'string' || !input.callbackPath.startsWith('/') || typeof input.token !== 'string' || input.token.length < 32)
      throw new BridgeError('invalid_request', 'Agent 任务标识或回调无效。');
    if (!input.selection?.provider || !input.selection?.model || typeof input.prompt !== 'string' || typeof input.systemPrompt !== 'string' || input.prompt.length + input.systemPrompt.length > 60000)
      throw new BridgeError('invalid_request', 'Agent 输入应是简短任务和资料引用。');
    const previous = this.runs.get(input.id);
    if (previous) {
      if (previous.token !== input.token) throw new BridgeError('conflict', 'Agent 任务标识已使用。', false, 409);
      return this.status(input);
    }
    const run = { id: input.id, token: input.token, status: 'running', sessionId: `paper-radar-${input.id}`, controller: new AbortController(), step: 0, result: null, error: null };
    this.runs.set(input.id, run);
    run.work = this.execute(run, input).then((result) => { run.result = result; run.status = 'completed'; }, (e) => {
      if (process.env.PAPER_RADAR_AGENT_DIAGNOSTICS === '1') console.error(String(e?.stack ?? e).replace(/https?:\/\/[^\s]+/g, '[URL]').replace(/(token|key|secret)=\S+/gi, '$1=[redacted]').slice(0,2500));
      const error = e instanceof BridgeError ? e : modelFailure(e);
      run.error = { code: error.code, message: error.message, retryable: error.retryable };
      run.status = 'failed';
    });
    // Completed status is only a reconnect aid; authoritative results live in PaperRadar.
    run.work.finally(() => { const timer = setTimeout(() => this.runs.delete(run.id), 30 * 60 * 1000); timer.unref(); });
    return this.status(input);
  }
  get(input) {
    const run = this.runs.get(input.id);
    if (!run || run.token !== input.token) throw new BridgeError('agent_run_missing', '宿主中的 Agent 运行已中断，请查看原任务后明确重试。', false, 404);
    return run;
  }
  status(input) {
    const r = this.get(input);
    return { id: r.id, status: r.status, sessionId: r.sessionId, runtimeId: this.models.runtimeId, step: r.step, result: r.result, error: r.error };
  }
  cancel(input) { const run = this.get(input); run.controller.abort(); return { accepted: true }; }
  async execute(run, input) {
    const task = input.task ?? 'screen';
    // Preserve explicit null across the bridge. Full analyses and discussions
    // have no total time or call cap; automatic screening retains its budget.
    const executionMs = input.executionMs === undefined ? (['single', 'discussion'].includes(task) ? null : 720000) : input.executionMs;
    const attempts = input.maxAttempts === undefined ? (['single', 'discussion'].includes(task) ? null : 12) : input.maxAttempts;
    const timeoutMs = executionMs === null ? null : Math.min(Math.max(executionMs, 1000), 3600000);
    const maxAttempts = attempts === null ? null : Math.min(Math.max(attempts, 1), 200);
    const tools = input.tools ?? SCREEN_TOOLS;
    if (!Array.isArray(tools) || !tools.length || tools.length > 40 || tools.some(t => !/^[a-z][a-z0-9_]{0,63}$/.test(t.name) || !t.parameters || typeof t.description !== 'string') || new Set(tools.map(t => t.name)).size !== tools.length) throw new BridgeError('invalid_request', 'Agent 工具定义无效。');
    const submitTool = input.submitTool ?? 'screening_submit_result';
    if (!tools.some(t => t.name === submitTool)) throw new BridgeError('invalid_request', '缺少结果提交接口。');
    const signal = AbortSignal.any([run.controller.signal, ...(timeoutMs === null ? [] : [AbortSignal.timeout(timeoutMs)])]);
    const callback = (kind, payload = {}) => bridgeRequest(input.callbackPath, '/agent/callback', { id: input.id, token: input.token, kind, ...payload }, { signal, timeout: kind === 'reserve' ? timeoutMs : 120000 });
    const recordContext = (event) => input.contextRecording ? callback('context', { event }) : Promise.resolve();
    let handle, failure, captured, staged = new WeakMap(), active, settled = Promise.resolve(), repairs = 0, count = 0;
    const finishAttempt = () => {
      if (!active) return;
      const attempt = active; active = null;
      settled = settled.then(() => callback('attempt', { attempt: { ...attempt, duration_ms: Date.now() - Date.parse(attempt.started_at), status: attempt.status ?? 'unknown', runtime_id: this.models.runtimeId, session_id: run.sessionId } })).catch((e) => { failure ??= e; });
    };
    const abort = () => handle?.agent.cancel({ kind: 'hook', reason: 'PaperRadar task cancelled or timed out' });
    signal.addEventListener('abort', abort, { once: true });
    try {
      const selected = await this.models.resolve(input.selection, signal);
      if ((selected.reasoningEffort ?? null) !== (input.selection.reasoningEffort ?? null)) throw new BridgeError('model_changed', '宿主默认思考强度已变化，请重新发起任务。');
      const maxTokens = Math.min(input.maxTokens ?? 4096, selected.maxTokens);
      const runtimeId = this.models.runtimeId;
      const newAttempt = (purpose = task) => ({ id: randomUUID(), attempt_unit: 'model-attempt', task, purpose, started_at: new Date().toISOString(), provider_id: selected.provider, model_id: selected.model, reasoning_effort: selected.reasoningEffort ?? null, usage: null, sent: false });
      const admit = async (attempt) => {
        await settled; signal.throwIfAborted();
        if (failure) throw failure;
        if (maxAttempts !== null && ++count > maxAttempts) throw new BridgeError('agent_step_limit', '已达到本次任务的模型调用预算，已保存的内容保留。');
        await callback('reserve', { attempt });
      };
      // The native summarizer also uses llm/stream; meter it against this task.
      run.compact = async function* (options, next) {
        const attempt = newAttempt('compaction');
        try {
          await admit(attempt);
          await recordContext({ kind: 'compaction', source: 'dsh', content: { recorded: false, reason: '运行环境执行上下文压缩；未保存其内部完整内容。' } });
          Object.assign(options, { provider: selected.provider, model: selected.model, reasoningEffort: selected.reasoningEffort, signal, maxTokens: Math.min(options.maxTokens ?? maxTokens, maxTokens) });
          attempt.sent = true;
          for await (const chunk of await next()) {
            if (chunk.type === 'usage') attempt.usage = { input: chunk.usage.inputTokens + (chunk.usage.cacheReadTokens ?? 0) + (chunk.usage.cacheWriteTokens ?? 0), output: chunk.usage.outputTokens, cost: null, raw: chunk.usage };
            if (chunk.type === 'finish') attempt.status = chunk.reason.kind === 'stop' ? 'succeeded' : chunk.reason.kind;
            yield chunk;
          }
        } catch (e) { failure ??= e; throw e; }
        finally {
          if (attempt.sent) await callback('attempt', { attempt: { ...attempt, status: attempt.status ?? 'unknown', duration_ms: Date.now() - Date.parse(attempt.started_at), runtime_id: runtimeId, session_id: run.sessionId } });
        }
      };
      const contextBytes = agent => Buffer.byteLength(JSON.stringify(agent.session.deriveMessages())) + Buffer.byteLength(input.systemPrompt) + Buffer.byteLength(JSON.stringify(tools));
      handle = await this.ctx.agents.create({
        sessionId: run.sessionId, signal, meta: { origin: 'subagent' },
        agentOptions: { provider: selected.provider, model: selected.model, ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}), maxTokens },
        setup: (scope, agent) => {
          scope.tools.restrict({ allow: [] });
          scope.tools.presentAs('native');
          scope.systemPrompt.suppressRuntimeContext();
          scope.systemPrompt.section({ name: 'paper-radar:task', order: 0, complete: true, text: input.systemPrompt });
          scope.on('agent/pre-step', async ({ messages, signal: turnSignal }, next) => {
            signal.throwIfAborted(); turnSignal.throwIfAborted();
            const entered = this.unhook && next ? await next() : { kind: 'enter', messages };
            if (failure) throw failure;
            const compaction = this.ctx.agentPresets?.serviceFor(agent, 'compaction');
            if (this.unhook && compaction && Math.ceil(contextBytes(agent) / 2) + maxTokens + 2000 > (selected.contextWindow ?? 32768))
              await compaction.compactIfNeeded(agent, 'context-overflow', signal);
            if (failure) throw failure;
            return entered;
          }, { prepend: true });
          scope.tools.guard(() => captured ? 'The task result has already been submitted.' : undefined);
          for (const tool of tools) scope.tools.register({
            ...tool, timeoutMs: 120000, isConcurrencySafe: () => false,
            output: { schema: { type: 'object', additionalProperties: true }, render: (_, value) => renderToolValue(value) },
            execute: async (args, exec) => {
              if (captured) throw new BridgeError('already_completed', '本次结果已经提交。');
              const value = await callback('tool', { tool: tool.name, args });
              if (tool.name === submitTool) { staged.set(exec, args); exec.concludeTurn(); }
              return prepareToolValue(this.ctx, value);
            },
          });
          scope.on('tools/result', (exec, result) => {
            const value = staged.get(exec); staged.delete(exec);
            if (value && !result.isError) captured = value;
          });
          scope.on('agent/request', async ({ signal: turnSignal, step }, next) => {
            await settled;
            signal.throwIfAborted(); turnSignal.throwIfAborted();
            if (failure) throw failure;
            const config = await next();
            // Admission uses the full accumulated history, not just the latest tool page.
            const bytes = contextBytes(agent) + (step === 1 ? Buffer.byteLength(input.prompt) : 0);
            if (Math.ceil(bytes / 2) + maxTokens + 2000 > (selected.contextWindow ?? 32768)) throw new BridgeError('context_length', '本篇 Agent 上下文已达上限，读取进度已保留；原样继续不会解决。');
            run.step = step;
            const attempt = newAttempt();
            await admit(attempt);
            active = attempt;
            return { ...config, provider: selected.provider, model: selected.model, reasoningEffort: selected.reasoningEffort, maxTokens };
          });
          scope.on('agent/assistant-stream', ({ frame }) => {
            if (!active) return;
            if (frame.type === 'start') { active.sent = true; active.request_id = frame.attemptId; }
            if (frame.type === 'chunk' && frame.chunk.type === 'usage') {
              const u = frame.chunk.usage;
              active.usage = { input: u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0), output: u.outputTokens, cost: null, raw: u };
            }
            if (frame.type === 'chunk' && frame.chunk.type === 'finish') {
              const reason = frame.chunk.reason;
              active.status = reason.kind === 'stop' ? 'succeeded' : reason.kind;
              if (reason.kind === 'max-tokens') failure = new BridgeError('output_truncated', '模型输出达到上限，任务结果尚未完成。');
            }
            if (frame.type === 'end') finishAttempt();
          });
          // Retry ownership is local and bounded, rather than inherited from a chat.
          scope.on('agent/request-error', async ({ failure: problem }) => { failure = modelFailure(problem); return undefined; }, { prepend: true });
          scope.on('agent/error', ({ error }) => { failure ??= error; });
          scope.on('agent/turn-stopping', async ({ agent }) => {
            if (!captured && !failure && repairs++ < 1) {
              const text = missingSubmissionPrompt(submitTool);
              agent.steer(createUserMessage({ source: { kind: 'plugin', plugin: 'paper-radar' }, content: [{ type: 'text', text }] }));
              await recordContext({ kind: 'additional_message', source: 'dsh', delivery: 'queued_in_host', content: { role: 'user', text, condition: 'missing_submission' } });
            }
          });
        },
      });
      signal.throwIfAborted();
      handle.agent.followup(createUserMessage({ source: { kind: 'plugin', plugin: 'paper-radar' }, content: [{ type: 'text', text: input.prompt }] }));
      await recordContext({ kind: 'host_input', source: 'dsh', delivery: 'accepted_by_host', content: { ...hostContext('dsh', input), model: selected.model, provider: selected.provider, session_id: run.sessionId } });
      await handle.agent.whenIdle();
      finishAttempt(); await settled;
      signal.throwIfAborted();
      if (failure) throw failure;
      if (!captured) throw new BridgeError('invalid_output', 'Agent 未提交可用的结构化结果。');
      return { data: captured, providerId: selected.provider, modelId: selected.model, reasoningEffort: selected.reasoningEffort ?? null, sessionId: run.sessionId, runtimeId: this.models.runtimeId };
    } finally {
      run.compact = null;
      signal.removeEventListener('abort', abort);
      finishAttempt(); await settled;
      await handle?.dispose();
    }
  }
  async close() { this.unhook?.(); for (const run of this.runs.values()) run.controller.abort(); await Promise.allSettled([...this.runs.values()].map((r) => r.work)); }
}
