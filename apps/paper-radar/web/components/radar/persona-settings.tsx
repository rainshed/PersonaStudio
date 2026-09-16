'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Check,
  File,
  FolderOpen,
  LoaderCircle,
  Plug,
  RefreshCw,
} from 'lucide-react';
import { analysisApi } from '@/lib/analysis-api';
import { useRequestPolling } from './use-request-polling';
import { useUiLanguage } from './ui-language';
import './persona-settings.css';

type Connection = {
  name: string;
  workspace: string;
  executable: string;
  connection_id: string | null;
};
type Subscription = { id: string; name: string };
type Settings = {
  revision: number;
  configured: boolean;
  path_picker_available: boolean;
  current: Connection | null;
  draft: Connection;
  pending: Connection | null;
  connected: boolean;
  pending_error: string | null;
  affected_subscriptions: Subscription[];
  needs_attention: Subscription[];
};
type ConnectionTest = {
  test_id: string;
  revision: number;
  connection: Connection;
  tag_count: number;
  tags: { id: string; label: string }[];
  different_workspace: boolean;
  affected_subscriptions: Subscription[];
};
const changed = () =>
  window.dispatchEvent(new Event('paper-radar-persona-changed'));

export function PersonaSettingsPage({
  demo = false,
  visible = true,
  onConnected,
}: {
  demo?: boolean;
  visible?: boolean;
  onConnected?: () => void;
}) {
  const { ui, uiLanguage } = useUiLanguage();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Connection | null>(null);
  const [tested, setTested] = useState<ConnectionTest | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const request = useRef<AbortController | null>(null);
  const latestRevision = useRef(-1);
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!visible && busy.startsWith('pick-')) request.current?.abort();
  }, [visible, busy]);
  useRequestPolling({
    identity: String(refresh),
    enabled: visible && !demo,
    intervalMs: 3000,
    run: async (signal) => {
      const next = await analysisApi<Settings>('persona/settings', { signal });
      if (signal.aborted || next.revision < latestRevision.current) return;
      latestRevision.current = next.revision;
      if (settings && settings.revision !== next.revision) {
        setTested(null);
        changed();
        if (settings.pending && !next.pending) {
          setNotice('连接设置已更新。');
          if (next.connected) onConnected?.();
        }
      }
      setSettings(next);
      setDraft((previous) => previous ?? next.draft);
    },
    onError: (cause) =>
      setError(
        cause instanceof Error ? cause.message : '无法读取 Persona 设置。',
      ),
  });
  const update = (patch: Partial<Connection>) => {
    setDraft((previous) => (previous ? { ...previous, ...patch } : previous));
    setTested(null);
    setError('');
    setNotice('');
  };
  async function choosePath(kind: 'workspace' | 'executable') {
    if (!draft || busy || request.current) return;
    setBusy('pick-' + kind);
    setError('');
    setNotice('');
    const controller = new AbortController();
    request.current = controller;
    try {
      const result = await analysisApi<{ path: string | null }>(
        'persona/settings/pick',
        {
          method: 'POST',
          signal: controller.signal,
          timeoutMs: 600000,
          body: {
            kind,
            initial_path: draft[kind] || draft.workspace,
            language: uiLanguage,
          },
        },
      );
      if (
        !controller.signal.aborted &&
        result.path !== null &&
        result.path !== draft[kind]
      )
        update({ [kind]: result.path });
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error
            ? cause.message
            : '无法完成选择，请重试或输入完整路径。',
        );
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy('');
      }
    }
  }
  async function perform(action: 'test' | 'save' | 'cancel') {
    if (!settings || !draft || busy || request.current) return;
    setBusy(action);
    setError('');
    setNotice('');
    const controller = new AbortController();
    request.current = controller;
    try {
      if (action === 'test') {
        const result = await analysisApi<ConnectionTest>(
          'persona/settings/test',
          {
            method: 'POST',
            signal: controller.signal,
            body: {
              name: draft.name,
              workspace: draft.workspace,
              executable: draft.executable,
              expected_revision: settings.revision,
            },
          },
        );
        if (result.revision < latestRevision.current)
          throw new Error('连接设置已改变，请刷新后重新测试。');
        setTested(result);
        setDraft(result.connection);
      } else {
        const next = await analysisApi<Settings>(
          action === 'save' ? 'persona/settings' : 'persona/settings/pending',
          {
            method: action === 'save' ? 'PUT' : 'DELETE',
            signal: controller.signal,
            body: {
              expected_revision: settings.revision,
              ...(action === 'save' ? { test_id: tested?.test_id } : {}),
            },
          },
        );
        latestRevision.current = next.revision;
        setSettings(next);
        setDraft(next.draft);
        setTested(null);
        changed();
        if (action === 'save' && next.connected && !next.pending)
          onConnected?.();
        setNotice(
          action === 'cancel'
            ? '已取消待生效的连接修改。'
            : next.pending
              ? '设置已保存，等待当前任务完成后生效。'
              : '连接已保存并生效。',
        );
      }
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : '连接操作未完成，请重试。',
        );
      setTested(null);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setBusy('');
      }
    }
  }
  if (demo)
    return (
      <section className="research-section persona-settings">
        <h2>{ui('连接 AI Persona')}</h2>
        <p>
          {ui(
            '本机连接在运行 Paper Radar 的电脑上配置。演示页面不读取本机知识库。',
          )}
        </p>
      </section>
    );
  return (
    <section className="research-section persona-settings">
      <div className="persona-settings-heading">
        <div>
          <h2>{ui('连接 AI Persona')}</h2>
          <p>{ui('连接你的本机知识库，为论文推荐提供个人知识背景。')}</p>
        </div>
        <span
          className={`persona-connection-state ${settings?.connected ? 'connected' : ''}`}
        >
          <Plug size={14} />
          {ui(
            settings?.connected
              ? '已连接'
              : settings?.configured
                ? '已配置'
                : '尚未配置',
          )}
        </span>
      </div>
      {settings?.current && (
        <div className="persona-current">
          <FolderOpen size={18} aria-hidden="true" />
          <div>
            <small>{ui('当前知识库')}</small>
            <strong>{settings.current.name}</strong>
            <span>{settings.current.workspace}</span>
          </div>
        </div>
      )}
      {settings?.pending && (
        <div className="persona-message pending">
          <strong>{ui('等待切换到：{0}', [settings.pending.name])}</strong>
          <p>
            {ui('排队和运行中的任务完成后自动生效，期间继续使用当前连接。')}
          </p>
          <button
            type="button"
            className="button-secondary"
            disabled={!!busy}
            onClick={() => void perform('cancel')}
          >
            {ui('取消这次修改')}
          </button>
        </div>
      )}
      {settings?.needs_attention.length ? (
        <div className="persona-message pending">
          <strong>{ui('以下订阅需要重新选择知识标签')}</strong>
          <p>
            {ui('相关订阅和自动推荐已暂停。选择新标签并重新启用后即可继续。')}
          </p>
          <ul>
            {settings.needs_attention.map((s) => (
              <li key={s.id}>
                <a
                  href={`#subscriptions?subscription=${encodeURIComponent(s.id)}`}
                >
                  {s.name}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error || settings?.pending_error ? (
        <p role="alert" className="persona-message error">
          {ui(error || settings?.pending_error || '')}
        </p>
      ) : null}
      {notice && (
        <p aria-live="polite" className="persona-message">
          {ui(notice)}
        </p>
      )}
      {!draft ? (
        <div className="persona-actions">
          <span>{ui('正在读取连接设置…')}</span>
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setError('');
              setRefresh((value) => value + 1);
            }}
          >
            <RefreshCw size={14} />
            {ui('重新读取')}
          </button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void perform(tested ? 'save' : 'test');
          }}
        >
          <fieldset disabled={!!busy} className="persona-fields">
            <label htmlFor="persona-connection-name">
              {ui('连接名称')}
              <input
                id="persona-connection-name"
                required
                maxLength={100}
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                autoComplete="off"
              />
            </label>
            <div className="persona-path-field">
              <label htmlFor="persona-workspace">{ui('知识库位置')}</label>
              <div className="persona-path-control">
                <input
                  id="persona-workspace"
                  required
                  value={draft.workspace}
                  onChange={(event) =>
                    update({ workspace: event.target.value })
                  }
                  placeholder={ui('选择文件夹或输入完整路径')}
                  spellCheck={false}
                  autoComplete="off"
                  aria-describedby="persona-workspace-hint"
                />
                <button
                  type="button"
                  className="button-secondary"
                  disabled={!settings?.path_picker_available}
                  onClick={() => void choosePath('workspace')}
                >
                  <FolderOpen size={15} aria-hidden="true" />
                  {ui('选择文件夹')}
                </button>
              </div>
              <p id="persona-workspace-hint" className="persona-field-hint">
                {ui(
                  '选择包含 persona-data 和 persona-state 的 AI Persona 文件夹，也可以输入完整路径。',
                )}
              </p>
            </div>
            <details className="persona-advanced">
              <summary>
                {uiLanguage === 'zh'
                  ? '高级连接设置'
                  : 'Advanced connection settings'}
              </summary>
              <div className="persona-path-field">
                <label htmlFor="persona-executable">
                  {ui('AI Persona 程序位置')}
                </label>
                <div className="persona-path-control">
                  <input
                    id="persona-executable"
                    value={draft.executable}
                    onChange={(event) =>
                      update({ executable: event.target.value })
                    }
                    placeholder={ui('留空以自动查找')}
                    spellCheck={false}
                    autoComplete="off"
                    aria-describedby="persona-executable-hint"
                  />
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={!settings?.path_picker_available}
                    onClick={() => void choosePath('executable')}
                  >
                    <File size={15} aria-hidden="true" />
                    {ui('选择程序')}
                  </button>
                </div>
                <p id="persona-executable-hint" className="persona-field-hint">
                  {ui(
                    '选择 ai-persona-mcp 文件（通常在 .venv/bin 内），也可以输入完整路径；留空时自动查找。',
                  )}
                </p>
              </div>
            </details>
            <p className="persona-field-hint">
              {ui(
                settings?.path_picker_available
                  ? '选择窗口会在运行 Paper Radar 的电脑上打开。'
                  : '此系统暂不支持选择窗口，请输入完整路径。',
              )}
            </p>
          </fieldset>
          {busy.startsWith('pick-') && (
            <div className="persona-message persona-actions" aria-live="polite">
              <span>{ui('请在弹出的系统窗口中选择。')}</span>
              <button
                type="button"
                className="button-secondary"
                onClick={() => request.current?.abort()}
              >
                {ui('取消选择')}
              </button>
            </div>
          )}
          {tested && (
            <div className="persona-message success" aria-live="polite">
              <strong>
                <Check size={16} />
                {ui('测试连接成功')}
              </strong>
              <p>
                {ui(
                  tested.tag_count
                    ? '已读取 {0} 个可用标签。'
                    : '连接成功，知识库尚无可用标签。',
                  [tested.tag_count],
                )}
              </p>
              {!!tested.tags.length && (
                <div className="persona-tag-preview">
                  {tested.tags.map((tag) => (
                    <span key={tag.id}>{tag.label}</span>
                  ))}
                </div>
              )}
              {tested.different_workspace && (
                <p>
                  {ui(
                    '这是另一个知识库。生效后，原知识库的相关订阅将暂停并需要重新选择标签。',
                  )}
                </p>
              )}
              {!!tested.affected_subscriptions.length && (
                <p>
                  {ui('受影响的订阅：{0}', [
                    tested.affected_subscriptions.map((s) => s.name).join('、'),
                  ])}
                </p>
              )}
            </div>
          )}
          <div className="persona-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={!!busy || !draft.name.trim() || !draft.workspace.trim()}
              onClick={() => void perform('test')}
            >
              {busy === 'test' ? (
                <LoaderCircle size={15} className="persona-spinner" />
              ) : (
                <Plug size={15} />
              )}
              {ui(busy === 'test' ? '正在测试连接…' : '测试连接')}
            </button>
            <button
              type="submit"
              className="button-primary"
              disabled={!!busy || !tested}
            >
              {busy === 'save' && (
                <LoaderCircle size={15} className="persona-spinner" />
              )}
              {ui(busy === 'save' ? '正在保存…' : '保存并连接')}
            </button>
            <button
              type="button"
              className="persona-reset"
              disabled={!!busy}
              onClick={() => {
                setDraft(settings?.draft ?? null);
                setTested(null);
                setError('');
                setNotice('');
                setRefresh((value) => value + 1);
              }}
            >
              {ui('放弃修改')}
            </button>
          </div>
          <p className="persona-field-hint persona-footer">
            {ui('测试成功后即可保存。用于推荐的标签仍在订阅或单篇分析中选择。')}
          </p>
        </form>
      )}
    </section>
  );
}
