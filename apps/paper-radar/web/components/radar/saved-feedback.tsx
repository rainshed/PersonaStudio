'use client';
import { useEffect, useRef, useState } from 'react';
import { useUiLanguage } from './ui-language';
import { FeedbackControl } from './feedback';
import { analysisApi } from '@/lib/analysis-api';
import type { Feedback, FeedbackDimension } from '@/lib/radar';

export function SavedFeedback({
  path,
  dimension,
  value,
  notRecommended = false,
  decision,
  language = 'zh',
}: {
  path: string;
  dimension: FeedbackDimension;
  value?: Feedback;
  notRecommended?: boolean;
  decision?: string;
  language?: 'zh' | 'en';
}) {
  const { ui } = useUiLanguage();
  const [draft, setDraft] = useState(value),
    [pending, setPending] = useState(0),
    [saved, setSaved] = useState(!!value),
    [error, setError] = useState('');
  const queue = useRef(Promise.resolve()),
    counter = useRef(0),
    writes = useRef(0);
  useEffect(() => {
    if (!writes.current) {
      setDraft(value);
      setSaved(!!value);
    }
  }, [value]);
  useEffect(() => {
    const controller = new AbortController();
    analysisApi<{ feedback: Partial<Record<FeedbackDimension, Feedback>> }>(
      path,
      { signal: controller.signal },
    )
      .then((result) => {
        if (!controller.signal.aborted && !counter.current) {
          setDraft(result.feedback.accuracy);
          setSaved(!!result.feedback.accuracy);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [path]);
  function save(next: Feedback | null) {
    setDraft(next ?? undefined);
    setError('');
    setSaved(false);
    writes.current++;
    setPending(writes.current);
    const seq = ++counter.current;
    queue.current = queue.current.then(async () => {
      try {
        const response = await analysisApi<
          Partial<Record<FeedbackDimension, Feedback>>
        >(path + '/feedback/' + dimension, {
          method: next ? 'PUT' : 'DELETE',
          ...(next ? { body: { value: next.value, reason: next.reason } } : {}),
        });
        if (seq === counter.current) {
          setDraft(response.accuracy);
          setSaved(!!response.accuracy);
        }
      } catch (e) {
        if (seq === counter.current)
          setError(e instanceof Error ? e.message : '反馈未保存。');
      } finally {
        writes.current--;
        setPending(writes.current);
      }
    });
  }
  return (
    <div>
      <FeedbackControl
        dimension={dimension}
        value={draft}
        onChange={save}
        compact
        language={language}
        notRecommended={notRecommended}
        decision={decision}
      />
      {saved && pending === 0 && !error && (
        <output className="feedback-saved">
          {ui('已加入测试集')} · <a href="#evaluations">{ui('查看测试集')}</a>
        </output>
      )}
      {!draft && !pending && !error && (
        <p className="feedback-hint">
          {ui('你的选择会自动成为这篇论文的测试答案。')}
        </p>
      )}
      {pending > 0 && <output>{ui('正在保存反馈…')}</output>}
      {error && (
        <p className="daily-notice" role="alert">
          {ui('反馈未保存：')}
          {ui(error)}
          <button onClick={() => save(draft ?? null)}>{ui('重试')}</button>
        </p>
      )}
    </div>
  );
}
