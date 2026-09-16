import { requireHostSettings } from '../hosts/execution.mjs';
import { recoverDaily } from '../tasks/recovery.mjs';
import { EvaluationService } from '../evaluations/service.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import subjects from './subjects.json' with { type: 'json' };
import { AnalysisError, hash, safeError } from '../analyses/contracts.mjs';
import { resolveConnection } from '../../lib/host-models.ts';
import { DailyRepository } from './repository.mjs';
import { DailyDiscovery } from './discovery.mjs';
import { followedAuthorsSchema } from '../../lib/contracts/analysis.ts';
import { authorNameKey, matchedFollowedAuthors, uniqueAuthorNames } from '../../lib/author-following.ts';
import { discoverSubjects } from './subject-bundle.mjs';
import {
  paperFingerprint,
  screenModelFingerprint,
} from './scheduler/source-check.mjs';
import { PERSONA_CONTEXT_VERSION } from '../persona/service.mjs';
import {
  screenWithAgent,
  screeningPromptFingerprint,
} from './agent-screening.mjs';
import { modelConcurrency, runConcurrent } from '../concurrency.mjs';
import { AGENT_SCREEN_VERSION } from '@paper-radar/host-contract/agent-contract';
import {
  subscriptionSubjects,
  sameSubjects,
} from '../../lib/subscription-subjects.ts';
import {
  activeRun,
  now,
  requestKey,
  validateSubscription,
  runSchema,
} from './contracts.mjs';

