import { PromptError } from './store.mjs';
import {
  SCREEN_PROMPT,
  SCREEN_RULES,
  TASK_PROMPTS,
} from './language-prompts.mjs';
import { compositionFor } from './render-policy.mjs';
import { settingsInput, settingsContext } from './settings-context.mjs';

const activeTasks = TASK_PROMPTS.filter(id => id !== 'paper-radar.task-discussion');

// Preview assembly never performs tool calls or model calls. Real source inputs
// are loaded only when a user explicitly selects a recorded task.
export function promptSettingsRoute(store, method, path, raw = {}, environment = {}) {
  const [id, action, ...extra] = path.split('/').filter(Boolean);
  if (id === 'runs' && method === 'GET' && !extra.length) {
    if (!action) {
      const recent = store.contextRuns();
      const captured = new Set(recent.map((r) => r.capture_id));
      const legacy = store.records('captures', null, 30).filter((r) => !captured.has(r.id)).map((r) => {
        const value = typeof r.variables.task === 'string' ? JSON.parse(r.variables.task) : r.variables.task;
        return { id: `legacy:${r.id}`, created_at: r.created_at, task: r.context.task ?? store.definition(r.prompt_id).task, language: value?.input?.language ?? value?.output?.language ?? 'zh', title: r.context.paper?.title ?? null, status: 'legacy', recording: 'initial_prompt_only' };
      });
      return { runs: [...recent, ...legacy].sort((a, b) => b.created_at.localeCompare(a.created_at)), retention: 30 };
    }
    if (action.startsWith('legacy:')) {
      const capture = store.record('captures', action.slice(7));
      return { id: action, created_at: capture.created_at, status: 'legacy', recording: 'initial_prompt_only', prepared: store.preview(capture.prompt_id, capture.variables, { snapshot: capture.snapshot }), events: [], event_count: 0, next_after: null };
    }
    const after = raw.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new PromptError('运行记录分页位置无效。');
    return store.contextRun(action, { after });
  }
  if (id === 'save-batch' && !action && method === 'POST') {
    const changes = raw.changes;
    if (!Array.isArray(changes) || !changes.length || changes.length > 20 || new Set(changes.map(c => c.prompt_id)).size !== changes.length) throw new PromptError('请选择不重复的提示词修改。');
    for (const change of changes) {
      if (!store.definition(change.prompt_id).settings_visible) throw new PromptError('提示词不存在。', 'not_found', 404);
      if (store.version(change.prompt_id).id !== change.expected_active) throw new PromptError('启用版本已改变，请刷新后比较再操作。', 'conflict', 409);
      store.makeVersion(change.prompt_id, change.templates, change.note);
    }
    for (const language of ['zh', 'en']) for (const task of activeTasks) for (const rule of task === SCREEN_PROMPT ? SCREEN_RULES : ['balanced']) {
      const root = `${task}.${language}`;
      const plan = compositionFor(root, { task: { input: { language }, criteria: { strictness: rule } } });
      const related = [plan.shared, plan.task, plan.rule];
      const affected = changes.filter(c => related.includes(c.prompt_id));
      if (!affected.length) continue;
      promptSettingsRoute(store, 'POST', `${root}/preview`, { templates: affected.find(c => c.prompt_id === root)?.templates ?? store.version(root).templates, screening_rule: rule, drafts: Object.fromEntries(affected.map(c => [c.prompt_id, c.templates])) }, environment);
    }
    const activation = changes.map(c => ({ prompt_id: c.prompt_id, expected_active: c.expected_active, version: store.saveVersion(c.prompt_id, c.templates, c.note, c.expected_active).id }));
    store.activate(activation);
    return { prompts: changes.map(c => promptSettingsRoute(store, 'GET', c.prompt_id)), activated: activation };
  }
  if (!id && method === 'GET')
    return { prompts: store.catalog().filter((p) => p.settings_visible) };
  if (!id || extra.length || !store.definition(id).settings_visible)
    throw new PromptError('提示词不存在。', 'not_found', 404);
  const definition = store.definition(id);
  const detail = () => {
    const value = store.detail(id);
    return {
      ...value,
      used_by: value.used_by.filter(
        (key) => store.definition(key).settings_visible,
      ),
    };
  };
  if (!action && method === 'GET') return detail();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new PromptError('请求内容无效。');
  if (raw.language !== undefined && raw.language !== definition.language)
    throw new PromptError('生成语言与当前提示词不一致。');

  const preview = (templates, { drafts = {}, task, screening_rule, source_id, personal, host } = {}) => {
    const language = definition.language;
    const base =
      definition.settings_role === 'task'
        ? definition.base_prompt
        : definition.settings_role === 'screening_rule'
          ? SCREEN_PROMPT
          : (task ?? 'paper-radar.task-single');
    if (!activeTasks.includes(base))
      throw new PromptError('请选择有效的预览任务。');
    const rule = definition.screening_rule ?? screening_rule ?? 'balanced';
    if (!SCREEN_RULES.includes(rule))
      throw new PromptError('请选择聚焦、平衡或探索。');
    const root = `${base}.${language}`;
    if (host !== undefined && !['codex', 'dsh'].includes(host)) throw new PromptError('请选择支持的运行环境。');
    if (personal !== undefined && typeof personal !== 'boolean') throw new PromptError('知识范围条件无效。');
    const taskName = store.definition(root).task;
    const input = settingsInput(store, taskName, language, rule, { source_id, personal });
    const variables = input.variables;
    const plan = compositionFor(root, variables);
    const allowed = new Set(
      [plan.task, plan.shared, plan.rule].filter(Boolean),
    );
    if (
      !drafts ||
      typeof drafts !== 'object' ||
      Array.isArray(drafts) ||
      Object.keys(drafts).length > 3
    )
      throw new PromptError('预览草稿无效。');
    const overrides = {};
    for (const [key, value] of Object.entries({ ...drafts, [id]: templates })) {
      if (!allowed.has(key))
        throw new PromptError('预览只能使用当前语言和筛选规则的草稿。');
      store.makeVersion(key, value);
      overrides[key] = { templates: value };
    }
    const prepared = store.preview(root, variables, { variant: { overrides } });
    return settingsContext(prepared, input, taskName, { host, settings: environment.settings });
  };
  if (method === 'POST' && action === 'preview')
    return preview(raw.templates, raw);
  if (method === 'POST' && ['save', 'activate'].includes(action)) {
    if (
      action === 'activate' &&
      (typeof raw.version !== 'string' || !raw.version)
    )
      throw new PromptError('请选择提示词版本。');
    if (raw.expected_active !== store.version(id).id)
      throw new PromptError(
        '启用版本已改变，请刷新后比较再操作。',
        'conflict',
        409,
      );
    const templates =
      action === 'save'
        ? raw.templates
        : store.version(id, raw.version).templates;
    store.makeVersion(id, templates, raw.note);
    // Check every affected composition before activating shared content.
    const tasks =
      definition.settings_role === 'shared'
        ? activeTasks
        : [definition.base_prompt ?? SCREEN_PROMPT];
    for (const task of tasks)
      for (const rule of task === SCREEN_PROMPT ? SCREEN_RULES : ['balanced'])
        preview(templates, { task, screening_rule: rule });
    const version =
      action === 'save'
        ? store.saveVersion(id, templates, raw.note, raw.expected_active).id
        : store.version(id, raw.version).id;
    store.activate([
      { prompt_id: id, version, expected_active: raw.expected_active },
    ]);
    return detail();
  }
  throw new PromptError('接口不存在。', 'not_found', 404);
}
