'use client';
import { useUiLanguage } from './ui-language';
import type { Evidence } from '@/lib/analysis-api';
export function EvidenceText({ evidence }: { evidence: Evidence }) {
  const { ui } = useUiLanguage();
  let record: {
    title?: string;
    description?: string;
    abstract?: string;
    summary?: string;
    scope_note?: string;
    body?: string;
    knowledge_level?: string;
    interest_level?: string;
    user_relationships?: string[];
  } | null = null;
  if (evidence.kind === 'record') {
    try {
      record = JSON.parse(evidence.text);
    } catch {
      /* Plain source fallback. */
    }
  }
  if (record)
    return (
      <div className="real-evidence-text">
        <p>
          {record.description ||
            record.abstract ||
            record.summary ||
            record.title}
        </p>
        {record.scope_note && (
          <p>
            <strong>{ui('知识范围：')}</strong>
            {record.scope_note}
          </p>
        )}
        {record.body && (
          <p>
            <strong>{ui('个人备注：')}</strong>
            {record.body}
          </p>
        )}
        <dl>
          {[
            [ui('知识程度'), record.knowledge_level],
            [ui('兴趣程度'), record.interest_level],
            [ui('用户关系'), record.user_relationships?.join('、')],
          ].map(
            ([label, value]) =>
              value && (
                <div key={label}>
                  <dt>{ui(label)}</dt>
                  <dd>{value}</dd>
                </div>
              ),
          )}
        </dl>
      </div>
    );
  return <div className="real-evidence-text">{evidence.text}</div>;
}
