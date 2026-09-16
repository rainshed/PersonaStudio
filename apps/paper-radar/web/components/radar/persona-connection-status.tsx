'use client';

import { useEffect, useState } from 'react';
import { CircleCheck, CircleHelp, LoaderCircle, Unplug } from 'lucide-react';
import { analysisApi } from '@/lib/analysis-api';
import { useRequestPolling } from './use-request-polling';
import { useUiLanguage } from './ui-language';
import './persona-connection-status.css';

type ConnectionState =
  | 'checking'
  | 'connected'
  | 'disconnected'
  | 'unavailable';

export function PersonaConnectionNotice({
  state,
  onSettings,
  onRetry,
}: {
  state: ConnectionState;
  onSettings: () => void;
  onRetry?: () => void;
}) {
  const { ui } = useUiLanguage();
  const Icon =
    state === 'checking'
      ? LoaderCircle
      : state === 'connected'
        ? CircleCheck
        : state === 'disconnected'
          ? Unplug
          : CircleHelp;
  return (
    <section
      className={`persona-home-status ${state}`}
      aria-label={ui('AI Persona 连接状态')}
    >
      <output className="persona-home-message">
        <Icon
          size={18}
          aria-hidden="true"
          className={state === 'checking' ? 'single-spin' : undefined}
        />
        <span>
          <strong>
            AI Persona ·{' '}
            {ui(
              {
                checking: '正在检查连接…',
                connected: '已连接',
                disconnected: '未连接',
                unavailable: '连接状态暂不可用',
              }[state],
            )}
          </strong>
          {state === 'disconnected' && (
            <span className="persona-home-copy">
              {ui('尚未连接个人知识库，请前往设置连接 AI Persona。')}
            </span>
          )}
          {state === 'unavailable' && (
            <span className="persona-home-copy">
              {ui('暂时无法确认连接状态，请重试或检查连接设置。')}
            </span>
          )}
        </span>
      </output>
      <div className="persona-home-actions">
        {state === 'unavailable' && onRetry && (
          <button type="button" onClick={onRetry}>
            {ui('重试')}
          </button>
        )}
        <button type="button" onClick={onSettings}>
          {ui(state === 'disconnected' ? '去连接' : '连接设置')}
        </button>
      </div>
    </section>
  );
}

export function PersonaConnectionStatus({
  visible,
  onSettings,
}: {
  visible: boolean;
  onSettings: () => void;
}) {
  const [state, setState] = useState<ConnectionState>('checking');
  const [revision, setRevision] = useState(0);
  const refresh = () => {
    setState('checking');
    setRevision((value) => value + 1);
  };
  useEffect(() => {
    const changed = () => {
      setState('checking');
      setRevision((value) => value + 1);
    };
    window.addEventListener('paper-radar-persona-changed', changed);
    return () =>
      window.removeEventListener('paper-radar-persona-changed', changed);
  }, []);
  useRequestPolling({
    identity: String(revision),
    enabled: visible,
    intervalMs: 30000,
    run: async (signal) => {
      const result = await analysisApi<{ connected: boolean }>(
        'persona/status',
        { signal, timeoutMs: 25000 },
      );
      if (!signal.aborted)
        setState(result.connected ? 'connected' : 'disconnected');
    },
    onError: () => setState('unavailable'),
  });
  return (
    <PersonaConnectionNotice
      state={state}
      onSettings={onSettings}
      onRetry={refresh}
    />
  );
}