const cleanRun = (run) => {
  const {
    model_settings: _settings,
    context: _context,
    prompt_snapshot: _prompts,
    ...safe
  } = run;
  return { ...safe, prompt_fingerprint: _prompts?.fingerprint ?? null };
};
const terminalJob = (status) => !['queued', 'running'].includes(status);
export class DailyService {
  constructor(analyses, { discovery, pollMs = 500 } = {}) {
    this.analyses = analyses;
    this.models = analyses.models;
    this.persona = analyses.persona;
    this.repo = new DailyRepository(analyses.db);
    this.evaluations = new EvaluationService(this);
    analyses.evaluations = this.evaluations;
    this.discovery = discovery ?? new DailyDiscovery(analyses.arxiv, this.repo);
    this.pollMs = pollMs;
    this.work = null;
    this.controllers = new Map();
    this.shutdown = new AbortController();
    this.taskQueue = analyses.taskRuntime.register('daily', {
      signal: this.shutdown.signal,
      stop: () => this.shutdown.abort(),
      pending: () => this.repo.queuedAll(),
      get: (id) => this.repo.get('daily_runs', id, false),
      run: (run) => this.execute(run),
      priority: (run) => (run.origin?.kind === 'scheduled' ? 0 : 10),
      group: () => 'daily-orchestration',
      concurrency: () => 2,
      exclusive: (run) => `subscription:${run.subscription.id}`,
      onError: (run, error) => {
        const latest = this.repo.get('daily_runs', run.id, false);
        if (!latest || !activeRun(latest.status)) return;
        latest.status = this.shutdown.signal.aborted ? 'interrupted' : 'failed';
        latest.error = safeError(error);
        latest.message = latest.error.message;
        this.repo.saveRun(latest);
      },
    });
    this.analyses.beforeDailyAttempt = (job) => {
      if (job.origin?.daily_run_id && job.origin.trigger !== 'manual')
        this.repo.reserve(job.origin.daily_run_id);
    };
    this.analyses.onDailyAttempt = (job, value) => {
      if (job.origin?.daily_run_id && job.origin.trigger !== 'manual')
        this.repo.attempt(job.origin.daily_run_id, {
          ...value,
          item_id: job.origin.daily_item_id,
        });
    };
    this.analyses.onJobChanged = (job) => this.syncAnalysis(job);
    for (const item of this.repo.db
      .prepare('SELECT data FROM daily_items WHERE job_id IS NOT NULL')
      .all()) {
      const job = this.analyses.db.job(JSON.parse(item.data).job_id);
      if (job) this.syncAnalysis(job);
    }
    recoverDaily(this.repo);
  }
  catalog() {
    return subjects;
  }
  get workflowVersion() {
    return AGENT_SCREEN_VERSION;
  }
  async saveSubscription(raw, id) {
    const old = id ? this.repo.get('subscriptions', id) : null;
    const { expected_revision, ...patch } = raw;
    // Explicit subjects replaces the entire selection; legacy subject patches
    // still replace it with one category. Unrelated patches preserve the set.
    if (Object.hasOwn(patch, 'subjects')) patch.subject = patch.subjects?.[0];
    else if (Object.hasOwn(patch, 'subject')) patch.subjects = [patch.subject];
    if (old && expected_revision !== old.revision)
      throw new AnalysisError(
        'conflict',
        '订阅已被修改，请刷新后重试。',
        false,
        409,
      );
    const settings = validateSubscription(
      old ? { ...this.subscriptionInput(old), ...patch } : patch,
      subjects.subjects,
    );
    let tags = old?.tags ?? [];
    if (settings.status === 'enabled') {
      const range = await this.persona.scopeReader(
        settings,
        AbortSignal.timeout(90000),
      );
      tags = range.tags;
      settings.persona_reselection_required = false;
    }
    // Another request may have saved while the MCP request was in progress.
    if (old && this.repo.get('subscriptions', id).revision !== old.revision)
      throw new AnalysisError(
        'conflict',
        '订阅已被修改，请刷新后重试。',
        false,
        409,
      );
    return this.repo.saveSubscription({
      ...settings,
      id: old?.id ?? 'subscription-' + randomUUID(),
      tags,
      revision: (old?.revision ?? 0) + 1,
      created_at: old?.created_at ?? now(),
      updated_at: now(),
    });
  }
  subscriptionInput(s) {
    const {
      id: _id,
      tags: _tags,
      revision: _revision,
      created_at: _created,
      updated_at: _updated,
      ...settings
    } = s;
    return settings;
  }
  saveFollowedAuthors(id, raw) {
    const old = this.repo.get('subscriptions', id);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.keys(raw).some((key) => !['expected_revision', 'followed_authors'].includes(key)))
      throw new AnalysisError('invalid_request', '作者关注设置无效。');
    if (raw.expected_revision !== old.revision)
      throw new AnalysisError('conflict', '订阅已被修改，请刷新后重试。', false, 409);
    const result = followedAuthorsSchema.safeParse(raw.followed_authors);
    if (!result.success)
      throw new AnalysisError('invalid_settings', '请填写完整作者姓名，每个姓名最多 150 字，最多关注 200 位作者。');
    // Following is a metadata filter and remains usable without Persona or a host.
    return this.repo.saveSubscription({
      ...old,
      followed_authors: uniqueAuthorNames(result.data),
      revision: old.revision + 1,
      updated_at: now(),
    });
  }
  followedAuthorFeed(id, { limit = 25, offset = 0, author = '' } = {}) {
    const subscription = this.repo.get('subscriptions', id);
    const all = this.repo.followedAuthorPapers(subscription);
    const papers = author ? all.filter((paper) =>
      paper.matched_authors.some((name) => authorNameKey(name) === authorNameKey(author))) : all;
    return {
      papers: papers.slice(offset, offset + limit),
      total: papers.length,
      next_offset: offset + limit < papers.length ? offset + limit : null,
      sources: this.repo.authorSources(subscriptionSubjects(subscription)),
    };
  }
  async refreshFollowedAuthors(id, options = {}) {
    const subscription = this.repo.get('subscriptions', id);
    if (!subscription.followed_authors?.length) return this.followedAuthorFeed(id, options);
    const subjects = subscriptionSubjects(subscription);
    const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(600000)]);
    const failures = new Map();
    for (const subject of subjects) {
      signal.throwIfAborted();
      try {
        const revision = await this.discovery.latest(subject, signal);
        if (revision.subject !== subject)
          throw new AnalysisError('invalid_feed', '公告分类与订阅不一致。', true);
      } catch (error) {
        signal.throwIfAborted();
        failures.set(subject, safeError(error).message);
      }
    }
    const feed = this.followedAuthorFeed(id, options);
    return {
      ...feed,
      sources: feed.sources.map((source) => failures.has(source.subject)
        ? { ...source, completeness: 'failed', issues: [failures.get(source.subject)] }
        : source),
    };
  }
  create(raw, key) {
    requestKey(key);
    if (this.shutdown.signal.aborted)
      throw new AnalysisError('unavailable', '服务正在关闭。', true, 503);
    const checked = runSchema.safeParse(raw);
    if (!checked.success)
      throw new AnalysisError(
        'invalid_request',
        '日报创建参数无效；公告日期须是真实日期且不晚于今天。',
      );
    const input = checked.data,
      requestHash = hash({ action: 'create', input }),
      old = this.repo.runForKey(key, requestHash);
    if (old) return { run: this.getRun(old.id), reused: true };
    const subscription = this.repo.get('subscriptions', input.subscription_id);
    if (subscription.revision !== input.expected_subscription_revision)
      throw new AnalysisError(
        'conflict',
        '订阅已修改，请刷新后重新生成。',
        false,
        409,
      );
    if (subscription.status !== 'enabled' || !subscription.scope.tag_ids.length)
      throw new AnalysisError('empty_scope', '请先选择有效标签并启用订阅。');
    const settings = structuredClone(this.models.store.state.settings);
    if (['screen'].some((task) => !resolveConnection(settings, task)))
      throw new AnalysisError('not_configured', '请先配置每日筛选使用的模型。');
    const fingerprint = screenModelFingerprint(settings);
    const promptSnapshot = this.analyses.prompts.snapshot();
    const active = this.repo
      .runs({ subscriptionId: subscription.id, limit: 10000 })
      .find(
        (r) =>
          activeRun(r.status) &&
          r.workflow_version === this.workflowVersion &&
          r.subscription.revision === subscription.revision &&
          r.model_fingerprint === fingerprint &&
          (this.workflowVersion === AGENT_SCREEN_VERSION
            ? screeningPromptFingerprint(
                r.prompt_snapshot,
                undefined,
                r.subscription,
              ) ===
              screeningPromptFingerprint(
                promptSnapshot,
                undefined,
                subscription,
              )
            : r.prompt_snapshot?.fingerprint === promptSnapshot.fingerprint) &&
          JSON.stringify(r.source) === JSON.stringify(input.source) &&
          r.force_regenerate === input.force_regenerate,
      );
    if (active) {
      this.repo.addRequest(key, requestHash, active.id);
      return { run: this.getRun(active.id), reused: true };
    }
    const run = {
      id: 'dailyrun-' + randomUUID(),
      workflow_version: this.workflowVersion,
      prompt_snapshot: promptSnapshot,
      report_id: null,
      subscription: structuredClone(subscription),
      source: input.source,
      ...(input.source.kind === 'announcement_date'
        ? { date: input.source.date }
        : {}),
      force_regenerate: input.force_regenerate,
      model_settings: settings,
      model_fingerprint: fingerprint,
      status: 'queued',
      message:
        input.source.kind === 'announcement_date'
          ? `等待读取 ${input.source.date} 的公告批次`
          : '等待读取公告批次',
      created_at: now(),
      actual_attempts: 0,
      max_model_calls: subscription.max_model_calls,
      context: null,
      error: null,
      cycle: 0,
    };
    this.repo.analysisDb.transaction(() => {
      this.repo.saveRun(run);
      this.repo.addRequest(key, requestHash, run.id);
    });
    this.pump();
    return { run: this.getRun(run.id), reused: false };
  }
  prepareStoredRun(subscription, revision, origin) {
    if (this.shutdown.signal.aborted)
      throw new AnalysisError('unavailable', '服务正在关闭。', true, 503);
    if (subscription.status !== 'enabled' || !subscription.scope.tag_ids.length)
      throw new AnalysisError('empty_scope', '请先选择有效标签并启用订阅。');
    if (!sameSubjects(subscription, revision))
      throw new AnalysisError('invalid_source', '公告范围与订阅不一致。');
    const settings = structuredClone(this.models.store.state.settings);
    if (!resolveConnection(settings, 'screen'))
      throw new AnalysisError('not_configured', '请先配置每日筛选使用的模型。');
    return {
      id: 'dailyrun-' + randomUUID(),
      workflow_version: this.workflowVersion,
      prompt_snapshot: this.analyses.prompts.snapshot(),
      report_id: null,
      subscription: structuredClone(subscription),
      source: {
        kind: 'stored_batch',
        batch_id: revision.batch_id,
        revision_id: revision.id,
      },
      force_regenerate: false,
      model_settings: settings,
      model_fingerprint: screenModelFingerprint(settings),
      status: 'queued',
      message: '等待自动初筛',
      created_at: now(),
      actual_attempts: 0,
      max_model_calls: subscription.max_model_calls,
      context: null,
      error: null,
      cycle: 0,
      origin,
    };
  }
  // Caller owns the SQLite transaction. No network or model work occurs here.
  admitStoredRevision(run, revision) {
    const bound = this.repo.bindReport(run, revision, true);
    if (bound.reused) return { run: bound.reused, reused: true };
    const previous = this.repo
      .runs({ subscriptionId: run.subscription.id, limit: 10000 })
      .filter((r) => r.id !== run.id);
    const known = new Map();
    for (const old of previous)
      for (const item of this.repo.items(old.id)) {
        const fp = paperFingerprint(item.paper);
        if (!known.has(fp)) known.set(fp, { item, run: old });
      }
    for (const item of this.repo.items(run.id)) {
      const old = known.get(paperFingerprint(item.paper));
      if (
        run.workflow_version !== AGENT_SCREEN_VERSION &&
        !item.excluded &&
        old &&
        !old.item.screening_version_id &&
        !old.item.excluded
      ) {
        item.execution_policy = 'manual_resume_required';
        item.previous_item_id = old.item.id;
        item.processing_status = 'failed';
        item.error = {
          code: 'manual_resume_required',
          message: '该论文此前未完成，需明确继续；本次更新不会自动重试。',
          retryable: true,
        };
        this.repo.saveItem(item);
      }
    }
    return { run: this.repo.get('daily_runs', run.id), reused: false };
  }
  getRun(id) {
    let run = this.repo.get('daily_runs', id);
    if (run.reused_run_id) run = this.repo.get('daily_runs', run.reused_run_id);
    const items = this.repo.items(run.id),
      candidates = items.filter((i) => !i.excluded),
      attempts = this.repo.attempts(run.id);
    const revision = run.revision_id
      ? this.repo.get('arxiv_batch_revisions', run.revision_id)
      : null;
    const currentSubscription = this.repo.get('subscriptions', run.subscription.id, false) ?? run.subscription;
    const summary = {
      total: candidates.length,
      followed_authors: items.filter((item) => matchedFollowedAuthors(item.paper,
        currentSubscription).length).length,
      screened: candidates.filter((i) => i.screening_version_id).length,
      screening_pending: candidates.filter((i) => !i.screening_version_id)
        .length,
      needs_confirmation: candidates.filter(
        (i) => i.screening_version_id && !i.final_decision,
      ).length,
      details_active: candidates.filter((i) =>
        ['queued', 'running'].includes(i.details_status),
      ).length,
      recommended: candidates.filter((i) => i.final_decision === 'recommended')
        .length,
      not_recommended: candidates.filter(
        (i) => i.final_decision === 'not_recommended',
      ).length,
      pending: candidates.filter((i) => !i.final_decision).length,
      details_complete: candidates.filter(
        (i) => i.details_status === 'available',
      ).length,
      excluded: items.length - candidates.length,
      failed: candidates.filter((i) =>
        ['failed', 'needs_review'].includes(i.processing_status),
      ).length,
      reused: candidates.filter((i) => i.screening_reuse?.reused).length,
    };
    return {
      ...cleanRun(run),
      stats: summary,
      discovery: revision
        ? {
            batch_id: revision.batch_id,
            revision_id: revision.id,
            date: revision.date,
            subject: subscriptionSubjects(revision)[0],
            subjects: subscriptionSubjects(revision),
            sources: revision.sources ?? [],
            cross_subject_duplicates: revision.cross_subject_duplicates ?? 0,
            completeness: revision.completeness,
            issues: revision.issues,
            coverage_basis: revision.coverage_basis,
            source_url: revision.source_url,
            raw_count: revision.raw_count,
            duplicates: revision.duplicates,
            rejected: revision.rejected,
          }
        : null,
      persona: run.context
        ? {
            identity: run.context.identity,
            revision: run.context.revision,
            tags: run.context.tags,
            coverage: run.context.coverage,
          }
        : null,
      usage: {
        requests: run.actual_attempts,
        recorded_attempts: attempts.length,
        input: attempts.reduce((n, a) => n + (a.usage?.input ?? 0), 0),
        output: attempts.reduce((n, a) => n + (a.usage?.output ?? 0), 0),
        cost:
          attempts.length && attempts.every((a) => a.usage?.cost != null)
            ? attempts.reduce((n, a) => n + a.usage.cost, 0)
            : null,
      },
      models: ['screen', 'summary', 'connections'].map((task) => ({
        task,
        model: resolveConnection(run.model_settings, task)?.modelId,
      })),
    };
  }
  listRuns(options) {
    return this.repo
      .runs(options)
      .map((r) => (r.reused_run_id ? null : this.getRun(r.id)))
      .filter(Boolean);
  }
  getReport(id) {
    const report = this.repo.get('daily_reports', id);
    return { ...report, runs: this.listRuns({ reportId: id, limit: 10000 }) };
  }
  getVersion(id) {
    const version = this.repo.get('daily_item_versions', id),
      { evidence: _evidence, ...safe } = version;
    const feedback = version.analysis_id
      ? this.analyses.db.feedback(version.analysis_id)
      : this.evaluations.feedbackFor(id);
    const analysis = version.analysis_id
      ? this.analyses.getResult(version.analysis_id)
      : null;
    return {
      ...safe,
      evidence_index: (version.evidence ?? []).map(
        ({ text: _text, ...e }) => e,
      ),
      feedback: analysis?.feedback ?? feedback,
      feedback_dimensions:
        analysis?.feedback_dimensions ??
        (['recommended', 'not_recommended'].includes(version.data?.outcome)
          ? ['accuracy']
          : []),
      feedback_target: version.analysis_id
        ? { kind: 'analysis', id: version.analysis_id }
        : { kind: 'screening', id },
    };
  }
  getItem(id) {
    const item = this.repo.get('daily_items', id),
      run = this.repo.get('daily_runs', item.run_id),
      job = item.job_id ? this.analyses.getJob(item.job_id) : null;
    return {
      ...item,
      screening_agent: run.workflow_version === AGENT_SCREEN_VERSION,
      screening_active: activeRun(run.status),
      analysis_id: item.analysis_id ?? job?.result_id ?? null,
      version: item.current_version_id
        ? this.getVersion(item.current_version_id)
        : null,
      screening: item.screening_version_id
        ? this.getVersion(item.screening_version_id)
        : null,
      job,
    };
  }
  items(id, { limit = 25, offset = 0, decision, status, query = '' } = {}) {
    const run = this.getRun(id);
    let items = this.repo.items(run.id);
    if (decision === 'followed_authors') {
      const scope = this.repo.get('subscriptions', run.subscription.id, false) ?? run.subscription;
      items = items.filter((item) => matchedFollowedAuthors(item.paper, scope).length);
    } else if (decision === 'excluded') items = items.filter((i) => i.excluded);
    else {
      items = items.filter((i) => !i.excluded);
      if (decision === 'pending')
        items = items.filter((i) => !i.final_decision);
      else if (decision === 'unscreened')
        items = items.filter((i) => !i.screening_version_id);
      else if (decision === 'needs_confirmation')
        items = items.filter(
          (i) => i.screening_version_id && !i.final_decision,
        );
      else if (decision)
        items = items.filter((i) => i.final_decision === decision);
    }
    if (status) items = items.filter((i) => i.processing_status === status);
    if (query)
      items = items.filter((i) =>
        (i.paper.title + ' ' + i.paper.authors.join(' '))
          .toLowerCase()
          .includes(query.toLowerCase()),
      );
    return {
      items: items.slice(offset, offset + limit).map((i) => this.getItem(i.id)),
      total: items.length,
      next_offset: offset + limit < items.length ? offset + limit : null,
    };
  }
  cancel(id) {
    const run = this.repo.get('daily_runs', id);
    if (activeRun(run.status) || run.status === 'paused') {
      run.status = 'cancelled';
      run.message = '日报已取消，已完成内容保留。';
      this.repo.saveRun(run);
      this.controllers.get(id)?.abort();
      for (const item of this.repo.items(id))
        if (!item.excluded && item.processing_status !== 'completed') {
          item.processing_status = 'cancelled';
          this.repo.saveItem(item);
        }
    }
    return this.getRun(id);
  }
  retry(id, raw, key) {
    requestKey(key);
    const requestHash = hash({ action: 'retry', id, raw }),
      old = this.repo.runForKey(key, requestHash);
    if (old) return { run: this.getRun(old.id), reused: true };
    const run = this.repo.get('daily_runs', id);
    if (activeRun(run.status) || this.controllers.has(id))
      throw new AnalysisError('conflict', '日报仍在运行。', false, 409);
    if (Object.keys(raw).some((k) => k !== 'max_model_calls'))
      throw new AnalysisError('invalid_request', '重试参数无效。');
    if (raw.max_model_calls !== undefined) {
      if (
        !Number.isInteger(raw.max_model_calls) ||
        raw.max_model_calls < run.actual_attempts ||
        raw.max_model_calls > 2000
      )
        throw new AnalysisError(
          'invalid_settings',
          '新预算应不低于已使用次数，最多 2000。',
        );
      run.max_model_calls = raw.max_model_calls;
    }
    for (const item of this.repo.items(id))
      if (!item.excluded && item.processing_status !== 'completed') {
        item.processing_status = item.screening_version_id
          ? 'completed'
          : 'pending';
        item.error = null;
        delete item.execution_policy;
        this.repo.saveItem(item);
      }
    run.status = 'queued';
    run.error = null;
    run.message = '等待继续未完成部分';
    delete run.screening_target_item_id;
    run.cycle++;
    this.repo.saveRun(run);
    this.repo.addRequest(key, requestHash, id);
    this.analyses.taskRuntime.retry('daily', id);
    this.pump();
    return { run: this.getRun(id), reused: false };
  }
  analyzeItem(id, key, raw = {}) {
    requestKey(key);
    if (
      Object.keys(raw).some((k) => k !== 'force_regenerate') ||
      (raw.force_regenerate !== undefined &&
        typeof raw.force_regenerate !== 'boolean')
    )
      throw new AnalysisError('invalid_request', '全文分析参数无效。');
    const item = this.repo.get('daily_items', id),
      run = this.repo.get('daily_runs', item.run_id);
    if (item.excluded)
      throw new AnalysisError('invalid_request', '版本动态请从单篇入口分析。');
    const requestHash = hash({
      action: 'analyze',
      id,
      force: raw.force_regenerate ?? false,
    });
    const old = this.repo.db
      .prepare('SELECT * FROM daily_detail_requests WHERE key=?')
      .get(key);
    if (old && old.request_hash !== requestHash)
      throw new AnalysisError(
        'conflict',
        '该请求标识已用于其他参数。',
        false,
        409,
      );
    const remember = (jobId) =>
      this.repo.db
        .prepare('INSERT INTO daily_detail_requests VALUES (?,?,?,?)')
        .run(key, requestHash, id, jobId);
    const previous = item.job_id ? this.analyses.getJob(item.job_id) : null;
    if (
      old ||
      (previous &&
        (!terminalJob(previous.status) ||
          (item.details_status === 'available' && !raw.force_regenerate)))
    ) {
      if (!old) remember(previous.id);
      return {
        run: this.getRun(run.id),
        item: this.getItem(id),
        job: old ? this.analyses.getJob(old.job_id) : previous,
        reused: true,
      };
    }
    // Explicit detail work has its own job, model snapshot and budget. The daily run stays terminal.
    const created = this.analyses.create(
      {
        arxiv_input: item.paper.url,
        persona_connection_id: run.subscription.persona_connection_id,
        scope: run.subscription.scope,
        language: run.subscription.language,
        summary_length: run.subscription.summary_length,
        recommendation_strictness:
          run.subscription.recommendation_strictness ?? 'balanced',
        force_regenerate: raw.force_regenerate ?? false,
      },
      'detail-' + hash({ key, id }).slice(0, 64),
      previous?.id ?? null,
      {
        origin: { daily_run_id: run.id, daily_item_id: id, trigger: 'manual' },
      },
    );
    item.job_id = created.job.id;
    item.details_status = 'queued';
    item.details_error = null;
    this.repo.saveItem(item);
    remember(created.job.id);
    return {
      run: this.getRun(run.id),
      item: this.getItem(id),
      job: created.job,
      reused: created.reused,
    };
  }
  rescreenItem(id, key, raw = {}) {
    requestKey(key);
    if (Object.keys(raw).length)
      throw new AnalysisError(
        'invalid_request',
        '单篇重筛按原任务设置执行，无需附加参数。',
      );
    const item = this.repo.get('daily_items', id),
      run = this.repo.get('daily_runs', item.run_id);
    const digest = hash({ action: 'rescreen-item', id }),
      old = this.repo.runForKey(key, digest);
    if (old)
      return { run: this.getRun(old.id), item: this.getItem(id), reused: true };
    if (item.excluded || run.workflow_version !== AGENT_SCREEN_VERSION)
      throw new AnalysisError(
        'invalid_request',
        '请先按当前订阅创建 Agent 初筛批次。',
      );
    if (activeRun(run.status) || this.controllers.has(run.id))
      throw new AnalysisError(
        'conflict',
        '本批仍在运行，请等待或取消后重筛。',
        false,
        409,
      );
    this.repo.analysisDb.transaction(() => {
      item.rescreen_requested = true;
      item.processing_status = 'pending';
      item.error = null;
      delete item.execution_policy;
      this.repo.saveItem(item);
      run.status = 'queued';
      run.error = null;
      run.message = '等待重新判断所选论文';
      run.cycle++;
      run.screening_target_item_id = id;
      this.repo.saveRun(run);
      this.repo.addRequest(key, digest, run.id);
    });
    this.pump();
    return { run: this.getRun(run.id), item: this.getItem(id), reused: false };
  }
  feedback(id, dimension, raw) {
    const v = this.repo.get('daily_item_versions', id);
    if (v.analysis_id)
      return this.analyses.feedback(v.analysis_id, dimension, raw);
    if (
      dimension !== 'accuracy' ||
      !['recommended', 'not_recommended'].includes(v.data?.outcome)
    )
      throw new AnalysisError(
        'invalid_request',
        '目前仅支持对已完成的推荐或不推荐判断反馈。',
      );
    return this.evaluations.feedback(id, raw).feedback;
  }
  evidence(id, evidenceId) {
    const v = this.repo.get('daily_item_versions', id);
    if (v.analysis_id) return this.analyses.evidence(v.analysis_id, evidenceId);
    const e = v.evidence?.find((e) => e.id === evidenceId);
    if (!e)
      throw new AnalysisError('not_found', '该结果没有此证据。', false, 404);
    return e;
  }
  async deleteReport(id) {
    this.repo.get('daily_reports', id);
    if (
      this.repo.db
        .prepare(`SELECT 1 FROM daily_screening_links l
      JOIN daily_item_versions v ON v.id=l.version_id
      JOIN daily_items original ON original.id=v.item_id JOIN daily_runs origin_run ON origin_run.id=original.run_id
      JOIN daily_items target ON target.id=l.item_id JOIN daily_runs target_run ON target_run.id=target.run_id
      WHERE origin_run.report_id=? AND target_run.report_id<>? LIMIT 1`)
        .get(id, id)
    )
      throw new AnalysisError(
        'conflict',
        '这份日报的筛选结果仍被其他日报引用，请先删除引用它的日报。',
        false,
        409,
      );
    const runs = this.repo.runs({ reportId: id, limit: 10000 });
    const jobIds = runs.flatMap((r) =>
      this.repo
        .items(r.id)
        .map((i) => i.job_id)
        .filter(Boolean),
    );
    for (const run of runs) this.cancel(run.id);
    for (const id of jobIds) this.analyses.cancel(id);
    while (
      runs.some((r) => this.controllers.has(r.id)) ||
      jobIds.some((id) => this.analyses.controllers.has(id))
    )
      await delay(25);
    this.repo.deleteReport(id, () => this.scheduler?.repo.markDeleted(id));
    return { ok: true };
  }
  start() {
    this.pump();
  }
  pump() {
    this.work = this.taskQueue.wake();
  }
  async execute(run) {
    run.model_settings = requireHostSettings(run.model_settings);
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const signal = AbortSignal.any([controller.signal, this.shutdown.signal]);
    run.status = 'running';
    this.repo.saveRun(run);
    try {
      if (!run.report_id) {
        run.message =
          run.source.kind === 'announcement_date'
            ? `读取 ${run.source.date} 的公告存档并核对候选`
            : '读取官方公告并核对候选';
        this.repo.saveRun(run);
        let revision;
        if (run.source.kind === 'stored_batch') {
          const batch = this.repo.get('arxiv_batches', run.source.batch_id);
          revision = this.repo.get(
            'arxiv_batch_revisions',
            run.source.revision_id ?? batch.revision_id,
          );
          if (
            revision.batch_id !== batch.id ||
            !sameSubjects(revision, run.subscription)
          )
            throw new AnalysisError(
              'invalid_source',
              '存档批次与订阅分类不一致。',
            );
        } else
          revision = await discoverSubjects(
            this.discovery,
            this.repo,
            subscriptionSubjects(run.subscription),
            signal,
            (message) => {
              run.message = message;
              this.repo.saveRun(run);
            },
            run.source.kind === 'announcement_date'
              ? run.source.date
              : undefined,
          );
        signal.throwIfAborted();
        if (
          run.source.kind === 'announcement_date' &&
          revision.date !== run.source.date
        )
          throw new AnalysisError(
            'invalid_source',
            '公告来源日期与所选日期不一致，未生成日报。',
          );
        const bound = this.repo.bindReport(run, revision);
        if (bound.reused) return;
      }
      const hasPending = this.repo
        .items(run.id)
        .some(
          (i) =>
            !i.excluded && (!i.screening_version_id || i.rescreen_requested),
        );
      if (
        hasPending &&
        (run.workflow_version !== this.workflowVersion ||
          (run.context &&
            run.context.schema_version !== PERSONA_CONTEXT_VERSION))
      )
        throw new AnalysisError(
          'persona_context_changed',
          '这批任务使用旧推荐依据；请按新规则重新筛选本批，旧结果和反馈保留。',
        );
      if (hasPending && !run.context) {
        run.message = '获取限定标签的筛选依据';
        this.repo.saveRun(run);
        run.context = await (
          this.persona.queryContext ?? this.persona.screeningSnapshot
        ).call(this.persona, run.subscription, signal);
        signal.throwIfAborted();
        this.repo.saveRun(run);
      }
      const pending = this.repo
        .items(run.id)
        .filter(
          (item) =>
            !item.excluded &&
            (!run.screening_target_item_id ||
              run.screening_target_item_id === item.id) &&
            (!item.screening_version_id || item.rescreen_requested) &&
            item.execution_policy !== 'manual_resume_required',
        );
      let fatal;
      const worker = async (item) => {
        signal.throwIfAborted();
        run.message = '筛选：' + item.paper.title;
        this.repo.saveRun(run);
        item.processing_status = 'screening';
        this.repo.saveItem(item);
        try {
          await this.screen(run, item, signal);
        } catch (e) {
          signal.throwIfAborted();
          const latest = this.repo.get('daily_items', item.id);
          latest.processing_status = 'failed';
          latest.error = safeError(e);
          this.repo.saveItem(latest);
          if (
            [
              'budget_exceeded',
              'auth_required',
              'connection_changed',
              'quota_exceeded',
              'not_configured',
              'AUTH',
              'MISSING_CREDENTIAL',
              'NO_ADAPTER',
              'model_changed',
              'codex_auth_required',
              'codex_isolation_failed',
              'codex_unavailable',
              'legacy_model_snapshot',
              'MODEL_NOT_FOUND',
              'INVALID_REASONING_EFFORT',
            ].includes(e.code)
          )
            fatal ??= e;
        }
      };
      await runConcurrent(pending, worker, {
        limit: () =>
          run.workflow_version === AGENT_SCREEN_VERSION
            ? modelConcurrency(this.models, run.model_settings)
            : 1,
        signal,
        canStart: () => !fatal,
        subscribe: (listener) => this.models.onConcurrencyChange?.(listener),
      });
      signal.throwIfAborted();
      if (fatal) throw fatal;
      signal.throwIfAborted();
      const items = this.repo.items(run.id).filter((i) => !i.excluded),
        revision = this.repo.get('arxiv_batch_revisions', run.revision_id);
      const complete =
        revision.completeness === 'complete' &&
        items.every((i) => !!i.screening_version_id && !i.rescreen_requested);
      run.status = complete ? 'completed' : 'partial';
      run.message = complete
        ? '本批次初筛已完成；详细分析由你按需开启'
        : '部分完成，请查看待处理项或来源缺口';
      run.error = null;
      this.repo.saveRun(run);
    } catch (e) {
      if (this.repo.get('daily_runs', run.id, false)?.status !== 'cancelled') {
        run.status = this.shutdown.signal.aborted
          ? 'interrupted'
          : e.code === 'budget_exceeded'
            ? 'paused'
            : run.report_id
              ? 'partial'
              : 'failed';
        run.error = this.shutdown.signal.aborted
          ? {
              code: 'interrupted',
              message: '服务中断，可继续未完成部分。',
              retryable: true,
            }
          : safeError(e);
        run.message = run.error.message;
        this.repo.saveRun(run);
      }
    } finally {
      this.controllers.delete(run.id);
    }
  }
  async screen(run, item, signal) {
    requireHostSettings(run.model_settings);
    if (run.workflow_version !== AGENT_SCREEN_VERSION)
      throw new AnalysisError(
        'unsupported_workflow',
        '该历史批次使用旧筛选流程，请重新发起筛选。',
      );
    return screenWithAgent(this, run, item, signal);
  }
  syncAnalysis(job) {
    const item = job.origin?.daily_item_id
      ? this.repo.get('daily_items', job.origin.daily_item_id, false)
      : null;
    if (!item || item.job_id !== job.id) return;
    if (!terminalJob(job.status)) {
      item.details_status = job.status;
      this.repo.saveItem(item);
      return;
    }
    const result = this.analyses.db.result(job.result_id);
    const valid = result?.personalization.status === 'available';
    item.analysis_id = result?.id ?? item.analysis_id ?? null;
    if (valid && item.published_analysis_id !== result.id) {
      this.repo.addVersion(item, {
        kind: 'analysis',
        analysis_id: result.id,
        scope: result.settings_snapshot.scope,
        persona_revision: result.persona?.revision,
        data: result.personalization.data,
        model: result.personalization.model,
      });
      item.published_analysis_id = result.id;
      item.analysis_decision = result.personalization.data.decision;
    }
    item.details_status =
      result?.summary.status === 'available' && valid
        ? 'available'
        : result?.summary.status === 'available' || valid
          ? 'partial'
          : ['cancelled', 'interrupted'].includes(job.status)
            ? job.status
            : 'failed';
    item.details_error =
      item.details_status === 'available'
        ? null
        : (job.error ?? {
            code: job.status,
            message: '详细分析尚未全部完成，可以重试。',
            retryable: true,
          });
    this.repo.saveItem(item);
  }
  async close() {
    await this.evaluations.close();
    if (this.shutdown.signal.aborted) {
      await this.work;
      return;
    }
    this.shutdown.abort();
    await this.taskQueue.close();
    await Promise.allSettled(this.discovery.pending?.values() ?? []);
  }
}
