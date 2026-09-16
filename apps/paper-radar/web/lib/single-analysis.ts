import {
  TAGS,
  type Feedback,
  type FeedbackDimension,
  type Language,
  type SummaryLength,
  type Subscription,
  validateSummaryLength,
} from './radar.ts';
import { countSummaryText } from './summary.ts';
import {
  SINGLE_SUMMARY,
  type SingleSummarySection,
} from './single-analysis-content.ts';

export const SINGLE_STORAGE_KEY = 'paper-radar.single-analysis.demo.v1';
export const SAMPLE_ARXIV = '2501.12903';
export const SAMPLE_VERSION = 3;
export const SAMPLE_TITLE =
  'Measurement-induced Lévy flights of quantum information';
export const SAMPLE_URL = 'https://arxiv.org/abs/2501.12903v3';
import { parseArxiv, type ArxivReference } from './arxiv.ts';
export { parseArxiv, type ArxivReference } from './arxiv.ts';
export type AnalysisSettings = {
  url: string;
  tags: string[];
  language: Language;
  summaryLength: SummaryLength;
};
export type AnalysisJob = {
  id: string;
  paper: ArxivReference;
  settings: AnalysisSettings;
  createdAt: string;
  status: 'running' | 'complete' | 'needs_review' | 'unavailable' | 'cancelled';
  origin: 'demo';
};
export type SingleAnalysisState = {
  draft: AnalysisSettings;
  jobs: AnalysisJob[];
  selectedId: string | null;
  feedback: Record<string, Partial<Record<FeedbackDimension, Feedback>>>;
};
export const STAGES = [
  '读取论文',
  '获取相关材料',
  '生成分析',
  '检查内容',
] as const;
export const STAGE_MS = 1400;
export function supportsSample(paper: ArxivReference) {
  return (
    paper.id === SAMPLE_ARXIV &&
    (paper.version === null || paper.version === SAMPLE_VERSION)
  );
}
export function defaultAnalysisSettings(): AnalysisSettings {
  return {
    url: '',
    tags: ['Physics'],
    language: 'zh',
    summaryLength: { min: 800, max: 1200 },
  };
}
export function settingsFromSubscription(
  subscription: Subscription,
  url: string,
): AnalysisSettings {
  return {
    url,
    tags: [...subscription.tags],
    language: subscription.language,
    summaryLength: { ...subscription.summaryLength },
  };
}
export function validateAnalysisSettings(
  settings: AnalysisSettings,
): string | null {
  if (!parseArxiv(settings.url))
    return '请填写有效的 arXiv 链接或论文编号，例如 2501.12903。';
  if (
    !['zh', 'en'].includes(settings.language) ||
    !Array.isArray(settings.tags) ||
    settings.tags.some((t) => !TAGS.includes(t)) ||
    new Set(settings.tags).size !== settings.tags.length
  )
    return '语言或标签设置无效。';
  return validateSummaryLength(settings.summaryLength);
}
export function singleSummary(language: Language, bounds: SummaryLength) {
  const sections: SingleSummarySection[] = SINGLE_SUMMARY.map((section) => ({
    title: section.title,
    source: section.source,
    paragraphs: [section.paragraphs[0]],
  }));
  const target = (bounds.min + bounds.max) / 2;
  let count = countSummaryText(
    sections.flatMap((s) => s.paragraphs.map((p) => p[language])).join('\n'),
    language,
  );
  for (let level = 1; level < 4; level++) {
    for (let i = 0; i < sections.length; i++) {
      const paragraph = SINGLE_SUMMARY[i].paragraphs[level];
      if (!paragraph) continue;
      const size = countSummaryText(paragraph[language], language);
      if (count + size > bounds.max) continue;
      if (
        count >= bounds.min &&
        Math.abs(count + size - target) >= Math.abs(count - target)
      )
        continue;
      sections[i].paragraphs.push(paragraph);
      count += size;
    }
  }
  return {
    sections,
    count,
    withinRange: count >= bounds.min && count <= bounds.max,
  };
}
export function stageOf(job: AnalysisJob, now: number) {
  return Math.min(
    STAGES.length - 1,
    Math.max(0, Math.floor((now - Date.parse(job.createdAt)) / STAGE_MS)),
  );
}
export function advanceJob(job: AnalysisJob, now: number): AnalysisJob {
  if (job.status !== 'running') return job;
  const elapsed = now - Date.parse(job.createdAt);
  if (!supportsSample(job.paper) && elapsed >= STAGE_MS)
    return { ...job, status: 'unavailable' };
  if (elapsed < STAGES.length * STAGE_MS) return job;
  return {
    ...job,
    status: singleSummary(job.settings.language, job.settings.summaryLength)
      .withinRange
      ? 'complete'
      : 'needs_review',
  };
}
export function analysisKey(settings: AnalysisSettings) {
  const p = parseArxiv(settings.url);
  if (!p) return '';
  const version = supportsSample(p) ? SAMPLE_VERSION : p.version;
  return JSON.stringify([
    p.id,
    version,
    [...settings.tags].sort(),
    settings.language,
    settings.summaryLength.min,
    settings.summaryLength.max,
  ]);
}
export function isPersonalized(settings: AnalysisSettings) {
  return settings.tags.length > 0;
}
export function recommendsSample(settings: AnalysisSettings) {
  return settings.tags.includes('Physics');
}
export function hydrateSingleAnalysis(
  value: unknown,
): SingleAnalysisState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as SingleAnalysisState;
  const settings = (v: AnalysisSettings) =>
    v &&
    typeof v.url === 'string' &&
    v.url.length <= 500 &&
    Array.isArray(v.tags) &&
    v.tags.every((t) => typeof t === 'string' && TAGS.includes(t)) &&
    ['zh', 'en'].includes(v.language) &&
    !validateSummaryLength(v.summaryLength);
  if (!settings(raw.draft) || !Array.isArray(raw.jobs) || raw.jobs.length > 50)
    return null;
  const clean = (s: AnalysisSettings): AnalysisSettings => ({
    url: s.url,
    tags: [...new Set(s.tags)],
    language: s.language,
    summaryLength: { min: s.summaryLength.min, max: s.summaryLength.max },
  });
  const jobs: AnalysisJob[] = [];
  for (const job of raw.jobs) {
    if (
      !job ||
      typeof job.id !== 'string' ||
      !/^single-[\w-]{1,80}$/.test(job.id) ||
      jobs.some((j) => j.id === job.id) ||
      !settings(job.settings) ||
      !parseArxiv(job.settings.url) ||
      !Number.isFinite(Date.parse(job.createdAt)) ||
      ![
        'running',
        'complete',
        'needs_review',
        'unavailable',
        'cancelled',
      ].includes(job.status)
    )
      return null;
    const paper = parseArxiv(job.settings.url)!;
    if (supportsSample(paper)) paper.version = SAMPLE_VERSION;
    paper.url = `https://arxiv.org/abs/${paper.id}${paper.version ? 'v' + paper.version : ''}`;
    if (
      ['complete', 'needs_review'].includes(job.status) &&
      !supportsSample(paper)
    )
      return null;
    jobs.push({
      id: job.id,
      paper,
      settings: clean(job.settings),
      createdAt: job.createdAt,
      status: job.status,
      origin: 'demo',
    });
  }
  const feedback: SingleAnalysisState['feedback'] = {};
  for (const job of jobs) {
    if (!['complete', 'needs_review'].includes(job.status)) continue;
    const entries = raw.feedback?.[job.id];
    for (const dim of [
      'accuracy',
      'summary',
      'reason',
      'connections',
    ] as const) {
      const f = entries?.[dim];
      if (dim !== 'summary' && !isPersonalized(job.settings)) continue;
      if (dim === 'connections' && !recommendsSample(job.settings)) continue;
      if (
        f &&
        ['positive', 'negative'].includes(f.value) &&
        typeof f.reason === 'string' &&
        f.reason.length <= 4000 &&
        Number.isFinite(Date.parse(f.updatedAt))
      ) {
        feedback[job.id] ??= {};
        feedback[job.id][dim] = {
          value: f.value,
          reason: f.value === 'negative' ? f.reason : '',
          updatedAt: f.updatedAt,
        };
      }
    }
  }
  return {
    draft: clean(raw.draft),
    jobs,
    selectedId: jobs.some((j) => j.id === raw.selectedId)
      ? raw.selectedId
      : null,
    feedback,
  };
}
