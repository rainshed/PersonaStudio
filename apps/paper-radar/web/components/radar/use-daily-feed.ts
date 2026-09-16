'use client';
import { useState } from 'react';
import { analysisApi } from '@/lib/analysis-api';
import type { DailyItem, DailyReport, DailyRun } from '@/lib/daily-api';
import type { RadarView } from '@/lib/radar-location';
import { matchesDailyDate } from '@/lib/daily-source';
import { activeRun as active } from '@/lib/daily-ui';
import { useRequestPolling } from './use-request-polling';
import { useRadarLocation } from './use-radar-location';

export function useDailyFeed({
  ready,
  selectedSub,
  selectedRun,
  view,
  tick,
  filter,
  query,
  offset,
  historyOffset,
  date,
  requestKey,
  updateLocation,
  onResolvedRun,
}: {
  ready: boolean;
  selectedSub: string;
  selectedRun: string | null;
  view: RadarView;
  tick: number;
  filter: string;
  query: string;
  offset: number;
  historyOffset: number;
  date: string;
  requestKey: string;
  updateLocation: ReturnType<typeof useRadarLocation>['update'];
  onResolvedRun: (target: string, resolved: string) => void;
}) {
  const [run, setRun] = useState<DailyRun | null>(null);
  const [runs, setRuns] = useState<DailyRun[]>([]);
  const [items, setItems] = useState<DailyItem[]>([]);
  const [reports, setReports] = useState<DailyReport[]>([]);
  const [reportDates, setReportDates] = useState<string[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [historyMore, setHistoryMore] = useState(false);
  const [loadedKey, setLoadedKey] = useState('');
  const [error, setError] = useState('');
  useRequestPolling({
    identity: JSON.stringify([requestKey, tick, historyOffset, view]),
    enabled:
      ready &&
      Boolean(selectedSub) &&
      ['daily', 'subscriptions'].includes(view),
    intervalMs: 2500,
    run: async (signal) => {
      let running = false;
      try {
        const [history, reportList] = await Promise.all([
          analysisApi<{ runs: DailyRun[]; next_offset: number | null }>(
            `daily-runs?subscription_id=${encodeURIComponent(selectedSub)}&limit=25&offset=${historyOffset}`,
            { signal },
          ),
          analysisApi<{
            reports: DailyReport[];
            dates: string[];
            available_dates: string[];
          }>(
            'daily-reports?subscription_id=' +
              encodeURIComponent(selectedSub) +
              (date ? '&date=' + date : ''),
            { signal },
          ),
        ]);
        if (signal.aborted) return;
        running = history.runs.some(
          (r) => active(r.status) || r.stats.details_active > 0,
        );
        setRuns(history.runs);
        setHistoryMore(history.next_offset !== null);
        setReports(reportList.reports);
        setReportDates(reportList.dates);
        setAvailableDates(reportList.available_dates ?? []);
        const target =
          selectedRun ??
          (date
            ? (reportList.reports.find((r) => r.date === date)
                ?.current_run_id ??
              history.runs.find((r) => matchesDailyDate(r, date))?.id)
            : history.runs[0]?.id);
        if (!target) {
          setRun(null);
          setItems([]);
          setTotal(0);
          setNextOffset(null);
          setError('');
          setLoadedKey(requestKey);
          return 15000;
        }
        let current: DailyRun;
        try {
          current = await analysisApi<DailyRun>('daily-runs/' + target, {
            signal,
          });
        } catch (e) {
          if (
            !signal.aborted &&
            e instanceof Error &&
            e.message === '记录不存在。'
          ) {
            updateLocation({ run: null });
            setRun(null);
            setItems([]);
            setLoadedKey(requestKey);
            return;
          }
          throw e;
        }
        if (signal.aborted) return;
        if (current.subscription.id !== selectedSub) {
          updateLocation({ run: null });
          return;
        }
        onResolvedRun(target, current.id);
        if (
          current.id !== selectedRun ||
          (date && current.date && current.date !== date)
        ) {
          updateLocation({
            run: current.id,
            ...(date && current.date ? { date: current.date } : {}),
          });
          return;
        }
        const rows = await analysisApi<{
          items: DailyItem[];
          total: number;
          next_offset: number | null;
        }>(
          `daily-runs/${current.id}/items?decision=${filter}&limit=25&offset=${offset}&query=${encodeURIComponent(query)}`,
          { signal },
        );
        if (signal.aborted) return;
        setRun(current);
        setItems(rows.items);
        setTotal(rows.total);
        setNextOffset(rows.next_offset);
        setError('');
        setLoadedKey(requestKey);
        running ||= active(current.status) || current.stats.details_active > 0;
      } catch (e) {
        if (!signal.aborted) {
          setError(e instanceof Error ? e.message : '无法更新日报。');
          setLoadedKey(requestKey);
        }
        throw e;
      }
      return running ? 2500 : 15000;
    },
  });
  return {
    run,
    setRun,
    runs,
    items,
    setItems,
    reports,
    reportDates,
    availableDates,
    total,
    nextOffset,
    historyMore,
    error,
    loading: !ready || loadedKey !== requestKey,
  };
}
