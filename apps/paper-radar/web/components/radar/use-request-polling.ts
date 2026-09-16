'use client';

import { useEffect, useEffectEvent } from 'react';
import { startRequestPolling, type PollResult } from '@/lib/request-polling';

/** Identity changes abort the previous request and reset its retry schedule.
 * The event callback reads current render data without restarting on every poll. */
export function useRequestPolling({
  identity,
  enabled = true,
  intervalMs = 2500,
  initialDelayMs = 0,
  run,
  onError,
}: {
  identity: string;
  enabled?: boolean;
  intervalMs?: number;
  initialDelayMs?: number;
  run: (signal: AbortSignal) => Promise<PollResult>;
  onError?: (error: unknown) => void;
}) {
  const execute = useEffectEvent(run);
  const reportError = useEffectEvent((error: unknown) => onError?.(error));
  useEffect(() => {
    if (!enabled) return;
    const polling = startRequestPolling({
      run: execute,
      onError: reportError,
      intervalMs,
      initialDelayMs,
    });
    const wake = () => {
      if (document.visibilityState === 'visible') polling.wake();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      polling.stop();
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }, [identity, enabled, intervalMs, initialDelayMs]);
}
