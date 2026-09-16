import { randomUUID } from 'node:crypto';
import {
  hostContext,
  HOST_CONTEXT_VERSION,
} from '@paper-radar/host-contract/context';
import { toolContent } from '@paper-radar/host-contract/tool-content';
import { backendFromSettings } from '../hosts/execution.mjs';

export const CONTEXT_MANIFEST_VERSION = 'paper-radar.agent-context/v1';
const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
export function agentContext(
  request,
  prepared,
  settings,
  { sample = false, host } = {},
) {
  const backend = host ?? backendFromSettings(settings);
  const runtime = hostContext(backend, request);
  const task = prepared.variables?.task
    ? typeof prepared.variables.task === 'string'
      ? parse(prepared.variables.task)
      : prepared.variables.task
    : parse(request.prompt);
  const language =
    prepared.blocks?.find((b) => b.source?.language)?.source.language ??
    task?.input?.language ??
    task?.output?.language;
  const sections = (prepared.blocks ?? []).map((block, index) => ({
    id: `prompt:${index}`,
    kind: 'prompt',
    title:
      block.kind === 'shared_rules'
        ? '共用提示词'
        : block.kind === 'screening_rule'
          ? '本次筛选规则'
          : '任务提示词',
    stage: 'initial',
    status: block.text.trim() ? 'included' : 'omitted',
    editable: true,
    source: { ...block.source, label: '提示词设置', kind: 'prompt_version' },
    content: block.text,
    condition:
      block.kind === 'screening_rule'
        ? '仅加入本次选中的筛选规则'
        : block.kind === 'shared_rules'
          ? '当前生成语言；留空时不加入'
          : '当前任务与生成语言',
  }));
  if (!(prepared.blocks ?? []).some((b) => b.kind === 'shared_rules'))
    sections.unshift({
      id: 'shared:omitted',
      kind: 'prompt',
      title: '共用提示词',
      stage: 'initial',
      status: 'omitted',
      editable: true,
      source: {
        label: '提示词设置',
        prompt_id: `paper-radar.shared.${language}`,
        kind: 'prompt_version',
      },
      content: '',
      condition: '当前语言的共用提示词为空，本次不加入',
    });
  const add = (id, title, content, source, extra = {}) =>
    sections.push({
      id,
      title,
      kind: 'data',
      stage: 'initial',
      status: content == null ? 'omitted' : 'included',
      editable: false,
      source: { kind: sample ? 'example' : 'task', label: source },
      content,
      ...extra,
    });
  add(
    'parameters',
    '本次任务参数',
    task?.input ?? task?.criteria ?? null,
    sample ? '示例任务表单' : '任务表单 / 订阅设置',
    { edit_target: request.task === 'screen' ? 'daily' : 'single' },
  );
  const question = task?.goal?.question ?? task?.question;
  add(
    'question',
    '当前问题与所选内容',
    question || task?.anchor
      ? { question, ...(task.anchor ? { anchor: task.anchor } : {}) }
      : null,
    '当前任务 / 讨论',
    { edit_target: 'discussion' },
  );
  add('paper', '论文资料', task?.paper ?? null, '固定版本论文的元数据与摘要', {
    condition: '启动时提供实际资料；正文通常在工具调用后追加',
  });
  add(
    'persona',
    '所选个人知识',
    task?.persona_scope ?? task?.persona ?? null,
    '本次所选知识范围',
    { condition: '仅提供本任务选择的范围及已返回资料', edit_target: 'persona' },
  );
  add(
    'available_results',
    '已有分析、讨论与笔记入口',
    task?.available_results ?? null,
    '当前论文与讨论',
    { condition: '入口和正文分别标注；正文在读取后加入' },
  );
  add(
    'output',
    '输出结构与校验要求',
    {
      ...task?.output,
      ...(typeof task?.output?.schema === 'string'
        ? { protocol_version: task.output.schema }
        : {}),
      interface: request.submitTool,
      schema: request.tools.find((t) => t.name === request.submitTool)
        ?.parameters,
    },
    '应用的结果接口',
    { kind: 'contract' },
  );
  add('tools', '可用工具的完整定义', request.tools, '本任务实际注册的工具', {
    kind: 'tools',
  });
  add('runtime', '运行环境加入的内容', runtime, 'Paper Radar 运行环境适配层', {
    kind: 'runtime',
  });
  sections.push({
    id: 'tool-results',
    title: '工具返回与校验反馈',
    kind: 'tool_results',
    stage: 'during_run',
    status: 'conditional',
    editable: false,
    source: { kind: 'tools', label: '实际工具调用' },
    content: null,
    condition: '调用后加入；在运行记录中查看实际内容',
  });
  return {
    schema: CONTEXT_MANIFEST_VERSION,
    host_version: HOST_CONTEXT_VERSION,
    sample,
    task: request.task,
    language,
    sections,
    request: {
      task: request.task,
      systemPrompt: request.systemPrompt,
      prompt: request.prompt,
      tools: request.tools,
      submitTool: request.submitTool,
    },
    runtime,
    prompt_versions: prepared.versions,
    input_template: prepared.templates?.user,
    visibility: 'application_boundary',
  };
}

// Capture the application boundary once. Host adapters add actual delivery events;
// tool results are separate from initial context and retain their source content.
export async function runAgentWithContext({
  store,
  models,
  request,
  options,
  prepared,
  captureId,
  origin,
  experiment = false,
}) {
  const context = agentContext(request, prepared, options.settings);
  const run = store.startContextRun({
    context,
    variables: prepared.variables,
    capture_id: captureId ?? null,
    origin,
    experiment,
    prompt_id: prepared.prompt_id,
    snapshot: prepared.version_snapshots,
  });
  const event = (value) => {
    store.appendContextEvent(run.id, value);
    options.onContext?.(value);
  };
  try {
    const value = await models.runAgent(request, {
      ...options,
      onContext: event,
      onRestart: () => {
        event({
          kind: 'restart',
          source: 'paper-radar:model-fallback',
          content: { reason: 'fallback' },
        });
        options.onRestart?.();
      },
      onTool: async (name, args, ...rest) => {
        const callId = randomUUID();
        event({
          kind: 'tool_call',
          call_id: callId,
          source: name,
          content: args,
        });
        try {
          const result = await options.onTool(name, args, ...rest);
          event({
            kind: 'tool_result',
            call_id: callId,
            source: name,
            content: toolContent(result),
            delivery: 'returned_to_host',
          });
          return result;
        } catch (error) {
          event({
            kind: 'tool_error',
            call_id: callId,
            source: name,
            content: {
              code: error.code ?? 'tool_error',
              message: error.message,
            },
            delivery: 'returned_to_host',
          });
          throw error;
        }
      },
    });
    store.finishContextRun(run.id, 'completed');
    return value;
  } catch (error) {
    store.finishContextRun(
      run.id,
      options.signal?.aborted ? 'interrupted' : 'failed',
      { code: error.code ?? 'agent_error', message: error.message },
    );
    throw error;
  }
}
