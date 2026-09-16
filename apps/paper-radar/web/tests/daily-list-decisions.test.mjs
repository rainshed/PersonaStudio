import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/daily-fixture.mjs';
import { migrateDailyListDecisions } from '../server/daily/list-decisions.mjs';
import { analysisDecisionNotice } from '../lib/daily-ui.ts';

for (const outcome of ['recommended', 'not_recommended', 'needs_fulltext']) {
  void test(`detail opinions never change the ${outcome} list or initial feedback`, async (t) => {
    const f = await fixture(t, {
      count: 1,
      outcome,
      finalDecision: 'not_recommended',
    });
    const run = await f.finish(f.create().run.id);
    const before = f.daily.items(run.id).items[0];
    if (outcome !== 'needs_fulltext') f.daily.feedback(before.screening.id, 'accuracy', {value:'positive'});
    const item = await f.detail(before.id);
    const filter =
      outcome === 'needs_fulltext' ? 'needs_confirmation' : outcome;
    assert.equal(
      f.daily.items(run.id, { decision: filter }).items[0].id,
      item.id,
    );
    assert.equal(item.final_decision, before.final_decision);
    assert.equal(item.analysis_decision, 'not_recommended');
    assert.equal(item.screening.id, before.screening.id);
    assert.equal(item.screening.data.reason, before.screening.data.reason);
    if (outcome !== 'needs_fulltext') assert.equal(item.screening.feedback.accuracy.value, 'positive');
    else assert.deepEqual(item.screening.feedback, {});
    assert.equal(item.version.kind, 'analysis');
    assert.equal(item.version.data.decision, 'not_recommended');
    if (outcome !== 'needs_fulltext') assert.equal(item.version.feedback.accuracy.expected_outcome, outcome);
    else assert.deepEqual(item.version.feedback, {});
    const ref = item.screening.evidence_index[0].id;
    assert(f.daily.evidence(item.screening.id, ref).text);
  });
}

void test('v3 migration restores original lists without changing reports, feedback, or report versions', async (t) => {
  const f = await fixture(t, {
    count: 1,
    outcome: 'recommended',
    finalDecision: 'not_recommended',
  });
  const run = await f.finish(f.create().run.id);
  const item = await f.detail(f.daily.items(run.id).items[0].id);
  f.daily.feedback(item.screening.id, 'accuracy', { value: 'positive' });
  f.db.setFeedback(item.analysis_id, 'reason', {
    value: 'negative',
    reason: '仍然感兴趣',
  });
  const stored = f.repo.get('daily_items', item.id);
  stored.final_decision = 'not_recommended';
  stored.decision_basis = 'full_text';
  delete stored.analysis_decision;
  f.repo.saveItem(stored);
  f.db.db.exec('PRAGMA user_version=3');
  const preservedTables = [
    'daily_item_versions',
    'results',
    'feedback',
    'daily_feedback',
    'jobs',
    'daily_reports',
    'daily_runs',
    'discussions',
    'discussion_turns',
  ];
  const contents = () =>
    preservedTables.map((table) =>
      JSON.stringify(
        f.db.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
      ),
    );
  const before = contents();
  migrateDailyListDecisions(f.db.db);
  assert.deepEqual(contents(), before);
  assert.equal(f.daily.getItem(item.id).final_decision, 'recommended');
  assert.equal(f.daily.getItem(item.id).analysis_decision, 'not_recommended');
  assert.equal(
    f.db.db.prepare('SELECT decision FROM daily_items WHERE id=?').get(item.id)
      .decision,
    'recommended',
  );
  const upgraded = JSON.stringify(f.repo.get('daily_items', item.id));
  migrateDailyListDecisions(f.db.db);
  f.daily.syncAnalysis(f.db.job(item.job_id));
  assert.equal(JSON.stringify(f.repo.get('daily_items', item.id)), upgraded);
  assert.equal(f.daily.items(run.id, { decision: 'recommended' }).total, 1);
  assert.equal(f.daily.items(run.id, { decision: 'not_recommended' }).total, 0);
});

void test('full-text UI opinion explicitly preserves the recommendation even when negative or uncertain', () => {
  for (const opinion of ['not_recommended', 'undetermined']) {
    const notice = analysisDecisionNotice({
      final_decision: 'recommended',
      analysis_decision: opinion,
    });
    assert.match(notice, /全文补充意见/);
    assert.match(notice, /保留在推荐列表/);
  }
  assert.equal(analysisDecisionNotice({ final_decision: 'recommended' }), null);
});
