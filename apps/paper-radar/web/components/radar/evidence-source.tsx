'use client';
import type { Evidence } from '@/lib/analysis-api';
import { evidencePresentation } from '@/lib/evidence-presentation';
import { useUiLanguage } from './ui-language';

export function EvidenceSource({
  evidence,
}: {
  evidence: Omit<Evidence, 'text'>;
}) {
  const { ui } = useUiLanguage();
  const source = evidencePresentation(evidence);
  return (
    <div className="evidence-source">
      <strong>{ui(source.basis)}</strong>
      <dl>
        {source.section && (
          <div>
            <dt>{ui('章节')}</dt>
            <dd>{source.section}</dd>
          </div>
        )}
        {source.fileName && (
          <div>
            <dt>{ui('来源文件')}</dt>
            <dd>{source.fileName}</dd>
          </div>
        )}
        {source.pages.length > 0 && (
          <div>
            <dt>{ui('页码')}</dt>
            <dd>{source.pages.join(', ')}</dd>
          </div>
        )}
        {source.lines.length > 0 && (
          <div>
            <dt>{ui('行号')}</dt>
            <dd>{source.lines.join('–')}</dd>
          </div>
        )}
        {source.characters && (
          <div>
            <dt>{ui('章节内字符')}</dt>
            <dd>{source.characters}</dd>
          </div>
        )}
        {source.recordRevision !== undefined && (
          <div>
            <dt>{ui('条目版本')}</dt>
            <dd>{source.recordRevision}</dd>
          </div>
        )}
      </dl>
      {source.visualCaution && (
        <p>
          {ui(
            '此依据来自提取的文字，不代表已理解图像、表格布局或公式的视觉内容。',
          )}
        </p>
      )}
    </div>
  );
}
