import {
  CURRENT_EVALUATION,
  casePlan,
  requireMatchingScopes,
  prepareCurrentInput,
  currentReaders,
  currentVariables,
} from './current-input.mjs';
import { analysisReplayReader } from './analysis-input.mjs';
import { runAutonomous } from '../agents/autonomous-task.mjs';
import {
  experimentOptions,
  experimentCandidate,
  saveDraft,
  suitePrompts,
} from './experiments.mjs';
import { SCREEN_AGENT_PROMPT } from '@paper-radar/host-contract/agent-contract';
import { AnalysisError, hash, safeError } from '../analyses/contracts.mjs';
import { resolveConnection } from '../../lib/host-models.ts';
import {
  ScreeningEvidence,
  executeScreeningAgent,
} from '../daily/agent-screening.mjs';
import { parseScreen } from '../daily/contracts.mjs';
import { identifier, stamp } from './repository.mjs';
import { EvaluationCases } from './cases.mjs';
import { fail } from './errors.mjs';
import {
  binary,
  scoreItems,
  compareItems,
  SCORING_VERSION,
  usageForItems,
} from './scoring.mjs';

const connectionFingerprint = (c) =>
  hash({
    id: c?.id,
    providerId: c?.providerId,
    modelId: c?.modelId,
    revision: c?.revision,
    reasoningEffort: c?.reasoningEffort,
  });
const safeConnection = (c) =>
  Object.fromEntries(
    [
      'id',
      'name',
      'providerId',
      'modelId',
      'revision',
      'reasoningEffort',
      'contextWindow',
      'maxTokens',
    ]
      .filter((k) => c[k] !== undefined)
      .map((k) => [k, c[k]]),
  );
const completionStatus = (items) => {
  const valid = items.filter(
    (i) => i.status === 'completed' && binary(i.outcome),
  ).length;
  return valid === items.length && valid > 0
    ? 'completed'
    : valid
      ? 'partial'
      : 'failed';
};
const terminal = (state) => !['queued', 'running'].includes(state);

