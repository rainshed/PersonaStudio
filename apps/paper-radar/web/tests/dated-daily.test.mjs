import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, feed, xmlEntry, subject } from './helpers/daily-fixture.mjs';
import { DailyDiscovery, parseFeed } from '../server/daily/discovery.mjs';
import { mergeSubjectSources } from '../server/daily/subject-bundle.mjs';
import { dailyRoute } from '../server/daily/http.mjs';
import { runSchema } from '../server/daily/contracts.mjs';
import {
  dailySource,
  isAnnouncementDate,
  matchesDailyDate,
} from '../lib/daily-source.ts';
import { generationNotice } from '../lib/daily-ui.ts';

const past = '2026-09-04';
const dated = (date) => ({ source: { kind: 'announcement_date', date } });
function archive(f, xml, category = subject) {
  return f.repo.archiveFeed({
    ...parseFeed(xml, category),
    xml,
    url: `https://rss.arxiv.org/atom/${category}`,
  });
}
function discovery(f, xml, error) {
  let downloads = 0;
  f.daily.discovery = new DailyDiscovery(
    {
      async download() {
        downloads++;
        if (error) throw error;
        return { bytes: Buffer.from(xml) };
      },
    },
    f.repo,
  );
  return () => downloads;
}

void test('date selection produces a dated source; stored replay and latest remain distinct', () => {
  assert.deepEqual(dailySource(''), { kind: 'latest_announcement' });
  assert.deepEqual(dailySource(past), dated(past).source);
  assert.deepEqual(
    dailySource(past, {
      batch_id: 'batch',
      revision_id: 'revision',
      date: past,
    }),
    {
      kind: 'stored_batch',
      batch_id: 'batch',
      revision_id: 'revision',
    },
  );
  assert.equal(
    matchesDailyDate({ ...dated(past), date: past }, '2026-09-07'),
    false,
  );
  assert.equal(matchesDailyDate({ ...dated(past), date: past }, ''), false);
  assert.equal(
    matchesDailyDate(
      { source: { kind: 'latest_announcement' }, date: past },
      past,
    ),
    true,
  );
  assert.equal(isAnnouncementDate('2024-02-29'), true);
  for (const date of ['2026-02-29', '2026-02-31', '2026-9-4', 'bad'])
    assert.equal(isAnnouncementDate(date), false);
});

void test('dated creation rejects impossible and future dates before creating jobs', async (t) => {
  const f = await fixture(t);
  for (const date of ['2026-02-31', '2026-02-29', '9999-01-01'])
    assert.throws(() => f.create('invalid-' + date, dated(date)), /日期/);
  assert.equal(f.repo.runs({ subscriptionId: f.sub.id }).length, 0);
  assert.equal(
    runSchema.safeParse({
      subscription_id: f.sub.id,
      expected_subscription_revision: 1,
      source: { kind: 'announcement_date', date: past, extra: true },
    }).success,
    false,
  );
});

void test('a saved historical announcement generates the requested report offline and reuses its result', async (t) => {
  const f = await fixture(t);
  const saved = archive(f, feed(xmlEntry('2501.54321', 'new', 1, past)))[0];
  const downloads = discovery(f, '', new Error('offline'));
  const created = f.create('historical-create', dated(past));
  assert.equal(created.run.date, past);
  assert.match(generationNotice(created.run), new RegExp(past));
  const run = await f.finish(created.run.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.date, past);
  assert.equal(run.discovery.revision_id, saved.id);
  assert.equal(f.repo.items(run.id)[0].paper.id, '2501.54321');
  assert.equal(downloads(), 0);
  const calls = f.calls;
  const again = await f.finish(
    f.create('historical-repeat', dated(past)).run.id,
  );
  assert.equal(again.id, run.id);
  assert.equal(f.calls, calls);
  assert.deepEqual(f.repo.reportDates(f.sub.id), [past]);
});

void test('a current feed containing several days selects only the requested day, not its newest group', async (t) => {
  const f = await fixture(t);
  const downloads = discovery(
    f,
    feed(
      xmlEntry('2501.54321', 'new', 1, past) +
        xmlEntry('2501.54322', 'new', 1, '2026-09-07'),
    ),
  );
  const run = await f.finish(f.create('select-feed-day', dated(past)).run.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.date, past);
  assert.deepEqual(
    f.repo.items(run.id).map((i) => i.paper.id),
    ['2501.54321'],
  );
  assert.equal(downloads(), 1);
  assert.ok(f.repo.announcementForDate(subject, '2026-09-07'));
});

void test('an unavailable day fails visibly without an empty report, latest fallback, or model calls', async (t) => {
  const f = await fixture(t);
  discovery(f, feed(xmlEntry('2501.54321', 'new', 1, '2026-09-07')));
  const run = await f.finish(f.create('missing-history', dated(past)).run.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.date, past);
  assert.equal(run.report_id, null);
  assert.equal(run.error.code, 'announcement_date_unavailable');
  assert.match(run.error.message, /2026-09-04.*未存档/);
  assert.equal(f.calls, 0);
  assert.deepEqual(f.repo.reportDates(f.sub.id), []);
  assert.equal(f.repo.items(run.id).length, 0);
});

