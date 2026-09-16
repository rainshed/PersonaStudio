export function countSummaryText(value: string, language: 'zh' | 'en'): number {
  if (language === 'zh') return Array.from(value.replace(/\s/gu, '')).length;
  return (value.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length;
}
