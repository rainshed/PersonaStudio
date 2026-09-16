'use client';
import type { Evidence } from '@/lib/analysis-api';
import { useUiLanguage } from './ui-language';

export function KnowledgeBasis({
  ids,
  evidence,
}: {
  ids?: string[];
  evidence: Omit<Evidence, 'text'>[];
}) {
  const { ui } = useUiLanguage();
  const names = ids
    ?.map(
      (id) =>
        evidence.find((e) => e.kind === 'record' && e.record_id === id)?.title,
    )
    .filter((name): name is string => !!name);
  if (!names?.length) return null;
  return (
    <p className="single-help">
      {ui('判断依据的知识点：')}
      {names.join(' · ')}
    </p>
  );
}
