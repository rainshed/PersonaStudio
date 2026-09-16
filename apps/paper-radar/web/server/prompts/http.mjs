import { isAgentPrompt, isScreenAgentPrompt, runAgentExperiment } from './agent-experiments.mjs';
import { z } from 'zod';
import { PromptError } from './store.mjs';
import { resolveConnection } from '../../lib/host-models.ts';
import {
  summarySchema,
  personalSchema,
  reviewSchema,
  parseOutput,
  validateSummary,
  validatePersonal,
} from '../analyses/contracts.mjs';
import { screenSchema, parseScreen } from '../daily/contracts.mjs';
import { answerSchema, parseAnswer } from '../discussions/contracts.mjs';
const decode = (value) =>
  typeof value === 'string' ? JSON.parse(value) : value;
const factsSchema = z
  .object({
    facts: z
      .array(
        z
          .object({
            text: z.string().min(1),
            evidence_ids: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .min(1)
      .max(60),
  })
  .strict();
export function validateResult(id, text, variables, context = {}) {
  const key = id.split('.').at(-1);
  if (key === 'repair' && context.variables) variables = context.variables;
  const coverage = ['输出结构'];
  let parsed,
    issues = [];
  if (key === 'screen') {
    parsed = parseOutput(text, screenSchema);
    if (context.paper && context.persona) {
      parsed = parseScreen(text, context.paper, context.persona);
      coverage.push('论文与 Persona 引用、用户事实');
    }
  } else if (key === 'discussion') {
    parsed = parseOutput(text, answerSchema);
    const c = variables.context ? decode(variables.context) : {};
    if (context.evidence || c.evidence) {
      parsed = parseAnswer(
        text,
        context.evidence ?? c.evidence,
        context.records ?? c.records ?? [],
      );
      coverage.push('引用与用户事实');
    }
  } else if (key === 'review') parsed = parseOutput(text, reviewSchema);
  else if (key === 'extract') {
    parsed = parseOutput(text, factsSchema);
    const allowed = new Set(decode(variables.blocks).map((v) => v.id));
    if (parsed.facts.some((v) => v.evidence_ids.some((id) => !allowed.has(id))))
      issues.push('分段事实引用了未提供的证据。');
    coverage.push('原始证据 ID');
  } else {
    const summary =
      key === 'summary' || (key === 'repair' && context.task !== 'connections');
    parsed = parseOutput(text, summary ? summarySchema : personalSchema);
    if (summary && variables.source) {
      const source = decode(variables.source);
      const ids = Array.isArray(source)
        ? source.map((v) => v.id)
        : (source.facts ?? []).flatMap((v) => v.evidence_ids);
      const checked = validateSummary(
        parsed,
        {
          language: variables.language === '中文' ? 'zh' : 'en',
          summary_length: {
            min: variables.min_length,
            max: variables.max_length,
          },
        },
        new Set(ids),
      );
      issues = checked.issues;
      coverage.push('字数、章节与原始引用');
    }
    if (!summary && context.paper && context.persona) {
      issues = validatePersonal(parsed, context.paper, context.persona);
      coverage.push('材料关系与用户事实');
    }
  }
  return {
    parsed,
    issues,
    coverage,
    note: '自动检查不能代替科学内容与推荐价值的人工判断。缺少原始业务上下文时只执行可验证的检查。',
  };
}
export class PromptAPI {
  constructor(store, models, analyses = null) {
    this.analyses = analyses;
    this.store = store;
    this.models = models;
    this.active = new Map();
    for (const e of store.records('experiments', null, -1))
      if (['running', 'queued'].includes(e.status))
        store.putRecord('experiments', {
          ...e,
          status: 'interrupted',
          error: '服务已重新启动，请重新运行实验。',
        });
  }
  async close() {
    for (const id of this.active.keys()) this.cancel(id);
    await Promise.allSettled([...this.active.values()].map((v) => v.work));
  }
  detail(id) {
    const d = this.store.detail(id),
      example = structuredClone(d.example);
    const key = id.split('.').at(-1);
    if (['summary', 'personalization'].includes(key)) {
      example.protocol = z.toJSONSchema(
        key === 'summary' ? summarySchema : personalSchema,
      );
      example.source = [
        {
          id: 'example-1',
          text: 'Synthetic example: diffusion on a one-dimensional chain with nearest-neighbor coupling. Higher dimensions have not been tested.',
          section: 'Abstract',
        },
      ];
      example.persona = { records: [], evidence: [], matches: [] };
    }
    if (key === 'screen') example.output_schema = z.toJSONSchema(screenSchema);
    if (key === 'discussion')
      example.output_schema = z.toJSONSchema(answerSchema);
    if (key === 'review')
      Object.assign(example, {
        language: '中文',
        source: [],
        persona: { records: [] },
        analysis: { sections: [] },
      });
    if (key === 'repair')
      Object.assign(example, {
        base: this.store.preview(
          'paper-radar.summary',
          this.detail('paper-radar.summary').example,
        ).rendered.user,
        previous: { sections: [] },
        issues: ['缺少六个章节'],
        all_issues: ['缺少六个章节'],
      });
    return {
      ...d,
      example,
      example_note: '内置虚构示例；真实任务可从运行记录载入输入。',
    };
  }
  start(raw) {
    const d = this.store.definition(raw.prompt_id);
    if (d.id === 'paper-radar.screen-agent')
      throw new PromptError(
        '此提示词需要真实论文与限定知识工具。可在此编辑、预览并启用；请从日报明确发起新筛选来验证，旧任务继续使用原快照。',
        'agent_task_required',
      );
    if (d.kind !== 'message')
      throw new PromptError('请通过使用此规则的功能进行试跑。');
    if (this.active.size >= 2)
      throw new PromptError('已有两个实验运行中，请等待或取消。', 'busy', 409);
    const capture = raw.capture_id
      ? this.store.record('captures', raw.capture_id)
      : null;
    if (capture && capture.prompt_id !== d.id)
      throw new PromptError('快照不属于当前提示词。');
    const variables =
      raw.variables ?? capture?.variables ?? this.detail(d.id).example;
    if (
      isAgentPrompt(d.id) &&
      (!this.analyses || !['dsh', 'codex'].includes(this.models.mode))
    )
      throw new PromptError(
        '自主任务试跑需要已连接的分析宿主和论文工具。',
        'agent_task_required',
      );
    if (isScreenAgentPrompt(d.id) && !capture?.context?.persona)
      throw new PromptError(
        '请载入一条真实初筛运行记录；它提供试跑所需的固定论文与知识范围。',
        'sample_required',
      );
    const variants = raw.variants ?? [{ version: 'active' }];
    if (!Array.isArray(variants) || variants.length < 1 || variants.length > 2)
      throw new PromptError('一次实验支持一个或两个版本。');
    const bundle = this.store.snapshot();
    const previews = variants.map((variant) =>
      this.store.preview(d.id, variables, { snapshot: bundle, variant }),
    );
    const settings = structuredClone(this.models.store.state.settings);
    const task =
      ['dsh', 'codex'].includes(this.models.mode) &&
      d.id.endsWith('.review')
        ? 'review'
        : (capture?.context?.task ?? d.task);
    if (raw.connection_id) {
      if (!settings.connections.some((v) => v.id === raw.connection_id))
        throw new PromptError('模型连接不存在。');
      settings.overrides[task] = raw.connection_id;
    }
    const c = resolveConnection(settings, task);
    if (!c)
      throw new PromptError(
        '请先在 Paper Radar 模型设置中配置此任务的模型。',
        'not_configured',
      );
    settings.fallback = { ...settings.fallback, enabled: false };
    const maxTokens = raw.max_tokens ?? 4096;
    if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 8192)
      throw new PromptError('实验输出上限应为 128–8192。');
    const value = this.store.putRecord('experiments', {
      prompt_id: d.id,
      name: d.name,
      status: 'queued',
      variables,
      previews,
      model: {
        connectionId: c.id,
        providerId: c.providerId,
        modelId: c.modelId,
        revision: c.revision,
        ...(settings.dsh || settings.codex
          ? {
              reasoningEffort: c.reasoningEffort,
              runtimeId:
                settings.dsh?.runtimeId ?? settings.codex?.protocol,
            }
          : {}),
      },
      max_tokens: maxTokens,
      results: [],
      feedback: null,
      capture_id: raw.capture_id ?? null,
    });
    const controller = new AbortController();
    const entry = { controller, work: null };
    this.active.set(value.id, entry);
    entry.work = Promise.resolve().then(() =>
      this.run(
        value,
        settings,
        task,
        capture &&
          JSON.stringify(variables) === JSON.stringify(capture.variables)
          ? capture.context
          : {},
        controller.signal,
      ),
    );
    return value;
  }
  async run(value, settings, task, context, signal) {
    try {
      if (signal.aborted) return;
      value.status = 'running';
      this.store.putRecord('experiments', value);
      for (const [i, preview] of value.previews.entries()) {
        if (signal.aborted) return;
        const started = Date.now();
        const result = { label: 'AB'[i], status: 'failed' };
        try {
          const raw = isAgentPrompt(value.prompt_id)
            ? await runAgentExperiment(
                this,
                value,
                settings,
                task,
                context,
                preview,
                signal,
              )
            : await this.models.run(
                {
                  task,
                  systemPrompt: preview.rendered.system,
                  prompt: preview.rendered.user,
                  maxTokens: value.max_tokens,
                  experiment: true,
                  businessTask: value.id,
                },
                {
                  settings,
                  signal,
                  beforeAttempt: (c) => {
                    if (
                      this.models.store.state.settings.connections.find(
                        (x) => x.id === c.id,
                      )?.revision !== c.revision
                    )
                      throw new PromptError(
                        '实验模型连接已改变，请重新开始实验。',
                        'connection_changed',
                      );
                    if (
                      Math.ceil(
                        Buffer.byteLength(
                          preview.rendered.system + preview.rendered.user,
                        ) / 2,
                      ) +
                        Math.min(c.maxTokens, value.max_tokens) +
                        2000 >
                      c.contextWindow
                    )
                      throw new PromptError(
                        '实验输入超过当前模型容量。',
                        'context_length',
                      );
                  },
                },
              );
          result.status = 'succeeded';
          result.output = raw.text;
          result.model = Object.fromEntries(
            Object.entries(raw).filter(([k]) => k !== 'text'),
          );
          try {
            result.validation =
              raw.validation ??
              validateResult(
                value.prompt_id,
                raw.text,
                value.variables,
                context,
              );
          } catch (e) {
            result.validation = {
              issues: [e.message || '输出校验失败。'],
              coverage: ['输出结构'],
            };
          }
        } catch (e) {
          result.error = e.message || '模型调用未完成。';
        }
        result.duration_ms = Date.now() - started;
        if (signal.aborted) return;
        value.results.push(result);
        this.store.putRecord('experiments', value);
      }
      value.status = value.results.every((r) => r.status === 'succeeded')
        ? 'succeeded'
        : 'failed';
      value.finished_at = new Date().toISOString();
      this.store.putRecord('experiments', value);
    } catch {
      if (!signal.aborted) {
        value.status = 'failed';
        value.error = '实验记录未能完整保存，请缩小输入后重试。';
        try {
          this.store.putRecord('experiments', value);
        } catch {}
      }
    } finally {
      this.active.delete(value.id);
    }
  }
  cancel(id) {
    const value = this.store.record('experiments', id);
    if (['running', 'queued'].includes(value.status)) {
      this.active.get(id)?.controller.abort();
      value.status = 'cancelled';
      this.store.putRecord('experiments', value);
    }
    return value;
  }
  async dispatch(method, path, raw = {}, query = {}) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length && method === 'GET')
      return {
        protocol_version: 1,
        project_id: 'paper-radar',
        capabilities: {
          experiments: true,
          captures: true,
          activation_batch: true,
        },
        prompts: this.store.catalog(),
      };
    if (parts.join('/') === 'models' && method === 'GET')
      return this.models.config();
    if (parts[0] === 'prompts') {
      if (parts.length === 2 && method === 'GET') return this.detail(parts[1]);
      if (parts.length === 3 && parts[2] === 'versions' && method === 'POST')
        return this.store.saveVersion(
          parts[1],
          raw.templates,
          raw.note,
          raw.base_version,
        );
    }
    if (parts.join('/') === 'activate' && method === 'POST')
      return this.store.activate(raw.changes);
    if (parts.join('/') === 'preview' && method === 'POST')
      return this.store.preview(raw.prompt_id, raw.variables, {
        variant: raw.variant,
      });
    if (parts.join('/') === 'delete' && method === 'POST')
      return this.store.delete(raw.kind, raw.id);
    if (parts.join('/') === 'export' && method === 'GET')
      return {
        protocol_version: 1,
        project_id: 'paper-radar',
        prompts: Object.keys(this.store.definitions).map((id) =>
          this.store.detail(id),
        ),
        ...Object.fromEntries(
          ['samples', 'captures', 'experiments'].map((k) => [
            k,
            this.store.records(k, null, -1),
          ]),
        ),
      };
    if (['samples', 'captures', 'experiments'].includes(parts[0])) {
      const kind = parts[0];
      if (method === 'GET') {
        if (parts.length === 2) return this.store.record(kind, parts[1]);
        if (parts.length === 1)
          return {
            items: this.store
              .records(kind, query.prompt_id)
              .map((v) =>
                Object.fromEntries(
                  Object.entries(v).filter(
                    ([key]) =>
                      ![
                        'variables',
                        'snapshot',
                        'context',
                        'previews',
                        'results',
                      ].includes(key),
                  ),
                ),
              ),
          };
      }
      if (method === 'POST') {
        if (kind === 'samples' && parts.length === 1) {
          this.store.preview(raw.prompt_id, raw.variables);
          if (
            typeof raw.name !== 'string' ||
            !raw.name.trim() ||
            raw.name.length > 200 ||
            typeof (raw.expected ?? '') !== 'string' ||
            (raw.expected?.length ?? 0) > 3000
          )
            throw new PromptError(
              '请填写不超过 200 字符的样例名称，预期说明不超过 3000 字符。',
            );
          return this.store.putRecord(kind, {
            prompt_id: raw.prompt_id,
            name: raw.name.trim(),
            variables: raw.variables,
            expected: raw.expected ?? '',
          });
        }
        if (kind === 'experiments') {
          if (parts.length === 1) return this.start(raw);
          if (parts.length === 3 && parts[2] === 'cancel')
            return this.cancel(parts[1]);
          if (parts.length === 3 && parts[2] === 'feedback') {
            if (
              !['A', 'B', 'equal'].includes(raw.choice) ||
              typeof (raw.note ?? '') !== 'string' ||
              (raw.note?.length ?? 0) > 2000
            )
              throw new PromptError('评价格式无效。');
            const value = this.store.record(kind, parts[1]);
            if (['queued', 'running'].includes(value.status))
              throw new PromptError('请等待实验结束。');
            return this.store.putRecord(kind, {
              ...value,
              feedback: { choice: raw.choice, note: raw.note ?? '' },
            });
          }
        }
      }
    }
    throw new PromptError('接口不存在。', 'not_found', 404);
  }
}
