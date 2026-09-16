import { requireHostSettings } from '../hosts/execution.mjs';
import { recoverDiscussions } from '../tasks/recovery.mjs';
import { isTaskActive } from '../../lib/contracts/task.ts';
import { executeAutonomousDiscussion } from './autonomous.mjs';
import { taskLane } from '../tasks/policy.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  AnalysisError,
  hash,
  validateInput,
  safeError,
} from '../analyses/contracts.mjs';
import { resolveConnection } from '../../lib/host-models.ts';
import { OUTPUT_POLICY_VERSION } from '../output-policy.mjs';
import { PERSONA_CONTEXT_VERSION } from '../persona/service.mjs';
import { requestKey, now } from '../daily/contracts.mjs';
import { DiscussionRepository } from './repository.mjs';
import {
  DISCUSSION_VERSION,
  sourceSchema,
  resolveAnchor,
} from './contracts.mjs';

const active = isTaskActive;
const publicPaper = (p) => ({
  id: p.id,
  version: p.version,
  title: p.title,
  url: p.url,
  abstract: p.abstract,
  coverage: p.coverage,
});
const publicTurn = (t) => {
  const {
    model_settings: _settings,
    evidence: _evidence,
    prompt_snapshot: _prompts,
    ...safe
  } = t;
  return {
    ...safe,
    prompt_fingerprint: _prompts?.fingerprint ?? null,
    evidence_index: (t.evidence ?? []).map(({ text: _text, ...e }) => e),
  };
};
export class DiscussionService {
  constructor(
    analyses,
    daily,
    { executionMs = null, maxAttempts = null } = {},
  ) {
    this.analyses = analyses;
    this.daily = daily;
    this.models = analyses.models;
    this.repo = new DiscussionRepository(analyses.db);
    this.executionMs = executionMs;
    this.maxAttempts = maxAttempts;
    this.work = null;
    this.controllers = new Map();
    this.shutdown = new AbortController();
    this.taskQueue = analyses.taskRuntime.register('discussion', {
      signal: this.shutdown.signal,
      stop: () => this.shutdown.abort(),
      pending: () => this.repo.queuedAll(),
      get: (id) => this.repo.turn(id),
      run: (turn) => this.execute(turn),
      priority: () => 30,
      ...taskLane(this.models, 'discussion'),
      exclusive: (turn) => `conversation:${turn.conversation_id}`,
      onError: (turn, error) => {
        const latest = this.repo.turn(turn.id);
        if (!active(latest.status)) return;
        latest.status = this.shutdown.signal.aborted ? 'interrupted' : 'failed';
        latest.error = safeError(error);
        latest.message = latest.error.message;
        this.save(latest);
      },
    });
    recoverDiscussions(this.repo);
  }
  create(raw) {
    const parsed = sourceSchema.safeParse(raw);
    if (!parsed.success)
      throw new AnalysisError('invalid_request', '讨论来源或锚点无效。');
    const s = parsed.data;
    if (
      (!s.daily_item_id && !s.analysis_id && !s.input) ||
      (s.input && (s.daily_item_id || s.analysis_id))
    )
      throw new AnalysisError('invalid_request', '请选择一个讨论来源。');
    let item, run, result, input;
    if (s.daily_item_id) {
      if (!this.daily)
        throw new AnalysisError('unavailable', '日报服务不可用。');
      item = this.daily.repo.get('daily_items', s.daily_item_id);
      run = this.daily.repo.get('daily_runs', item.run_id);
      if (s.analysis_id) {
        const versions = this.daily.repo.db
          .prepare(
            'SELECT 1 FROM daily_item_versions WHERE item_id=? AND analysis_id=?',
          )
          .get(item.id, s.analysis_id);
        if (item.analysis_id !== s.analysis_id && !versions)
          throw new AnalysisError('invalid_anchor', '报告不属于这篇日报论文。');
      }
      result =
        s.analysis_id || s.anchor
          ? this.analyses.db.result(s.analysis_id ?? item.analysis_id)
          : null;
      input = validateInput({
        arxiv_input: item.paper.url,
        persona_connection_id: run.subscription.persona_connection_id,
        scope: run.subscription.scope,
        language: run.subscription.language,
        summary_length: run.subscription.summary_length,
        recommendation_strictness:
          run.subscription.recommendation_strictness ?? 'balanced',
      });
    } else if (s.analysis_id) {
      result = this.analyses.db.result(s.analysis_id);
      if (!result)
        throw new AnalysisError('not_found', '报告不存在。', false, 404);
      input = validateInput({
        ...result.settings_snapshot,
        arxiv_input: result.paper.url,
        force_regenerate: false,
      });
    } else input = validateInput(s.input);
    const anchor = resolveAnchor(s.anchor, result);
    const sourceKey = hash(
      item
        ? { item: item.id }
        : { input: { ...input, force_regenerate: false } },
    );
    const topicKey = hash({ sourceKey, report: result?.id ?? null, anchor });
    if (!s.new_conversation) {
      const old = this.repo.topic(topicKey);
      if (old) return { conversation: this.get(old.id), reused: true };
    }
    const c = {
      id: 'discussion-' + randomUUID(),
      source_key: sourceKey,
      topic_key: topicKey,
      created_at: now(),
      daily_item_id: item?.id ?? null,
      analysis_id: result?.id ?? null,
      input,
      anchor,
      paper: result
        ? publicPaper(result.paper)
        : item
          ? publicPaper(item.paper)
          : null,
      context: result
        ? {
            paper: publicPaper(result.paper),
            evidence: result.evidence,
            records: result.persona?.records ?? [],
            persona: result.persona,
            report: {
              id: result.id,
              created_at: result.created_at,
              summary: result.summary,
              personalization: result.personalization,
            },
            coverage: 'stored_report_evidence',
          }
        : null,
      title: anchor?.label ?? '自由讨论',
      protocol: DISCUSSION_VERSION,
      output_policy: OUTPUT_POLICY_VERSION,
    };
    this.repo.save(c);
    return { conversation: this.get(c.id), reused: false };
  }
  get(id) {
    const c = this.repo.conversation(id),
      {
        context: _context,
        source_key: _source,
        topic_key: _topic,
        ...safe
      } = c;
    return {
      ...safe,
      persona: c.context?.persona
        ? {
            revision: c.context.persona.revision,
            tags: c.context.persona.tags,
            coverage: c.context.persona.coverage,
          }
        : null,
      turns: this.repo.turns(id).map(publicTurn),
      related: this.repo.related(c.source_key).map((v) => ({
        id: v.id,
        title: v.title,
        created_at: v.created_at,
        analysis_id: v.analysis_id,
        anchor: v.anchor,
      })),
    };
  }
  send(id, raw, key) {
    requestKey(key);
    if (this.shutdown.signal.aborted)
      throw new AnalysisError('unavailable', '服务正在关闭。', true, 503);
    const p = z
      .object({ question: z.string().trim().min(1).max(12000) })
      .strict()
      .safeParse(raw);
    if (!p.success)
      throw new AnalysisError('invalid_request', '请输入 1–12000 字的问题。');
    this.repo.conversation(id);
    const h = hash({ id, question: p.data.question }),
      old = this.repo.existing(key, h);
    if (old) return { turn: publicTurn(old), reused: true };
    if (this.repo.turns(id).some((t) => active(t.status)))
      throw new AnalysisError(
        'conflict',
        '请等待或取消当前回答，再继续提问。',
        false,
        409,
      );
    if (
      this.repo.db
        .prepare(
          "SELECT count(*) n FROM discussion_turns WHERE status IN ('queued','running')",
        )
        .get().n >= 30
    )
      throw new AnalysisError('busy', '讨论队列已满，请稍后重试。', true, 429);
    const previousSettings = this.repo.turns(id).at(-1)?.model_settings;
    const explicit = this.models.context?.getStore()?.explicit;
    const settings = requireHostSettings(
      structuredClone(
        (previousSettings?.dsh ||
          previousSettings?.harness ||
          previousSettings?.codex) &&
          !explicit?.model &&
          !explicit?.reasoningEffort
          ? previousSettings
          : this.models.store.state.settings,
      ),
    );
    if (!resolveConnection(settings, 'discussion'))
      throw new AnalysisError(
        'not_configured',
        '请在 AI 模型设置中配置讨论模型。',
      );
    const t = {
      id: 'turn-' + randomUUID(),
      conversation_id: id,
      question: p.data.question,
      status: 'queued',
      created_at: now(),
      updated_at: now(),
      message: '等待回答',
      answer: null,
      error: null,
      attempts: [],
      actual_attempts: 0,
      max_attempts: this.maxAttempts,
      prompt_snapshot: this.analyses.prompts.snapshot(),
      model_settings: settings,
      evidence: [],
    };
    this.analyses.db.transaction(() => {
      this.repo.saveTurn(t);
      this.repo.request(key, h, t.id);
    });
    this.pump();
    return { turn: publicTurn(t), reused: false };
  }
  retry(id, key) {
    requestKey(key);
    const h = hash({ retry: id }),
      old = this.repo.existing(key, h);
    if (old) return { turn: publicTurn(old), reused: true };
    const t = this.repo.turn(id);
    if (!['failed', 'cancelled', 'interrupted'].includes(t.status))
      throw new AnalysisError('conflict', '这条消息不需要重试。', false, 409);
    const turns = this.repo.turns(t.conversation_id);
    if (
      turns.at(-1).id !== id ||
      turns.some((t) => active(t.status)) ||
      this.controllers.has(id)
    )
      throw new AnalysisError(
        'conflict',
        '请在当前会话末尾重新提问，或等待当前任务结束。',
        false,
        409,
      );
    t.status = 'queued';
    t.error = null;
    t.message = '等待重新回答';
    t.max_attempts =
      this.maxAttempts == null ? null : t.actual_attempts + this.maxAttempts;
    t.started_at = null;
    t.model_settings = requireHostSettings(t.model_settings);
    this.analyses.db.transaction(() => {
      this.repo.saveTurn(t);
      this.repo.request(key, h, id);
    });
    this.analyses.taskRuntime.retry('discussion', id);
    this.pump();
    return { turn: publicTurn(t), reused: false };
  }
  cancel(id) {
    const t = this.repo.turn(id);
    if (active(t.status)) {
      t.status = 'cancelled';
      t.message = '已取消';
      t.error = null;
      this.repo.saveTurn(t);
      this.controllers.get(id)?.abort();
    }
    return publicTurn(t);
  }
  evidence(id, turnId, evidenceId) {
    this.repo.conversation(id);
    const t = this.repo.turn(turnId);
    const e =
      t.conversation_id === id && t.evidence?.find((e) => e.id === evidenceId);
    if (!e)
      throw new AnalysisError('not_found', '本轮讨论没有此证据。', false, 404);
    return e;
  }
  async delete(id) {
    this.repo.conversation(id);
    const turns = this.repo.turns(id);
    for (const t of turns) this.cancel(t.id);
    while (turns.some((t) => this.controllers.has(t.id))) await delay(25);
    this.repo.delete(id);
    return { ok: true };
  }
  start() {
    this.pump();
  }
  pump() {
    this.work = this.taskQueue.wake();
  }
  save(t) {
    if (this.repo.turn(t.id).status === 'cancelled') return false;
    t.updated_at = now();
    this.repo.saveTurn(t);
    return true;
  }
  async context(c, signal, progress, question = '') {
    if (c.context && (!c.input.scope.tag_ids.length || c.context.persona)) {
      if (
        c.context.persona &&
        c.context.persona.schema_version !== PERSONA_CONTEXT_VERSION
      ) {
        c.context.reading_limitation =
          '此讨论保留原有依据；使用新版知识点推荐依据请重新分析论文后发起讨论。';
      } else if (question && c.context.persona) {
        const supplemented = await this.analyses.persona.supplement(
          c.context.paper,
          c.input,
          c.context.persona,
          question,
          signal,
          progress,
        );
        signal.throwIfAborted();
        c.context.persona = supplemented.context;
        c.context.records = supplemented.context.records;
        c.context.evidence = [
          ...c.context.evidence.filter((e) => !e.id.startsWith('persona:')),
          ...supplemented.context.evidence,
        ];
        c.context.reading_limitation = supplemented.limitation;
        this.repo.save(c);
      }
      return c.context;
    }
    const prior = c.context;
    const paper = await this.analyses.arxiv.get(
      c.input.arxiv_input,
      signal,
      progress,
    );
    signal.throwIfAborted();
    progress('读取限定标签的讨论依据');
    const persona = c.input.scope.tag_ids.length
      ? await this.analyses.persona.snapshot(
          paper,
          c.input,
          signal,
          progress,
          question,
        )
      : null;
    signal.throwIfAborted();
    if (
      persona &&
      (JSON.stringify(
        [...persona.scope.tag_ids].sort((a, b) => a.localeCompare(b)),
      ) !==
        JSON.stringify(
          [...c.input.scope.tag_ids].sort((a, b) => a.localeCompare(b)),
        ) ||
        persona.scope.tag_match !== 'any')
    )
      throw new AnalysisError('out_of_scope', '讨论材料超出了固定标签范围。');
    c.paper = publicPaper(paper);
    c.input.arxiv_input = paper.url;
    c.context = {
      paper: c.paper,
      evidence: [
        ...paper.blocks.map((b) => ({ ...b, title: paper.title })),
        ...(persona?.evidence ?? []),
      ],
      records: persona?.records ?? [],
      persona,
      report: prior?.report ?? null,
      coverage: 'paper_and_scoped_materials',
    };
    this.repo.save(c);
    return c.context;
  }
  async execute(t) {
    t.model_settings = requireHostSettings(t.model_settings);
    t.max_attempts = this.maxAttempts == null ? null : t.max_attempts;
    return executeAutonomousDiscussion(this, t);
  }
  async close() {
    this.shutdown.abort();
    await this.taskQueue.close();
  }
}
