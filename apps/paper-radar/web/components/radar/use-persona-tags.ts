'use client';

import { useEffect, useState } from 'react';
import { analysisApi, type RealTag } from '@/lib/analysis-api';
import { useRequestPolling } from './use-request-polling';

export function usePersonaTags(refresh: number) {
  const [tags, setTags] = useState<RealTag[]>([]);
  const [personaId, setPersonaId] = useState<string | null>(null);
  const [personaError, setPersonaError] = useState('');
  const [connectionRefresh, setConnectionRefresh] = useState(0);
  useEffect(() => {
    const changed = () => { setTags([]); setPersonaId(null); setConnectionRefresh((value) => value + 1); };
    window.addEventListener('paper-radar-persona-changed', changed);
    return () => window.removeEventListener('paper-radar-persona-changed', changed);
  }, []);
  useRequestPolling({
    identity: `${refresh}:${connectionRefresh}`,
    run: async (signal) => {
      let page = await analysisApi<{
        tags: RealTag[];
        connection_id: string;
        persona_revision: number;
        next_cursor: string | null;
      }>('persona/tags', { signal });
      const all = [...page.tags];
      const { connection_id: connectionId, persona_revision: revision } = page;
      const seen = new Set<string>();
      while (page.next_cursor && !signal.aborted) {
        if (seen.has(page.next_cursor) || all.length > 5000)
          throw new Error('标签数量超过读取上限。');
        seen.add(page.next_cursor);
        page = await analysisApi(
          'persona/tags?cursor=' +
            encodeURIComponent(page.next_cursor) +
            '&revision=' +
            revision,
          { signal },
        );
        if (
          page.connection_id !== connectionId ||
          page.persona_revision !== revision
        )
          throw new Error('Persona 内容已更新，请刷新标签。');
        all.push(...page.tags);
      }
      if (!signal.aborted) {
        setTags(all);
        setPersonaId(connectionId);
        setPersonaError('');
      }
      return false;
    },
    onError: (error) =>
      setPersonaError(
        error instanceof Error ? error.message : 'Persona 未连接。',
      ),
  });
  return { tags, personaId, personaError };
}
