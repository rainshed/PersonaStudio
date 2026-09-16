'use client';
import { useEffect, useState } from 'react';
import { LiveRadarApp } from '@/components/radar/daily-real';
import { DemoHome } from '@/components/radar/demo-home';
import { FirstUse } from '@/components/radar/first-use';
import {
  LanguageSwitcher,
  useUiLanguage,
} from '@/components/radar/ui-language';
import { isStandaloneDemo, readBackendResponse } from '@/lib/backend-response';

export default function Home() {
  const { ui } = useUiLanguage();
  const [mode, setMode] = useState<'loading' | 'live' | 'demo' | 'error'>(
    'loading',
  );
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState(''),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/capabilities', {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10000),
          ]),
        });
        if (response.status === 404 && isStandaloneDemo(location)) {
          setMode('demo');
          return;
        }
        const data = await readBackendResponse<{
          mode: string;
          daily_recommendation?: boolean;
        }>(response);
        if (data.mode !== 'local' || !data.daily_recommendation)
          throw new Error(
            '当前入口未提供真实日报服务，请确认后端已更新并转发完整页面和 API。',
          );
        const setupResponse = await fetch('/api/onboarding', {
          signal: controller.signal,
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        const setup = await readBackendResponse<{ needs_setup: boolean }>(
          setupResponse,
        );
        setNeedsSetup(setup.needs_setup);
        setMode('live');
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : '无法连接后台。');
          setMode('error');
        }
      }
    })();
    return () => controller.abort();
  }, [retry]);
  if (mode === 'live')
    return needsSetup ? (
      <FirstUse onFinished={() => setNeedsSetup(false)} />
    ) : (
      <LiveRadarApp />
    );
  if (mode === 'demo') return <DemoHome />;
  return (
    <div
      className="single-workspace"
      style={{ maxWidth: 760, margin: '8vh auto', padding: '2rem' }}
    >
      <div className="page-heading">
        <h1>Paper Radar</h1>
        <LanguageSwitcher />
      </div>
      <section className="single-form-card">
        <h2>
          {ui(mode === 'loading' ? '正在连接研究工作台' : '研究服务未连接')}
        </h2>
        {mode === 'error' && (
          <>
            <p className="single-body-text">
              {ui(error)}{' '}
              {ui(' 已有订阅和分析保存在电脑上，连接恢复后即可查看。')}
            </p>
            <button
              className="button-primary"
              onClick={() => {
                setMode('loading');
                setRetry((v) => v + 1);
              }}
            >
              {ui('刷新连接')}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
