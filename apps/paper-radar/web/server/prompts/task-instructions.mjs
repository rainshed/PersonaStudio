export const taskInstructions = {
  zh: {
    screen:
      '判断本篇论文是否值得用户进一步阅读，给出简短介绍、推荐判断和理由。',
    single:
      '完成单篇论文分析：总结研究问题、方法、发现、条件和局限；在选择个人知识范围时，说明阅读价值、材料联系和待验证的交叉可能。',
    summary: '总结论文的研究问题、方法、发现、条件和局限。',
    connections:
      '结合用户选择的知识范围，判断论文的阅读价值、材料联系和待验证的交叉可能。',
    review:
      '针对指定内容和当前问题，核查已有分析中的重要结论及依据，说明发现的问题。',
    discussion:
      '回答用户当前关于论文的问题，结合所选内容和已有讨论中的相关要求。',
  },
  en: {
    screen:
      'Assess whether this paper is worth further reading. Provide a brief introduction, recommendation, and reasons.',
    single:
      'Analyze the paper: summarize its research question, methods, findings, conditions, and limitations. When a personal knowledge scope is selected, explain reading value, material connections, and possible crossovers to investigate.',
    summary:
      'Summarize the paper’s research question, methods, findings, conditions, and limitations.',
    connections:
      'Assess the paper’s reading value, material connections, and possible crossovers for the user’s selected knowledge scope.',
    review:
      'Review the specified content and current question against the conclusions and evidence in the existing analysis. Explain any issues found.',
    discussion:
      'Answer the user’s current question about the paper, using the selected content and relevant requirements from the discussion.',
  },
};

export function withTaskInstructions(templates, task, language) {
  const instruction = taskInstructions[language]?.[task];
  if (!instruction || templates.system.includes(instruction)) return templates;
  return {
    ...templates,
    system: [instruction, templates.system.trim()].filter(Boolean).join('\n\n'),
  };
}
