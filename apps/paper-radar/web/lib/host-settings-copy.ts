export const hostSettingsCopy = {
  en: {
    title: 'Model settings',
    subtitle:
      'Two defaults for your research. Fine-tune individual tasks when you need to.',
    connected: 'Connected to DSH',
    disconnected: 'DSH is unavailable',
    refresh: 'Refresh connection',
    shared: 'Models and accounts are managed in DSH.',
    manage: 'Manage in DSH',
    fast: 'Fast & economical',
    fastDescription: 'For daily screening and quick relevance decisions.',
    deep: 'Deep analysis',
    deepDescription:
      'For close reading, research connections and thoughtful discussion.',
    model: 'Model',
    reasoning: 'Thinking effort',
    hostDefault: 'Follow DSH',
    defaultEffort: 'Automatic',
    autoDescription: 'Use the model’s default thinking effort.',
    effortDescription: 'Applied to new tasks using this selection.',
    chooseModel: 'Choose a model',
    current: 'Currently',
    waiting: 'Waiting for connection',
    unavailable: 'Unavailable',
    modelMissing:
      'This model is unavailable. Restore it in DSH or choose another.',
    effortMissing:
      'This thinking effort is unavailable. Choose another or use Automatic.',
    noEfforts: 'This model does not expose adjustable thinking effort.',
    usedBy: 'Used for',
    unused: 'No tasks use this preset yet.',
    advanced: 'Advanced settings',
    advancedDescription: 'Task overrides, concurrency and fallback',
    exception: 'task with custom routing',
    exceptions: 'tasks with custom routing',
    noExceptions: 'All tasks follow their default preset',
    tasksTitle: 'Task preferences',
    tasksDescription:
      'Choose a preset or a custom model for each task. A full paper analysis uses one agent; the agent decides how to read and use tools.',
    custom: 'Custom model',
    routing: 'Model preference',
    restore: 'Restore default',
    screen: 'Daily screening',
    single: 'Single-paper analysis',
    summary: 'Research summary',
    connections: 'Personalized connections',
    review: 'Content review',
    discussion: 'Paper discussion',
    screenHelp: 'One independent agent per paper.',
    singleHelp: 'A complete report from one agent.',
    summaryHelp: 'A standalone research summary.',
    connectionsHelp: 'Connections to your knowledge and interests.',
    reviewHelp: 'Check claims and supporting evidence.',
    discussionHelp: 'Questions, follow-ups and deeper exploration.',
    concurrency: 'Parallel tasks',
    concurrencyHelp:
      'Shared limit for paper agents and model requests. Lowering it lets active requests finish.',
    concurrencyRange: 'Between 1 and 16. Default: 4.',
    concurrencyError: 'Enter a whole number from 1 to 16.',
    fallback: 'Fallback model',
    fallbackHelp:
      'Try another model when the provider fails or rate-limits a request.',
    fallbackChoose: 'Choose a fallback model before saving.',
    connectionDetails: 'DSH connection',
    remoteHelp:
      'Manage accounts on the computer running DSH. You can select its configured models here.',
    hostHelp:
      'Start DSH and enable the PaperRadar plugin, then refresh the connection.',
    connection: 'Connection',
    modelId: 'Model ID',
    hostModel: 'DSH default',
    save: 'Save changes',
    saving: 'Saving…',
    refreshing: 'Refreshing…',
    discard: 'Discard changes',
    unsaved: 'You have unsaved changes.',
    unchanged: 'Model changes apply to new tasks.',
    saved: 'Saved. New tasks will use these settings.',
    refreshed: 'Model list refreshed.',
    refreshedDraft: 'Model list refreshed. Your unsaved changes are kept.',
    conflict:
      'Settings changed elsewhere. Discard your changes to load the latest version, then try again.',
    requestFailed:
      'Could not update settings. Check the DSH connection and try again.',
    invalidSettings:
      'Some settings are invalid. Check the models, thinking effort and parallel task limit.',
    invalidEffort:
      'The selected model does not support this thinking effort. Choose another or use Automatic.',
    authError:
      'Model authorization needs attention. Reconnect the account in DSH.',
    modelError:
      'A selected model is no longer available. Restore it in DSH or choose another.',
    none: 'None',
    minimal: 'Minimal',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Maximum',
    ultra: 'Ultra',
  },
  zh: {
    title: '模型设置',
    subtitle: '两套默认方案，满足日常研究。需要时，再为单个任务细调。',
    connected: '已连接 DSH',
    disconnected: 'DSH 暂不可用',
    refresh: '刷新连接',
    shared: '模型与账号统一在 DSH 中管理。',
    manage: '在 DSH 中管理',
    fast: '快速省钱',
    fastDescription: '适合每日初筛，快速判断论文是否值得关注。',
    deep: '深入分析',
    deepDescription: '适合论文精读、知识联系与深入讨论。',
    model: '模型',
    reasoning: '思考强度',
    hostDefault: '跟随 DSH',
    defaultEffort: '自动',
    autoDescription: '使用所选模型的默认思考强度。',
    effortDescription: '适用于使用此配置的新任务。',
    chooseModel: '选择模型',
    current: '当前',
    waiting: '等待连接',
    unavailable: '暂不可用',
    modelMissing: '此模型暂不可用，请在 DSH 中恢复或选择其他模型。',
    effortMissing: '此思考强度暂不可用，请重新选择或使用自动。',
    noEfforts: '此模型未提供可调思考强度。',
    usedBy: '用于',
    unused: '暂时没有任务使用此方案。',
    advanced: '高级设置',
    advancedDescription: '逐任务配置、并行数量与备用模型',
    exception: '个任务使用自定义配置',
    exceptions: '个任务使用自定义配置',
    noExceptions: '所有任务均使用默认方案',
    tasksTitle: '任务偏好',
    tasksDescription:
      '为每个任务选择方案，或单独指定模型。完整论文分析由一个 Agent 完成，如何阅读、如何使用工具，由 Agent 自主决定。',
    custom: '自定义模型',
    routing: '模型方案',
    restore: '恢复默认',
    screen: '每日初筛',
    single: '单篇分析',
    summary: '研究总结',
    connections: '个性化联系',
    review: '内容复核',
    discussion: '论文讨论',
    screenHelp: '每篇论文由独立 Agent 判断。',
    singleHelp: '一个 Agent 完成完整报告。',
    summaryHelp: '独立生成研究总结。',
    connectionsHelp: '联系你的知识与研究兴趣。',
    reviewHelp: '核查结论及其证据。',
    discussionHelp: '提问、追问与深入探讨。',
    concurrency: '并行任务数',
    concurrencyHelp:
      '论文 Agent 与模型请求共享的并发上限。调低时，已开始的请求会继续完成。',
    concurrencyRange: '可设置为 1–16，默认 4。',
    concurrencyError: '请输入 1–16 的整数。',
    fallback: '备用模型',
    fallbackHelp: '模型服务出错或请求受限时，尝试使用另一个模型。',
    fallbackChoose: '保存前请选择备用模型。',
    connectionDetails: 'DSH 连接',
    remoteHelp: '请在运行 DSH 的电脑上管理账号，此处可直接选择已配置的模型。',
    hostHelp: '请启动 DSH 并启用 PaperRadar 插件，然后刷新连接。',
    connection: '模型连接',
    modelId: '模型标识',
    hostModel: 'DSH 默认模型',
    save: '保存修改',
    saving: '正在保存…',
    refreshing: '正在刷新…',
    discard: '放弃修改',
    unsaved: '有尚未保存的修改。',
    unchanged: '模型修改从新任务开始使用。',
    saved: '已保存，新任务将使用这些设置。',
    refreshed: '模型列表已刷新。',
    refreshedDraft: '模型列表已刷新，未保存的修改已保留。',
    conflict:
      '设置已在其他页面修改。请放弃当前修改以载入最新版本，再重新设置。',
    requestFailed: '设置更新失败，请检查 DSH 连接后重试。',
    invalidSettings: '部分设置无效，请检查模型、思考强度与并行任务数。',
    invalidEffort: '所选模型不支持此思考强度，请重新选择或使用自动。',
    authError: '模型授权需要更新，请在 DSH 中重新连接账号。',
    modelError: '所选模型已不可用，请在 DSH 中恢复或选择其他模型。',
    none: '关闭',
    minimal: '极低',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '很高',
    max: '最高',
    ultra: '极高',
  },
} as const;
export type HostSettingsCopy = {
  [K in keyof typeof hostSettingsCopy.en]: string;
};
export function dshSettingsError(
  code: string | undefined,
  copy: HostSettingsCopy,
) {
  if (code === 'conflict') return copy.conflict;
  if (
    code === 'INVALID_REASONING_EFFORT' ||
    code === 'UNSUPPORTED_REASONING_EFFORT'
  )
    return copy.invalidEffort;
  if (code === 'AUTH' || code === 'MISSING_CREDENTIAL') return copy.authError;
  if (
    code === 'NO_ADAPTER' ||
    code === 'MODEL_NOT_FOUND' ||
    code === 'not_configured'
  )
    return copy.modelError;
  if (code === 'invalid_settings' || code === 'invalid_selection')
    return copy.invalidSettings;
  return copy.requestFailed;
}

// Host catalogs may return effort names in a different language from the UI.
export function thinkingEffortLabel(id: string, language: 'zh' | 'en') {
  const copy = hostSettingsCopy[language];
  const efforts = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra',
  ] as const;
  return (efforts as readonly string[]).includes(id)
    ? copy[id as (typeof efforts)[number]]
    : id;
}
