import { uiCatalog } from './ui-catalog.ts';

// These placeholders are source titles, identifiers or labels, not UI copy.
const rawParameters: Record<string, number[]> = {
  '筛选：{0}': [0],
  'Codex 模型 {0} 当前不可用。': [0],
  '模板缺少必要变量或共用规则：{0}': [0],
  '缺少变量：{0}': [0],
  '材料 {0} 没有可检索的文本。': [0],
  '材料 {0} 未找到相关原文片段。': [0],
  '材料 {0} 原文未读取：{1}': [0],
};
const preserveParameter = (template: string, index: number) =>
  rawParameters[template]?.includes(index) ||
  /引用：|证据：|证据不存在：|记录不符：|记录的引用：|范围内：|材料的证据：|文献匹配：|尚未提供：/.test(
    template,
  );
import type { UiLanguage } from './ui-language.ts';

const normalize = (value: string) => value.replace(/\s+/g, ' ').trim();
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const templates = Object.entries(uiCatalog)
  .filter(([zh]) => /\{\d+\}/.test(zh))
  .sort(
    ([a], [b]) =>
      b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length,
  )
  .map(([zh, en]) => ({
    pattern: new RegExp(
      '^' +
        zh
          .split(/\{\d+\}/)
          .map(escape)
          .join(rawParameters[zh] ? '(.+?)' : '([^。！？]+?)') +
        '$',
    ),
    en,
    zh,
  }));

function translate(value: string, language: UiLanguage, depth = 0): string {
  const key = normalize(value);
  if (!key || depth > 4) return value;
  if (language === 'zh') return key === 'words' ? '词' : value;
  if (Object.hasOwn(uiCatalog, key)) return uiCatalog[key];
  for (const { pattern, en, zh } of templates) {
    const match = key.match(pattern);
    if (match)
      return en.replace(/\{(\d+)\}/g, (_, index) =>
        preserveParameter(zh, Number(index))
          ? match[Number(index) + 1]
          : translate(match[Number(index) + 1], language, depth + 1),
      );
  }
  // A saved status may concatenate several known notices. Translate each whole
  // sentence, never arbitrary substrings of names, identifiers or external errors.
  const boundary = key.search(/[。！？]/);
  if (boundary >= 0 && boundary < key.length - 1) {
    const first = key.slice(0, boundary + 1),
      rest = key.slice(boundary + 1);
    const start = translate(first, language, depth + 1),
      end = translate(rest, language, depth + 1);
    if (start !== first || end !== rest) return start + ' ' + end;
  }
  return value;
}

/** Translate interface text at render time so saved notices switch immediately.
 * Non-text values and unknown external messages pass through unchanged.
 * Callers keep paper content, user labels and form values outside this function.
 */
export function translateUi<T>(
  value: T,
  language: UiLanguage,
  parameters?: readonly (string | number | null | undefined)[],
): T {
  if (typeof value !== 'string') return value;
  if (parameters) {
    const template =
      language === 'en' ? (uiCatalog[normalize(value)] ?? value) : value;
    return template.replace(/\{(\d+)\}/g, (placeholder, index) =>
      Number(index) < parameters.length
        ? String(parameters[Number(index)] ?? '')
        : placeholder,
    ) as T;
  }
  const translated = translate(value, language);
  if (translated === value) return value;
  return ((value.match(/^\s*/)?.[0] ?? '') +
    translated +
    (value.match(/\s*$/)?.[0] ?? '')) as T;
}
