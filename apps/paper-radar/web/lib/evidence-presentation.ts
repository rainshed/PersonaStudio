import type { Evidence } from './analysis-api.ts';

const kinds: Record<string, string> = {
  abstract: '论文摘要',
  paragraph: '论文正文',
  excerpt: '原文摘录',
  caption: '图注文字',
  table: '表格文字',
  equation: '公式文字',
  reference: '参考文献',
  record: 'Persona 条目',
  query: 'Persona 查询记录',
  image: '原始资料图片',
};

/** Render only recorded locations; absence never implies full-text coverage. */
export function evidencePresentation(evidence: Omit<Evidence, 'text'>) {
  const locator = evidence.locator ?? {};
  const section =
    evidence.section ||
    (typeof locator.section === 'string' ? locator.section : '');
  const numbers = (value: unknown): number[] =>
    Array.isArray(value)
      ? value.filter(
          (entry): entry is number => Number.isInteger(entry) && entry > 0,
        )
      : [];
  const pages = numbers(evidence.pages ?? locator.pages);
  const lines = numbers(evidence.lines ?? locator.lines);
  const offset = locator.offset;
  const end = locator.end;
  return {
    basis: kinds[evidence.kind] ?? '保存的来源文字',
    section,
    pages,
    lines,
    characters:
      typeof offset === 'number' &&
      typeof end === 'number' &&
      Number.isInteger(offset) &&
      Number.isInteger(end) &&
      offset >= 0 &&
      end > offset
        ? `${offset + 1}–${end}`
        : '',
    fileName: evidence.file_name ?? '',
    recordRevision: evidence.record_revision,
    visualCaution: ['caption', 'table', 'equation'].includes(evidence.kind),
  };
}
