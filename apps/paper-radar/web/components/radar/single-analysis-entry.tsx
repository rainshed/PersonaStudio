'use client';
import { useUiLanguage } from '@/components/radar/ui-language';
import { useEffect, useState } from 'react';
import { SingleAnalysisPage as Demo } from './single-analysis';
import { RealSingleAnalysis } from './single-analysis-real';
import type { Subscription } from '@/lib/radar';
import { isStandaloneDemo, readBackendResponse } from '@/lib/backend-response';

export function SingleAnalysisPage(props: {
  subscriptions: Subscription[];
  onModels: () => void;
}) {
  const { ui } = useUiLanguage();
  const [mode, setMode] = useState<'loading' | 'live' | 'demo' | 'error'>(
    'loading',
  );
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const r = await fetch('/api/capabilities', {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(8000),
          ]),
          cache: 'no-store',
        });
        if (r.status === 404 && isStandaloneDemo(location)) {
          setMode('demo');
          return;
        }
        const data = await readBackendResponse<{
          mode?: string;
          single_analysis?: boolean;
        }>(r);
        if (data.mode !== 'local' || !data.single_analysis)
          throw new Error('当前入口未提供单篇分析服务，请检查转发地址。');
        setMode('live');
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : '后台暂时无法连接。');
          setMode('error');
        }
      }
    })();
    return () => controller.abort();
  }, [retry]);
  if (mode === 'live') return <RealSingleAnalysis {...props} />;
  if (mode === 'demo') return <Demo {...props} />;
  return (
    <div className="single-workspace">
      <div className="page-heading">
        <h1>{ui('单篇论文分析')}</h1>
      </div>
      <section className="single-form-card">
        <h2>
          {ui(mode === 'loading' ? '正在连接分析服务' : '分析服务未连接')}
        </h2>
        {mode === 'error' && (
          <>
            <p className="single-body-text">
              {ui(error)}{' '}
              {ui(' 已有记录保留在电脑上，连接恢复后即可继续查看。')}
            </p>
            <a
              className="button-primary"
              href="http://127.0.0.1:4317/#single-analysis"
            >
              {ui('在运行服务的电脑上打开')}
            </a>
            <button
              className="button-secondary"
              onClick={() => {
                setMode('loading');
                setRetry((v) => v + 1);
              }}
            >
              {ui('重新连接')}
            </button>
          </>
        )}
      </section>
    </div>
  );
}
