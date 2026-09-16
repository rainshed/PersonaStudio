'use client';

import { useEffect, useState } from 'react';
import { Check, Eye, Layers2, PencilLine, RotateCcw } from 'lucide-react';
import {
  promptSettingsApi,
  type PromptDetail,
  type PromptEntry,
  type PromptPreview,
  type PromptTemplates,
  type ContextRunSummary,
} from '@/lib/prompt-settings';
import { useUiLanguage } from './ui-language';
import './prompt-settings.css';
import { PromptTemplateEditor } from './prompt-template-editor';
import { ContextInspector, PromptRunHistory } from './prompt-context-panel';

const tasks = [
  ['screen', '每日筛选'],
  ['single', '单篇分析'],
  ['summary', '研究总结'],
  ['connections', '个性化分析'],
  ['review', '内容复核'],
];
const rules = [
  ['focused', '聚焦'],
  ['balanced', '平衡'],
  ['exploratory', '探索'],
];
const same = (a: PromptTemplates, b: PromptTemplates) =>
  JSON.stringify(a) === JSON.stringify(b);
type Draft = {
  detail: PromptDetail;
  templates: PromptTemplates;
  note: string;
  notice: string;
  error: string;
  conflict: boolean;
};
const draftFor = (detail: PromptDetail): Draft => ({
  detail,
  templates: { ...detail.active.templates },
  note: '',
  notice: '',
  error: '',
  conflict: false,
});

