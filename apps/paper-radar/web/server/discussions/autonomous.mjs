import { safeError, AnalysisError } from '../analyses/contracts.mjs';
import {
  ResearchTools,
  toolProgress,
  publicPaper,
} from '../agents/research-tools.mjs';
import { runAutonomous } from '../agents/autonomous-task.mjs';

export async function executeAutonomousDiscussion(service, t) {
  const controller = new AbortController();
  service.controllers.set(t.id, controller);
  const signal = AbortSignal.any([
    controller.signal,
    service.shutdown.signal,
    ...(service.executionMs == null ? [] : [AbortSignal.timeout(service.executionMs)]),
  ]);
  let c, reader;
  t.status = 'running';
  t.started_at = new Date().toISOString();
  t.message = 'Agent 正在处理问题';
  service.save(t);
  const sync = () => {
    signal.throwIfAborted();
    t.evidence = reader.evidence();
    t.coverage = reader.coverage();
    t.persona_revision = reader.persona?.revision ?? null;
    c.paper = publicPaper(reader.full ?? reader.paper);
    c.input = reader.input;
    c.context = {
      paper: c.paper,
      persona: reader.persona,
      records: reader.persona?.records ?? [],
      report: reader.report,
      notes: reader.notes,
      evidence: [
        ...new Map(
          [...(c.context?.evidence ?? []), ...reader.evidence()].map((e) => [
            e.id,
            e,
          ]),
        ).values(),
      ],
      coverage: 'agent_selected',
    };
    service.repo.save(c);
    service.save(t);
  };
  try {
    c = service.repo.conversation(t.conversation_id);
    const history = service.repo
      .turns(c.id)
      .filter((v) => v.id !== t.id)
      .map((v) => ({
        user: v.question,
        assistant: v.answer,
        status: v.status,
      }));
    reader = await new ResearchTools({
      analyses: service.analyses,
      input: c.input,
      signal,
      paper: c.context?.paper ?? c.paper,
      persona: c.context?.persona ?? null,
      report: c.context?.report ?? null,
      notes: c.context?.notes ?? [],
      evidence: c.context?.evidence ?? [],
      history,
      onChange: (_, name) => {
        t.message = toolProgress(name);
        sync();
      },
    }).prepare();
    sync();
    const answer = await runAutonomous({
      analyses: service.analyses,
      task: 'discussion',
      reader,
      settings: t.model_settings,
      snapshot: t.prompt_snapshot,
      signal,
      businessId: t.id,
      maxAttempts: t.max_attempts == null ? null : t.max_attempts - t.actual_attempts,
      executionMs: service.executionMs,
      maxTokens: 5000,
      question: t.question,
      anchor: c.anchor,
      beforeAttempt: (_c, attempt) => {
        signal.throwIfAborted();
        if (t.max_attempts != null && t.actual_attempts >= t.max_attempts)
          throw new AnalysisError(
            'budget_exceeded',
            '本轮达到模型调用预算，已保存内容保留，可以重试。',
            true,
          );
        t.actual_attempts++;
        t.message =
          attempt.purpose === 'compaction'
            ? 'DSH 正在整理上下文'
            : 'Agent 正在思考';
        service.save(t);
      },
      onAttempt: (a) => {
        t.attempts.push(a);
        service.save(t);
      },
      onProgress: (p) => {
        t.session_id = p.session_id;
        service.save(t);
      },
    });
    t.answer = answer.data;
    t.model = {
      model_id: answer.modelId,
      provider_id: answer.providerId,
      reasoning_effort: answer.reasoningEffort,
      request_id: answer.requestId,
      session_id: answer.sessionId,
      fallback_from: answer.fallbackFrom ?? null,
    };
    sync();
    t.status = 'succeeded';
    t.error = null;
    t.message = '回答已保存';
    service.save(t);
  } catch (e) {
    if (service.repo.turn(t.id).status !== 'cancelled') {
      t.status = service.shutdown.signal.aborted ? 'interrupted' : 'failed';
      t.error = signal.aborted
        ? {
            code: service.shutdown.signal.aborted ? 'interrupted' : 'timeout',
            message: '本轮回答中断，已保存依据与笔记保留，可以重试。',
            retryable: true,
          }
        : safeError(e);
      t.message = t.error.message;
      service.save(t);
    }
  } finally {
    service.controllers.delete(t.id);
  }
}
