'use client';
import { useUiLanguage } from './ui-language';

export function PromptTemplateEditor({
  id,
  templates,
  field,
  onChange,
  disabled = false,
  rows = 9,
}: {
  id: string;
  templates: Record<string, string>;
  field: string;
  onChange: (templates: Record<string, string>) => void;
  disabled?: boolean;
  rows?: number;
}) {
  const { ui } = useUiLanguage();
  return (
    <textarea
      id={id}
      aria-label={ui(
        field === 'system'
          ? '工作要求'
          : field === 'text'
            ? '规则内容'
            : '任务输入模板',
      )}
      rows={rows}
      spellCheck={false}
      maxLength={50000}
      disabled={disabled}
      value={templates[field] ?? ''}
      onChange={(event) =>
        onChange({ ...templates, [field]: event.target.value })
      }
    />
  );
}