void test('a partial snapshot can be repaired while an older complete snapshot survives later bad reads', async (t) => {
  const f = await fixture(t);
  const good = feed(xmlEntry('2501.54321', 'new', 1, past));
  const bad = feed(
    xmlEntry('2501.54321', 'new', 1, past) +
      xmlEntry('2501.54322', 'new', 1, past).replace(/<title>.*?<\/title>/, ''),
  );
  assert.equal(archive(f, bad)[0].completeness, 'incomplete');
  const downloads = discovery(f, good);
  const repaired = await f.daily.discovery.byDate(
    subject,
    past,
    new AbortController().signal,
  );
  assert.equal(repaired.completeness, 'complete');
  assert.equal(downloads(), 1);
  archive(f, bad);
  assert.equal(f.repo.announcementForDate(subject, past).id, repaired.id);
  await f.daily.discovery.byDate(subject, past, new AbortController().signal);
  assert.equal(downloads(), 1);
});

void test('different requested dates are independent, and duplicate clicks on one date share the active task', async (t) => {
  const f = await fixture(t, { modelDelay: 15 });
  archive(f, feed(xmlEntry('2501.54321', 'new', 1, past)));
  discovery(f, '', new Error('offline'));
  const first = f.create('first-date-create', dated(past));
  const duplicate = f.create('first-date-duplicate', dated(past));
  const second = f.create('second-date-create', dated('2026-09-07'));
  assert.equal(duplicate.run.id, first.run.id);
  assert.notEqual(second.run.id, first.run.id);
  assert.equal((await f.finish(first.run.id)).date, past);
  assert.equal((await f.finish(second.run.id)).date, '2026-09-07');
  assert.deepEqual(f.repo.reportDates(f.sub.id), ['2026-09-07', past]);
});

void test('multi-subject date requests exclude other dates and expose incomplete coverage', async (t) => {
  const f = await fixture(t);
  const other = 'quant-ph';
  const correct = archive(f, feed(xmlEntry('2501.54321', 'new', 1, past)))[0];
  const foreignXml = feed(
    xmlEntry('2501.54322', 'new', 1, '2026-09-03'),
  ).replaceAll(subject, other);
  const foreign = archive(f, foreignXml, other)[0];
  const bundle = mergeSubjectSources(
    [subject, other],
    [
      { subject, revision: correct },
      { subject: other, revision: foreign },
    ],
    past,
  );
  assert.equal(bundle.date, past);
  assert.equal(bundle.completeness, 'incomplete');
  assert.deepEqual(
    bundle.papers.map((p) => p.id),
    ['2501.54321'],
  );
  assert.equal(
    bundle.sources.find((s) => s.subject === other).status,
    'different_date',
  );
  assert.throws(
    () =>
      mergeSubjectSources(
        [other],
        [{ subject: other, revision: foreign }],
        past,
      ),
    /均不可用/,
  );
  const sub = await f.daily.saveSubscription(
    { expected_revision: f.sub.revision, subjects: [subject, other] },
    f.sub.id,
  );
  discovery(f, '', new Error('offline'));
  const request = {
    subscription_id: sub.id,
    expected_subscription_revision: sub.revision,
    ...dated(past),
  };
  const response = await dailyRoute(
    f.daily,
    { method: 'POST', headers: { 'idempotency-key': 'date-http-request' } },
    new URL('http://localhost/api/daily-runs'),
    async () => request,
  );
  assert.equal(response.status, 202);
  const run = await f.finish(response.body.run.id);
  assert.equal(run.status, 'partial');
  assert.equal(run.date, past);
  assert.equal(
    run.discovery.sources.find((s) => s.subject === other).status,
    'failed',
  );
  assert.deepEqual(f.repo.availableAnnouncementDates([subject, other]), []);
  archive(f, foreignXml.replaceAll('2026-09-03', past), other);
  assert.deepEqual(f.repo.availableAnnouncementDates([subject, other]), [past]);
  const dates = await dailyRoute(
    f.daily,
    { method: 'GET', headers: {} },
    new URL(
      `http://localhost/api/daily-reports?subscription_id=${sub.id}&date=2026-09-03`,
    ),
  );
  assert.deepEqual(dates.body.available_dates, [past]);
  assert.equal(dates.body.reports.length, 0);
});

void test('source date mismatch is rejected before binding even for a single subject', async (t) => {
  const f = await fixture(t);
  f.daily.discovery.byDate = async () => f.revision;
  const run = await f.finish(f.create('bad-date-provider', dated(past)).run.id);
  assert.equal(run.error.code, 'invalid_source');
  assert.equal(run.report_id, null);
  assert.equal(f.calls, 0);
});
