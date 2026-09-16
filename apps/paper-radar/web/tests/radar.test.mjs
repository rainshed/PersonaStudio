import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SUBSCRIPTIONS,
  PAPERS,
  MATERIALS,
  candidates,
  isRecommended,
  connectionsFor,
  reasonFor,
  feedbackKey,
  applyFeedback,
  hydrateDemo,
  validateSubscription,
  validateSummaryLength,
  DEFAULT_SUMMARY_LENGTH,
} from '../lib/radar.ts';
import { buildSummaryPreview, countSummaryText } from '../lib/summary.ts';
const physics = DEFAULT_SUBSCRIPTIONS[0];
void test('subject candidates partition completely without duplicates', () => {
  const all = candidates(physics, '2026-09-06');
  const rec = all.filter((p) => isRecommended(p, physics));
  const excluded = all.filter((p) => !isRecommended(p, physics));
  assert.equal(all.length, 6);
  assert.equal(rec.length, 3);
  assert.equal(rec.length + excluded.length, all.length);
  assert.equal(new Set(all.map((p) => p.id)).size, all.length);
});
void test('scope changes exclude out-of-tag recommendations and materials', () => {
  const aiScope = { ...physics, tags: ['AI'] };
  for (const p of candidates(aiScope, '2026-09-06')) {
    assert.equal(isRecommended(p, aiScope), false);
    assert.deepEqual(connectionsFor(p, aiScope), []);
  }
  const general = { ...physics, tags: [] };
  assert.equal(isRecommended(PAPERS[0], general), true);
  assert.deepEqual(connectionsFor(PAPERS[0], general), []);
  assert.equal(reasonFor(PAPERS[0], general), PAPERS[0].generalReason);
});
void test('every generated material connection stays within selected tags', () => {
  for (const tags of [
    [],
    ['AI'],
    ['Physics'],
    ['Mathematics'],
    ['AI', 'Physics'],
  ])
    for (const p of PAPERS) {
      for (const m of connectionsFor(p, { ...physics, tags })) {
        assert.ok(tags.includes(m.tag));
        assert.ok(p.materialIds.includes(m.id));
        assert.ok(MATERIALS.includes(m));
      }
    }
});
void test('optional feedback creates only the explicit dimension and can be cleared independently', () => {
  const f = {
    value: 'negative',
    reason: '',
    updatedAt: '2026-09-06T12:00:00Z',
  };
  const key = feedbackKey(PAPERS[0], physics);
  const initial = {};
  const first = applyFeedback(initial, key, 'summary', f);
  assert.deepEqual(initial, {});
  assert.deepEqual(Object.keys(first[key]), ['summary']);
  assert.equal(first[key].summary.reason, '');
  assert.equal(first[key].accuracy, undefined);
  const second = applyFeedback(first, key, 'accuracy', {
    ...f,
    value: 'positive',
  });
  const third = applyFeedback(second, key, 'summary', null);
  assert.deepEqual(Object.keys(third[key]), ['accuracy']);
  assert.deepEqual(applyFeedback(third, key, 'accuracy', null), {});
});
void test('feedback context includes scope and language, and ignores tag ordering', () => {
  const p = PAPERS[0];
  assert.notEqual(
    feedbackKey(p, physics),
    feedbackKey(p, { ...physics, tags: ['AI'] }),
  );
  assert.notEqual(
    feedbackKey(p, physics),
    feedbackKey(p, { ...physics, language: 'en' }),
  );
  assert.equal(
    feedbackKey(p, { ...physics, tags: ['AI', 'Physics'] }),
    feedbackKey(p, { ...physics, tags: ['Physics', 'AI'] }),
  );
});
void test('demo storage restores explicit feedback and rejects corrupt subscriptions', () => {
  assert.equal(hydrateDemo(null), null);
  assert.equal(hydrateDemo({ subscriptions: [{}] }), null);
  assert.equal(
    hydrateDemo({ subscriptions: [{ ...physics, tags: ['unknown'] }] }),
    null,
  );
  const hydrated = hydrateDemo({
    subscriptions: [physics],
    activeId: 'missing',
    feedback: {},
  });
  assert.equal(hydrated.activeId, physics.id);
  assert.deepEqual(hydrated.feedback, {});
  assert.equal(
    validateSubscription({ ...physics, name: ' ' }),
    '请填写订阅名称',
  );
});
void test('unsupported dates have no candidates rather than fabricated results', () =>
  assert.deepEqual(candidates(physics, '2026-08-01'), []));

