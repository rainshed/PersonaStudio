'use client';
import { thinkingEffortLabel } from '@/lib/host-settings-copy';
import { useState, useSyncExternalStore } from 'react';
import {
  Zap,
  ScanText,
  ChevronDown,
  RefreshCw,
  ArrowUpRight,
  SlidersHorizontal,
  Check,
  CircleAlert,
} from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useUiLanguage } from './ui-language';
import { readBackendResponse } from '@/lib/backend-response';
import { MAX_CONCURRENCY, validConcurrency } from '@/lib/concurrency';
import {
  HOST_TASKS,
  upgradeRoutes,
  taskChoice,
  defaultPreset,
  modelKey,
  cleanModelName,
  type ModelChoice,
  type HostRouting,
  type LegacyRouting,
  type Preset,
  type Assignment,
} from '@/lib/host-settings';
import {
  hostSettingsCopy,
  dshSettingsError,
  type HostSettingsCopy,
} from '@/lib/host-settings-copy';
import './host-routing-settings.css';

type Model = {
  provider: string;
  model: string;
  name: string;
  unavailable?: boolean;
  reasoning?: {
    efforts: { id: string; name: string }[];
    defaultEffort?: string;
  } | null;
};
export type HostConfig = {
  mode: 'dsh' | 'codex';
  connected: boolean;
  error?: { code?: string; message: string } | null;
  catalog: {
    defaults: { provider: string; model: string; reasoningEffort?: string };
    groups: { id: string; name: string; models: Model[] }[];
    settingsUrl: string | null;
  } | null;
  tasks: { id: string; name: string }[];
  routing: LegacyRouting | HostRouting;
};
const visibleTasks = HOST_TASKS.filter((task) => task !== 'discussion');
const subscribeLocation = () => () => {};
const localHosts = ['127.0.0.1', 'localhost', '[::1]'];
function hostLinkUsable(url: string | null | undefined, localBrowser: boolean) {
  try {
    const parsed = new URL(url ?? '');
    return (
      ['http:', 'https:'].includes(parsed.protocol) &&
      (localBrowser || !localHosts.includes(parsed.hostname))
    );
  } catch {
    return false;
  }
}
export function HostRoutingSettings({
  initial,
  endpointBase = '/api/models',
  host = 'dsh',
}: {
  initial: HostConfig;
  endpointBase?: string;
  host?: 'dsh' | 'codex';
}) {
  const { uiLanguage } = useUiLanguage();
  const baseCopy: HostSettingsCopy = hostSettingsCopy[uiLanguage];
  const t: HostSettingsCopy =
    host === 'dsh'
      ? baseCopy
      : {
          ...baseCopy,
          connected:
            uiLanguage === 'zh'
              ? 'Codex 已连接（隔离模式）'
              : 'Codex connected (isolated)',
          disconnected:
            uiLanguage === 'zh' ? 'Codex 暂不可用' : 'Codex is unavailable',
          shared:
            uiLanguage === 'zh'
              ? '模型和账号由 Paper Radar 专属 Codex 运行空间管理。'
              : 'Models and the account are managed in Paper Radar’s isolated Codex runtime.',
          hostDefault: uiLanguage === 'zh' ? '跟随 Codex' : 'Follow Codex',
          modelMissing:
            uiLanguage === 'zh'
              ? '此模型当前不可用，请刷新目录或选择其他模型。'
              : 'This model is unavailable. Refresh the catalog or choose another.',
          connectionDetails:
            uiLanguage === 'zh' ? 'Codex 连接' : 'Codex connection',
          remoteHelp:
            uiLanguage === 'zh'
              ? '账号仅保存在 Paper Radar 的隔离运行空间中。'
              : 'The account is stored only in Paper Radar’s isolated runtime.',
          hostHelp:
            uiLanguage === 'zh'
              ? '请先登录 Paper Radar 专用 Codex 账号，然后刷新连接。'
              : 'Sign in to the Codex account dedicated to Paper Radar, then refresh.',
          hostModel: uiLanguage === 'zh' ? 'Codex 默认模型' : 'Codex default',
          authError:
            uiLanguage === 'zh'
              ? 'Codex 授权需要更新，请重新登录。'
              : 'Codex authorization needs attention. Sign in again.',
          modelError:
            uiLanguage === 'zh'
              ? '所选 Codex 模型已不可用，请刷新后重新选择。'
              : 'The selected Codex model is unavailable. Refresh and choose another.',
        };
  const [config, setConfig] = useState(initial),
    [draft, setDraft] = useState(() => upgradeRoutes(initial.routing));
  const [busy, setBusy] = useState<'save' | 'refresh' | null>(null);
  const [notice, setNotice] = useState<keyof HostSettingsCopy | null>(null),
    [error, setError] = useState<{ code?: string } | null>(null);
  const localBrowser = useSyncExternalStore(
    subscribeLocation,
    () => localHosts.includes(window.location.hostname),
    () => false,
  );
  const canOpenHost = hostLinkUsable(config.catalog?.settingsUrl, localBrowser);
  const models = config.catalog?.groups.flatMap((g) => g.models) ?? [];
  const changed =
    JSON.stringify(draft) !== JSON.stringify(upgradeRoutes(config.routing));
  const concurrencyValid = validConcurrency(draft.concurrency);
  const exceptions = visibleTasks.filter(
    (task) => draft.assignments[task] !== defaultPreset(task),
  ).length;
  const effortName = (id: string) => thinkingEffortLabel(id, uiLanguage);
  const findModel = (model: ModelChoice['model']) =>
    models.find((m) => modelKey(m) === modelKey(model));
  const modelName = (model: ModelChoice['model']) =>
    cleanModelName(findModel(model)?.name ?? model?.model ?? t.waiting);
  const effective = (choice: ModelChoice) =>
    choice.model ?? config.catalog?.defaults ?? null;
  function choiceInvalid(choice: ModelChoice) {
    const selected = findModel(effective(choice));
    return !!(
      (choice.model && (!selected || selected.unavailable)) ||
      (choice.reasoningEffort &&
        !selected?.reasoning?.efforts.some(
          (e) => e.id === choice.reasoningEffort,
        ))
    );
  }
  const choicesValid = [
    draft.presets.fast,
    draft.presets.deep,
    ...visibleTasks
      .filter((task) => draft.assignments[task] === 'custom')
      .map((task) => draft.tasks[task]),
    ...(draft.fallback.enabled ? [draft.fallback] : []),
  ].every((choice) => !choiceInvalid(choice));
  function edit(next: HostRouting) {
    setDraft(next);
    setNotice(null);
    setError(null);
  }
  async function load(save = false) {
    setBusy(save ? 'save' : 'refresh');
    setNotice(null);
    setError(null);
    try {
      const response = await fetch(
        save ? `${endpointBase}/routing` : `${endpointBase}/config`,
        {
          method: save ? 'POST' : 'GET',
          headers: { 'content-type': 'application/json', 'x-paper-radar': '1' },
          ...(save ? { body: JSON.stringify(draft) } : {}),
          signal: AbortSignal.timeout(30000),
        },
      );
      const value = await readBackendResponse<HostConfig>(response);
      setConfig(value);
      if (save || !changed) setDraft(upgradeRoutes(value.routing));
      if (value.connected)
        setNotice(save ? 'saved' : changed ? 'refreshedDraft' : 'refreshed');
      else setError({ code: value.error?.code });
    } catch (e) {
      setError({
        code:
          e && typeof e === 'object' && 'code' in e
            ? String(e.code)
            : undefined,
      });
      if (e && typeof e === 'object' && 'code' in e && e.code === 'conflict') {
        // Keep the edited draft, but let Discard load the current server version.
        try {
          setConfig(
            await readBackendResponse<HostConfig>(
              await fetch(`${endpointBase}/config`, {
                signal: AbortSignal.timeout(10000),
              }),
            ),
          );
        } catch {
          /* Keep the last known configuration. */
        }
      }
    } finally {
      setBusy(null);
    }
  }
  function modelSelect(
    id: string,
    choice: ModelChoice,
    update: (choice: ModelChoice) => void,
    allowInherit = true,
  ) {
    const missing = choice.model && !findModel(choice.model);
    return (
      <div className="dsh-choice">
        <label id={`${id}-model-label`} htmlFor={`${id}-model`}>
          {t.model}
        </label>
        <Select
          value={choice.model || allowInherit ? modelKey(choice.model) : null}
          disabled={!!busy || !config.connected}
          onValueChange={(value) => {
            if (!value || value === modelKey(choice.model)) return;
            const model = models.find((m) => modelKey(m) === value);
            // Thinking effort belongs to the chosen model, not to the dropdown slot.
            update({
              model:
                value === 'inherit'
                  ? null
                  : model
                    ? { provider: model.provider, model: model.model }
                    : choice.model,
              reasoningEffort: null,
            });
          }}
        >
          <SelectTrigger
            id={`${id}-model`}
            aria-labelledby={`${id}-model-label`}
            aria-invalid={
              !!(
                choice.model &&
                (!findModel(choice.model) ||
                  findModel(choice.model)?.unavailable)
              )
            }
          >
            <SelectValue>
              {choice.model
                ? modelName(choice.model)
                : allowInherit
                  ? t.hostDefault
                  : t.chooseModel}
            </SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            {allowInherit && (
              <SelectItem value="inherit">{t.hostDefault}</SelectItem>
            )}
            {missing && (
              <SelectItem value={modelKey(choice.model)} disabled>
                {modelName(choice.model)} · {t.unavailable}
              </SelectItem>
            )}
            {models.map((m) => (
              <SelectItem
                key={modelKey(m)}
                value={modelKey(m)}
                disabled={m.unavailable}
              >
                <span className="dsh-option-name">
                  {cleanModelName(m.name)}
                  {models.filter(
                    (other) =>
                      cleanModelName(other.name) === cleanModelName(m.name),
                  ).length > 1 && <small>{m.provider}</small>}
                </span>
                {m.unavailable && <small>{t.unavailable}</small>}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!choice.model && allowInherit && (
          <p className="dsh-hint">
            {t.current}: {modelName(effective(choice))}
          </p>
        )}
        {choice.model &&
          (!findModel(choice.model) ||
            findModel(choice.model)?.unavailable) && (
            <p className="dsh-error">{t.modelMissing}</p>
          )}
      </div>
    );
  }
  function reasoningSelect(
    id: string,
    choice: ModelChoice,
    update: (choice: ModelChoice) => void,
  ) {
    const model = findModel(effective(choice)),
      efforts = model?.reasoning?.efforts ?? [];
    const invalid =
      !!choice.reasoningEffort &&
      !efforts.some((e) => e.id === choice.reasoningEffort);
    const defaults = config.catalog?.defaults;
    const inherited =
      (modelKey(effective(choice)) === modelKey(defaults)
        ? defaults?.reasoningEffort
        : undefined) ?? model?.reasoning?.defaultEffort;
    return (
      <div className="dsh-choice">
        <label id={`${id}-effort-label`} htmlFor={`${id}-effort`}>
          {t.reasoning}
        </label>
        <Select
          value={choice.reasoningEffort ?? 'inherit'}
          disabled={
            !!busy ||
            !config.connected ||
            (!efforts.length && !choice.reasoningEffort)
          }
          onValueChange={(value) =>
            update({
              ...choice,
              reasoningEffort: value === 'inherit' ? null : value,
            })
          }
        >
          <SelectTrigger
            id={`${id}-effort`}
            aria-labelledby={`${id}-effort-label`}
            aria-invalid={invalid}
          >
            <SelectValue>
              {choice.reasoningEffort
                ? effortName(choice.reasoningEffort)
                : t.defaultEffort}
            </SelectValue>
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectItem value="inherit">{t.defaultEffort}</SelectItem>
            {invalid && (
              <SelectItem value={choice.reasoningEffort!} disabled>
                {effortName(choice.reasoningEffort!)} · {t.unavailable}
              </SelectItem>
            )}
            {efforts.map((e) => (
              <SelectItem key={e.id} value={e.id}>
                {effortName(e.id)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className={invalid ? 'dsh-error' : 'dsh-hint'}>
          {invalid
            ? t.effortMissing
            : !efforts.length
              ? t.noEfforts
              : !choice.reasoningEffort && inherited
                ? `${t.defaultEffort}: ${effortName(inherited)}`
                : choice.reasoningEffort
                  ? t.effortDescription
                  : t.autoDescription}
        </p>
      </div>
    );
  }
  const hostLink =
    canOpenHost && config.catalog?.settingsUrl ? (
      <a href={config.catalog.settingsUrl} target="_blank" rel="noreferrer">
        {t.manage}
        <ArrowUpRight size={14} />
      </a>
    ) : null;
  return (
    <section
      className="dsh-model-settings"
      aria-labelledby="dsh-settings-title"
    >
      <header className="dsh-heading">
        <div>
          <h1 id="dsh-settings-title">{t.title}</h1>
          <p>{t.subtitle}</p>
        </div>
        <button className="dsh-button" onClick={() => load()} disabled={!!busy}>
          <RefreshCw
            size={15}
            className={busy === 'refresh' ? 'dsh-spin' : ''}
          />
          {busy === 'refresh' ? t.refreshing : t.refresh}
        </button>
      </header>
      <div className={`dsh-status ${config.connected ? 'connected' : ''}`}>
        <span className="dsh-status-dot" />
        <span>{config.connected ? t.connected : t.disconnected}</span>
        {hostLink}
      </div>
      {!config.connected && (
        <div className="dsh-notice error" role="alert">
          <CircleAlert size={17} />
          <span>{t.hostHelp}</span>
        </div>
      )}
      <div className="dsh-presets">
        {(['fast', 'deep'] as const).map((preset) => {
          const choice = draft.presets[preset],
            used = visibleTasks.filter(
              (task) => draft.assignments[task] === preset,
            );
          const update = (value: ModelChoice) =>
            edit({ ...draft, presets: { ...draft.presets, [preset]: value } });
          return (
            <article className={`dsh-preset ${preset}`} key={preset}>
              <div className="dsh-preset-icon">
                {preset === 'fast' ? (
                  <Zap size={22} strokeWidth={1.6} />
                ) : (
                  <ScanText size={22} strokeWidth={1.6} />
                )}
              </div>
              <h2>{t[preset]}</h2>
              <p className="dsh-preset-description">
                {preset === 'fast' ? t.fastDescription : t.deepDescription}
              </p>
              {modelSelect(`preset-${preset}`, choice, update)}
              <details className="dsh-effort-details">
                <summary>
                  {t.reasoning}
                  <span>
                    {choice.reasoningEffort
                      ? effortName(choice.reasoningEffort)
                      : t.defaultEffort}
                    <ChevronDown size={14} />
                  </span>
                </summary>
                {reasoningSelect(`preset-${preset}`, choice, update)}
              </details>
              <div className="dsh-usage">
                <span>{used.length ? t.usedBy : t.unused}</span>
                {used.length > 0 && (
                  <p>
                    {used
                      .map((task) => t[task])
                      .join(uiLanguage === 'zh' ? ' · ' : ', ')}
                  </p>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <p className="dsh-shared-note">{t.shared}</p>
      <details className="dsh-advanced">
        <summary>
          <SlidersHorizontal size={18} />
          <span>
            <strong>{t.advanced}</strong>
            <small>{t.advancedDescription}</small>
          </span>
          <span className="dsh-exceptions">
            {exceptions
              ? `${exceptions} ${exceptions === 1 ? t.exception : t.exceptions}`
              : t.noExceptions}
          </span>
          <ChevronDown size={18} />
        </summary>
        <div className="dsh-advanced-body">
          <div className="dsh-section-heading">
            <h2>{t.tasksTitle}</h2>
            <p>{t.tasksDescription}</p>
          </div>
          <div className="dsh-task-list">
            {visibleTasks.map((task) => {
              const assignment = draft.assignments[task],
                choice = taskChoice(draft, task);
              const update = (value: ModelChoice) =>
                edit({ ...draft, tasks: { ...draft.tasks, [task]: value } });
              return (
                <div className="dsh-task-row" key={task}>
                  <div className="dsh-task-title">
                    <h3>{t[task]}</h3>
                    <p>{t[`${task}Help`]}</p>
                  </div>
                  <div className="dsh-task-preference">
                    <Select
                      value={assignment}
                      disabled={!!busy}
                      onValueChange={(value) => {
                        if (!value) return;
                        edit({
                          ...draft,
                          assignments: {
                            ...draft.assignments,
                            [task]: value as Assignment,
                          },
                          tasks: { ...draft.tasks, [task]: { ...choice } },
                        });
                      }}
                    >
                      <SelectTrigger aria-label={`${t[task]} · ${t.routing}`}>
                        <SelectValue>{t[assignment]}</SelectValue>
                      </SelectTrigger>
                      <SelectContent alignItemWithTrigger={false}>
                        {(['fast', 'deep', 'custom'] as const).map((option) => (
                          <SelectItem key={option} value={option}>
                            {t[option]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {assignment !== 'custom' && (
                      <p className="dsh-hint">
                        {modelName(effective(choice))} ·{' '}
                        {choice.reasoningEffort
                          ? effortName(choice.reasoningEffort)
                          : t.defaultEffort}
                      </p>
                    )}
                  </div>
                  {assignment !== defaultPreset(task) && (
                    <button
                      className="dsh-reset"
                      disabled={!!busy}
                      onClick={() =>
                        edit({
                          ...draft,
                          assignments: {
                            ...draft.assignments,
                            [task]: defaultPreset(task),
                          },
                        })
                      }
                    >
                      {t.restore}
                    </button>
                  )}
                  {assignment === 'custom' && (
                    <div className="dsh-custom-choices">
                      {modelSelect(task, choice, update)}
                      {reasoningSelect(task, choice, update)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="dsh-concurrency">
            <div>
              <h2>
                <label htmlFor="dsh-concurrency">{t.concurrency}</label>
              </h2>
              <p id="dsh-concurrency-help">{t.concurrencyHelp}</p>
              <p className="dsh-hint">{t.concurrencyRange}</p>
            </div>
            <input
              id="dsh-concurrency"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_CONCURRENCY}
              step={1}
              value={draft.concurrency || ''}
              disabled={!!busy}
              aria-describedby="dsh-concurrency-help"
              aria-invalid={!concurrencyValid}
              onChange={(event) =>
                edit({
                  ...draft,
                  concurrency: Number(event.currentTarget.value),
                })
              }
            />
            {!concurrencyValid && (
              <p className="dsh-error" role="alert">
                {t.concurrencyError}
              </p>
            )}
          </div>
          <div className="dsh-fallback">
            <div className="dsh-fallback-heading">
              <div>
                <h2>
                  <label htmlFor="dsh-fallback">{t.fallback}</label>
                </h2>
                <p id="dsh-fallback-help">{t.fallbackHelp}</p>
              </div>
              <Switch
                id="dsh-fallback"
                aria-describedby="dsh-fallback-help"
                checked={draft.fallback.enabled}
                disabled={!!busy}
                onCheckedChange={(enabled) =>
                  edit({ ...draft, fallback: { ...draft.fallback, enabled } })
                }
              />
            </div>
            {draft.fallback.enabled && (
              <>
                <div className="dsh-custom-choices">
                  {modelSelect(
                    'fallback',
                    draft.fallback,
                    (choice) =>
                      edit({
                        ...draft,
                        fallback: { ...choice, enabled: true },
                      }),
                    false,
                  )}
                  {reasoningSelect('fallback', draft.fallback, (choice) =>
                    edit({ ...draft, fallback: { ...choice, enabled: true } }),
                  )}
                </div>
                {!draft.fallback.model && (
                  <p className="dsh-error">{t.fallbackChoose}</p>
                )}
              </>
            )}
          </div>
          <details className="dsh-connection-details">
            <summary>
              {t.connectionDetails}
              <ChevronDown size={14} />
            </summary>
            <p>{hostLink ?? t.remoteHelp}</p>
            <p>
              {t.hostModel}: {modelName(config.catalog?.defaults ?? null)}
            </p>
            <dl>
              {(['fast', 'deep'] as Preset[]).map((preset) => (
                <div key={preset}>
                  <dt>{t[preset]}</dt>
                  <dd>
                    {t.connection}:{' '}
                    {effective(draft.presets[preset])?.provider ?? '—'}
                    <br />
                    {t.modelId}:{' '}
                    {effective(draft.presets[preset])?.model ?? '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      </details>
      <footer className="dsh-footer">
        <div
          className={error ? 'dsh-notice error' : 'dsh-save-status'}
          role={error ? 'alert' : 'status'}
        >
          {error ? (
            <CircleAlert size={16} />
          ) : notice === 'saved' ? (
            <Check size={16} />
          ) : null}
          <span>
            {error
              ? dshSettingsError(error.code, t)
              : notice
                ? t[notice]
                : changed
                  ? t.unsaved
                  : t.unchanged}
          </span>
        </div>
        <div className="dsh-footer-actions">
          {changed && (
            <button
              className="dsh-button"
              disabled={!!busy}
              onClick={() => {
                setDraft(upgradeRoutes(config.routing));
                setError(null);
                setNotice(null);
              }}
            >
              {t.discard}
            </button>
          )}
          <button
            className="dsh-button dsh-save"
            disabled={
              !!busy ||
              !changed ||
              !config.connected ||
              !concurrencyValid ||
              !choicesValid ||
              (draft.fallback.enabled && !draft.fallback.model)
            }
            onClick={() => load(true)}
          >
            {busy === 'save' ? t.saving : t.save}
          </button>
        </div>
      </footer>
    </section>
  );
}
