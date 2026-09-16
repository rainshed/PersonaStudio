import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SAMPLE_URL,
  STAGE_MS,
  advanceJob,
  analysisKey,
  defaultAnalysisSettings,
  hydrateSingleAnalysis,
  parseArxiv,
  settingsFromSubscription,
  singleSummary,
  supportsSample,
  validateAnalysisSettings,
} from '../lib/single-analysis.ts';
import { DEFAULT_SUBSCRIPTIONS } from '../lib/radar.ts';
import { countSummaryText } from '../lib/summary.ts';

const settings = {
  ...defaultAnalysisSettings(),
  url: SAMPLE_URL,
};
const createdAt = '2026-09-06T12:00:00Z';
const started = Date.parse(createdAt);
const job = {
  id: 'single-example',
  paper: parseArxiv(SAMPLE_URL),
  settings,
  createdAt,
  status: 'running',
  origin: 'demo',
};

void test('arXiv input variants preserve IDs and explicit versions without accepting arbitrary URLs', () => {
  for (const input of [
    '2501.12903v3',
    'arXiv: 2501.12903v3',
    SAMPLE_URL,
    'https://arxiv.org/pdf/2501.12903v3.pdf?download=1#page=2',
    'https://arxiv.org/html/2501.12903v3',
  ])
    assert.deepEqual(parseArxiv(input), parseArxiv(SAMPLE_URL));
  assert.equal(parseArxiv('2501.12903').version, null);
  assert.equal(parseArxiv('hep-th/9901001v2').id, 'hep-th/9901001');
  assert.equal(supportsSample(parseArxiv('2501.12903v1')), false);
  for (const input of [
    'https://arxiv.org.example.com/abs/2501.12903',
    'https://example.com/abs/2501.12903',
    'https://user:password@arxiv.org/abs/2501.12903',
    'https://arxiv.org:8000/abs/2501.12903',
    'javascript:alert(1)',
    '2513.12903',
    '2501.12903v0',
  ])
    assert.equal(parseArxiv(input), null);
});

void test('bilingual preset summaries meet the displayed bounds using complete, non-repeated sections', () => {
  for (const language of ['zh', 'en']) {
    for (const [min, max] of [
      [400, 600],
      [800, 1200],
      [1500, 2000],
    ]) {
      const summary = singleSummary(language, { min, max });
      const paragraphs = summary.sections.flatMap((s) =>
        s.paragraphs.map((p) => p[language]),
      );
      assert.equal(summary.sections.length, 6);
      assert.equal(new Set(paragraphs).size, paragraphs.length);
      assert.equal(
        summary.count,
        countSummaryText(paragraphs.join('\n'), language),
      );
      assert.equal(summary.withinRange, true);
      assert.ok(summary.count >= min && summary.count <= max);
    }
    const long = singleSummary(language, { min: 2500, max: 3000 });
    assert.equal(
      long.withinRange,
      false,
      'insufficient fixture text must not claim success',
    );
  }
});

void test('simulation completes supported examples, reports unsupported papers, and honors cancellation', () => {
  assert.equal(advanceJob(job, started + STAGE_MS).status, 'running');
  assert.equal(advanceJob(job, started + 4 * STAGE_MS).status, 'complete');
  const tooLong = {
    ...job,
    settings: { ...settings, summaryLength: { min: 2500, max: 3000 } },
  };
  assert.equal(
    advanceJob(tooLong, started + 4 * STAGE_MS).status,
    'needs_review',
  );
  for (const id of ['2501.12904', '2501.12903v1']) {
    const other = {
      ...job,
      paper: parseArxiv(id),
      settings: { ...settings, url: id },
    };
    assert.equal(advanceJob(other, started + STAGE_MS).status, 'unavailable');
  }
  const cancelled = { ...job, status: 'cancelled' };
  assert.equal(advanceJob(cancelled, started + 100_000), cancelled);
});

void test('analysis identity scopes reuse to the same paper version, tags, language and length', () => {
  assert.equal(
    analysisKey(settings),
    analysisKey({ ...settings, url: '2501.12903' }),
  );
  assert.equal(
    analysisKey({ ...settings, tags: ['Physics', 'AI'] }),
    analysisKey({ ...settings, tags: ['AI', 'Physics'] }),
  );
  for (const change of [
    { tags: [] },
    { language: 'en' },
    { url: '2501.12903v1' },
    { summaryLength: { min: 1500, max: 2000 } },
  ])
    assert.notEqual(
      analysisKey(settings),
      analysisKey({ ...settings, ...change }),
    );
  assert.equal(validateAnalysisSettings({ ...settings, tags: [] }), null);
  assert.ok(
    validateAnalysisSettings({
      ...settings,
      summaryLength: { min: 900, max: 800 },
    }),
  );
  const inherited = settingsFromSubscription(
    DEFAULT_SUBSCRIPTIONS[0],
    SAMPLE_URL,
  );
  assert.equal(inherited.subject, undefined);
  assert.notEqual(inherited.tags, DEFAULT_SUBSCRIPTIONS[0].tags);
});

void test('history restores job snapshots and only explicit feedback for available content', () => {
  const completed = { ...job, status: 'complete' };
  const summaryOnly = {
    ...completed,
    id: 'single-no-tags',
    settings: { ...settings, tags: [] },
  };
  const explicit = { value: 'negative', reason: '', updatedAt: createdAt };
  const saved = hydrateSingleAnalysis({
    draft: settings,
    jobs: [completed, summaryOnly, { ...job, id: 'single-resume' }],
    selectedId: completed.id,
    readingStatus: 'read',
    feedback: {
      [completed.id]: { accuracy: explicit },
      [summaryOnly.id]: {
        summary: explicit,
        accuracy: explicit,
        connections: explicit,
      },
    },
  });
  assert.equal(saved.selectedId, completed.id);
  assert.deepEqual(Object.keys(saved.feedback[completed.id]), ['accuracy']);
  assert.deepEqual(Object.keys(saved.feedback[summaryOnly.id]), ['summary']);
  assert.equal(saved.feedback[completed.id].accuracy.reason, '');
  assert.equal(saved.readingStatus, undefined);
  assert.equal(saved.feedback['single-resume'], undefined);
  assert.equal(advanceJob(saved.jobs[2], started + 100_000).status, 'complete');
  assert.equal(
    hydrateSingleAnalysis({
      ...saved,
      jobs: [{ ...completed, settings: { ...settings, url: '2501.12904' } }],
    }),
    null,
  );
  assert.equal(
    hydrateSingleAnalysis({ ...saved, jobs: [{ ...completed, settings: {} }] }),
    null,
  );
});
