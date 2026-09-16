const tasks = [
  [
    'single',
    '单篇完整分析',
    '形成研究总结，并在选择个人知识范围时给出推荐理由、材料联系和潜在交叉。',
  ],
  ['summary', '独立研究总结', '围绕论文给出符合用户要求的研究总结。'],
  [
    'connections',
    '独立个性化分析',
    '结合所选知识范围说明推荐理由、材料联系与潜在交叉。',
  ],
  ['review', '按需内容复核', '针对用户指定的已有内容和疑问给出复核结果。'],
  [
    'discussion',
    '论文讨论 Agent',
    '回答用户当前问题，结合该话题已有约束和所需依据。',
  ],
];
export const autonomousPrompts = tasks.map(([task, name, goal]) => ({
  id: `paper-radar.task-${task}`,
  name,
  group: '自主分析',
  description: goal,
  task,
  kind: 'message',
  schema_version: '1',
  dependencies: ['paper-radar.terminology'],
  variables: [
    {
      name: 'task',
      label: '任务目标、资料引用与输出约定',
      type: 'json',
      required: true,
    },
  ],
  templates: {
    system:
      '{{@paper-radar.terminology}}'
      + (task === 'discussion' ? ' Challenge false premises. Explain the evidence and conditions behind any disagreement.' : ''),
    user: '{{task}}',
  },
  example: {
    task: {
      goal,
      input: {
        arxiv_input: 'https://arxiv.org/abs/1706.03762v7',
        scope: { tag_ids: [], tag_match: 'any' },
        persona_connection_id: null,
        language: 'zh',
        summary_length: { min: 800, max: 1400 },
      },
      question: task === 'discussion' ? '论文的核心贡献是什么？' : undefined,
    },
  },
}));
