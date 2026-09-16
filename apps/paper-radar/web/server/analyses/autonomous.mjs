import { captureAnalysisInput } from '../evaluations/analysis-input.mjs';
import { PARSER_VERSION } from './arxiv.mjs';
import { randomUUID } from 'node:crypto';
import {
  AnalysisError,
  hash,
  safeError,
  SCHEMA_VERSION,
} from './contracts.mjs';
import {
  ResearchTools,
  toolProgress,
  AUTONOMOUS_VERSION,
  publicPaper,
} from '../agents/research-tools.mjs';
import {
  validateTaskResult,
  runAutonomous,
  taskFingerprint,
  promptFingerprint,
  promptIdFor,
} from '../agents/autonomous-task.mjs';

export async function executeAutonomous(service, job) {
  const controller = new AbortController();
  service.controllers.set(job.id, controller);
  const signal = AbortSignal.any([
    controller.signal,
    service.shutdown.signal,
    ...(service.executionMs == null ? [] : [AbortSignal.timeout(service.executionMs)]),
  ]);
  let result, reader, key;
  const task = 'single';
  job.status = 'running';
  job.started_at = new Date().toISOString();
  job.step = 'agent';
  job.message = 'Agent 正在分析';
  job.stages = [{ id: 'agent', label: '自主分析', status: 'running' }];
  service.persist(job);
  const sync = () => {
    signal.throwIfAborted();
    if (!result) return;
    result.evidence = reader.evidence();
    result.persona = reader.persona ? structuredClone(reader.persona) : null;
    result.paper = publicPaper(reader.full ?? reader.paper);
    if (result.personalization.data && reader.persona)
      result.personalization.data.matched_knowledge_ids = reader.persona.records
        .filter(
          (record) =>
            record.entity_type === 'knowledge_node' &&
            result.personalization.data.reasons.some((reason) =>
              reason.persona_evidence_ids.includes(
                `persona:${record.id}:r${record.record_revision}`,
              ),
            ),
        )
        .map((record) => record.id);
    if (result.personalization.status === 'available' && !result.reused_from)
      result.input_snapshot_id = captureAnalysisInput(service, job, reader).id;
    result.agent_context = { notes: reader.notes, coverage: reader.coverage() };
    job.stages[0].tool_count = reader.reads.length;
    service.persist(job, result);
  };
  try {
    if (job.pipeline_version !== AUTONOMOUS_VERSION)
      throw new AnalysisError(
        'pipeline_changed',
        '此任务属于旧流程，请明确重试；旧结果已保留。',
        true,
      );
    reader = await new ResearchTools({
      analyses: service,
      input: job.input,
      signal,
      onChange: (_, name) => {
        job.message = toolProgress(name);
        sync();
      },
    }).prepare();
    const fingerprint = promptFingerprint(
      job.prompt_snapshot,
      promptIdFor(task),
      { task: { input: job.input } },
    );
    key =
      'autonomous-analysis:' +
      hash({
        v: AUTONOMOUS_VERSION,
        parser: PARSER_VERSION,
        input: {
          ...job.input,
          arxiv_input: reader.paper.url,
          force_regenerate: false,
        },
        paper: {
          id: reader.paper.id,
          version: reader.paper.version,
          title: reader.paper.title,
          abstract: reader.paper.abstract,
        },
        persona: reader.persona
          ? {
              identity: reader.persona.identity,
              revision: reader.persona.revision,
              scope: reader.persona.scope,
            }
          : null,
        model: taskFingerprint(job.model_settings, task),
        prompt: fingerprint,
      });
    result = {
      id: 'analysis-' + randomUUID(),
      job_id: job.id,
      schema_version: SCHEMA_VERSION,
      pipeline_version: AUTONOMOUS_VERSION,
      prompt_fingerprint: fingerprint,
      created_at: new Date().toISOString(),
      settings_snapshot: job.input,
      paper: publicPaper(reader.paper),
      persona: null,
      summary: { status: 'pending' },
      personalization: { status: reader.persona ? 'pending' : 'not_requested' },
      evidence: [],
      cache_key: key,
      quality_notice:
        '引用、格式和个人事实由程序校验；阅读方式由 Agent 决定，未自动执行独立内容复核。',
    };
    job.result_id = result.id;
    job.paper_title = reader.paper.title;
    sync();
    const ref = !job.input.force_regenerate && service.db.cache(key),
      cached = ref && service.db.result(ref.result_id);
    if (
      cached?.cache_key === key &&
      cached.summary.status === 'available' &&
      (!reader.persona || cached.personalization.status === 'available')
    ) {
      Object.assign(result, {
        summary: { ...cached.summary, cache_hit: true },
        personalization:
          cached.personalization.status === 'available'
            ? { ...cached.personalization, cache_hit: true }
            : cached.personalization,
        persona: cached.persona,
        evidence: cached.evidence,
        agent_context: cached.agent_context,
        reused_from: cached.id,
        input_snapshot_id: cached.input_snapshot_id ?? null,
      });
      job.message = '复用相同任务条件下的已有分析';
    } else {
      const priorJob = job.retry_of && service.db.job(job.retry_of),
        prior = priorJob && service.db.result(priorJob.result_id);
      if (!job.input.force_regenerate && prior?.cache_key === key) {
        reader.report = {
          id: prior.id,
          summary: prior.summary,
          personalization: prior.personalization,
          draft: prior.agent_draft,
        };
        reader.notes = structuredClone(prior.agent_context?.notes ?? []);
        for (const e of prior.evidence ?? []) reader.known.set(e.id, e);
        reader.persona = prior.persona
          ? structuredClone(prior.persona)
          : reader.persona;
        for (const part of ['summary', 'personalization'])
          if (prior[part].status === 'available')
            result[part] = structuredClone(prior[part]);
        // Preserve original evidence for saved components even if no new tool reads it.
        for (const e of prior.evidence ?? []) reader.delivered.set(e.id, e);
        sync();
      }
      const answer = await runAutonomous({
        analyses: service,
        task,
        reader,
        settings: job.model_settings,
        snapshot: job.prompt_snapshot,
        signal,
        businessId: job.id,
        maxAttempts: service.maxAttempts,
        executionMs: service.executionMs,
        onDraft: (parts) => {
          result.agent_draft = {
            data: parts,
            updated_at: new Date().toISOString(),
          };
          for (const name of ['summary', 'personalization'])
            if (parts[name]) {
              try {
                const checked = validateTaskResult(
                  'single',
                  { [name]: parts[name] },
                  reader,
                  { partial: true },
                );
                if (
                  !checked.issues.length ||
                  result[name].status !== 'available'
                )
                  result[name] = {
                    status: checked.issues.length
                      ? 'needs_review'
                      : 'available',
                    data: structuredClone(parts[name]),
                    actual_length: checked.actual_length,
                    version: hash({ key, name, data: parts[name] }),
                    cache_key: key,
                    cache_hit: false,
                    validation: {
                      issues: checked.issues,
                      content_review: 'not_requested',
                    },
                  };
              } catch {
                /* A malformed draft remains available for inspection and retry. */
              }
            }
          sync();
        },
        onSave: (parts) => {
          for (const [name, data] of Object.entries(parts))
            result[name] = {
              status: 'available',
              data: structuredClone(data),
              version: hash({ key, name, data }),
              cache_key: key,
              cache_hit: false,
              validation: { issues: [], content_review: 'not_requested' },
              actual_length:
                name === 'summary'
                  ? validateTaskResult('summary', data, reader).actual_length
                  : undefined,
            };
          sync();
        },
        beforeAttempt: (_c, attempt) => {
          signal.throwIfAborted();
          if (service.maxAttempts != null && job.actual_attempts >= service.maxAttempts)
            throw new AnalysisError(
              'budget_exceeded',
              '本次模型调用已达到预算，已保存内容保留。',
              true,
            );
          service.beforeDailyAttempt?.(job);
          job.actual_attempts++;
          job.message =
            attempt.purpose === 'compaction'
              ? 'DSH 正在整理上下文'
              : 'Agent 正在思考';
          service.persist(job, result);
        },
        onAttempt: (a) => {
          service.db.addAttempt({
            ...a,
            job_id: job.id,
            phase: a.purpose ?? task,
          });
          service.onDailyAttempt?.(job, {
            ...a,
            job_id: job.id,
            phase: a.purpose ?? task,
          });
        },
        onProgress: (p) => {
          job.stages[0].session_id = p.session_id;
          job.stages[0].step = p.step;
          service.persist(job, result);
        },
      });
      for (const name of ['summary', 'personalization'])
        if (result[name].status === 'available')
          result[name].model = {
            provider_id: answer.providerId,
            model_id: answer.modelId,
            reasoning_effort: answer.reasoningEffort,
            request_id: answer.requestId,
            session_id: answer.sessionId,
            fallback_from: answer.fallbackFrom ?? null,
          };
      sync();
      job.message = '分析完成';
    }
    signal.throwIfAborted();
    job.status = 'succeeded';
    job.step = 'finished';
    job.error = null;
    job.stages[0].status = 'succeeded';
    if (service.persist(job, result))
      service.db.putCache(key, 'autonomous-result-reference', {
        result_id: result.id,
      });
  } catch (e) {
    if (service.db.job(job.id)?.status !== 'cancelled') {
      const partial =
        result &&
        ['summary', 'personalization'].some(
          (k) => result[k].status === 'available',
        );
      job.status = service.shutdown.signal.aborted
        ? 'interrupted'
        : partial
          ? 'partial'
          : 'failed';
      job.error = signal.aborted
        ? {
            code: service.shutdown.signal.aborted
              ? 'interrupted'
              : 'budget_exceeded',
            message: service.shutdown.signal.aborted
              ? '服务中断，已保存内容保留，可重试。'
              : '超过任务时间预算，已保存内容保留，可重试。',
            retryable: true,
          }
        : safeError(e);
      job.message = job.error.message;
      job.stages[0].status = job.status;
      job.stages[0].error = job.error;
      if (result)
        for (const name of ['summary', 'personalization'])
          if (result[name].status === 'pending')
            result[name] = { status: 'failed', error: job.error };
      service.persist(job, result);
    }
  } finally {
    service.controllers.delete(job.id);
  }
}
