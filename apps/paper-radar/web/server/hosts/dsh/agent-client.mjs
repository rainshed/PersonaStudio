import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chmod, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError, PROTOCOL, readJson, sendJson } from '../transport.mjs';

export class AgentClient {
  constructor(models) { this.models = models; this.tasks = new Map(); this.path = join(models.directory, `agent-${process.pid}.sock`); }
  async open() {
    if (this.opening) return this.opening;
    this.opening = (async () => {
      // Keep Unix socket paths below platform limits, even for a long data directory.
      this.socketDirectory = await mkdtemp(join(tmpdir(), 'pr-host-'));
      await chmod(this.socketDirectory, 0o700);
      this.path = join(this.socketDirectory, 'callback.sock');
      const server = this.server = createServer(async (req, res) => {
        try {
          if (req.method !== 'POST' || req.url !== '/agent/callback' || req.headers['x-paper-radar-protocol'] !== PROTOCOL) throw new BridgeError('protocol_error', 'Agent 回调协议不兼容。');
          const data = await readJson(req), task = this.tasks.get(data.id);
          if (!task || data.token !== task.token) throw new BridgeError('not_found', 'Agent 任务已关闭。', false, 404);
          task.signal.throwIfAborted();
          let value;
          if (data.kind === 'reserve') value = await task.reserve(data.attempt);
          else if (data.kind === 'attempt') value = task.attempt(data.attempt);
          else if (data.kind === 'tool') value = await task.tool(data.tool, data.args);
          else if (data.kind === 'context') value = task.context(data.event);
          else throw new BridgeError('invalid_request', '未知 Agent 回调。');
          sendJson(res, 200, value ?? { ok: true });
        } catch (e) { sendJson(res, e.httpStatus ?? 400, { code: e.code ?? 'agent_callback_error', message: e.message, retryable: !!e.retryable }); }
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(this.path, resolve); });
      await chmod(this.path, 0o600);
    })();
    return this.opening;
  }
  async run(request, options, connection) {
    await this.open();
    const id = randomUUID(), token = randomUUID();
    const lifecycle = new AbortController();
    const signal = AbortSignal.any([lifecycle.signal, this.models.shutdown.signal, ...(options.signal ? [options.signal] : [])]);
    const attempts = new Map();
    const record = (value) => {
      const pending = attempts.get(value.id);
      if (!pending || pending.done) return { recorded: true };
      pending.done = true;
      try {
        const attempt = { ...pending.value, ...value, connection_id: connection.id, attempt_unit: 'model-attempt' };
        options.onAttempt?.(attempt);
        this.models.runs.push({ ...attempt, connectionName: connection.name, modelId: connection.modelId, at: attempt.started_at, durationMs: attempt.duration_ms });
        this.models.runs = this.models.runs.slice(-100);
      } finally { pending.release(); }
      return { recorded: true };
    };
    const task = {
      token, signal,
      async reserve(attempt) {
        attempt = { ...attempt, attempt_unit: 'model-attempt' };
        if (!attempt?.id || attempts.has(attempt.id)) throw new BridgeError('duplicate_attempt', '模型尝试标识重复。');
        const release = await task.acquire(signal);
        try {
          signal.throwIfAborted();
          await options.beforeAttempt?.(connection, attempt);
          attempts.set(attempt.id, { value: attempt, release, done: false });
          options.onProgress?.({ phase: 'judging', session_id: `paper-radar-${id}` });
          return { admitted: true };
        } catch (e) { release(); throw e; }
      },
      acquire: (s) => this.models.acquire(s, options.priority), attempt: record,
      tool: (name, args) => options.onTool(name, args, signal),
      context: (event) => { options.onContext?.(event); return { recorded: true }; },
    };
    this.tasks.set(id, task);
    const ref = { id, token };
    let done = false;
    try {
      signal.throwIfAborted();
      let state = await this.models.call('/agent/start', { ...ref, callbackPath: this.path, contextRecording: !!options.onContext, task: request.task, tools: request.tools, submitTool: request.submitTool, maxAttempts: request.maxAttempts, executionMs: request.executionMs, selection: { provider: connection.providerId, model: connection.modelId, ...(connection.reasoningEffort ? { reasoningEffort: connection.reasoningEffort } : {}) }, prompt: request.prompt, systemPrompt: request.systemPrompt, maxTokens: Math.min(request.maxTokens ?? 4096, connection.maxTokens) }, { signal });
      while (state.status === 'running') {
        options.onProgress?.({ phase: 'judging', session_id: state.sessionId, step: state.step });
        await delay(300, undefined, { signal });
        // Reads may be retried; submission and model admissions are never replayed.
        let lastError;
        for (let retry = 0; retry < 3; retry++) {
          try { state = await this.models.call('/agent/status', ref, { signal }); lastError = null; break; }
          catch (e) { lastError = e; if (e.code === 'agent_run_missing' || signal.aborted) break; await delay(300, undefined, { signal }); }
        }
        if (lastError) throw lastError;
      }
      signal.throwIfAborted(); done = true;
      if (state.status !== 'completed') throw new BridgeError(state.error?.code ?? 'agent_failed', state.error?.message ?? '论文 Agent 执行未完成。', !!state.error?.retryable);
      return { ...state.result, connectionId: connection.id, requestId: id, text: JSON.stringify(state.result.data) };
    } finally {
      const interrupted = signal.aborted;
      lifecycle.abort();
      if (!done) await this.models.call('/agent/cancel', ref, { timeout: 5000 }).catch(() => {});
      for (const [attemptId, pending] of attempts) if (!pending.done) record({ id: attemptId, status: interrupted ? 'interrupted' : 'unknown', usage: null, duration_ms: Date.now() - Date.parse(pending.value.started_at) });
      this.tasks.delete(id);
    }
  }
  async close() {
    await this.opening?.catch(() => {});
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise((resolve) => this.server.close(resolve));
    await unlink(this.path).catch(() => {});
    await rm(this.socketDirectory, { recursive: true, force: true });
  }
}
