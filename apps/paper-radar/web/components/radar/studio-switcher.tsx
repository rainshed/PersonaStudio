'use client';
import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { analysisApi } from '@/lib/analysis-api';
import { useUiLanguage } from './ui-language';

export function StudioSwitcher() {
  const { uiLanguage, ui } = useUiLanguage();
  const zh = uiLanguage === 'zh';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [url, setUrl] = useState('');
  return (
    <div className="studio-switcher">
      <button
        className="button-secondary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void analysisApi<{ url: string }>('studio/persona', {
            method: 'POST',
            body: {},
            timeoutMs: 60000,
          })
            .then((result) => {
              setUrl(result.url);
              window.location.assign(result.url);
            })
            .catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : String(cause)),
            )
            .finally(() => setBusy(false));
        }}
      >
        <ExternalLink size={15} />
        {busy
          ? zh
            ? '正在打开…'
            : 'Opening…'
          : zh
            ? '打开 AI Persona'
            : 'Open AI Persona'}
      </button>
      {url && <a href={url}>{zh ? '前往 AI Persona' : 'Go to AI Persona'}</a>}
      {error && (
        <p role="alert" className="persona-message error">
          {ui(error)}
        </p>
      )}
    </div>
  );
}