export class EvaluationService extends EvaluationCases {
  constructor(daily) {
    super(daily);
    this.importLegacy();
    this.models = daily.models;
    this.prompts = daily.analyses.prompts;
    this.controllers = new Map();
    this.onWithdraw = (id) => {
      for (const entry of this.controllers.values())
        if (entry.caseId === id)
          entry.itemController?.abort(
            new AnalysisError('withdrawn', '样例已撤销。'),
          );
    };
    this.work = null;
    this.closed = false;
    this.shutdown = new AbortController();
    this.previews = new Map();
    this.queue = daily.analyses.taskRuntime.register('evaluation', {
      signal: this.shutdown.signal,
      stop: () => this.shutdown.abort(),
      pending: () =>
        this.repo.all('evaluation_runs').filter((r) => r.status === 'queued'),
      get: (id) => this.repo.get('evaluation_runs', id, false),
      run: (run) => this.execute(run.id),
      onError: (run, error) => {
        const value = this.repo.get('evaluation_runs', run.id);
        value.status = 'interrupted';
        value.error = error.message;
        this.repo.put('evaluation_runs', value);
      },
      priority: () => 0,
      group: () => 'evaluation',
      concurrency: () => 1,
    });
    for (const run of this.repo.all('evaluation_runs'))
      if (!terminal(run.status)) {
        run.status = 'interrupted';
        run.error = '服务中断；请明确恢复。已发出但未确认的调用不会自动重发。';
        this.repo.put('evaluation_runs', run);
        for (const item of this.items(run.id))
          if (item.status === 'running') {
            item.status = 'result_unknown';
            item.error = { code: 'result_unknown', message: run.error };
            this.repo.put('evaluation_run_items', item);
          }
      }
    // Older runs marked every skipped sample as a completed experiment.
    // Correct existing records and their notifications without issuing a new one.
    for (const run of this.repo.all('evaluation_runs')) {
      if (run.status !== 'completed') continue;
      const status = completionStatus(this.items(run.id));
      if (status === run.status) continue;
      run.status = status;
      this.repo.put('evaluation_runs', run);
      if (
        this.repo.db
          .prepare("SELECT 1 FROM sqlite_master WHERE name='notifications'")
          .get()
      )
        this.repo.db
          .prepare(
            "UPDATE notifications SET status=? WHERE kind='evaluation' AND task_id=?",
          )
          .run(status, run.id);
    }
  }
  experimentOptions(suiteId, scopeKey) {
    return experimentOptions(this, suiteId, scopeKey);
  }
  saveDraft(raw) {
    return saveDraft(this, raw);
  }
  options() {
    const settings = this.models.store.state.settings;
    return {
      connections: settings.connections.map(safeConnection),
      default_connection_id: resolveConnection(settings, 'screen')?.id ?? null,
      prompts: [SCREEN_AGENT_PROMPT, 'paper-radar.screen']
        .map((id) => {
          try {
            const p = this.prompts.detail(id);
            return {
              id,
              name: p.name,
              active_version: p.active_version,
              versions: p.versions
                .filter((v) => v.compatible)
                .map((v) => ({
                  id: v.id,
                  created_at: v.created_at,
                  label: v.label ?? v.id,
                })),
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean),
    };
  }
  prepare(raw) {
    const suite = this.checkSuite(raw.suite_id);
    if (
      !Array.isArray(raw.candidates) ||
      raw.candidates.length < 1 ||
      raw.candidates.length > 2
    )
      fail('invalid_request', '请选择一个或两个候选版本。');
    const settings = structuredClone(this.models.store.state.settings),
      bundle = this.prompts.snapshot();
    const casePlans = Object.fromEntries(
      suite.members.map((m) => {
        const c = this.caseRevision(m);
        return [c.id, casePlan(this, c)];
      }),
    );
    requireMatchingScopes(casePlans);
    const promptIds = new Set(Object.values(casePlans).map((p) => p.prompt_id));
    const taskKeys = [
      ...new Set(
        [...promptIds].map((id) =>
          id === 'paper-radar.task-single' ? 'single' : 'screen',
        ),
      ),
    ];
    if (!taskKeys.length) taskKeys.push('screen');
    const promptId = [...promptIds][0] ?? SCREEN_AGENT_PROMPT;
    if (
      (promptIds.has(SCREEN_AGENT_PROMPT) ||
        promptIds.has('paper-radar.task-single')) &&
      (this.models.supportsAgents === false ||
        typeof this.models.runAgent !== 'function')
    )
      fail(
        'incompatible',
        '当前模型宿主不支持推荐评测工具，请切换到支持 Agent 的宿主。',
      );
    const candidates = raw.candidates.map((candidate, index) => {
      if (candidate.prompt_id && candidate.prompt_id !== promptId)
        fail('incompatible', '所选提示词不适用于本次评测任务。');
      const experiment =
        candidate.selection && !candidate.current
          ? experimentCandidate(this, candidate, suite, bundle)
          : null;
      const connection =
        experiment?.connection ??
        settings.connections.find(
          (c) =>
            c.id ===
            (candidate.connection_id ??
              resolveConnection(settings, taskKeys[0])?.id),
        );
      if (
        !connection ||
        (candidate.current &&
          taskKeys.some((task) => !resolveConnection(settings, task)))
      )
        fail('not_configured', '选择的模型连接不存在。');
      const snapshot = experiment?.snapshot ?? structuredClone(bundle);
      if (!experiment && !candidate.current)
        snapshot.versions[promptId] = this.prompts.version(
          promptId,
          candidate.version ?? 'active',
        );
      const ownSettings = experiment?.settings ?? {
        ...structuredClone(settings),
        overrides: candidate.current
          ? settings.overrides
          : {
              ...settings.overrides,
              ...Object.fromEntries(
                taskKeys.map((task) => [task, connection.id]),
              ),
            },
        fallback: { ...settings.fallback, enabled: false },
      };
      const selectedHost =
        this.models.backendForSettings?.(ownSettings) ?? this.models;
      if (
        (promptIds.has(SCREEN_AGENT_PROMPT) ||
          promptIds.has('paper-radar.task-single')) &&
        (selectedHost.supportsAgents === false ||
          typeof selectedHost.runAgent !== 'function')
      )
        fail('incompatible', '所选 Agent 不支持推荐任务所需的工具。');
      for (const plan of Object.values(casePlans))
        this.prompts.preview(plan.prompt_id, plan.variables, { snapshot });
      return {
        ...(experiment
          ? {
              experimental: true,
              backend: experiment.backend,
              base_prompt_versions: experiment.base_prompt_versions,
              prompt_changes: experiment.prompt_changes,
              prompt_fields: experiment.prompt_fields,
            }
          : {}),
        id: index ? 'B' : 'A',
        prompt_id: promptId,
        task_keys: taskKeys,
        current: !!candidate.current,
        ...(candidate.current
          ? {
              task_models: Object.fromEntries(
                taskKeys.map((task) => [
                  task,
                  safeConnection(resolveConnection(settings, task)),
                ]),
              ),
              prompt_fields: suitePrompts(this, suite, snapshot).map((id) => ({
                id,
                name: this.prompts.definition(id).name,
                templates: snapshot.versions[id].templates,
              })),
            }
          : {}),
        prompt_snapshot: snapshot,
        model: safeConnection(connection),
        attempt_unit:
          this.models.capabilitiesForSettings?.(ownSettings)?.attemptUnit ??
          (this.models.backendForSettings?.(ownSettings) ?? this.models)
            .capabilities?.attemptUnit ??
          (ownSettings.codex
            ? 'agent-turn'
            : ownSettings.dsh
              ? 'model-attempt'
              : 'unknown'),
        connection_fingerprint: connectionFingerprint(connection),
        settings: ownSettings,
      };
    });
    const maxCalls =
      raw.max_calls ??
      suite.members.length *
        candidates.length *
        (promptIds.has(SCREEN_AGENT_PROMPT) ||
        promptIds.has('paper-radar.task-single')
          ? 20
          : 2);
    if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 20000)
      fail('invalid_request', '调用预算应为 1–20000。');
    const maxTokens = raw.max_tokens ?? 8192;
    if (!Number.isInteger(maxTokens) || maxTokens < 128 || maxTokens > 8192)
      fail('invalid_request', '输出上限应为 128–8192。');
    const budgetTokens = raw.token_budget ?? maxCalls * 100000;
    if (
      !Number.isInteger(budgetTokens) ||
      budgetTokens < 1 ||
      budgetTokens > 2e9
    )
      fail('invalid_request', 'Token 预算无效。');
    return {
      suite,
      case_plans: casePlans,
      candidates,
      max_calls: maxCalls,
      max_tokens: maxTokens,
      token_budget: budgetTokens,
    };
  }
  preview(raw) {
    const p = this.prepare(raw),
      previewId = identifier('preview');
    for (const [id, value] of this.previews)
      if (Date.now() - value.at > 1800000) this.previews.delete(id);
    this.previews.set(previewId, {
      prepared: p,
      hash: hash(raw),
      at: Date.now(),
    });
    return {
      preview_id: previewId,
      suite_id: p.suite.id,
      suite_hash: p.suite.hash,
      cases: p.suite.members.length,
      papers: new Set(p.suite.members.map((m) => m.group_id)).size,
      recommended: p.suite.members.filter(
        (m) => m.expected_outcome === 'recommended',
      ).length,
      input_missing: 0,
      max_calls: p.max_calls,
      max_tokens: p.max_tokens,
      token_budget: p.token_budget,
      estimated_cost: null,
      candidates: p.candidates.map(
        ({ settings: _settings, prompt_snapshot, ...v }) => ({
          ...v,
          prompt_version:
            v.experimental || v.current
              ? prompt_snapshot.fingerprint
              : prompt_snapshot.versions[v.prompt_id].id,
        }),
      ),
      note: '预算使用宿主计量次数：Codex 按任务轮次，Harness 按模型请求，工具往返不一定等于一次计量。Token 阈值在宿主回报用量后检查，可能跨过一个执行单位。按本次配置读取论文和当前 tag 范围的知识库；保存和预览不调用模型。',
    };
  }
  start(raw) {
    const { preview_id, idempotency_key, ...request } = raw;
    const requestKey = idempotency_key ?? preview_id;
    if (
      typeof requestKey !== 'string' ||
      requestKey.length < 8 ||
      requestKey.length > 150
    )
      fail('invalid_request', '开始回测需要有效预览或幂等请求标识。');
    const prior = this.repo.db
      .prepare(
        "SELECT data FROM evaluation_runs WHERE json_extract(data,'$.request_key')=?",
      )
      .get(requestKey);
    if (prior) {
      const previous = JSON.parse(prior.data);
      if (previous.request_hash !== hash(request))
        fail('conflict', '重复开始请求的配置不同。', 409);
      return this.report(previous.id);
    }

    const saved = preview_id ? this.previews.get(preview_id) : null;
    if (
      preview_id &&
      (!saved ||
        saved.hash !== hash(request) ||
        Date.now() - saved.at > 1800000)
    )
      fail('preview_changed', '预览已过期或设置有变化，请重新预览。', 409);
    const p = saved ? structuredClone(saved.prepared) : this.prepare(request);
    this.checkSuite(p.suite.id);
    if (preview_id) this.previews.delete(preview_id);
    const run = {
      id: identifier('eval'),
      request_key: requestKey,
      request_hash: hash(request),
      suite_id: p.suite.id,
      suite_hash: p.suite.hash,
      status: 'queued',
      created_at: stamp(),
      name: typeof raw.name === 'string' ? raw.name.slice(0, 150) : null,
      name_is_default:
        raw.name_is_default === true && raw.name === '我的推荐测试集 · 新实验',
      candidates: p.candidates,
      max_calls: p.max_calls,
      max_tokens: p.max_tokens,
      token_budget: p.token_budget,
      actual_calls: 0,
      usage: {
        input: 0,
        output: 0,
        cost: null,
        known_cost: 0,
        cost_complete: false,
        unknown_cost_calls: 0,
      },
      scoring_version: SCORING_VERSION,
      execution_version: CURRENT_EVALUATION,
      case_plans: p.case_plans,
      current_inputs: {},
      error: null,
    };
    this.repo.database.transaction(() => {
      this.repo.put('evaluation_runs', run);
      for (const c of p.candidates)
        for (const m of p.suite.members)
          this.repo.put('evaluation_run_items', {
            id: `${run.id}:${c.id}:${m.case_id}`,
            run_id: run.id,
            candidate_id: c.id,
            ...m,
            status: 'queued',
            outcome: null,
            attempts: [],
            created_at: stamp(),
          });
    });
    this.pump();
    return this.report(run.id);
  }
  items(id) {
    return this.repo
      .all('evaluation_run_items')
      .filter((v) => v.run_id === id)
      .reverse();
  }
  report(id) {
    const run = this.repo.get('evaluation_runs', id),
      items = this.items(id);
    const { current_inputs: _inputs, case_plans: _plans, ...publicRun } = run;
    const status =
      run.status === 'completed' ? completionStatus(items) : run.status;
    return {
      ...publicRun,
      status,
      candidates: run.candidates.map(
        ({ settings: _settings, prompt_snapshot, ...v }) => ({
          ...v,
          prompt_version:
            v.experimental || v.current
              ? prompt_snapshot.fingerprint
              : prompt_snapshot.versions[v.prompt_id].id,
        }),
      ),
      items,
      scores: Object.fromEntries(
        run.candidates.map((c) => [
          c.id,
          scoreItems(items.filter((v) => v.candidate_id === c.id)),
        ]),
      ),
      candidate_usage: Object.fromEntries(
        run.candidates.map((c) => [
          c.id,
          usageForItems(items.filter((i) => i.candidate_id === c.id)),
        ]),
      ),
      comparisons:
        run.candidates.length === 2
          ? compareItems(
              items.filter((v) => v.candidate_id === 'A'),
              items.filter((v) => v.candidate_id === 'B'),
            )
          : [],
      partial: status !== 'completed',
      title: run.name || '个人已评价样例表现',
    };
  }
  async execute(id) {
    let run = this.repo.get('evaluation_runs', id);
    run.status = 'running';
    run.started_at ??= stamp();
    this.repo.put('evaluation_runs', run);
    const controller = new AbortController();
    this.controllers.set(id, {
      controller,
      caseId: null,
      itemController: null,
    });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new AnalysisError('run_timeout', '本次回测超过一小时。'),
        ),
      3600000,
    );
    try {
      for (const item of this.items(id)) {
        if (item.status !== 'queued') continue;
        run = this.repo.get('evaluation_runs', id);
        if (run.status !== 'running') break;
        if (
          run.actual_calls >= run.max_calls ||
          run.usage.input + run.usage.output >= run.token_budget
        ) {
          run.status = 'paused';
          run.error = '预算已耗尽；可增加预算后明确恢复。';
          this.repo.put('evaluation_runs', run);
          break;
        }
        await this.executeItem(
          run,
          item,
          AbortSignal.any([controller.signal, this.shutdown.signal]),
        );
      }
      run = this.repo.get('evaluation_runs', id);
      if (run.status === 'running') {
        run.status = controller.signal.aborted
          ? 'interrupted'
          : completionStatus(this.items(id));
        run.finished_at = stamp();
        this.repo.put('evaluation_runs', run);
      }
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(id);
    }
  }
  async executeItem(run, item, runSignal) {
    const latestCase = this.repo.get('evaluation_cases', item.case_id);
    const frozen = this.repo.get('evaluation_suites', run.suite_id).automatic;
    const c = frozen ? this.caseRevision(item) : latestCase;
    if (
      latestCase.state !== 'active' ||
      (!frozen && c.benchmark_revision !== item.benchmark_revision)
    ) {
      item.status = 'withdrawn';
      this.repo.put('evaluation_run_items', item);
      return;
    }
    const currentMode = run.execution_version === CURRENT_EVALUATION;
    if (!currentMode && !c.input_snapshot_id) {
      item.status = 'input_missing';
      this.repo.put('evaluation_run_items', item);
      return;
    }
    let input = currentMode
      ? null
      : this.repo.get('screening_inputs', c.input_snapshot_id);
    const candidate = run.candidates.find((v) => v.id === item.candidate_id);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      runSignal,
      controller.signal,
      AbortSignal.timeout(600000),
    ]);
    this.controllers.get(run.id).caseId = c.id;
    this.controllers.get(run.id).itemController = controller;
    let unavailable = false;
    item.status = 'running';
    item.started_at = stamp();
    this.repo.put('evaluation_run_items', item);
    const check = () => {
      signal.throwIfAborted();
      const latest = this.repo.get('evaluation_cases', c.id);
      if (
        latest.state !== 'active' ||
        (!frozen && latest.benchmark_revision !== item.benchmark_revision)
      )
        fail('withdrawn', '样例反馈已修改或撤销。');
      if (currentMode) return;
      const host =
        this.models.backendForSettings?.(candidate.settings) ?? this.models;
      const task =
        input.prompt.prompt_id === 'paper-radar.task-single'
          ? 'single'
          : 'screen';
      const model = candidate.current
        ? resolveConnection(candidate.settings, task)
        : candidate.model;
      const current = host.store.state.settings.connections.find(
        (v) => v.id === model?.id,
      );
      if (
        !candidate.experimental &&
        connectionFingerprint(current) !==
          (candidate.current
            ? connectionFingerprint(model)
            : candidate.connection_fingerprint)
      )
        fail('connection_changed', '所选模型连接已改变，请重新开始。');
    };
    const hooks = {
      beforeAttempt: (_connection, attempt = {}) => {
        check();
        if (attempt.id && item.attempts.some((a) => a.id === attempt.id))
          return;
        const current = this.repo.get('evaluation_runs', run.id);
        if (current.status !== 'running') fail('cancelled', '评测已停止。');
        if (
          current.actual_calls >= current.max_calls ||
          current.usage.input + current.usage.output >= current.token_budget
        )
          fail('budget_exhausted', '评测预算已耗尽。');
        current.actual_calls++;
        this.repo.put('evaluation_runs', current);
        item.attempts.push({
          ...attempt,
          id: attempt.id ?? identifier('attempt'),
          correlation_missing: !attempt.id,
          dispatched: true,
          status: 'running',
          usage: null,
        });
        this.repo.put('evaluation_run_items', item);
      },
      onAttempt: (attempt) => {
        let index = item.attempts.findIndex((v) => v.id === attempt.id);
        if (index < 0)
          index = item.attempts.findIndex(
            (v) => v.correlation_missing && v.status === 'running',
          );
        if (index < 0) item.attempts.push({ ...attempt, dispatched: false });
        else
          item.attempts[index] = {
            ...attempt,
            dispatched: item.attempts[index].dispatched,
          };
        this.repo.put('evaluation_run_items', item);
        const current = this.repo.get('evaluation_runs', run.id);
        current.usage = usageForItems(this.items(run.id));
        this.repo.put('evaluation_runs', current);
      },
    };
    try {
      check();
      if (currentMode) {
        input =
          run.current_inputs?.[c.id] ??
          (await prepareCurrentInput(this, run.case_plans[c.id], signal));
        const current = this.repo.get('evaluation_runs', run.id);
        current.current_inputs[c.id] = input;
        this.repo.put('evaluation_runs', current);
        check();
      }
      const readers = currentMode
        ? currentReaders(this, input, candidate.prompt_snapshot, signal)
        : null;
      let data, result;
      if (input.prompt.prompt_id === 'paper-radar.task-single') {
        const reader = readers
          ? await readers.single()
          : await analysisReplayReader(input, signal, () => {
              unavailable = true;
            });
        result = await runAutonomous({
          analyses: { models: this.models, prompts: this.prompts },
          task: 'single',
          reader,
          settings: candidate.settings,
          snapshot: candidate.prompt_snapshot,
          signal,
          businessId: run.id,
          experiment: true,
          // Keep the production tool contract; partial output stays inside this run.
          onSave: () => {},
          maxAttempts: 20,
          executionMs: 600000,
          maxTokens: run.max_tokens,
          preview: this.prompts.preview(
            input.prompt.prompt_id,
            readers
              ? currentVariables(input, reader, candidate.prompt_snapshot)
              : input.variables,
            { snapshot: candidate.prompt_snapshot },
          ),
          ...hooks,
        });
        data = {
          outcome: result.data.personalization.decision,
          reason: result.data.personalization.reasons
            .map((r) => r.text)
            .join('\n'),
          introduction:
            result.data.summary.sections[0]?.paragraphs.join('\n') ?? '',
        };
      } else if (input.prompt.prompt_id === SCREEN_AGENT_PROMPT) {
        const frozenRun = {
          context: structuredClone(input.context),
          subscription: structuredClone(input.subscription),
        };
        const makeReader = () =>
          readers
            ? readers.screening()
            : new ScreeningEvidence(
                null,
                frozenRun,
                structuredClone(input.item),
                signal,
                {
                  replay: true,
                  frozenPaper: input.full_paper,
                  frozenQueries: input.persona_queries ?? [],
                  onUnavailable: () => {
                    unavailable = true;
                  },
                },
              );
        const reader = makeReader();
        reader.initial();
        const prepared = this.prompts.preview(
          input.prompt.prompt_id,
          readers
            ? currentVariables(input, reader, candidate.prompt_snapshot)
            : input.variables,
          { snapshot: candidate.prompt_snapshot },
        );
        ({ data, result } = await executeScreeningAgent({
          store: this.prompts,
          experiment: true,
          models: this.models,
          prepared,
          signal,
          settings: candidate.settings,
          taskId: run.id,
          reader,
          createReader: makeReader,
          hooks,
          maxTokens: run.max_tokens,
        }));
      } else {
        let issues = '';
        for (let iteration = 0; iteration < 2; iteration++) {
          const prepared = this.prompts.preview(
            input.prompt.prompt_id,
            { ...input.variables, issues },
            { snapshot: candidate.prompt_snapshot },
          );
          result = await this.models.run(
            {
              task: 'screen',
              systemPrompt: prepared.rendered.system,
              prompt: prepared.rendered.user,
              maxTokens: Math.min(run.max_tokens, 2048),
              businessTask: run.id,
            },
            { signal, settings: candidate.settings, ...hooks },
          );
          try {
            data = parseScreen(result.text, input.item.paper, input.context);
            break;
          } catch (e) {
            if (iteration) throw e;
            issues = '\nFix the previous format/evidence issue: ' + e.message;
          }
        }
      }
      check();
      if (unavailable)
        fail(
          'input_unavailable',
          '候选需要原始运行未保存的全文，不能进行同等输入回放。',
        );
      item.outcome = data.outcome;
      item.output = data;
      item.model = {
        provider_id: result.providerId,
        model_id: result.modelId,
        request_id: result.requestId,
        reasoning_effort: result.reasoningEffort ?? null,
      };
      item.status = binary(data.outcome) ? 'completed' : 'needs_fulltext';
    } catch (e) {
      const code = signal.reason?.code ?? e.code;
      item.error = safeError(e);
      item.status = unavailable
        ? 'input_unavailable'
        : code === 'withdrawn'
          ? 'withdrawn'
          : code === 'input_unavailable'
            ? 'input_unavailable'
            : currentMode && !item.attempts.length
              ? 'input_failed'
              : code === 'budget_exhausted'
                ? 'queued'
                : code === 'connection_changed'
                  ? 'connection_changed'
                  : runSignal.aborted
                    ? 'cancelled'
                    : signal.aborted
                      ? 'timeout'
                      : ['invalid_output', 'invalid_reference'].includes(code)
                        ? 'validation_failed'
                        : item.attempts.some((a) => a.status === 'running')
                          ? 'result_unknown'
                          : 'request_failed';
      if (code === 'budget_exhausted' || code === 'connection_changed') {
        const current = this.repo.get('evaluation_runs', run.id);
        current.status = 'paused';
        current.error = e.message;
        this.repo.put('evaluation_runs', current);
      }
    } finally {
      if (currentMode && input) {
        const current = this.repo.get('evaluation_runs', run.id);
        if (this.repo.get('evaluation_cases', c.id).state !== 'deleted') {
          current.current_inputs[c.id] = input;
          this.repo.put('evaluation_runs', current);
        }
      }
      item.duration_ms = Date.now() - Date.parse(item.started_at);
      this.repo.put('evaluation_run_items', item);
      this.controllers.get(run.id).caseId = null;
    }
  }
  pump() {
    if (!this.closed) this.work = this.queue.wake();
  }
  cancel(id) {
    const run = this.repo.get('evaluation_runs', id);
    if (!terminal(run.status) || run.status === 'paused') {
      run.status = 'cancelled';
      run.finished_at = stamp();
      this.repo.put('evaluation_runs', run);
      this.controllers
        .get(id)
        ?.controller.abort(new AnalysisError('cancelled', '用户取消评测。'));
      for (const item of this.items(id))
        if (item.status === 'queued') {
          item.status = 'cancelled';
          this.repo.put('evaluation_run_items', item);
        }
    }
    return this.report(id);
  }
  resume(id, raw = {}) {
    const run = this.repo.get('evaluation_runs', id);
    if (!['paused', 'interrupted', 'cancelled'].includes(run.status))
      fail('conflict', '当前评测不能恢复。', 409);
    this.checkSuite(run.suite_id);
    if (raw.max_calls !== undefined) {
      if (
        !Number.isInteger(raw.max_calls) ||
        raw.max_calls < run.max_calls ||
        raw.max_calls > 20000
      )
        fail('invalid_request', '新的调用预算必须不小于原预算。');
      run.max_calls = raw.max_calls;
    }
    if (raw.token_budget !== undefined) {
      if (
        !Number.isInteger(raw.token_budget) ||
        raw.token_budget < run.token_budget ||
        raw.token_budget > 2e9
      )
        fail(
          'invalid_request',
          '新的 Token 预算必须不小于原预算，且不超过二十亿。',
        );
      run.token_budget = raw.token_budget;
    }
    for (const item of this.items(id))
      if (item.status === 'cancelled' && !item.attempts.length) {
        item.status = 'queued';
        this.repo.put('evaluation_run_items', item);
      }
    if (!this.items(id).some((i) => i.status === 'queued'))
      fail(
        'conflict',
        '没有可以安全恢复的未执行项；结果未知的请求请在新运行中明确重试。',
        409,
      );
    run.status = 'queued';
    run.error = null;
    this.repo.put('evaluation_runs', run);
    this.daily.analyses.taskRuntime.retry('evaluation', id);
    this.pump();
    return this.report(id);
  }
  async close() {
    this.closed = true;
    this.shutdown.abort();
    for (const [id] of this.controllers) {
      const run = this.repo.get('evaluation_runs', id);
      run.status = 'interrupted';
      this.repo.put('evaluation_runs', run);
      this.controllers
        .get(id)
        .controller.abort(new AnalysisError('interrupted', '服务正在关闭。'));
    }
    await this.queue.close();
  }
}
