'use client';
import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { readBackendResponse } from '@/lib/backend-response';
import {
  HostModelSettings,
  type HostRouterConfig,
} from './host-model-settings';
import { useUiLanguage } from './ui-language';
import './host-model-settings.css';

export function ModelSettingsPage() {
  const { uiLanguage, ui } = useUiLanguage();
  const zh = uiLanguage === 'zh';
  const [config, setConfig] = useState<HostRouterConfig | null>(null);
  const [state, setState] = useState<'loading' | 'offline' | 'error'>(
    'loading',
  );
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/models/config', {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        });
        if (controller.signal.aborted) return;
        if (response.status === 404) {
          setState('offline');
          return;
        }
        const value = await readBackendResponse<HostRouterConfig>(response);
        if (
          value.mode !== 'host-router' ||
          !value.backends?.codex ||
          !value.backends?.dsh
        )
          throw new Error('请更新并重新启动本机 Paper Radar 服务。');
        if (!controller.signal.aborted) setConfig(value);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setState('error');
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    })();
    return () => controller.abort();
  }, [revision]);
  if (config) return <HostModelSettings initial={config} />;
  return (
    <section className="host-settings" aria-busy={state === 'loading'}>
      <div className="host-settings-header">
        <div>
          <p className="eyebrow">ANALYSIS HOST</p>
          <h1>{zh ? '分析宿主' : 'Analysis host'}</h1>
          <p>
            {zh
              ? '通过 Codex 或 DSH 执行论文分析和日报。模型与认证由所选宿主管理。'
              : 'Use Codex or DSH for paper analysis and daily recommendations. Your chosen host manages models and authentication.'}
          </p>
        </div>
        {state !== 'loading' && (
          <button
            className="host-refresh"
            onClick={() => {
              setState('loading');
              setError('');
              setRevision((value) => value + 1);
            }}
          >
            <RefreshCw size={15} />
            {zh ? '重新连接' : 'Reconnect'}
          </button>
        )}
      </div>
      {state === 'loading' ? (
        <output>
          {zh ? '正在连接本机服务…' : 'Connecting to the local service…'}
        </output>
      ) : state === 'offline' ? (
        <p>
          {zh
            ? '在线演示不连接分析宿主。请打开本机 Paper Radar，再选择 Codex 或 DSH。'
            : 'The online demo does not connect to analysis hosts. Open local Paper Radar to choose Codex or DSH.'}
        </p>
      ) : (
        <div className="host-error" role="alert">
          <p>
            {zh
              ? '无法连接本机服务，请确认 Paper Radar 已启动。'
              : 'Cannot connect to the local service. Check that Paper Radar is running.'}
          </p>
          <p>{ui(error)}</p>
        </div>
      )}
    </section>
  );
}
