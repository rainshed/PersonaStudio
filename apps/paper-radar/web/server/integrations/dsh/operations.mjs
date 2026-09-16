import { AnalysisError, hash, safeError } from '../../analyses/contracts.mjs';
import { analysisRoute } from '../../analyses/http.mjs';
import { dailyRoute } from '../../daily/http.mjs';
import { schedulerRoute } from '../../daily/scheduler/http.mjs';
import { PROTOCOL } from '../../hosts/transport.mjs';

const reads = {
  subscriptions: '/api/subscriptions', reports: '/api/daily-reports', runs: '/api/daily-runs', jobs: '/api/jobs', analyses: '/api/analyses', feedback: '/api/analyses/feedback',
  job: '/api/jobs/:id', report: '/api/daily-reports/:id', run: '/api/daily-runs/:id', item: '/api/daily-items/:id', items: '/api/daily-runs/:id/items', analysis: '/api/analyses/:id',
};
const writes = {
  analyze: ['POST', '/api/analyses'], daily: ['POST', '/api/daily-runs'], detail: ['POST', '/api/daily-items/:id/analyze'],
  rescreen: ['POST', '/api/daily-items/:id/rescreen'],
  'cancel-job': ['POST', '/api/jobs/:id/cancel'], 'retry-job': ['POST', '/api/jobs/:id/retry'],
  'cancel-daily': ['POST', '/api/daily-runs/:id/cancel'], 'retry-daily': ['POST', '/api/daily-runs/:id/retry'],
  'check-updates': ['POST', '/api/subscriptions/:id/schedule/check'], 'continue-update': ['POST', '/api/schedule-updates/:id/process'],
};
function bounded(value, state, depth = 0) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') { if (value.length > 1800) state.truncated = true; return value.slice(0, 1800); }
  if (depth > 8) { state.truncated = true; return null; }
  if (Array.isArray(value)) { if (value.length > 25) state.truncated = true; return value.slice(0, 25).map((v) => bounded(v, state, depth + 1)); }
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['context', 'model_settings', 'prompt_snapshot', 'blocks', 'persona', 'records', 'retrieval', 'evidence', 'evidence_index'].includes(key)).map(([key, v]) => [key, bounded(v, state, depth + 1)]));
}
export class DshOperations {
  constructor({ analyses, daily, models, publicOrigin }) {
    Object.assign(this, { analyses, daily, models });
    this.base = publicOrigin ?? 'http://127.0.0.1:4317';
    this.db = analyses.db.db;
    this.pending = new Map();
    // Preserve idempotency and conversation links from the former table name.
    const table = (name) => this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    if (table('harness_requests') && !table('dsh_requests'))
      this.db.exec('ALTER TABLE harness_requests RENAME TO dsh_requests');
    this.db.exec('CREATE TABLE IF NOT EXISTS dsh_requests (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, session_id TEXT, runtime_id TEXT, created_at TEXT NOT NULL, response TEXT)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_dsh_requests_session ON dsh_requests(session_id, created_at DESC)');
  }
  link(kind, value) {
    const url = new URL(this.base), p = new URLSearchParams();
    let view = 'single-analysis';
    if (kind === 'run' || kind === 'report') { view = 'daily'; p.set('run', value.current_run_id ?? value.id); if (value.subscription?.id) p.set('subscription', value.subscription.id); }
    else if (kind === 'item') { view = 'daily'; p.set('paper', value.id); p.set('run', value.run_id); }
    else if (kind === 'job') p.set('job', value.id);
    else if (kind === 'analysis') p.set('job', value.job_id);
    url.hash = `${view}?${p}`; return url.href;
  }
  decorate(operation, value) {
    const kind = value.job ? 'job' : value.run ? 'run' : ['job', 'run', 'report', 'item', 'analysis'].includes(operation) ? operation : null;
    const object = value.job ?? value.run ?? value;
    const state = { truncated: false }, data = bounded(value, state);
    const card = kind && object.id ? { kind, id: object.id, title: object.paper?.title ?? object.subscription?.name ?? object.title ?? 'PaperRadar 任务', status: object.status ?? 'available', stage: object.message ?? '', updatedAt: object.updated_at ?? object.created_at, url: this.link(kind, object), actions: [] } : null;
    if (card && ['queued', 'running'].includes(card.status)) {
      const action = kind === 'job' ? 'cancel-job' : kind === 'run' ? 'cancel-daily' : null;
      if (action) card.actions.push({ operation: action, id: object.id, label: '取消任务' });
    }
    if (card && ['failed', 'interrupted', 'cancelled', 'partial'].includes(card.status) && object.error?.retryable !== false) {
      const action = kind === 'job' ? 'retry-job' : kind === 'run' ? 'retry-daily' : null;
      if (action) card.actions.push({ operation: action, id: object.id, label: '重试未完成部分' });
    }
    const result = { data, card, truncated: state.truncated, view: 'overview', source: 'PaperRadar', next_offset: value.next_offset ?? null };
    if (JSON.stringify(result).length > 35000) { result.data = { message: '内容较多，请缩小分页或打开完整页面。' }; result.truncated = true; }
    return result;
  }
  async dispatch(args) {
    const writing = args && (writes[args.operation] || ['set-feedback', 'withdraw-feedback'].includes(args.operation));
    if (!writing || !args.request_id) return this.performDispatch(args);
    const digest = hash({ op: args.operation, id: args.id, input: args.input ?? {}, query: args.query ?? {}, selection: args.selection });
    const pending = this.pending.get(args.request_id);
    if (pending) {
      if (pending.digest !== digest) throw new AnalysisError('conflict', '请求标识已用于其他参数。', false, 409);
      return pending.promise;
    }
    const promise = this.performDispatch(args);
    this.pending.set(args.request_id, { digest, promise });
    try { return await promise; } finally { this.pending.delete(args.request_id); }
  }
  async performDispatch(args) {
    if (!args || typeof args.operation !== 'string') throw new AnalysisError('invalid_request', '请选择明确操作。');
    const op = args.operation;
    if (op === 'status') return { protocol: PROTOCOL, model_mode: this.models.mode ?? 'unavailable', paperRadarUrl: this.base, settingsUrl: `${this.base}/#models`, capabilities: { single_analysis: true, daily: !!this.daily, discussion: false }, help: {
      analyze: { input: { arxiv_input: 'arXiv 编号或链接', scope: { tag_ids: [], tag_match: 'any' }, language: 'zh', summary_length: { min: 800, max: 1200 } } },
      daily: { input: { subscription_id: '来自 subscriptions', expected_subscription_revision: '使用订阅当前 revision', source: { kind: 'latest_announcement' } } },
      rescreen: 'id 使用 items 返回的论文候选 ID。按原批次模型、提示词和知识快照重新判断本篇；旧报告与反馈保留。若需要采用新设置，请明确发起新的 daily 批次。',
      evidence: 'id 为报告 ID，query.evidence_id 为返回内容中的真实引用 ID；query.kind=version 查询初筛证据。',
      feedback: 'set-feedback/withdraw-feedback 的 id 为报告或初筛版本 ID，query.dimension 仅支持 accuracy（推荐判断），query.kind=version 指向初筛版本。',
    } };
    if (op === 'models') return this.models.config();
    const query = args.query ?? {}, input = args.input ?? {};
    const limit = Number(query.limit ?? 10), offset = Number(query.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 25 || !Number.isInteger(offset) || offset < 0 || offset > 100000) throw new AnalysisError('invalid_request', '每页最多 25 项，请使用有效分页参数。');
    if (op === 'session-links') return { links: this.db.prepare('SELECT response,created_at FROM dsh_requests WHERE session_id=? AND response IS NOT NULL ORDER BY created_at DESC LIMIT ? OFFSET ?').all(args.host?.sessionId ?? '', limit, offset).map((r) => ({ card: JSON.parse(r.response).card, created_at: r.created_at })).filter((entry) => entry.card?.kind !== 'discussion'), next_offset: offset + limit };
    let route = reads[op] ? ['GET', reads[op]] : writes[op];
    if (op === 'evidence' || ['set-feedback', 'withdraw-feedback'].includes(op)) {
      const root = query.kind === 'version' ? 'daily-item-versions' : 'analyses';
      const suffix = op === 'evidence' ? `evidence/${encodeURIComponent(query.evidence_id ?? '')}` : `feedback/${encodeURIComponent(query.dimension ?? '')}`;
      route = [op === 'evidence' ? 'GET' : op === 'set-feedback' ? 'PUT' : 'DELETE', `/api/${root}/:id/${suffix}`];
    }
    if (!route) throw new AnalysisError('invalid_request', '不支持的 PaperRadar 操作。');
    const [method, pattern] = route;
    if (pattern.includes(':id') && (typeof args.id !== 'string' || !/^[\w.-]{1,160}$/.test(args.id))) throw new AnalysisError('invalid_request', '请提供查询得到的业务对象 ID。');
    const url = new URL(pattern.replace(':id', encodeURIComponent(args.id)), 'http://127.0.0.1');
    for (const [key, value] of Object.entries({ ...query, limit, offset })) if (['limit', 'offset', 'subscription_id', 'date', 'decision', 'status', 'query', 'dimension', 'value'].includes(key)) url.searchParams.set(key, String(value));
    const writing = method !== 'GET', digest = hash({ op, id: args.id, input, query, selection: args.selection });
    if (writing) {
      if (!/^[\w-]{8,120}$/.test(args.request_id ?? '')) throw new AnalysisError('invalid_request', '写操作需要稳定的请求标识。');
      const old = this.db.prepare('SELECT request_hash,response FROM dsh_requests WHERE id=?').get(args.request_id);
      if (old) {
        if (old.request_hash !== digest) throw new AnalysisError('conflict', '请求标识已用于其他参数。', false, 409);
        if (!old.response) throw new AnalysisError('outcome_unknown', '此前请求结果待核对，请先查看原业务任务。', false, 409);
        const recorded = JSON.parse(old.response);
        if (recorded.error) throw new AnalysisError(recorded.error.code, recorded.error.message, recorded.error.retryable);
        return { ...recorded, replayed: true };
      }
    }
    const perform = async () => {
      if (writing) this.db.prepare('INSERT INTO dsh_requests VALUES (?,?,?,?,?,NULL)').run(args.request_id, digest, args.host?.sessionId ?? null, args.host?.runtimeId ?? null, new Date().toISOString());
      try {
        const req = { method, headers: { 'idempotency-key': args.request_id } }, read = async () => input;
        const handler = /^\/api\/(subscriptions\/[^/]+\/schedule|schedule-updates)/.test(url.pathname) ? () => schedulerRoute(this.daily.scheduler, req, url, read)
          : /^\/api\/(daily-|subscriptions)/.test(url.pathname) ? () => dailyRoute(this.daily, req, url, read)
          : () => analysisRoute(this.analyses, req, url, read);
        const response = await handler();
        if (!response || response.status >= 400) throw new AnalysisError(response?.body?.code ?? 'not_found', response?.body?.error ?? '对象不存在。');
        let value = response.body;
        if (op === 'evidence') {
          const start = Number(query.text_offset ?? 0);
          if (!Number.isInteger(start) || start < 0) throw new AnalysisError('invalid_request', '证据分页无效。');
          const text = value.text ?? '';
          value = { ...value, text: text.slice(start, start + 1600), text_offset: start, next_text_offset: start + 1600 < text.length ? start + 1600 : null };
        }
        const result = this.decorate(op, value);
        if (writing) this.db.prepare('UPDATE dsh_requests SET response=? WHERE id=?').run(JSON.stringify(result), args.request_id);
        return result;
      } catch (e) {
        // Record the failure: retrying a transport request must not execute a second action.
        if (writing) this.db.prepare('UPDATE dsh_requests SET response=? WHERE id=?').run(JSON.stringify({ error: safeError(e), card: null }), args.request_id);
        throw e;
      }
    };
    return this.models.mode === 'dsh' && ['analyze', 'daily', 'detail', 'continue-update'].includes(op)
      ? this.models.withContext({ sessionId: args.host?.sessionId, explicit: args.selection, parent: ['analyze', 'detail'].includes(op) ? 'single' : undefined }, perform)
      : perform();
  }
}
