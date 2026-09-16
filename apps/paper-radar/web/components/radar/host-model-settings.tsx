'use client';
import { useEffect, useState } from 'react';
import { Check, ExternalLink, LogIn, LogOut, RefreshCw } from 'lucide-react';
import { readBackendResponse } from '@/lib/backend-response';
import { useUiLanguage } from './ui-language';
import {
  HostRoutingSettings,
  type HostConfig,
} from './host-routing-settings';
import './host-model-settings.css';

type CodexConfig = HostConfig & {
  account?: { type: string; email?: string | null; planType?: string } | null;
  isolation?: {
    ok: boolean;
    hooks_enabled: number;
    persona_mcp_callable: boolean;
  } | null;
};

export type HostRouterConfig = {
  mode: 'host-router';
  activeBackend: 'dsh' | 'codex';
  revision: number;
  backends: { dsh: HostConfig; codex: CodexConfig };
};

async function request<T>(path: string, input?: unknown) {
  const response = await fetch(path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      Accept: 'application/json',
      ...(input === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'X-Paper-Radar': '1' }),
    },
    body: input === undefined ? undefined : JSON.stringify(input),
    signal: AbortSignal.timeout(30000),
    cache: 'no-store',
  });
  return readBackendResponse<T>(response);
}

export function HostModelSettings({ initial }: { initial: HostRouterConfig }) {
  const { uiLanguage, ui } = useUiLanguage();
  const zh = uiLanguage === 'zh';
  const [config, setConfig] = useState(initial);
  const [view, setView] = useState<'dsh' | 'codex'>(initial.activeBackend);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const codex = config.backends.codex;

  async function refresh() {
    const value = await request<HostRouterConfig>('/api/models/config');
    setConfig(value);
    if (value.backends.codex.connected) setLoginUrl('');
    return value;
  }

  useEffect(() => {
    if (!loginUrl || codex.connected) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {});
    }, 2000);
    return () => clearInterval(timer);
  }, [loginUrl, codex.connected]);

  async function action(name: string, work: () => Promise<void>) {
    setBusy(name);
    setError('');
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : '操作未完成。',
      );
    } finally {
      setBusy('');
    }
  }

  async function activate(backend: 'dsh' | 'codex') {
    await action('activate', async () => {
      const value = await request<HostRouterConfig>('/api/models/backend', {
        backend,
        revision: config.revision,
      });
      setConfig(value);
      setView(backend);
    });
  }

  async function login() {
    await action('login', async () => {
      const value = await request<{ authUrl: string }>(
        '/api/models/backends/codex/login',
        {},
      );
      setLoginUrl(value.authUrl);
      window.open(value.authUrl, '_blank', 'noopener,noreferrer');
    });
  }

  async function logout() {
    await action('logout', async () => {
      await request('/api/models/backends/codex/logout', {});
      await refresh();
    });
  }

  const selected = config.backends[view];
  return (
    <div className="host-settings">
      <section className="host-settings-header" aria-labelledby="host-title">
        <div>
          <p className="eyebrow">ANALYSIS HOST</p>
          <h1 id="host-title">{zh ? '分析宿主' : 'Analysis host'}</h1>
          <p>
            {zh
              ? '选择新任务由 DSH 还是隔离的 Codex 执行。已开始的任务不会迁移。'
              : 'Choose DSH or isolated Codex for new tasks. Running tasks do not move.'}
          </p>
        </div>
        <button
          className="host-refresh"
          disabled={!!busy}
          onClick={() => action('refresh', async () => void (await refresh()))}
        >
          <RefreshCw size={15} className={busy === 'refresh' ? 'spin' : ''} />
          {zh ? '刷新状态' : 'Refresh'}
        </button>
      </section>

      <div
        className="host-picker"
        role="tablist"
        aria-label={zh ? '分析宿主' : 'Analysis host'}
      >
        {(['dsh', 'codex'] as const).map((backend) => {
          const item = config.backends[backend];
          const active = config.activeBackend === backend;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={view === backend}
              className={view === backend ? 'selected' : ''}
              key={backend}
              onClick={() => setView(backend)}
            >
              <span>
                <strong>
                  {backend === 'dsh' ? 'DSH' : 'Codex'}
                </strong>
                <small>
                  {item.connected
                    ? zh
                      ? '可用'
                      : 'Available'
                    : zh
                      ? '未连接'
                      : 'Disconnected'}
                </small>
              </span>
              {active && (
                <em>
                  <Check size={13} /> {zh ? '当前默认' : 'Current default'}
                </em>
              )}
            </button>
          );
        })}
      </div>

      <section className="host-actions">
        <div>
          <strong>{view === 'dsh' ? 'DSH' : 'Codex'}</strong>
          <span>
            {view === 'codex'
              ? zh
                ? '专属运行空间 · Hook 关闭 · AI Persona MCP 不可调用'
                : 'Dedicated runtime · hooks off · AI Persona MCP unavailable'
              : zh
                ? '保留现有 DSH 插件、账号和模型配置'
                : 'Keep the existing DSH plugin, accounts, and model setup'}
          </span>
        </div>
        {view === 'codex' &&
          !codex.account &&
          codex.error?.code === 'codex_auth_required' && (
            <button disabled={!!busy} onClick={login}>
              <LogIn size={15} /> {zh ? '登录 Codex' : 'Sign in to Codex'}
            </button>
          )}
        {view === 'codex' && codex.account && (
          <button disabled={!!busy} onClick={logout}>
            <LogOut size={15} /> {zh ? '退出专用账号' : 'Sign out'}
          </button>
        )}
        {config.activeBackend !== view && (
          <button
            className="host-activate"
            disabled={!!busy || !selected.connected}
            onClick={() => activate(view)}
          >
            {zh ? '用于后续新任务' : 'Use for new tasks'}
          </button>
        )}
      </section>

      {view === 'codex' && codex.account && (
        <output className="host-isolation">
          <span>
            {codex.account.email ??
              (zh ? 'Codex 账号已登录' : 'Codex account signed in')}
          </span>
          <span>
            {codex.isolation?.ok
              ? zh
                ? '隔离检查通过'
                : 'Isolation checks passed'
              : zh
                ? '隔离检查未通过'
                : 'Isolation checks failed'}
          </span>
        </output>
      )}
      {loginUrl && !codex.connected && (
        <a
          className="host-login-link"
          href={loginUrl}
          target="_blank"
          rel="noreferrer"
        >
          <ExternalLink size={14} />
          {zh ? '继续在浏览器完成 Codex 登录' : 'Continue Codex sign-in'}
        </a>
      )}
      {view === 'codex' &&
        codex.error &&
        codex.error.code !== 'codex_auth_required' && (
          <div className="host-error" role="alert">
            {ui(codex.error.message)}
          </div>
        )}
      {error && (
        <div className="host-error" role="alert">
          {ui(error)}
        </div>
      )}

      <HostRoutingSettings
        key={`${view}:${selected.connected}:${selected.error?.code ?? ''}:${selected.routing.revision}`}
        initial={selected}
        host={view}
        endpointBase={`/api/models/backends/${view}`}
      />
    </div>
  );
}
