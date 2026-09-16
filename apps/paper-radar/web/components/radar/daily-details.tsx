'use client';
import { useState } from 'react';
import { useRequestPolling } from './use-request-polling';
import { analysisApi, type RealResult } from '@/lib/analysis-api';
import type { DailyItem } from '@/lib/daily-api';
import { useUiLanguage } from './ui-language';
import { PaperWorkspace, type PaperSection } from './paper-workspace';
export { SavedFeedback } from './saved-feedback';

export function DailyDetails({
  itemId,
  onClose,
  onAnalyze,
  onRescreen,
  onSingle,
  analyzing = false,
  refreshToken = 0,
  actionError = '',
  section,
  onSection,
  expanded,
  onExpand,
}: {
  itemId: string | null;
  onClose: () => void;
  onAnalyze: (id: string, force?: boolean) => void;
  onRescreen?: (id: string) => void;
  onSingle: (jobId: string) => void;
  analyzing?: boolean;
  refreshToken?: number;
  actionError?: string;
  section?: PaperSection;
  onSection?: (section: PaperSection) => void;
  expanded?: boolean;
  onExpand?: () => void;
}) {
  const { ui } = useUiLanguage();
  const [item, setItem] = useState<DailyItem | null>(null);
  const [result, setResult] = useState<RealResult | null>(null);
  const [failure, setFailure] = useState<{
    id: string | null;
    message: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const error = failure?.id === itemId ? failure.message : '';
  useRequestPolling({
    identity: JSON.stringify([itemId, refreshToken, retry]),
    enabled: Boolean(itemId),
    intervalMs: 2500,
    run: async (signal) => {
      const value = await analysisApi<DailyItem>('daily-items/' + itemId, {
        signal,
      });
      const report = value.analysis_id
        ? await analysisApi<RealResult>('analyses/' + value.analysis_id, {
            signal,
          })
        : null;
      if (signal.aborted || value.id !== itemId) return false;
      setItem(value);
      setResult(report);
      setFailure(null);
      return ['pending', 'screening'].includes(value.processing_status) ||
        ['queued', 'running'].includes(value.details_status)
        ? 2500
        : 15000;
    },
    onError: (error) =>
      setFailure({
        id: itemId,
        message: error instanceof Error ? error.message : '无法读取论文详情。',
      }),
  });

  return (
    <section className="daily-inline-reader" aria-label={ui('论文分析')}>
      {error && (
        <p className="daily-notice" role="alert">
          {ui(error)}
          <button onClick={() => setRetry((value) => value + 1)}>
            {ui('重试')}
          </button>
        </p>
      )}
      {item?.id === itemId && item ? (
        <PaperWorkspace
          key={item.id}
          item={item}
          result={result?.id === item.analysis_id ? result : null}
          onClose={onClose}
          onAnalyze={onAnalyze}
          onRescreen={onRescreen}
          onSingle={onSingle}
          analyzing={analyzing}
          actionError={actionError}
          section={section}
          onSection={onSection}
          expanded={expanded}
          onExpand={onExpand}
        />
      ) : (
        <div className="research-empty">
          {!error && <output>{ui('正在读取论文…')}</output>}
          <button className="button-secondary" onClick={onClose}>
            {ui('返回列表')}
          </button>
        </div>
      )}
    </section>
  );
}
