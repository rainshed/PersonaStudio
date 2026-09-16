import { ResearchTools } from '../agents/research-tools.mjs';
import { autonomousInput, autonomousTools } from '../agents/task-input.mjs';
import { ScreeningEvidence } from '../daily/agent-screening.mjs';
import { agentContext } from './agent-context.mjs';
import { TASK_CONTEXT_POLICY } from './context-policy.mjs';

export function settingsInput(store, task, language, rule, options = {}) {
  if (options.source_id) {
    const legacy = options.source_id.startsWith('legacy:')
      ? store.record('captures', options.source_id.slice(7))
      : null;
    const legacyValue =
      legacy &&
      (typeof legacy.variables.task === 'string'
        ? JSON.parse(legacy.variables.task)
        : legacy.variables.task);
    const run = legacy
      ? {
          id: options.source_id,
          created_at: legacy.created_at,
          variables: legacy.variables,
          context: {
            task:
              legacy.context.task ?? store.definition(legacy.prompt_id).task,
            language:
              legacyValue?.input?.language ??
              legacyValue?.output?.language ??
              'zh',
          },
        }
      : store.contextRun(options.source_id, { limit: 0 });
    if (run.context.task !== task || run.context.language !== language)
      throw new Error('请选择当前任务和语言的运行记录。');
    const variables = structuredClone(run.variables);
    if (!variables) throw new Error('该记录未保存可重新组合的任务资料。');
    const value =
      typeof variables.task === 'string'
        ? JSON.parse(variables.task)
        : variables.task;
    // This is explicitly a recomposition with current instructions, never a replay.
    if (!value || typeof value !== 'object')
      throw new Error('该记录未保存可重新组合的任务资料。');
    let tools = run.context.request?.tools;
    const submitTool =
      task === 'screen' ? 'screening_submit_result' : 'task_submit_result';
    if (legacy) {
      const snapshot = { context_policy: TASK_CONTEXT_POLICY };
      if (task === 'screen') {
        if (
          !legacy.context.persona ||
          !legacy.context.subscription ||
          !legacy.context.paper
        )
          throw new Error('该记录未保存可重新组合的任务资料。');
        const reader = new ScreeningEvidence(
          {},
          {
            id: legacy.id,
            prompt_snapshot: snapshot,
            context: legacy.context.persona,
            subscription: legacy.context.subscription,
          },
          { id: legacy.id, paper: legacy.context.paper },
          new AbortController().signal,
          { replay: true },
        );
        tools = reader.toolset();
      } else {
        const reader = new ResearchTools({
          analyses: { persona: { scopeReader: true } },
          input: value.input,
          persona: legacy.context.persona ?? value.persona_scope ?? null,
        });
        tools = autonomousTools(reader, task, task === 'single');
        value.output = {
          ...value.output,
          interface: submitTool,
          schema: tools.find((t) => t.name === submitTool).parameters,
          language,
          source_ref: 'paper-radar:result-contract',
          ...(value.goal?.summary ? { summary: value.goal.summary } : {}),
        };
      }
    }
    if (value.goal && typeof value.goal === 'object') {
      delete value.goal.description;
      delete value.goal.uncertainty;
    } else if (typeof value.goal === 'string') delete value.goal;
    if (value.task?.goal) delete value.task.goal;
    if (task === 'screen') {
      value.criteria.strictness = rule;
      variables.recommendation_strictness = rule;
    }
    variables.task = JSON.stringify(value);
    return {
      variables,
      tools,
      submitTool,
      source: {
        kind: 'recomposition',
        run_id: run.id,
        created_at: run.created_at,
        tool_source: legacy ? 'current_contract' : 'recorded_definitions',
      },
    };
  }
  const personal = options.personal !== false;
  const input = {
    arxiv_input: 'https://arxiv.org/abs/1706.03762v7',
    language,
    scope: { tag_ids: personal ? ['example:research'] : [], tag_match: 'any' },
    persona_connection_id: personal ? 'example:persona' : null,
    summary_length: { min: 800, max: 1400 },
    recommendation_strictness: rule,
  };
  const paper = {
    id: '1706.03762',
    version: 7,
    title: 'Attention Is All You Need',
    abstract:
      '示例摘要：论文研究基于注意力机制的序列建模。此处仅用于展示输入组成。',
    url: input.arxiv_input,
    authors: [],
    categories: ['cs.CL'],
    evidence_id: 'example:paper-abstract',
  };
  const persona = {
    identity: 'example:persona',
    revision: 'example:revision',
    scope: input.scope,
    records: [],
    knowledge_ids: [],
    retrieval: [],
    evidence: [],
    matches: [],
    coverage: { complete_knowledge_scan: false },
    query_mode: true,
  };
  const snapshot = { context_policy: TASK_CONTEXT_POLICY };
  if (task === 'screen') {
    const run = {
      id: 'example:run',
      prompt_snapshot: snapshot,
      subscription: { ...input, id: 'example:subscription', revision: 1 },
      context: persona,
    };
    const reader = new ScreeningEvidence(
      {},
      run,
      { id: 'example:item', paper },
      new AbortController().signal,
      { replay: true },
    );
    return {
      variables: {
        task: JSON.stringify(reader.initial()),
        recommendation_strictness: rule,
      },
      tools: reader.toolset(),
      submitTool: 'screening_submit_result',
      source: { kind: 'example' },
    };
  }
  const reader = new ResearchTools({
    analyses: { persona: { scopeReader: true } },
    input,
    paper,
    persona: personal ? persona : null,
    signal: new AbortController().signal,
  });
  reader.abstractId = paper.evidence_id;
  const variables = {
    task: JSON.stringify(
      autonomousInput({
        task,
        reader,
        question: ['review', 'discussion'].includes(task)
          ? language === 'zh'
            ? '这项方法在什么条件下适用？'
            : 'Under what conditions is this method applicable?'
          : undefined,
        snapshot,
      }),
    ),
  };
  return {
    variables,
    tools: autonomousTools(reader, task, task === 'single'),
    submitTool: 'task_submit_result',
    source: { kind: 'example' },
  };
}

export function settingsContext(prepared, input, task, options = {}) {
  const request = {
    task,
    tools: input.tools,
    submitTool: input.submitTool,
    systemPrompt: prepared.rendered.system,
    prompt: prepared.rendered.user,
  };
  return {
    ...prepared,
    context: agentContext(request, prepared, options.settings, {
      sample: input.source.kind === 'example',
      host: options.host,
    }),
    preview_source: input.source,
  };
}
