'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultLocation,
  radarHash,
  readRadarLocation,
  type RadarLocation,
} from '@/lib/radar-location';

export function useRadarLocation() {
  const [value, setValue] = useState(defaultLocation);
  const [ready, setReady] = useState(false);
  const current = useRef(value);
  const update = useCallback(
    (patch: Partial<RadarLocation>, mode: 'push' | 'replace' = 'replace') => {
      const next = { ...current.current, ...patch };
      current.current = next;
      const url = location.pathname + location.search + radarHash(next);
      if (location.hash !== radarHash(next))
        history[mode === 'push' ? 'pushState' : 'replaceState'](null, '', url);
      setValue(next);
    },
    [],
  );
  useEffect(() => {
    const read = () => {
      current.current = readRadarLocation(location.hash);
      setValue(current.current);
    };
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return;
      if (!location.hash) {
        try {
          const saved = JSON.parse(
            localStorage.getItem('paper-radar.daily.selection.v1') ?? 'null',
          );
          update({
            ...defaultLocation,
            subscription:
              typeof saved?.subscription === 'string' ? saved.subscription : '',
            run: typeof saved?.run === 'string' ? saved.run : null,
          });
        } catch {
          update(defaultLocation);
        }
      } else read();
      setReady(true);
    });
    window.addEventListener('popstate', read);
    window.addEventListener('hashchange', read);
    return () => {
      cancelled = true;
      window.removeEventListener('popstate', read);
      window.removeEventListener('hashchange', read);
    };
  }, [update]);
  useEffect(() => {
    if (!ready) return;
    try {
      localStorage.setItem(
        'paper-radar.daily.selection.v1',
        JSON.stringify(value),
      );
    } catch {
      /* Optional view preferences. */
    }
  }, [value, ready]);
  return { value, current, update, ready };
}
