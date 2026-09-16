'use client';
import { thinkingEffortLabel } from '@/lib/host-settings-copy';
import { DEFAULT_EXPERIMENT_NAME } from '@/lib/evaluation-display';
import { browserRequestId } from '@/lib/backend-response';
import { useEffect, useRef, useState } from 'react';
import {
  evaluationApi,
  evaluationWrite,
  type ExperimentOptions,
  type ExperimentSelection,
  type ExperimentConfiguration,
  type ExperimentDraft,
  type EvaluationRun,
  type EvaluationSuite,
  type EvaluationPreview,
} from '@/lib/evaluation-api';
import { useUiLanguage } from './ui-language';
import { PromptTemplateEditor } from './prompt-template-editor';

export function EvaluationExperiment({
  suite,
  draft,
  onRun,
  onSaved,
  onClose,
}: {
  suite: EvaluationSuite;
  draft?: ExperimentDraft;
  onRun: (run: EvaluationRun) => void;
  onSaved: (draft: ExperimentDraft) => void;
  onClose: () => void;
}) {
  const { ui, uiLanguage } = useUiLanguage();
  const pendingSnapshot = useRef<{
    configuration: string;
    suite: EvaluationSuite;
  } | null>(null);
  const pendingRun = useRef<{ key: string; configuration: string } | null>(
    null,
  );
  const [options, setOptions] = useState<ExperimentOptions | null>(null);
  const [baseline, setBaseline] = useState<ExperimentSelection | null>(null);
  const [selection, setSelection] = useState<ExperimentSelection | null>(null);
  const [overrides, setOverrides] = useState<
    Record<string, Record<string, string>>
  >(draft?.configuration.candidates[1]?.prompt_overrides ?? {});
  const [customName, setName] = useState<string | null>(
    draft && !draft.name_is_default ? draft.name : null,
  );
  const nameIsDefault = customName === null && !!suite.automatic;
  const name =
    customName ??
    (suite.automatic
      ? ui(DEFAULT_EXPERIMENT_NAME)
      : `${suite.name} · ${ui('新实验')}`);
  const savedName = nameIsDefault ? DEFAULT_EXPERIMENT_NAME : name;
  const [saved, setSaved] = useState(draft);
  const [promptId, setPromptId] = useState('');
  const [maxCalls, setMaxCalls] = useState(
    draft?.configuration.max_calls?.toString() ?? '',
  );
  const [tokens, setTokens] = useState(
    draft?.configuration.token_budget?.toString() ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    evaluationApi<ExperimentOptions>(
      'experiment-options?suite_id=' +
        encodeURIComponent(suite.id) +
        (suite.scope_key
          ? '&scope_key=' + encodeURIComponent(suite.scope_key)
          : ''),
      { signal: controller.signal },
    )
      .then((o) => {
        if (controller.signal.aborted) return;
        setOptions(o);
        const host = o.hosts.find((h) => h.id === o.active_backend);
        const current = host?.default
          ? {
              backend: host.id,
              providerId: host.default.providerId,
              modelId: host.default.modelId,
              reasoningEffort: host.default.reasoningEffort ?? null,
            }
          : null;
        setBaseline(current);
        setSelection(
          (old) =>
            old ?? draft?.configuration.candidates[1]?.selection ?? current,
        );
        setPromptId(
          (old) =>
            old ||
            o.prompt_fields.find((p) => p.settings_role === 'task')?.id ||
            o.prompt_fields[0]?.id ||
            '',
        );
        setError('');
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [suite.id, suite.scope_key, draft, tick]);
  const host = options?.hosts.find((h) => h.id === selection?.backend);
  const model = host?.models.find(
    (m) =>
      m.providerId === selection?.providerId &&
      m.modelId === selection?.modelId,
  );
  const prompt = options?.prompt_fields.find((p) => p.id === promptId);
  const templates = prompt ? (overrides[prompt.id] ?? prompt.templates) : {};
  const field = prompt?.kind === 'message' ? 'system' : 'text';
  const configuration = (): ExperimentConfiguration => ({
    name: savedName,
    name_is_default: nameIsDefault,
    suite_id: suite.id,
    candidates: [
      { selection: baseline!, current: true },
      { selection: selection!, prompt_overrides: overrides },
    ],
    ...(maxCalls ? { max_calls: Number(maxCalls) } : {}),
    ...(tokens ? { token_budget: Number(tokens) } : {}),
  });
  const valid =
    !!baseline &&
    !!selection &&
    !!model &&
    !!host?.connected &&
    !!options?.hosts.find((h) => h.id === baseline.backend)?.connected &&
    !!name.trim();
  async function submit(run: boolean) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const config = configuration();
      // Freeze the current tag-scoped dataset only when the user saves or runs.
      if (suite.id === 'dataset') {
        const input = JSON.stringify(config);
        if (!run || pendingSnapshot.current?.configuration !== input)
          pendingSnapshot.current = {
            configuration: input,
            suite: await evaluationWrite<EvaluationSuite>('dataset/snapshot', {
              scope_key: suite.scope_key,
            }),
          };
        config.suite_id = pendingSnapshot.current!.suite.id;
      }
      if (run) {
        const serialized = JSON.stringify(config);
        if (pendingRun.current?.configuration !== serialized)
          pendingRun.current = {
            key: browserRequestId(),
            configuration: serialized,
          };
        const preview = await evaluationWrite<EvaluationPreview>(
          'runs/preview',
          config,
        );
        onRun(
          await evaluationWrite<EvaluationRun>('runs', {
            ...config,
            preview_id: preview.preview_id,
            idempotency_key: pendingRun.current.key,
          }),
        );
      } else {
        const result = await evaluationWrite<ExperimentDraft>('drafts', {
          id: saved?.id,
          revision: saved?.revision,
          name: savedName,
          name_is_default: nameIsDefault,
          configuration: config,
        });
        setSaved(result);
        onSaved(result);
        setNotice('实验草稿已保存');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="evaluation-experiment">
      <div className="evaluation-section-title">
        <h2>{ui('新实验')}</h2>
        <button className="button-secondary" disabled={busy} onClick={onClose}>
          {ui('收起')}
        </button>
      </div>
      <p>
        {suite.scope_name ?? (suite.automatic ? ui(suite.name) : suite.name)} ·{' '}
        {suite.members.length} {ui('篇论文')} ·{' '}
        {ui(
          '开始时保存所选 tag 范围的样例、答案与本次配置，使用当前知识库重新分析。',
        )}
      </p>
      <label className="evaluation-field">
        {ui('实验名称')}
        <input
          value={name}
          maxLength={150}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
      </label>
      {!options ? (
        <output>{ui('正在读取模型与提示词…')}</output>
      ) : (
        <>
          <div className="evaluation-config-grid">
            <article className="evaluation-baseline">
              <h3>{ui('当前配置')}</h3>
              <p>
                {options.hosts.find((h) => h.id === baseline?.backend)?.name ??
                  '—'}{' '}
                · {baseline?.modelId ?? ui('尚未配置')}
              </p>
              <p>
                {ui('思考强度')}：
                {baseline?.reasoningEffort
                  ? thinkingEffortLabel(baseline.reasoningEffort, uiLanguage)
                  : ui('模型默认')}
              </p>
              <p>{ui('提示词和模型使用各任务在设置中的当前配置。')}</p>
              {Object.entries(
                options.hosts.find((h) => h.id === baseline?.backend)
                  ?.defaults ?? {},
              ).map(([task, m]) => (
                <p key={task}>
                  {ui(task === 'single' ? '单篇分析' : '每日初筛')}：
                  {m?.modelId ?? ui('尚未配置')} ·{' '}
                  {m?.reasoningEffort ?? ui('模型默认')}
                </p>
              ))}
              <button
                className="button-secondary"
                disabled={busy}
                onClick={() => setTick((v) => v + 1)}
              >
                {ui('刷新当前配置')}
              </button>
            </article>
            <fieldset disabled={busy} className="evaluation-candidate">
              <legend>{ui('实验配置')}</legend>
              <label>
                {ui('推荐 Agent')}
                <select
                  value={selection?.backend ?? ''}
                  onChange={(e) => {
                    const h = options.hosts.find(
                      (x) => x.id === e.target.value,
                    )!;
                    const m =
                      h.models.find(
                        (x) =>
                          x.modelId === h.default?.modelId &&
                          x.providerId === h.default?.providerId,
                      ) ?? h.models[0];
                    setSelection({
                      backend: h.id,
                      providerId: m?.providerId ?? '',
                      modelId: m?.modelId ?? '',
                      reasoningEffort: m?.reasoning?.defaultEffort ?? null,
                    });
                  }}
                >
                  <option value="" disabled>
                    {ui('选择 Agent')}
                  </option>
                  {options.hosts.map((h) => (
                    <option key={h.id} value={h.id} disabled={!h.connected}>
                      {h.name}
                      {!h.connected ? ` · ${ui('未连接')}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {ui('模型')}
                <select
                  value={JSON.stringify([
                    selection?.providerId,
                    selection?.modelId,
                  ])}
                  onChange={(e) => {
                    const [providerId, modelId] = JSON.parse(
                      e.target.value,
                    ) as string[];
                    const m = host!.models.find(
                      (x) =>
                        x.providerId === providerId && x.modelId === modelId,
                    )!;
                    setSelection({
                      ...selection!,
                      providerId,
                      modelId,
                      reasoningEffort: m.reasoning?.defaultEffort ?? null,
                    });
                  }}
                >
                  <option
                    value={JSON.stringify([undefined, undefined])}
                    disabled
                  >
                    {ui('选择模型')}
                  </option>
                  {host?.models.map((m) => (
                    <option
                      key={JSON.stringify([m.providerId, m.modelId])}
                      value={JSON.stringify([m.providerId, m.modelId])}
                    >
                      {m.name} · {m.providerId}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {ui('思考强度')}
                <select
                  value={selection?.reasoningEffort ?? ''}
                  disabled={!model?.reasoning?.efforts.length}
                  onChange={(e) =>
                    setSelection({
                      ...selection!,
                      reasoningEffort: e.target.value || null,
                    })
                  }
                >
                  <option value="">{ui('模型默认')}</option>
                  {model?.reasoning?.efforts.map((effort) => (
                    <option key={effort.id} value={effort.id}>
                      {thinkingEffortLabel(effort.id, uiLanguage)}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>
          </div>
          {(!baseline || !valid) && (
            <p className="daily-notice">
              {ui('请在设置中连接可用的 Agent，并为两组配置选择可用模型。')}
            </p>
          )}
          <fieldset disabled={busy} className="evaluation-prompt-editor">
            <legend>{ui('实验提示词')}</legend>
            <p>
              {ui(
                '建议每次先改一项，方便判断改善来自哪里。实验草稿不会修改正式设置。',
              )}
            </p>
            <label className="evaluation-field">
              {ui('编辑内容')}
              <select
                value={promptId}
                onChange={(e) => setPromptId(e.target.value)}
              >
                {options.prompt_fields.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.language?.toUpperCase()} · {ui(p.name)}
                    {overrides[p.id] ? ' *' : ''}
                  </option>
                ))}
              </select>
            </label>
            {prompt && (
              <>
                <PromptTemplateEditor
                  id="evaluation-prompt"
                  templates={templates}
                  field={field}
                  onChange={(value) =>
                    setOverrides((old) => ({ ...old, [prompt.id]: value }))
                  }
                />
                {prompt.kind === 'message' && (
                  <details>
                    <summary>{ui('任务输入模板')}</summary>
                    <PromptTemplateEditor
                      id="evaluation-input-template"
                      templates={templates}
                      field="user"
                      rows={4}
                      onChange={(value) =>
                        setOverrides((old) => ({ ...old, [prompt.id]: value }))
                      }
                    />
                  </details>
                )}
                <button
                  className="button-secondary"
                  disabled={!overrides[prompt.id]}
                  onClick={() =>
                    setOverrides((old) => {
                      const next = { ...old };
                      delete next[prompt.id];
                      return next;
                    })
                  }
                >
                  {ui('恢复当前提示词')}
                </button>
              </>
            )}
          </fieldset>
          <details className="evaluation-advanced">
            <summary>{ui('运行预算')}</summary>
            <div className="evaluation-filters">
              <label>
                {ui('最多执行次数')}
                <input
                  type="number"
                  min={1}
                  max={20000}
                  placeholder={ui('自动计算')}
                  value={maxCalls}
                  disabled={busy}
                  onChange={(e) => setMaxCalls(e.target.value)}
                />
              </label>
              <label>
                {ui('Token 预算')}
                <input
                  type="number"
                  min={1}
                  max={2000000000}
                  placeholder={ui('自动计算')}
                  value={tokens}
                  disabled={busy}
                  onChange={(e) => setTokens(e.target.value)}
                />
              </label>
            </div>
            <p>{ui('达到预算后暂停，可在实验记录中增加预算并继续。')}</p>
          </details>
        </>
      )}
      {error && (
        <p role="alert" className="daily-notice">
          {ui(error)}{' '}
          <button onClick={() => setTick((v) => v + 1)}>{ui('重试')}</button>
        </p>
      )}
      {notice && <output className="daily-success">{ui(notice)}</output>}
      <div className="evaluation-actions">
        <button
          className="button-secondary"
          disabled={busy || !valid}
          onClick={() => void submit(false)}
        >
          {ui('保存实验草稿')}
        </button>
        <button
          className="button-primary"
          disabled={busy || !valid}
          onClick={() => void submit(true)}
        >
          {ui(busy ? '正在提交…' : '开始对比（使用模型额度）')}
        </button>
      </div>
    </section>
  );
}
