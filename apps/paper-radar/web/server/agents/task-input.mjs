import { z } from 'zod';
import {
  summarySchema,
  personalSchema,
  reviewSchema,
} from '../analyses/contracts.mjs';
import { answerSchema } from '../discussions/contracts.mjs';
import { jsonSchema, AUTONOMOUS_VERSION } from './research-tools.mjs';
import { usesEditableGoals } from '../prompts/context-policy.mjs';

export function resultSchema(task, personal) {
  if (task === 'discussion') return answerSchema;
  if (task === 'review') return reviewSchema;
  if (task === 'summary') return summarySchema;
  if (task === 'connections') return personalSchema;
  return z
    .object({
      summary: summarySchema,
      ...(personal ? { personalization: personalSchema } : {}),
    })
    .strict();
}
export const partialSchema = z
  .object({
    summary: summarySchema.optional(),
    personalization: personalSchema.optional(),
  })
  .strict()
  .refine((v) => v.summary || v.personalization);
export function taskGoal(task, input, question) {
  if (task === 'discussion') return { question, language: input.language };
  if (task === 'review')
    return {
      question:
        question ?? '核查已有分析中的重要结论及证据，说明问题与不确定性。',
      language: input.language,
    };
  return {
    description:
      task === 'summary'
        ? '总结论文的研究问题、方法、发现、条件和局限。'
        : task === 'connections'
          ? '结合用户选择的完整知识范围判断阅读价值、材料联系与待验证的交叉可能。'
          : '完成单篇论文分析：研究总结，以及所选知识范围下的推荐理由、材料联系和待验证交叉可能。',
    language: input.language,
    summary:
      task === 'connections'
        ? undefined
        : {
            sections: 6,
            length: input.summary_length,
            count_unit:
              input.language === 'zh'
                ? 'non-whitespace characters including punctuation'
                : 'English words',
          },
    recommendation_strictness: input.recommendation_strictness,
    selected_scope: input.scope,
    uncertainty:
      '明确未证实的推测和影响结论的资料缺口；没有合适联系时列表可以为空。',
  };
}

export function autonomousInput({
  task,
  reader,
  question,
  anchor,
  goalOverride,
  snapshot,
}) {
  const legacyGoal = taskGoal(task, reader.input, question);
  const editable = usesEditableGoals(snapshot);
  return {
    schema: AUTONOMOUS_VERSION,
    goal: editable
      ? {
          ...(question ? { question } : {}),
          language: reader.input.language,
          source_ref: 'paper-radar:task-form',
        }
      : { ...legacyGoal, ...goalOverride },
    input: reader.input,
    ...reader.initial(),
    ...(anchor ? { anchor } : {}),
    output: {
      interface: 'task_submit_result',
      schema: jsonSchema(resultSchema(task, !!reader.persona)),
      ...(editable
        ? {
            source_ref: 'paper-radar:result-contract',
            language: reader.input.language,
            ...(['single', 'summary'].includes(task)
              ? { summary: legacyGoal.summary }
              : {}),
          }
        : {}),
    },
  };
}
export function autonomousTools(reader, task, partial = false) {
  return [
    ...reader.toolset(),
    {
      name: 'task_submit_result',
      description: 'Submit the final result in the task output schema.',
      parameters: jsonSchema(resultSchema(task, !!reader.persona)),
    },
    ...(partial
      ? [
          {
            name: 'task_save_result',
            description:
              'Persist one or more completed report components. The task remains open.',
            parameters: jsonSchema(
              z
                .object({
                  summary: summarySchema.optional(),
                  personalization: personalSchema.optional(),
                })
                .strict(),
            ),
          },
        ]
      : []),
  ];
}
