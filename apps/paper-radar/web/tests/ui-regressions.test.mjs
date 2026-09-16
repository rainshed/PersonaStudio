import { test } from 'node:test';
import assert from 'node:assert/strict';
import { academicName } from '../lib/academic-text.ts';
import {
  defaultLocation,
  radarHash,
  readRadarLocation,
} from '../lib/radar-location.ts';
import {
  generationNotice,
  emptyDailyMessage,
  detailStatus,
  screeningHeading,
} from '../lib/daily-ui.ts';
import { fixture } from './helpers/daily-fixture.mjs';
import { dailyRoute } from '../server/daily/http.mjs';

const run = (status, extra = {}) => ({
  status,
  date: '2026-09-07',
  message: '',
  stats: { total: 4, pending: 4 },
  discovery: { date: '2026-09-07' },
  ...extra,
});
void test('generation reuse describes cancelled, completed and running tasks truthfully', () => {
  assert.match(generationNotice(run('cancelled'), true), /已取消.*继续未完成/);
  assert.doesNotMatch(generationNotice(run('cancelled'), true), /仍会继续/);
  assert.match(generationNotice(run('completed'), true), /2026-09-07.*已完成/);
  assert.match(generationNotice(run('running'), true), /初筛.*仍会继续/);
  assert.match(
    generationNotice(run('queued', { discovery: null })),
    /正在检查/,
  );
});
void test('empty results distinguish discovery, cancellation, failures and completed results', () => {
  assert.match(
    emptyDailyMessage(
      run('running', { discovery: null, stats: { total: 0 } }),
      'unscreened',
    ).title,
    /读取/,
  );
  assert.doesNotMatch(
    emptyDailyMessage(run('cancelled'), 'recommended').description,
    /仍在处理/,
  );
  assert.match(
    emptyDailyMessage(
      run('failed', { error: { message: 'Provider offline' } }),
      'recommended',
    ).description,
    /Provider offline/,
  );
  assert.match(
    emptyDailyMessage(run('completed'), 'unscreened').title,
    /全部完成/,
  );
  assert.match(
    emptyDailyMessage(run('completed'), 'recommended', 'no match').description,
    /搜索词/,
  );
  assert.match(detailStatus('partial'), /部分完成/);
  assert.match(detailStatus('queued'), /排队/);
  assert.equal(
    screeningHeading({ final_decision: null, screening: null }),
    '初筛进度',
  );
  assert.equal(
    screeningHeading({ final_decision: null, screening: {} }),
    '关联待确认',
  );
});
void test('URL round trips preserve pages, subscription, date, run and recommendation filter', () => {
  for (const view of [
    'daily',
    'subscriptions',
    'single',
    'models',
    'authors',
  ]) {
    const state = {
      ...defaultLocation,
      view,
      subscription: 'scope with &',
      run: 'run-2',
      date: '2026-09-06',
      filter: 'needs_confirmation',
    };
    assert.deepEqual(readRadarLocation(radarHash(state)), state);
  }
  assert.equal(readRadarLocation('#single-analysis').view, 'single');
  assert.equal(
    readRadarLocation('#daily?date=bad&filter=bad').filter,
    'recommended',
  );
  assert.equal(readRadarLocation('#daily?date=bad').date, '');
  assert.equal(readRadarLocation('#daily?date=2026-02-31').date, '');
});
void test('author names render TeX accents without changing ordinary names or unknown commands', () => {
  assert.equal(
    academicName(String.raw`Martin \'Aron Juh\'asz, Mih\'aly Weiner`),
    'Martin Áron Juhász, Mihály Weiner',
  );
  assert.equal(
    academicName(String.raw`Milo\v{s} Milovanovi\'c`),
    'Miloš Milovanović',
  );
  assert.equal(
    academicName(String.raw`W. A. Z\'u\~niga-Galindo`),
    'W. A. Zúñiga-Galindo',
  );
  assert.equal(academicName(String.raw`Pedro Alc\^antara`), 'Pedro Alcântara');
  assert.equal(
    academicName(String.raw`Bj{\o}rn \AA{}berg and G\"{o}del`),
    'Bjørn Åberg and Gödel',
  );
  assert.equal(
    academicName('John D. Monnier (University of Michigan)'),
    'John D. Monnier (University of Michigan)',
  );
  assert.equal(
    academicName(String.raw`Unknown \command`),
    String.raw`Unknown \command`,
  );
});
void test('unfinished screening and screened-but-uncertain are separate, exhaustive categories', async (t) => {
  const f = await fixture(t, { count: 3, outcome: 'needs_fulltext' });
  const result = await f.finish(f.create().run.id);
  const one = f.repo.items(result.id)[0];
  f.repo.saveItem({
    ...one,
    screening_version_id: null,
    processing_status: 'failed',
  });
  assert.equal(f.daily.items(result.id, { decision: 'unscreened' }).total, 1);
  assert.equal(
    f.daily.items(result.id, { decision: 'needs_confirmation' }).total,
    2,
  );
  assert.equal(f.daily.items(result.id, { decision: 'pending' }).total, 3);
  const stats = f.daily.getRun(result.id).stats;
  assert.equal(stats.screening_pending, 1);
  assert.equal(stats.needs_confirmation, 2);
});
void test('report dates are scoped and independent of the current date filter', async (t) => {
  const f = await fixture(t);
  await f.finish(f.create().run.id);
  assert.deepEqual(f.repo.reportDates(f.sub.id), ['2026-09-07']);
  assert.deepEqual(f.repo.reportDates('different-subscription'), []);
  const response = await dailyRoute(
    f.daily,
    { method: 'GET', headers: {} },
    new URL(
      `http://localhost/api/daily-reports?subscription_id=${f.sub.id}&date=2026-09-06`,
    ),
  );
  assert.equal(response.body.reports.length, 0);
  assert.deepEqual(response.body.dates, ['2026-09-07']);
});
void test('repeating latest after cancellation reuses cancelled run without spending more model calls', async (t) => {
  const f = await fixture(t);
  const initial = await f.finish(f.create().run.id);
  f.repo.saveRun({
    ...f.repo.get('daily_runs', initial.id),
    status: 'cancelled',
  });
  const calls = f.calls;
  const next = await f.finish(f.create('check-again').run.id);
  assert.equal(next.id, initial.id);
  assert.equal(next.status, 'cancelled');
  assert.equal(f.calls, calls);
  assert.match(generationNotice(next, true), /已取消/);
});