export function PromptSettingsPage({
  demo = false,
  visible = true,
}: {
  demo?: boolean;
  visible?: boolean;
}) {
  const { ui, uiLanguage } = useUiLanguage();
  const [entries, setEntries] = useState<PromptEntry[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [language, setLanguage] = useState('zh');
  const [selected, setSelected] = useState('summary');
  const [rule, setRule] = useState('balanced');
  const [part, setPart] = useState('rule');
  const [view, setView] = useState('edit');
  const [sampleTask, setSampleTask] = useState('single');
  const [sourceId, setSourceId] = useState('');
  const [personal, setPersonal] = useState(false);
  const [host, setHost] = useState('');
  const [sourceRuns, setSourceRuns] = useState<ContextRunSummary[] | null>(
    null,
  );
  const [previewState, setPreviewState] = useState<{
    key: string;
    value?: PromptPreview;
    error?: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const langLabel = ui(language === 'zh' ? '中文' : '英文');
  const ruleLabel = ui(rules.find(([key]) => key === rule)![1]);
  const entryFor = (role: string, task?: string, screeningRule?: string) =>
    entries?.find(
      (entry) =>
        entry.language === language &&
        entry.settings_role === role &&
        (!task || entry.task === task) &&
        (!screeningRule || entry.screening_rule === screeningRule),
    );
  const commonEntry = entryFor('shared');
  const entry =
    selected === 'shared'
      ? commonEntry
      : selected === 'screen' && part === 'rule'
        ? entryFor('screening_rule', 'screen', rule)
        : entryFor('task', selected);
  const currentId = entry?.id ?? '';
  const draft = drafts[currentId];
  const previewTask = selected === 'shared' ? sampleTask : selected;
  const taskEntry = entryFor('task', previewTask);
  const screeningEntry = entryFor('screening_rule', 'screen', rule);
  const currentRuleTitle = ui('{0}提示词', [ruleLabel]);
  const dirty = (id?: string) =>
    !!id &&
    !!drafts[id] &&
    !same(drafts[id].templates, drafts[id].detail.active.templates);
  const update = (id: string, values: Partial<Draft>) =>
    setDrafts((previous) => ({
      ...previous,
      [id]: { ...previous[id], ...values },
    }));

  useEffect(() => {
    if (demo || !visible || entries) return;
    const controller = new AbortController();
    void (async () => {
      const { prompts } = await promptSettingsApi<{ prompts: PromptEntry[] }>(
        '',
        undefined,
        controller.signal,
      );
      const details = await Promise.all(
        prompts.map((p) =>
          promptSettingsApi<PromptDetail>(p.id, undefined, controller.signal),
        ),
      );
      if (controller.signal.aborted) return;
      setDrafts(
        Object.fromEntries(
          details.map((detail) => [detail.id, draftFor(detail)]),
        ),
      );
      setEntries(prompts);
      setError('');
    })().catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message);
    });
    return () => controller.abort();
  }, [demo, visible, entries, retry]);

  const previewIds = [
    commonEntry?.id,
    taskEntry?.id,
    ...(previewTask === 'screen' ? [screeningEntry?.id] : []),
  ].filter((id): id is string => !!id);
  const matchingRuns = sourceRuns?.filter(
    (r) => r.task === previewTask && r.language === language,
  );
  const effectiveSource = matchingRuns?.some((r) => r.id === sourceId)
    ? sourceId
    : '';
  const saveIds = [...new Set([...previewIds, currentId])].filter((id) =>
    dirty(id),
  );
  const previewRequest =
    draft && taskEntry && commonEntry
      ? JSON.stringify({
          id: currentId,
          payload: {
            templates: draft.templates,
            language,
            task: taskEntry.base_prompt,
            screening_rule: rule,
            source_id: effectiveSource || undefined,
            personal: previewTask === 'screen' || personal,
            host: host || undefined,
            drafts: Object.fromEntries(
              previewIds.map((id) => [id, drafts[id].templates]),
            ),
          },
        })
      : '';
  const settledPreview =
    previewState?.key === previewRequest ? previewState : null;
  const preview = settledPreview?.value;
  const previewError = settledPreview?.error;
  const loadingPreview = !!previewRequest && !settledPreview;
  useEffect(() => {
    if (view === 'runs' || !previewRequest) return;
    const controller = new AbortController();
    const { id, payload } = JSON.parse(previewRequest);
    void promptSettingsApi<PromptPreview>(
      `${id}/preview`,
      payload,
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted)
          setPreviewState({ key: previewRequest, value });
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setPreviewState({ key: previewRequest, error: cause.message });
      });
    return () => controller.abort();
  }, [view, previewRequest]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    update(currentId, { error: '', notice: '' });
    try {
      const result = await promptSettingsApi<{ prompts: PromptDetail[] }>(
        'save-batch',
        {
          changes: saveIds.map((id) => ({
            prompt_id: id,
            templates: drafts[id].templates,
            note: drafts[id].note,
            expected_active: drafts[id].detail.active_version,
          })),
        },
      );
      setDrafts((previous) => ({
        ...previous,
        ...Object.fromEntries(
          result.prompts.map((detail) => [
            detail.id,
            { ...draftFor(detail), notice: '已保存并启用，将用于新任务。' },
          ]),
        ),
      }));
    } catch (cause) {
      const failure = cause as Error & { code?: string; status?: number };
      update(currentId, {
        error: failure.message,
        conflict: failure.code === 'conflict' || failure.status === 409,
      });
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    setBusy(true);
    try {
      const details = await Promise.all(
        [...new Set([...previewIds, currentId])].map((id) =>
          promptSettingsApi<PromptDetail>(id),
        ),
      );
      setDrafts((previous) => ({
        ...previous,
        ...Object.fromEntries(
          details.map((detail) => [
            detail.id,
            {
              ...previous[detail.id],
              detail,
              conflict: false,
              error: '',
              notice: '已读取最新启用版本，草稿已保留。请比较后再保存。',
            },
          ]),
        ),
      }));
    } catch (cause) {
      update(currentId, { error: (cause as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const load = (templates: PromptTemplates) =>
    update(currentId, {
      templates: { ...templates },
      error: '',
      notice: '已载入草稿，保存并启用后生效。',
    });

  return (
    <section className="prompt-settings" aria-label={ui('提示词设置')}>
      <header>
        <h2>{ui('提示词与任务输入')}</h2>
        <p>
          {ui('查看 Agent 会收到什么、内容来自哪里，以及哪些要求可以修改。')}
        </p>
      </header>
      {demo ? (
        <p className="prompt-notice">
          {ui('演示页面不连接本机提示词。请在本机应用的设置中编辑。')}
        </p>
      ) : (
        <>
          {error && (
            <div className="prompt-error" role="alert">
              <p>{ui(error)}</p>
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setRetry((n) => n + 1);
                }}
              >
                {ui('重试')}
              </button>
            </div>
          )}
          {!entries && !error && <output>{ui('正在读取提示词…')}</output>}
          {entries && (
            <>
              <div className="prompt-language-bar">
                <div>
                  <strong>{ui('生成语言')}</strong>
                  <div className="prompt-segments" aria-label={ui('生成语言')}>
                    {[
                      ['zh', '中文'],
                      ['en', 'English'],
                    ].map(([value, label]) => (
                      <button
                        type="button"
                        key={value}
                        disabled={busy}
                        aria-pressed={language === value}
                        onClick={() => setLanguage(value)}
                      >
                        {ui(label)}
                      </button>
                    ))}
                  </div>
                </div>
                <small>{ui('各语言独立保存，切换保留草稿。')}</small>
              </div>
              <div className="prompt-settings-layout">
                <nav
                  className="prompt-settings-nav"
                  aria-label={ui('选择提示词')}
                >
                  <div>
                    <h3>{ui('共用规则')}</h3>
                    <button
                      type="button"
                      disabled={busy}
                      aria-current={selected === 'shared' ? 'page' : undefined}
                      onClick={() => setSelected('shared')}
                    >
                      <Layers2 size={16} />
                      {ui('共用规则')}
                      {dirty(commonEntry?.id) && (
                        <span
                          className="prompt-dot"
                          aria-label={ui('有未保存修改')}
                        />
                      )}
                    </button>
                  </div>
                  <div>
                    <h3>{ui('任务提示词')}</h3>
                    {tasks.map(([task, label]) => (
                      <button
                        type="button"
                        disabled={busy}
                        key={task}
                        aria-current={selected === task ? 'page' : undefined}
                        onClick={() => setSelected(task)}
                      >
                        {ui(label)}
                        {entries.some(
                          (e) =>
                            e.language === language &&
                            e.task === task &&
                            dirty(e.id),
                        ) && (
                          <span
                            className="prompt-dot"
                            aria-label={ui('有未保存修改')}
                          />
                        )}
                      </button>
                    ))}
                  </div>
                </nav>
                {draft && entry && (
                  <article className="prompt-editor">
                    <div className="prompt-editor-heading">
                      <div>
                        <h3>
                          {selected === 'shared'
                            ? ui('共用规则')
                            : ui(
                                tasks.find(([task]) => task === selected)![1],
                              )}{' '}
                          <span className="prompt-badge">{langLabel}</span>
                        </h3>
                        <p>
                          {ui(
                            selected === 'screen'
                              ? '为每种筛选规则维护独立提示词。'
                              : selected === 'shared'
                                ? '自动应用于当前生成语言的所有任务，可以留空。'
                                : entry.description,
                          )}
                        </p>
                      </div>
                      <div
                        className="prompt-segments"
                        aria-label={ui('编辑或预览')}
                      >
                        <button
                          type="button"
                          disabled={busy}
                          aria-pressed={view === 'edit'}
                          onClick={() => setView('edit')}
                        >
                          <PencilLine size={14} />
                          {ui('提示词与输入')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          aria-pressed={view === 'preview'}
                          onClick={() => setView('preview')}
                        >
                          <Eye size={14} />
                          {ui('发送预览')}
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          aria-pressed={view === 'runs'}
                          onClick={() => setView('runs')}
                        >
                          {ui('运行记录')}
                        </button>
                      </div>
                    </div>
                    {view !== 'runs' &&
                      (selected === 'screen' ||
                        (view === 'preview' && previewTask === 'screen')) && (
                        <section
                          className="prompt-screen-controls"
                          aria-label={ui('筛选规则')}
                        >
                          <div>
                            <strong>{ui('筛选规则')}</strong>
                            <div className="prompt-rule-options">
                              {rules.map(([value, label]) => (
                                <button
                                  type="button"
                                  key={value}
                                  disabled={busy}
                                  aria-pressed={rule === value}
                                  onClick={() => {
                                    setRule(value);
                                    setPart('rule');
                                  }}
                                >
                                  {ui(label)}
                                  {dirty(
                                    entryFor('screening_rule', 'screen', value)
                                      ?.id,
                                  ) && (
                                    <span
                                      className="prompt-dot"
                                      aria-label={ui('有未保存修改')}
                                    />
                                  )}
                                </button>
                              ))}
                            </div>
                          </div>
                          <small>
                            {ui('此处切换编辑与预览，实际执行规则由订阅决定。')}
                          </small>
                        </section>
                      )}
                    {view !== 'runs' && (
                      <div className="prompt-context-controls">
                        {selected === 'shared' && (
                          <label>
                            {ui('预览任务')}
                            <select
                              value={sampleTask}
                              onChange={(e) => setSampleTask(e.target.value)}
                            >
                              {tasks.map(([id, label]) => (
                                <option key={id} value={id}>
                                  {ui(label)}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                        <label>
                          {ui('运行环境')}
                          <select
                            value={host}
                            onChange={(e) => setHost(e.target.value)}
                          >
                            <option value="">{ui('使用当前模型设置')}</option>
                            <option value="codex">Codex</option>
                            <option value="dsh">DSH</option>
                          </select>
                        </label>
                        <label>
                          {ui('预览资料')}
                          <select
                            value={effectiveSource}
                            onChange={(e) => setSourceId(e.target.value)}
                          >
                            <option value="">{ui('示例资料')}</option>
                            {matchingRuns?.map((r) => (
                              <option value={r.id} key={r.id}>
                                {r.created_at.slice(0, 16).replace('T', ' ')} ·{' '}
                                {r.title ?? ui('未命名任务')}
                              </option>
                            ))}
                          </select>
                        </label>
                        {
                          <button
                            type="button"
                            onClick={() => {
                              void promptSettingsApi<{
                                runs: ContextRunSummary[];
                              }>('runs')
                                .then((value) => setSourceRuns(value.runs))
                                .catch((e) =>
                                  update(currentId, { error: e.message }),
                                );
                            }}
                          >
                            {ui(
                              sourceRuns
                                ? '刷新可选资料'
                                : '载入可选的真实任务资料',
                            )}
                          </button>
                        }
                        {!effectiveSource && previewTask !== 'screen' && (
                          <label className="prompt-context-scope">
                            <input
                              type="checkbox"
                              checked={personal}
                              onChange={(e) => setPersonal(e.target.checked)}
                            />
                            {ui('示例中选择个人知识范围')}
                          </label>
                        )}
                        <small>
                          {ui(
                            effectiveSource
                              ? '所选任务资料 + 当前草稿；这是重新组合预览，不是历史输入。'
                              : '示例资料 + 当前草稿；只展开，不调用模型。',
                          )}
                        </small>
                        {preview?.preview_source?.tool_source ===
                          'current_contract' && (
                          <small>
                            {ui(
                              '旧记录没有工具定义，本预览使用当前工具与输出协议重新组合。',
                            )}
                          </small>
                        )}
                      </div>
                    )}
                    {view === 'runs' ? (
                      <PromptRunHistory
                        key={`${previewTask}:${language}`}
                        task={previewTask}
                        language={language}
                      />
                    ) : view === 'edit' ? (
                      <div className="prompt-edit-context-grid">
                        <div>
                          {selected === 'screen' && (
                            <div className="prompt-part-tabs">
                              <button
                                type="button"
                                disabled={busy}
                                aria-pressed={part === 'rule'}
                                onClick={() => setPart('rule')}
                              >
                                {currentRuleTitle}
                              </button>
                              <button
                                type="button"
                                disabled={busy}
                                aria-pressed={part === 'common'}
                                onClick={() => setPart('common')}
                              >
                                {ui('每日通用要求')}
                                {dirty(entryFor('task', 'screen')?.id) && (
                                  <span
                                    className="prompt-dot"
                                    aria-label={ui('有未保存修改')}
                                  />
                                )}
                              </button>
                            </div>
                          )}
                          {selected !== 'shared' && (
                            <div className="prompt-applied">
                              <span>
                                <Layers2 size={15} />
                                {ui('自动加入当前语言的共用规则')}
                                {dirty(commonEntry?.id) &&
                                  ` · ${ui('有未保存修改')}`}
                              </span>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => setSelected('shared')}
                              >
                                {ui('查看并编辑')}
                              </button>
                            </div>
                          )}
                          <fieldset
                            className="prompt-editor-fields"
                            disabled={busy}
                          >
                            <div className="prompt-field-heading">
                              <label htmlFor={`prompt-${currentId}`}>
                                {ui(
                                  entry.kind === 'message'
                                    ? '工作要求'
                                    : '规则内容',
                                )}
                              </label>
                              <span>
                                {ui(
                                  dirty(currentId)
                                    ? '有未保存修改'
                                    : draft.detail.active_version ===
                                        draft.detail.default_version
                                      ? '使用默认提示词'
                                      : '使用自定义提示词',
                                )}
                              </span>
                            </div>
                            <PromptTemplateEditor
                              id={`prompt-${currentId}`}
                              templates={draft.templates}
                              field={
                                entry.kind === 'message' ? 'system' : 'text'
                              }
                              onChange={(templates) =>
                                update(currentId, { templates, notice: '' })
                              }
                            />
                            <p className="prompt-help">
                              {ui(
                                selected === 'screen'
                                  ? part === 'common'
                                    ? '自动应用于当前语言的所有每日筛选任务。'
                                    : '仅用于所选筛选规则，每日通用要求自动加入。'
                                  : selected === 'shared'
                                    ? '共用规则也可以留空，按你的需要自由维护。'
                                    : '共用规则会自动加入，这里只需填写当前任务的要求。',
                              )}
                            </p>
                            {entry.kind === 'message' && (
                              <details className="prompt-advanced">
                                <summary>{ui('任务输入模板')}</summary>
                                <p>
                                  {ui('保留 {{task}}，任务资料会自动填入。')}
                                </p>
                                <label>
                                  {ui('任务输入模板')}
                                  <textarea
                                    rows={3}
                                    spellCheck={false}
                                    maxLength={50000}
                                    value={draft.templates.user}
                                    onChange={(event) =>
                                      update(currentId, {
                                        templates: {
                                          ...draft.templates,
                                          user: event.target.value,
                                        },
                                        notice: '',
                                      })
                                    }
                                  />
                                </label>
                              </details>
                            )}
                            {saveIds.length > 0 && (
                              <p className="prompt-save-impact">
                                {ui('本次保存：{0}', [
                                  saveIds
                                    .map((id) => ui(drafts[id].detail.name))
                                    .join(uiLanguage === 'zh' ? '、' : ', '),
                                ])}
                                {saveIds.includes(commonEntry?.id ?? '') &&
                                  ` ${ui('共用提示词的修改会影响当前语言的全部任务。')}`}
                              </p>
                            )}
                            <div className="prompt-actions">
                              <button
                                type="button"
                                onClick={() => load(draft.detail.templates)}
                              >
                                <RotateCcw size={14} />
                                {ui('恢复此项默认')}
                              </button>
                              <button
                                className="button-primary"
                                type="button"
                                disabled={!saveIds.length || draft.conflict}
                                onClick={() => void save()}
                              >
                                <Check size={14} />
                                {ui('保存当前组合并启用')}
                              </button>
                            </div>
                            <details className="prompt-history">
                              <summary>{ui('版本与修改说明')}</summary>
                              <label>
                                {ui('修改说明（可选）')}
                                <input
                                  maxLength={500}
                                  value={draft.note}
                                  onChange={(event) =>
                                    update(currentId, {
                                      note: event.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label>
                                {ui('载入历史版本')}
                                <select
                                  value=""
                                  onChange={(event) => {
                                    const version = draft.detail.versions.find(
                                      (v) => v.id === event.target.value,
                                    );
                                    if (version) load(version.templates);
                                  }}
                                >
                                  <option value="">
                                    {ui('选择版本以载入草稿')}
                                  </option>
                                  {draft.detail.versions
                                    .filter((v) => v.compatible)
                                    .map((version) => (
                                      <option
                                        value={version.id}
                                        key={version.id}
                                      >
                                        {version.created_at
                                          .slice(0, 16)
                                          .replace('T', ' ')}{' '}
                                        ·{' '}
                                        {version.id ===
                                        draft.detail.default_version
                                          ? ui('项目默认版本')
                                          : version.note ||
                                            version.id.slice(0, 8)}
                                      </option>
                                    ))}
                                </select>
                              </label>
                              <button
                                type="button"
                                onClick={() =>
                                  load(draft.detail.active.templates)
                                }
                              >
                                {ui('撤销本次修改')}
                              </button>
                              <details>
                                <summary>{ui('查看当前启用的提示词')}</summary>
                                {Object.entries(
                                  draft.detail.active.templates,
                                ).map(([key, text]) => (
                                  <pre key={key}>{text}</pre>
                                ))}
                              </details>
                            </details>
                          </fieldset>
                          {draft.error && (
                            <div className="prompt-error" role="alert">
                              {ui(draft.error)}
                            </div>
                          )}
                          {draft.conflict && (
                            <div className="prompt-conflict">
                              <p>
                                {ui(
                                  '其他页面已修改启用版本。读取最新版本会保留你的草稿，比较后可再次保存。',
                                )}
                              </p>
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => void refresh()}
                              >
                                {ui('读取最新启用版本')}
                              </button>
                            </div>
                          )}
                          {draft.notice && (
                            <output className="prompt-notice">
                              {ui(draft.notice)}
                            </output>
                          )}
                        </div>
                        <aside>
                          {loadingPreview && (
                            <output>{ui('正在生成预览…')}</output>
                          )}
                          {previewError && (
                            <p className="prompt-error" role="alert">
                              {ui(previewError)}
                            </p>
                          )}
                          {preview?.context && (
                            <ContextInspector
                              context={preview.context}
                              compact
                            />
                          )}
                        </aside>
                      </div>
                    ) : (
                      <section
                        className="prompt-preview"
                        aria-label={ui('发送预览')}
                      >
                        {loadingPreview && (
                          <output>{ui('正在生成预览…')}</output>
                        )}
                        {previewError && (
                          <div className="prompt-error" role="alert">
                            {ui(previewError)}
                          </div>
                        )}
                        {preview?.context && (
                          <ContextInspector
                            context={preview.context}
                            onEdit={(id) => {
                              const target = entries.find((e) => e.id === id);
                              if (!target) return;
                              setView('edit');
                              if (target.settings_role === 'shared')
                                setSelected('shared');
                              else {
                                setSelected(target.task ?? 'summary');
                                setPart(
                                  target.settings_role === 'screening_rule'
                                    ? 'rule'
                                    : 'common',
                                );
                                if (target.screening_rule)
                                  setRule(target.screening_rule);
                              }
                            }}
                          />
                        )}
                        {saveIds.length > 0 && (
                          <div className="prompt-actions">
                            <p>
                              {ui('本次保存：{0}', [
                                saveIds
                                  .map((id) => ui(drafts[id].detail.name))
                                  .join(uiLanguage === 'zh' ? '、' : ', '),
                              ])}
                            </p>
                            <button
                              className="button-primary"
                              type="button"
                              disabled={busy || draft.conflict}
                              onClick={() => void save()}
                            >
                              {ui('保存当前组合并启用')}
                            </button>
                          </div>
                        )}
                        {draft.error && (
                          <p className="prompt-error" role="alert">
                            {ui(draft.error)}
                          </p>
                        )}
                        {draft.notice && <output>{ui(draft.notice)}</output>}
                      </section>
                    )}
                  </article>
                )}
              </div>
              <p className="prompt-footer">
                {ui(
                  '保存后用于新任务；进行中的任务和原任务重试继续使用原版本。',
                )}
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
