import { withTaskInstructions } from './task-instructions.mjs';
export const SCREEN_PROMPT = 'paper-radar.screen-autonomous';
export const TASK_PROMPTS = [
  SCREEN_PROMPT,
  ...['single', 'summary', 'connections', 'review', 'discussion'].map(
    (task) => `paper-radar.task-${task}`,
  ),
];
export const SCREEN_RULES = ['focused', 'balanced', 'exploratory'];
export const ruleNames = {
  focused: '聚焦',
  balanced: '平衡',
  exploratory: '探索',
};
export const sharedId = (language) => `paper-radar.shared.${language}`;
export const ruleId = (language, rule) =>
  `paper-radar.screen-${rule}.${language}`;
export const stripSharedReferences = (templates) =>
  Object.fromEntries(
    Object.entries(templates).map(([key, text]) => [
      key,
      text
        .replace(/\{\{\s*@paper-radar\.(?:terminology|strictness)\s*\}\}/g, '')
        .trim(),
    ]),
  );

// Keep legacy definitions intact: their signatures are used by saved jobs.
export function languagePrompts(catalog) {
  const find = (id) => catalog.find((entry) => entry.id === id);
  return ['zh', 'en'].flatMap((language) => [
    {
      id: sharedId(language),
      name: '共用规则',
      description: '自动应用于当前生成语言的所有任务，可以留空。',
      kind: 'fragment',
      group: '共用规则',
      task: null,
      schema_version: '1',
      variables: [],
      dependencies: [],
      language,
      settings_role: 'shared',
      settings_visible: true,
      templates: {
        text:
          language === 'zh'
            ? find('paper-radar.terminology').templates.text
            : '',
      },
      example: {},
      migration_from: language === 'zh' ? 'paper-radar.terminology' : null,
    },
    ...TASK_PROMPTS.map((id) => {
      const source = find(id);
      const example = structuredClone(source.example);
      if (example.task?.input) example.task.input.language = language;
      else if (example.task?.output) example.task.output.language = language;
      return {
        ...source,
        id: `${id}.${language}`,
        language,
        settings_role: 'task',
        settings_visible: source.task !== 'discussion',
        base_prompt: id,
        schema_version: 'language-v1',
        dependencies: [],
        name: id === SCREEN_PROMPT ? '每日筛选通用要求' : source.name,
        templates: withTaskInstructions(stripSharedReferences(source.templates), source.task, language),
        example,
        migration_from: id,
      };
    }),
    ...SCREEN_RULES.map((rule) => ({
      id: ruleId(language, rule),
      name: `${ruleNames[rule]}提示词`,
      description: '仅用于选择此筛选规则的每日筛选任务。',
      kind: 'fragment',
      group: '每日筛选',
      task: 'screen',
      schema_version: '1',
      variables: [],
      dependencies: [],
      language,
      screening_rule: rule,
      settings_role: 'screening_rule',
      settings_visible: true,
      templates: { text: find('paper-radar.strictness').templates[rule] },
      example: {},
      migration_from: 'paper-radar.strictness',
    })),
  ]);
}
