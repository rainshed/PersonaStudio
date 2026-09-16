import { EvaluationCases } from '../evaluations/cases.mjs';
import { DailyRepository } from '../daily/repository.mjs';
import { requireHostSettings } from '../hosts/execution.mjs';
import { executeAutonomous } from './autonomous.mjs';
import { TaskRuntime } from '../tasks/runtime.mjs';
import { taskLane } from '../tasks/policy.mjs';
import { AUTONOMOUS_VERSION } from '../agents/research-tools.mjs';
import {
  taskFingerprint,
  promptFingerprint,
  promptIdFor,
} from '../agents/autonomous-task.mjs';
import { PromptStore } from '../prompts/store.mjs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveConnection } from '../../lib/host-models.ts';
import {
  AnalysisError,
  hash,
  validateInput,
  feedbackDimensions,
  safeError,
} from './contracts.mjs';

const finished = new Set([
  'succeeded',
  'partial',
  'failed',
  'cancelled',
  'interrupted',
]);
function publicJob(job) {
  const {
    model_settings: _modelSettings,
    prompt_snapshot: _prompts,
    ...safe
  } = job;
  safe.prompt_fingerprint = _prompts?.fingerprint ?? null;
  return safe;
}
export class AnalysisService {
  constructor(
    db,
    models,
    arxiv,
    persona,
    // Full analyses finish on submission, cancellation or error. Explicit limits
    // remain available to isolated experiments and tests; null means unlimited.
    { maxAttempts = null, executionMs = null } = {},
  ) {
    this.db = db;
    this.prompts = new PromptStore(join(db.directory, 'prompts'));
    this.models = models;
    this.arxiv = arxiv;
    this.persona = persona;
    this.maxAttempts = maxAttempts;
    this.executionMs = executionMs;
    this.controllers = new Map();
    this.shutdown = new AbortController();
    this.work = null;
    this.taskRuntime = new TaskRuntime({
      subscribe: (listener) => models.onConcurrencyChange?.(listener),
    });
    this.taskQueue = this.taskRuntime.register('analysis', {
      signal: this.shutdown.signal,
      stop: () => this.shutdown.abort(),
      pending: () => this.db.queuedAll(),
      get: (id) => this.db.job(id),
      run: (job) => this.execute(job),
      priority: (job) => (job.origin?.trigger === 'scheduled' ? 0 : 20),
      ...taskLane(models, 'analysis'),
      onError: (job, error) => {
        const latest = this.db.job(job.id);
        if (!latest || finished.has(latest.status)) return;
        latest.status = this.shutdown.signal.aborted ? 'interrupted' : 'failed';
        latest.error = safeError(error);
        latest.message = latest.error.message;
        const result = this.db.result(latest.result_id);
        for (const component of ['summary', 'personalization'])
          if (result?.[component]?.status === 'pending')
            result[component] = { status: 'failed', error: latest.error };
        this.persist(latest, result);
      },
    });
  }
  start() {
    this.pump();
  }
  create(raw, key, retryOf = null, internal = {}) {
    if (this.shutdown.signal.aborted)
      throw new AnalysisError(
        'unavailable',
        '服务正在关闭，请稍后重试。',
        true,
        503,
      );
    if (typeof key !== 'string' || !/^[\w-]{8,120}$/.test(key))
      throw new AnalysisError('invalid_request', '缺少有效的请求幂等标识。');
    const input = validateInput(raw),
      requestHash = hash({
        input,
        retryOf,
        ...(internal.origin ? { origin: internal.origin } : {}),
      }),
      existing = this.db.existing(key);
    if (existing) {
      if (existing.hash !== requestHash)
        throw new AnalysisError(
          'conflict',
          '该请求标识已用于不同的分析设置。',
          false,
          409,
        );
      return { job: publicJob(existing.job), reused: true };
    }
    const settings = structuredClone(
      requireHostSettings(
        internal.settings ?? this.models.store.state.settings,
      ),
    );
    requireHostSettings(settings);
    const pipeline = AUTONOMOUS_VERSION;
    if (!resolveConnection(settings, 'single'))
      throw new AnalysisError(
        'not_configured',
        '请先在宿主设置中选择单篇分析模型。',
      );
    const promptSnapshot = internal.promptSnapshot ?? this.prompts.snapshot();
    const fingerprint = taskFingerprint(settings, 'single');
    const promptsFingerprint = promptFingerprint(
      promptSnapshot,
      promptIdFor('single'),
      { task: { input } },
    );
    if (!retryOf && !input.force_regenerate) {
      const active = this.db.db
        .prepare("SELECT data FROM jobs WHERE status IN ('queued','running')")
        .all()
        .map((row) => JSON.parse(row.data))
        .find(
          (job) =>
            job.pipeline_version === pipeline &&
            job.model_fingerprint === fingerprint &&
            (job.task_prompt_fingerprint ??
              job.prompt_snapshot?.fingerprint) === promptsFingerprint &&
            hash(job.input) === hash(input) &&
            hash(job.origin ?? null) === hash(internal.origin ?? null),
        );
      if (active) {
        this.db.aliasRequest(key, active.id, requestHash);
        return { job: publicJob(active), reused: true };
      }
    }
    const queued = this.db.db
      .prepare(
        "SELECT count(*) AS n FROM jobs WHERE status IN ('queued','running')",
      )
      .get().n;
    if (queued >= 50)
      throw new AnalysisError(
        'queue_full',
        '任务队列已满，请等待当前任务完成。',
        true,
        429,
      );
    const id = 'job-' + randomUUID(),
      at = new Date().toISOString();
    const job = {
      id,
      pipeline_version: pipeline,
      task_prompt_fingerprint: promptsFingerprint,
      input,
      status: 'queued',
      step: 'queued',
      message: '等待分析',
      stages: [['agent', '自主分析']].map(([id, label]) => ({
        id,
        label,
        status: 'pending',
      })),
      prompt_snapshot: promptSnapshot,
      model_settings: settings,
      model_fingerprint: fingerprint,
      created_at: at,
      updated_at: at,
      result_id: null,
      error: null,
      retry_of: retryOf,
      actual_attempts: 0,
      ...(internal.origin ? { origin: internal.origin } : {}),
    };
    this.db.insertJob(job, key, requestHash);
    this.pump();
    return { job: publicJob(job), reused: false };
  }
  getJob(id) {
    const job = this.db.job(id);
    if (!job) throw new AnalysisError('not_found', '任务不存在。', false, 404);
    return publicJob(job);
  }
  listJobs(limit, offset) {
    return this.db.listJobs(limit, offset).map(publicJob);
  }
  getResult(id) {
    const result = this.db.result(id);
    if (!result)
      throw new AnalysisError('not_found', '结果不存在。', false, 404);
    const { evidence, ...safe } = result;
    return {
      ...safe,
      persona: safe.persona ? { ...safe.persona, evidence: undefined } : null,
      evidence_index: evidence.map(({ text: _text, ...entry }) => entry),
      feedback: this.recommendationEvaluations().feedbackFor(id),
      feedback_dimensions: feedbackDimensions(result),
      attempts: this.db.attempts(result.job_id),
    };
  }
  evidence(id, evidenceId) {
    const result = this.db.result(id);
    const e = result?.evidence.find((e) => e.id === evidenceId);
    if (!e)
      throw new AnalysisError('not_found', '该结果没有此证据。', false, 404);
    return e;
  }
  cancel(id) {
    const job = this.db.job(id);
    if (!job) throw new AnalysisError('not_found', '任务不存在。', false, 404);
    if (!finished.has(job.status)) {
      job.status = 'cancelled';
      job.message = '已取消';
      for (const stage of job.stages)
        if (['running', 'pending'].includes(stage.status))
          stage.status = 'cancelled';
      const result = this.db.result(job.result_id);
      this.db.transaction(() => {
        if (result) {
          for (const key of ['summary', 'personalization'])
            if (result[key].status === 'pending')
              result[key] = {
                status: 'failed',
                error: {
                  code: 'cancelled',
                  message: '本次任务已取消，可重试。',
                  retryable: true,
                },
              };
          this.db.saveResult(result);
        }
        this.db.saveJob(job);
      });
      this.onJobChanged?.(job);
      this.controllers.get(id)?.abort();
    }
    return publicJob(job);
  }
  retry(id, key) {
    const j = this.db.job(id);
    if (!j) throw new AnalysisError('not_found', '任务不存在。', false, 404);
    if (j.origin?.daily_run_id)
      throw new AnalysisError(
        'conflict',
        '该任务属于日报，请对这篇论文使用详细分析入口重试。',
        false,
        409,
      );
    if (!finished.has(j.status))
      throw new AnalysisError('conflict', '任务尚在运行。', false, 409);
    return this.create({ ...j.input, force_regenerate: false }, key, id, {
      settings: requireHostSettings(j.model_settings),
      promptSnapshot: j.prompt_snapshot,
    });
  }
  recommendationEvaluations() {
    this.evaluations ??= new EvaluationCases({ analyses: this, repo: new DailyRepository(this.db) });
    return this.evaluations;
  }
  feedback(id, dimension, raw) {
    const result = this.db.result(id);
    if (!result) throw new AnalysisError('not_found', '结果不存在。', false, 404);
    if (dimension !== 'accuracy' || !feedbackDimensions(result).includes(dimension))
      throw new AnalysisError('invalid_request', '目前仅支持对已完成的推荐或不推荐判断反馈。');
    return this.recommendationEvaluations().feedback(id, raw).feedback;
  }
  pump() {
    this.work = this.taskQueue.wake();
  }
  persist(job, result) {
    if (this.db.job(job.id)?.status === 'cancelled') return false;
    this.db.transaction(() => {
      if (result) this.db.saveResult(result);
      this.db.saveJob(job);
    });
    this.onJobChanged?.(job);
    return true;
  }
  async execute(job) {
    job.model_settings = requireHostSettings(job.model_settings);
    return executeAutonomous(this, job);
  }
  async close() {
    await this.personaSettings?.close();
    this.shutdown.abort();
    await this.taskQueue.close();
    await this.taskRuntime.close();
    await this.persona.close();
    this.prompts.close();
  }
}
