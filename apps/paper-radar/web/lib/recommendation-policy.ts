import type { AnalysisInput } from './contracts/analysis';
export type RecommendationStrictness =
  AnalysisInput['recommendation_strictness'];
export const STRICTNESS_OPTIONS: {
  id: RecommendationStrictness;
  label: string;
  description: string;
}[] = [
  {
    id: 'focused',
    label: '聚焦',
    description: '只推荐明确贴近研究问题或能直接使用的方法。',
  },
  {
    id: 'balanced',
    label: '均衡',
    description: '兼顾明确的主题关联、有依据的方法迁移和材料联系。',
  },
  {
    id: 'exploratory',
    label: '探索',
    description: '也考虑有具体依据的邻近方向，明确说明探索性和前提。',
  },
];
export const strictnessLabel = (value?: string) =>
  STRICTNESS_OPTIONS.find((v) => v.id === value)?.label ?? '旧版标准';
