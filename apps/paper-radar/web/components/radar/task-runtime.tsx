'use client';
import { useEffect, useState } from 'react';
import { Clock3, Sparkles } from 'lucide-react';
import { elapsedTime } from '@/lib/task-runtime';
import { useUiLanguage } from './ui-language';
import './task-runtime.css';

export function TaskRuntime({
  status,
  started_at,
  created_at,
  actual_attempts,
}: {
  status: string;
  started_at?: string | null;
  created_at?: string;
  actual_attempts: number;
}) {
  const { ui } = useUiLanguage();
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const update = () => setNow(Date.now());
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="task-runtime" aria-live="off">
      <span>
        <Clock3 size={14} aria-hidden="true" />
        {ui(status === 'queued' ? '已等待' : '已运行')}{' '}
        <time>
          {now === null ? '—' : elapsedTime(started_at ?? created_at, now)}
        </time>
      </span>
      <span>
        <Sparkles size={14} aria-hidden="true" />
        {ui('模型调用 {0} 次', [actual_attempts ?? 0])}
      </span>
    </span>
  );
}