void test('summary bounds reject missing, fractional, non-finite and reversed values', () => {
  for (const range of [
    undefined,
    null,
    {},
    { min: NaN, max: 1200 },
    { min: 800, max: Infinity },
    { min: 800.5, max: 1200 },
    { min: 199, max: 1200 },
    { min: 800, max: 3001 },
    { min: 1200, max: 800 },
    { min: 800, max: 800 },
  ]) {
    assert.ok(validateSummaryLength(range));
    assert.ok(validateSubscription({ ...physics, summaryLength: range }));
  }
  assert.equal(validateSummaryLength({ min: 200, max: 3000 }), null);
  assert.equal(validateSummaryLength(DEFAULT_SUMMARY_LENGTH), null);
});

void test('old saved subscriptions gain default bounds without losing settings or feedback', () => {
  const { summaryLength: _summaryLength, ...oldSubscription } = physics;
  const key = feedbackKey(PAPERS[0], physics);
  const feedback = {
    [key]: {
      accuracy: {
        value: 'positive',
        reason: '',
        updatedAt: '2026-09-06T12:00:00Z',
      },
    },
  };
  const restored = hydrateDemo({
    subscriptions: [oldSubscription],
    activeId: physics.id,
    feedback,
  });
  assert.deepEqual(restored.subscriptions, [physics]);
  assert.deepEqual(restored.feedback, feedback);
  const custom = { ...physics, summaryLength: { min: 1100, max: 1600 } };
  assert.deepEqual(hydrateDemo({ subscriptions: [custom] }).subscriptions, [
    custom,
  ]);
});

void test('summary counting follows the displayed Chinese character and English word rules', () => {
  assert.equal(countSummaryText('研究 AI，\n 结果。', 'zh'), 8);
  assert.equal(
    countSummaryText("Tool-based research: it's a test.\nTwo results.", 'en'),
    7,
  );
});

void test('daily recommended examples provide six detailed sections within default bounds in either language', () => {
  for (const subscription of DEFAULT_SUBSCRIPTIONS) {
    for (const paper of candidates(subscription, '2026-09-06').filter((p) =>
      isRecommended(p, subscription),
    )) {
      for (const language of ['zh', 'en']) {
        const summary = buildSummaryPreview(paper, {
          ...subscription,
          language,
        });
        const paragraphs = summary.sections.flatMap((s) => s.paragraphs);
        assert.equal(summary.sections.length, 6);
        assert.equal(
          summary.withinRange,
          true,
          `${paper.id} ${language}: ${summary.count}`,
        );
        assert.equal(
          summary.count,
          countSummaryText(paragraphs.join('\n'), language),
        );
        assert.equal(new Set(paragraphs).size, paragraphs.length);
      }
    }
  }
});

void test('longer targets expand the example and unavailable lengths are reported honestly', () => {
  const short = buildSummaryPreview(PAPERS[0], {
    ...physics,
    summaryLength: { min: 500, max: 800 },
  });
  const long = buildSummaryPreview(PAPERS[0], {
    ...physics,
    summaryLength: { min: 1200, max: 1800 },
  });
  assert.ok(short.withinRange && long.withinRange);
  assert.ok(long.count > short.count);
  const unavailable = buildSummaryPreview(PAPERS[0], {
    ...physics,
    summaryLength: { min: 2900, max: 3000 },
  });
  assert.equal(unavailable.withinRange, false);
  assert.ok(unavailable.count < unavailable.min);
});

void test('length changes invalidate only the summary feedback context', () => {
  const changed = { ...physics, summaryLength: { min: 1200, max: 1800 } };
  assert.notEqual(
    feedbackKey(PAPERS[0], physics, 'summary'),
    feedbackKey(PAPERS[0], changed, 'summary'),
  );
  for (const dimension of ['accuracy', 'reason', 'connections']) {
    assert.equal(
      feedbackKey(PAPERS[0], physics, dimension),
      feedbackKey(PAPERS[0], changed, dimension),
    );
  }
});
