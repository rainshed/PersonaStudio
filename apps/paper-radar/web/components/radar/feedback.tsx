'use client';
import { useUiLanguage } from '@/components/radar/ui-language';
import { Check, X, RotateCcw } from 'lucide-react';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import type { Feedback, FeedbackDimension, Language } from '@/lib/radar';
import { useId } from 'react';
export function FeedbackControl({
  dimension,
  value,
  onChange,
  compact = false,
  notRecommended = false,
  decision,
  disabled = false,
}: {
  dimension: FeedbackDimension;
  value?: Feedback;
  onChange: (v: Feedback | null) => void;
  language?: Language;
  compact?: boolean;
  notRecommended?: boolean;
  decision?: string;
  disabled?: boolean;
}) {
  const { ui, uiLanguage } = useUiLanguage();
  const id = useId();
  const en = uiLanguage === 'en';
  const accuracy = dimension === 'accuracy';
  const label = accuracy
    ? en
      ? 'Do you agree with this recommendation decision?'
      : '你认可这个推荐判断吗？'
    : dimension === 'summary'
      ? en
        ? 'Satisfied with the summary?'
        : '对研究总结满意吗？'
      : dimension === 'reason'
        ? en
          ? 'Satisfied with the recommendation reason?'
          : '对推荐理由满意吗？'
        : en
          ? 'Satisfied with the connections and potential crossover?'
          : '对已有材料联系和潜在交叉满意吗？';
  const choose = (v: unknown) => {
    if (v !== 'positive' && v !== 'negative') return;
    onChange({
      value: v,
      reason: v === 'negative' ? (value?.reason ?? '') : '',
      updatedAt: new Date().toISOString(),
    });
  };
  if (
    !accuracy ||
    (decision && !['recommended', 'not_recommended'].includes(decision))
  )
    return null;
  return (
    <div className={'feedback-control ' + (compact ? 'compact' : '')}>
      <div className="feedback-line">
        <span id={id} className="feedback-label">
          {ui(label)}
        </span>
        <RadioGroup
          aria-labelledby={id}
          value={value?.value ?? null}
          onValueChange={choose}
          disabled={disabled}
          className="feedback-choices"
        >
          {(['positive', 'negative'] as const).map((v) => (
            <label
              className={
                'feedback-choice ' + (value?.value === v ? 'chosen ' + v : '')
              }
              key={v}
            >
              <RadioGroupItem value={v} className="sr-only" />
              {v === 'positive' ? <Check size={14} /> : <X size={14} />}
              <span>
                {ui(
                  v === 'positive'
                    ? en
                      ? 'Satisfied'
                      : '满意'
                    : en
                      ? 'Unsatisfied'
                      : '不满意',
                )}
              </span>
            </label>
          ))}
        </RadioGroup>
        {value && (
          <button
            className="feedback-undo"
            aria-label={ui(en ? 'Clear this feedback' : '撤销此项反馈')}
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            <RotateCcw size={13} />
            <span>{ui(en ? 'Undo' : '撤销')}</span>
          </button>
        )}
      </div>
      {value?.reason && (
        <details className="feedback-previous-note">
          <summary>{ui(en ? 'Saved note' : '已保存的说明')}</summary>
          <p>{value.reason}</p>
        </details>
      )}
      {value && (accuracy || !compact) && (
        <output className="feedback-saved">
          {ui(
            accuracy &&
              (!decision ||
                ['recommended', 'not_recommended'].includes(decision))
              ? (value.value === 'positive') !==
                (decision ? decision === 'not_recommended' : notRecommended)
                ? en
                  ? 'Answer: should recommend'
                  : '正确答案：应该推荐'
                : en
                  ? 'Answer: should not recommend'
                  : '正确答案：不该推荐'
              : en
                ? 'Recorded · independent of other feedback'
                : '已记录 · 不影响其他评价',
          )}
        </output>
      )}
    </div>
  );
}
