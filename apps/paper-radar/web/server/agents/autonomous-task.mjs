import { runAgentWithContext } from '../prompts/agent-context.mjs';
import { resultSchema, partialSchema, autonomousInput, autonomousTools } from './task-input.mjs';
export { resultSchema, partialSchema, taskGoal } from './task-input.mjs';
import { PERSONA_READING_VERSION } from '@paper-radar/host-contract/persona-tools';
import { fingerprintInput, compositionRoots } from '../prompts/render-policy.mjs';
import { resolveConnection } from '../../lib/host-models.ts';
import {
  AnalysisError,
  hash,
  validateSummary,
  validatePersonal,
  parseOutput,
} from '../analyses/contracts.mjs';
import { parseAnswer } from '../discussions/contracts.mjs';
import {
  publicPaper,
} from './research-tools.mjs';

export const promptIdFor = (task) => `paper-radar.task-${task}`;
export function taskFingerprint(settings, task) {
  const model = (c) =>
    c
      ? Object.fromEntries(
          [
            'id',
            'providerId',
            'modelId',
            'reasoningEffort',
            'maxTokens',
            'contextWindow',
            'revision',
          ].map((k) => [k, c[k] ?? null]),
        )
      : null;
  return hash({
    persona_reading: PERSONA_READING_VERSION,
    host:
      settings.codex?.protocol ?? settings.dsh?.protocol ?? 'unsupported',
    selected: model(resolveConnection(settings, task)),
    fallback: settings.fallback?.enabled
      ? model(
          settings.connections.find(
            (c) => c.id === settings.fallback.connectionId,
          ),
        )
      : null,
  });
}
export function promptFingerprint(snapshot, id, variables = {}) {
  const found = {};
  function visit(key) {
    if (found[key]) return;
    const version = snapshot.versions[key];
    if (!version)
      throw new AnalysisError(
        'prompt_changed',
        '任务缺少当前自主分析提示词，请重新发起。',
        true,
      );
    found[key] = version.id;
    for (const m of Object.values(version.templates)
      .join('\n')
      .matchAll(/\{\{\s*@([\w.-]+)\s*\}\}/g))
      visit(m[1]);
  }
  compositionRoots(snapshot, id, variables).forEach(visit);
  return hash(fingerprintInput(snapshot, found));
}
export function validateTaskResult(
  task,
  raw,
  reader,
  { partial = false } = {},
) {
  const schema = partial ? partialSchema : resultSchema(task, !!reader.persona);
  const value = parseOutput(JSON.stringify(raw), schema),
    paper = reader.paperForValidation();
  if (task === 'discussion')
    return {
      data: parseAnswer(
        JSON.stringify(value),
        reader.evidence(),
        reader.persona?.records ?? [],
      ),
      issues: [],
    };
  if (task === 'review') return { data: value, issues: [] };
  const parts =
    task === 'summary'
      ? { summary: value }
      : task === 'connections'
        ? { personalization: value }
        : value;
  const issues = [];
  let actual_length;
  if (parts.summary) {
    const checked = validateSummary(
      parts.summary,
      reader.input,
      new Set(paper.blocks.map((b) => b.id)),
    );
    issues.push(...checked.issues);
    actual_length = checked.actual_length;
  }
  if (parts.personalization) {
    if (!reader.persona) issues.push('本任务没有选择个人知识范围。');
    else {
      const persona = {
        ...reader.persona,
        evidence: reader.evidence().filter((e) => e.id.startsWith('persona:')),
      };
      issues.push(
        ...validatePersonal(parts.personalization, paper, persona, {
          requireCompleteKnowledge: false,
        }),
      );
      for (const reason of parts.personalization.reasons)
        for (const claim of reason.claims) {
          const evidence = persona.evidence.find(
            (e) => e.record_id === claim.record_id && e.kind === 'record',
          );
          if (
            !evidence?.fact_fields ||
            !(Array.isArray(evidence.fact_fields[claim.field])
              ? evidence.fact_fields[claim.field].includes(claim.value)
              : evidence.fact_fields[claim.field] === claim.value)
          )
            issues.push(
              '个人事实字段尚未提供：' + claim.record_id + '.' + claim.field,
            );
        }
    }
  }
  return { data: value, issues: [...new Set(issues)], actual_length };
}
export async function runAutonomous({
  analyses,
  task,
  reader,
  settings,
  snapshot,
  signal,
  businessId,
  maxAttempts = ['single', 'discussion'].includes(task) ? null : 12,
  executionMs = ['single', 'discussion'].includes(task) ? null : 900000,
  maxTokens = 8192,
  question,
  anchor,
  goalOverride,
  experiment = false,
  preview = null,
  preparePreview = null,
  onSave,
  onDraft,
  beforeAttempt,
  onAttempt,
  onProgress,
}) {
  const payload = autonomousInput({ task, reader, question, anchor, goalOverride, snapshot });
  const variables = { task: JSON.stringify(payload) };
  const prepared =
    preparePreview?.(variables) ??
    preview ??
    analyses.prompts.preview(promptIdFor(task), variables, { snapshot });
  const capture = experiment
    ? null
    : analyses.prompts.capture(
        promptIdFor(task),
        variables,
        snapshot,
        {
          task,
          input: reader.input,
          report_id: reader.report?.id ?? null,
          conversation_id:
            task === 'discussion'
              ? (analyses.db.db
                  .prepare(
                    'SELECT conversation_id FROM discussion_turns WHERE id=?',
                  )
                  .get(businessId)?.conversation_id ?? null)
              : null,
          history_before_turn: task === 'discussion' ? businessId : null,
          anchor,
          paper: publicPaper(reader.paper),
          persona: reader.persona
            ? {
                ...reader.persona,
                records: [],
                evidence: [],
                knowledge_ids: [],
                matches: [],
                relations: [],
                retrieval: [],
              }
            : null,
        },
        businessId,
      );
  const tools = autonomousTools(reader, task, !!onSave);
  let submitted;
  const raw = await runAgentWithContext({
    store: analyses.prompts, models: analyses.models, prepared, captureId: capture?.id, origin: businessId, experiment,
    request: {
      task,
      tools,
      submitTool: 'task_submit_result',
      systemPrompt: prepared.rendered.system,
      prompt: prepared.rendered.user,
      maxAttempts,
      executionMs,
      maxTokens,
      businessTask: businessId,
      experiment,
    },
    options: {
      settings,
      signal,
      beforeAttempt,
      onProgress,
      onAttempt: (a) =>
        onAttempt?.({
          ...a,
          prompt_versions: prepared.versions,
          prompt_capture_id: capture?.id ?? null,
        }),
      onTool: async (name, args) => {
        if (!['task_submit_result', 'task_save_result'].includes(name))
          return reader.call(name, args);
        await onDraft?.(args, reader);
        const checked = validateTaskResult(task, args, reader, {
          partial: name === 'task_save_result',
        });
        if (checked.issues.length)
          throw new AnalysisError(
            'invalid_output',
            checked.issues.join('\n'),
            true,
          );
        signal.throwIfAborted();
        await onSave?.(checked.data, reader, name === 'task_submit_result');
        if (name === 'task_submit_result') submitted = checked.data;
        return { accepted: true };
      },
    },
  });
  signal.throwIfAborted();
  if (!submitted)
    throw new AnalysisError(
      'invalid_output',
      'Agent 没有提交经过接口校验的结果。',
      true,
    );
  return {
    ...raw,
    data: submitted,
    text: JSON.stringify(submitted),
    capture_id: capture?.id ?? null,
  };
}
