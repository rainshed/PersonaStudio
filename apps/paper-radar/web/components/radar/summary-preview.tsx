'use client';
import { useUiLanguage } from '@/components/radar/ui-language';
import { FileText, SlidersHorizontal, Info } from 'lucide-react';
import { buildSummaryPreview } from '@/lib/summary';
import type { Paper, Subscription } from '@/lib/radar';
export function SummaryPreview({
  paper,
  subscription,
  onEdit,
}: {
  paper: Paper;
  subscription: Subscription;
  onEdit: () => void;
}) {
  const { ui, uiLanguage } = useUiLanguage();
  const summary = buildSummaryPreview(paper, subscription);
  const en = uiLanguage === 'en';
  const unit = subscription.language === 'en' ? 'words' : '字';
  return (
    <div className="summary-preview">
      <div className="summary-length-bar">
        <div>
          <FileText size={15} />
          <span>
            {ui(en ? 'Target' : '目标')}{' '}
            <strong>
              {summary.min}–{summary.max}
            </strong>{' '}
            {ui(unit)}
          </span>
          <span className="summary-count">
            {ui(en ? 'This example' : '本示例')} {summary.count} {ui(unit)}
          </span>
        </div>
        <button onClick={onEdit}>
          <SlidersHorizontal size={14} />
          {ui(en ? 'Set length' : '调整字数')}
        </button>
      </div>
      <p
        className={
          'summary-preview-caption ' +
          (!summary.withinRange ? 'outside-range' : '')
        }
      >
        <Info size={13} />
        {ui(
          en
            ? summary.withinRange
              ? 'Prewritten demo, adjusted by whole paragraphs. AI generation is not connected yet.'
              : 'This prewritten example does not meet the target range. Your target is saved for future AI generation; the demo does not pad or cut sentences.'
            : summary.withinRange
              ? '预写示例按完整段落调整；AI 按范围生成功能尚未接入。'
              : '当前预写示例未达到目标范围。设置已保存，接入 AI 后将按范围生成；演示不凑字数或截断句子。',
        )}
      </p>
      <div className="long-summary">
        {summary.sections.map((section) => (
          <section key={section.id}>
            <h4>{section.title}</h4>
            {section.paragraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
