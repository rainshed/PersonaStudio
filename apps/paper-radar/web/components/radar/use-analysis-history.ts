'use client';

import { useState } from 'react';
import { analysisApi, type RealJob, type RealResult } from '@/lib/analysis-api';
import { useRequestPolling } from './use-request-polling';

export function useAnalysisHistory({
  ready,
  selectedId,
  offset,
  refresh,
  onSelect,
}: {
  ready: boolean;
  selectedId: string | null;
  offset: number;
  refresh: number;
  onSelect: (id: string) => void;
}) {
  const [jobs, setJobs] = useState<RealJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<RealJob | null>(null);
  const [result, setResult] = useState<RealResult | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [failure, setFailure] = useState<{
    id: string | null;
    message: string;
  } | null>(null);
  const networkError = failure?.id === selectedId ? failure.message : '';
  useRequestPolling({
    identity: JSON.stringify([selectedId, offset, refresh]),
    enabled: ready,
    intervalMs: 2000,
    run: async (signal) => {
      const page = await analysisApi<{
        jobs: RealJob[];
        next_offset: number | null;
      }>(`jobs?limit=25&offset=${offset}`, { signal });
      if (signal.aborted) return false;
      setJobs(page.jobs);
      setHasMore(page.next_offset !== null);
      if (!selectedId && page.jobs.length) {
        onSelect(page.jobs[0].id);
        return false;
      }
      const job = selectedId
        ? (page.jobs.find((entry) => entry.id === selectedId) ??
          (await analysisApi<RealJob>('jobs/' + selectedId, { signal })))
        : null;
      const output = job?.result_id
        ? await analysisApi<RealResult>('analyses/' + job.result_id, { signal })
        : null;
      // Publish both together: a new task can never display the preceding report.
      if (signal.aborted) return false;
      setSelectedJob(job);
      setResult(output);
      setFailure(null);
      return page.jobs.some((entry) =>
        ['queued', 'running'].includes(entry.status),
      ) ||
        (job && ['queued', 'running'].includes(job.status))
        ? 2000
        : 15000;
    },
    onError: (error) =>
      setFailure({
        id: selectedId,
        message: error instanceof Error ? error.message : '无法更新进度。',
      }),
  });
  const currentJob = selectedJob?.id === selectedId ? selectedJob : null;
  return {
    jobs,
    selectedJob: currentJob,
    setSelectedJob,
    result: currentJob?.result_id === result?.id ? result : null,
    setResult,
    hasMore,
    networkError,
    loading: Boolean(selectedId) && !currentJob && !networkError,
  };
}
