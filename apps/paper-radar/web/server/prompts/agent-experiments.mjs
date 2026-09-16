import { runAgentWithContext } from './agent-context.mjs';
import { randomUUID } from 'node:crypto';
import { validateInput, AnalysisError } from '../analyses/contracts.mjs';
import { ResearchTools } from '../agents/research-tools.mjs';
import { runAutonomous } from '../agents/autonomous-task.mjs';
import { ScreeningEvidence } from '../daily/agent-screening.mjs';
import {
  SCREEN_AGENT_PROMPT,
} from '@paper-radar/host-contract/agent-contract';

export const isScreenAgentPrompt = (id) => id === SCREEN_AGENT_PROMPT || id === `${SCREEN_AGENT_PROMPT}.zh` || id === `${SCREEN_AGENT_PROMPT}.en`;
export const isAgentPrompt = (id) =>
  id.startsWith('paper-radar.task-') || isScreenAgentPrompt(id);
export async function runAgentExperiment(
  api,
  value,
  settings,
  task,
  context,
  preview,
  signal,
) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(300000)]),
    attempts = [];
  let count = 0;
  const beforeAttempt = () => {
    deadline.throwIfAborted();
    if (++count > 12)
      throw new AnalysisError('budget_exceeded', '实验达到模型调用预算。');
  };
  const onAttempt = (a) => {
    attempts.push(a);
    value.agent_attempts = [...(value.agent_attempts ?? []), a];
    api.store.putRecord('experiments', value);
  };
  if (isScreenAgentPrompt(value.prompt_id)) {
    const supplied =
      typeof value.variables.task === 'string'
        ? JSON.parse(value.variables.task)
        : value.variables.task;
    if (!context.paper || !context.persona || !context.subscription)
      throw new AnalysisError(
        'sample_required',
        '初筛 Agent 试跑需要载入一条真实初筛运行记录，以固定论文和知识范围。',
      );
    const run = {
        id: 'experiment-' + value.id,
        status: 'running',
        prompt_snapshot: api.store.snapshot(),
        subscription: context.subscription,
        context: structuredClone(context.persona),
      },
      item = { id: randomUUID(), run_id: run.id, paper: context.paper };
    const reader = new ScreeningEvidence(
      {
        analyses: api.analyses,
        repo: {
          get: (table) => (table === 'daily_runs' ? run : item),
          saveItem: () => {},
        },
      },
      run,
      item,
      deadline,
    );
    // Keep the capture's source identifiers while the experiment writes only its own record.
    reader.coverageRef = supplied.persona.source_ref;
    reader.initial();
    const raw = await runAgentWithContext({
      store: api.store, models: api.models, prepared: preview, origin: value.id, experiment: true,
      request: {
        task: 'screen',
        tools: reader.toolset(),
        submitTool: 'screening_submit_result',
        systemPrompt: preview.rendered.system,
        prompt: preview.rendered.user,
        maxTokens: value.max_tokens,
        maxAttempts: 12,
        executionMs: 300000,
        experiment: true,
      },
      options: {
        settings,
        signal: deadline,
        beforeAttempt,
        onAttempt,
        onTool: (name, args) => reader.call(name, args),
      },
    });
    reader.validate(raw.data);
    return {
      ...raw,
      attempts,
      validation: {
        issues: [],
        coverage: ['输出结构', '引用与用户事实'],
        reading: reader.coverage(),
        note: '阅读由 Agent 自行决定。',
      },
    };
  }
  const payload =
    typeof value.variables.task === 'string'
      ? JSON.parse(value.variables.task)
      : value.variables.task;
  const input = validateInput(context.input ?? payload.input);
  if (context.report_id) {
    const report = api.analyses.db.result(context.report_id);
    if (!report)
      throw new AnalysisError(
        'sample_unavailable',
        '试跑引用的历史报告已删除，请重新选择样例。',
      );
    context = {
      ...context,
      report: {
        id: report.id,
        summary: report.summary,
        personalization: report.personalization,
      },
      evidence: report.evidence,
      persona: report.persona ?? context.persona,
    };
  }
  if (context.conversation_id) {
    const row = api.analyses.db.db
      .prepare('SELECT data FROM discussions WHERE id=?')
      .get(context.conversation_id);
    if (!row)
      throw new AnalysisError(
        'sample_unavailable',
        '试跑引用的历史讨论已删除，请重新选择样例。',
      );
    const discussion = JSON.parse(row.data);
    const turns = api.analyses.db.db
      .prepare(
        'SELECT data FROM discussion_turns WHERE conversation_id=? ORDER BY created_at,rowid',
      )
      .all(context.conversation_id)
      .map((r) => JSON.parse(r.data));
    const index = turns.findIndex((t) => t.id === context.history_before_turn);
    if (index < 0)
      throw new AnalysisError(
        'sample_unavailable',
        '试跑对应的讨论轮次已不存在。',
      );
    context = {
      ...context,
      history: turns.slice(0, index).map((t) => ({
        user: t.question,
        assistant: t.answer,
        status: t.status,
      })),
      evidence: discussion.context?.evidence ?? context.evidence,
      persona: discussion.context?.persona ?? context.persona,
    };
  }
  const reader = await new ResearchTools({
    analyses: api.analyses,
    input,
    signal: deadline,
    paper: context.paper ?? null,
    persona: context.persona ?? null,
    report: context.report ?? payload.report ?? null,
    history: context.history ?? payload.history ?? [],
    evidence: context.evidence ?? [],
  }).prepare();
  // Example variables receive fixed source refs and the runtime output schema too.
  const snapshot = api.store.snapshot();
  for (const [id, version] of Object.entries(preview.versions))
    snapshot.versions[id] =
      preview.version_snapshots?.[id] ?? api.store.version(id, version);
  const raw = await runAutonomous({
    analyses: api.analyses,
    task,
    reader,
    settings,
    snapshot: api.store.snapshot(),
    signal: deadline,
    businessId: value.id,
    maxTokens: value.max_tokens,
    maxAttempts: 12,
    executionMs: 300000,
    experiment: true,
    preview: context.input ? preview : null,
    preparePreview: context.input
      ? null
      : (variables) =>
          api.store.preview(value.prompt_id, variables, { snapshot }),
    question: payload.goal?.question ?? payload.question,
    goalOverride: payload.goal,
    anchor: context.anchor,
    beforeAttempt,
    onAttempt,
  });
  return {
    ...raw,
    attempts,
    validation: {
      issues: [],
      coverage: ['输出结构', '引用与用户事实'],
      reading: reader.coverage(),
      note: '独立 Agent 试跑，不写入论文报告或日报。',
    },
  };
}
