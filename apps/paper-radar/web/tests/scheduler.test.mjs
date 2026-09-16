import { DATABASE_VERSION } from '../server/storage/migrations.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  fixture,
  subject,
  feed,
  xmlEntry,
  subscription,
} from './helpers/daily-fixture.mjs';
import { parseFeed } from '../server/daily/discovery.mjs';
import { DailyScheduler } from '../server/daily/scheduler/service.mjs';
import { DailyService } from '../server/daily/service.mjs';
import { sourceScope } from '../server/daily/scheduler/source-check.mjs';
import {
  nextOccurrence,
  validTimezone,
  localParts,
} from '../server/daily/scheduler/clock.mjs';
import { createModelServer } from '../server/index.mjs';
import { AnalysisError } from '../server/analyses/contracts.mjs';

async function setup(t, options = {}) {
  const f = await fixture(t, { count: 2, ...options });
  let ms = Date.parse('2026-09-08T05:00:00Z');
  const scheduler = new DailyScheduler(f.daily, {
    clock: () => ms,
    cooldownMs: 0,
    ...options.scheduler,
  });
  t.after(() => scheduler.close());
  let current = f.revision,
    reads = 0;
  const original = f.daily.persona.screeningSnapshot.bind(f.daily.persona);
  f.daily.persona.screeningSnapshot = async (...args) => {
    reads++;
    return original(...args);
  };
  f.daily.discovery.latest = async () => current;
  async function finishCheck(id) {
    for (let i = 0; i < 3000; i++) {
      const c = scheduler.repo.getCheck(id);
      if (!['queued', 'checking'].includes(c.status)) return c;
      await delay(2);
    }
    throw new Error('Check did not finish');
  }
  return {
    f,
    scheduler,
    finishCheck,
    get current() {
      return current;
    },
    set current(v) {
      current = v;
    },
    get reads() {
      return reads;
    },
    advance(n) {
      ms += n;
    },
    get now() {
      return ms;
    },
    async enable(extra = {}) {
      return scheduler.save(f.sub.id, {
        expected_revision: scheduler.settings(f.sub.id).revision,
        enabled: true,
        local_time: '07:30',
        timezone: 'Europe/Vienna',
        max_model_calls_24h: 200,
        ...extra,
      });
    },
    async check(key = 'check-' + randomUUID()) {
      return finishCheck(scheduler.check(f.sub.id, key).check.id);
    },
    revise(xml) {
      current = f.repo.archiveFeed({
        ...parseFeed(xml, subject),
        xml,
        url: 'https://rss.arxiv.org/atom/' + subject,
      })[0];
      return current;
    },
  };
}

for (const [name, alter] of [
  ['identical feed', (xml) => xml],
  [
    'generated timestamp changes',
    (xml) => xml.replace('2026-09-07T04:00:00Z', '2026-09-08T14:30:00Z'),
  ],
  [
    'entry order changes',
    () => feed(xmlEntry('2501.10001') + xmlEntry('2501.10000')),
  ],
])
  void test(`unchanged content: ${String(name)} creates no runs, Persona reads or model calls`, async (t) => {
    const s = await setup(t),
      first = await s.check();
    assert.equal(first.outcome, 'admitted');
    await s.f.finish(first.run_id);
    const n = s.f.calls,
      r = s.reads,
      runs = s.f.repo.runs().length;
    const xml = feed(xmlEntry('2501.10000') + xmlEntry('2501.10001'));
    s.revise(alter(xml));
    const second = await s.check();
    assert.equal(second.outcome, 'no_update');
    assert.equal(s.f.calls, n);
    assert.equal(s.reads, r);
    assert.equal(s.f.repo.runs().length, runs);
  });

void test('new paper reuses unchanged successful results; no automatic full reports', async (t) => {
  const s = await setup(t);
  const a = await s.check();
  await s.f.finish(a.run_id);
  const calls = s.f.calls;
  s.revise(
    feed(
      xmlEntry('2501.10000') + xmlEntry('2501.10001') + xmlEntry('2501.10002'),
    ),
  );
  const b = await s.check();
  assert.equal(b.outcome, 'admitted');
  const run = await s.f.finish(b.run_id);
  assert.equal(run.stats.total, 3);
  assert.equal(s.f.calls, calls + 1);
  assert.equal(s.f.db.db.prepare('SELECT count(*) n FROM jobs').get().n, 0);
  assert.equal((await s.check()).outcome, 'no_update');
});
void test('abstract correction triggers one new analysis and unchanged metadata is cached', async (t) => {
  const s = await setup(t);
  const a = await s.check();
  await s.f.finish(a.run_id);
  const calls = s.f.calls;
  s.revise(
    feed(
      xmlEntry('2501.10000').replace('A controlled model', 'A revised model') +
        xmlEntry('2501.10001'),
    ),
  );
  const b = await s.check();
  await s.f.finish(b.run_id);
  assert.equal(s.f.calls, calls + 1);
});
void test('excluded version updates and removal-only revisions do not invoke a model', async (t) => {
  const s = await setup(t);
  const a = await s.check();
  await s.f.finish(a.run_id);
  const calls = s.f.calls;
  s.revise(
    feed(
      xmlEntry('2501.10000') +
        xmlEntry('2501.10001') +
        xmlEntry('2501.10002', 'replace', 2),
    ),
  );
  assert.equal((await s.check()).outcome, 'no_eligible_change');
  s.revise(feed(xmlEntry('2501.10000')));
  assert.equal((await s.check()).outcome, 'no_eligible_change');
  assert.equal(s.f.calls, calls);
});
for (const code of [
  'arxiv_unavailable',
  'invalid_feed',
  'announcement_unknown',
])
  void test(`source ${code} is never reported as no update`, async (t) => {
    const s = await setup(t);
    s.f.daily.discovery.latest = async () => {
      throw new AnalysisError(code, 'Source unavailable');
    };
    assert.equal((await s.check()).outcome, 'source_failed');
    assert.equal(s.f.calls, 0);
    assert.equal(s.f.repo.runs().length, 0);
  });
void test('incomplete observation does not advance cursor; recovery admits update', async (t) => {
  const s = await setup(t);
  s.current = {
    ...s.current,
    completeness: 'incomplete',
    issues: ['truncated'],
  };
  assert.equal((await s.check()).outcome, 'source_incomplete');
  assert.equal(s.scheduler.repo.cursor(s.f.sub.id, sourceScope(s.f.sub)), null);
  s.current = s.f.revision;
  const c = await s.check();
  assert.equal(c.outcome, 'admitted');
  await s.f.finish(c.run_id);
});
void test('multi-category dates must agree; different subscribers retain independent baselines', async (t) => {
  const s = await setup(t);
  const sub2 = await s.f.daily.saveSubscription({
    ...subscription,
    name: 'Two subjects',
    subjects: [subject, 'quant-ph'],
  });
  const xml = feed(xmlEntry('2501.10005', 'new', 1, '2026-09-08')).replaceAll(
    subject,
    'quant-ph',
  );
  const q = s.f.repo.archiveFeed({
    ...parseFeed(xml, 'quant-ph'),
    xml,
    url: 'https://rss.arxiv.org/atom/quant-ph',
  })[0];
  s.f.daily.discovery.latest = async (id) =>
    id === subject ? s.f.revision : q;
  const c = await s.finishCheck(
    s.scheduler.check(sub2.id, 'multi-check-001').check.id,
  );
  assert.equal(c.outcome, 'source_incomplete');
  assert.equal(s.f.calls, 0);
  const single = await s.check();
  await s.f.finish(single.run_id);
  const sub3 = await s.f.daily.saveSubscription({
    ...subscription,
    name: 'Independent',
  });
  const another = await s.finishCheck(
    s.scheduler.check(sub3.id, 'single-another-001').check.id,
  );
  assert.equal(another.outcome, 'admitted');
  await s.f.finish(another.run_id);
});
void test('manual and scheduled discovery race uses one analysis run', async (t) => {
  const s = await setup(t, { modelDelay: 5 });
  const manual = s.f.create('manual-competes');
  const c = await s.check();
  const a = await s.f.finish(manual.run.id);
  if (c.run_id) await s.f.finish(c.run_id);
  assert.equal(s.f.calls, 2);
  assert.equal(s.f.repo.runs().length, 1);
  assert.equal(s.f.daily.getRun(c.run_id).id, s.f.daily.getRun(a.id).id);
});
void test('immediate check concurrency, request replay and mismatched keys', async (t) => {
  const s = await setup(t);
  const a = s.scheduler.check(s.f.sub.id, 'repeat-check-key');
  const b = s.scheduler.check(s.f.sub.id, 'other-check-key');
  assert.equal(a.check.id, b.check.id);
  const done = await s.finishCheck(a.check.id);
  await s.f.finish(done.run_id);
  assert.equal(
    s.scheduler.check(s.f.sub.id, 'repeat-check-key').check.id,
    a.check.id,
  );
  assert.throws(
    () =>
      s.scheduler.check(s.f.sub.id, 'repeat-check-key', { scheduled: true }),
    (e) => e.code === 'conflict',
  );
  assert.equal(s.f.calls, 2);
});
void test('schedule edits, disable/re-enable, model and Persona changes do not rerun unchanged sources', async (t) => {
  const s = await setup(t);
  await s.enable();
  const a = await s.check();
  await s.f.finish(a.run_id);
  const calls = s.f.calls;
  await s.enable({ local_time: '08:30', timezone: 'America/New_York' });
  await s.enable({ enabled: false });
  await s.enable();
  s.f.models.store.state.settings.connections[0].revision = 'new-model';
  await s.f.daily.saveSubscription(
    {
      expected_revision: s.f.sub.revision,
      recommendation_strictness: 'focused',
    },
    s.f.sub.id,
  );
  assert.equal((await s.check()).outcome, 'no_update');
  assert.equal(s.f.calls, calls);
});
void test('first scheduled check reuses existing compatible manual report', async (t) => {
  const s = await setup(t);
  const m = s.f.create();
  await s.f.finish(m.run.id);
  const calls = s.f.calls;
  await s.enable();
  const c = await s.check();
  assert.equal(c.outcome, 'existing_result');
  assert.equal(c.run_id, m.run.id);
  assert.equal(s.f.calls, calls);
});
void test('normalizer baseline upgrade does not manufacture updates', async (t) => {
  const s = await setup(t);
  const c = await s.check();
  await s.f.finish(c.run_id);
  const cur = s.scheduler.repo.cursor(s.f.sub.id, sourceScope(s.f.sub));
  cur.version = 'older-normalizer';
  cur.content_hash = 'old-hash';
  s.scheduler.repo.saveCursor(s.f.sub.id, sourceScope(s.f.sub), cur);
  const calls = s.f.calls;
  assert.equal((await s.check()).outcome, 'baseline_rebuilt');
  assert.equal(s.f.calls, calls);
});
void test('budget exhaustion pauses all candidates; time replenishment never resumes unchanged update', async (t) => {
  const s = await setup(t);
  await s.enable({ max_model_calls_24h: 1 });
  const a = await s.check();
  const run = await s.f.finish(a.run_id);
  assert.equal(run.status, 'paused');
  assert.equal(run.stats.total, 2);
  assert.equal(s.f.calls, 1);
  assert.equal(s.scheduler.repo.used(s.f.sub.id), 1);
  s.advance(86400001);
  assert.equal(s.scheduler.repo.used(s.f.sub.id), 0);
  assert.equal((await s.check()).outcome, 'no_update');
  assert.equal(s.f.calls, 1);
  const resumed = s.scheduler.process(a.update_id, 'explicit-resume-key');
  await s.f.finish(resumed.run.id);
  assert.equal(s.f.calls, 2);
});
void test('discovery under exhausted rolling budget records blocked update without run', async (t) => {
  const s = await setup(t, { count: 1 });
  await s.enable({ max_model_calls_24h: 1 });
  const a = await s.check();
  await s.f.finish(a.run_id);
  s.revise(feed(xmlEntry('2501.10002', 'new', 1, '2026-09-08')));
  const b = await s.check();
  assert.equal(b.outcome, 'blocked_budget');
  assert.equal(b.run_id, null);
  assert.equal(s.f.repo.runs().length, 1);
  s.advance(86400001);
  assert.equal((await s.check()).outcome, 'no_update');
  assert.equal(s.f.calls, 1);
  const r = s.scheduler.process(b.update_id, 'process-blocked-update');
  await s.f.finish(r.run.id);
  assert.equal(s.f.calls, 2);
  assert.equal(
    s.scheduler.process(b.update_id, 'process-blocked-update').run.id,
    r.run.id,
  );
});
void test('concurrent reservations cannot exceed final slot or partially increment run budget', async (t) => {
  const s = await setup(t);
  await s.enable({ max_model_calls_24h: 1 });
  const run = s.f.daily.prepareStoredRun(s.f.sub, s.current, {
    kind: 'scheduled',
  });
  s.f.repo.analysisDb.transaction(() =>
    s.f.daily.admitStoredRevision(run, s.current),
  );
  run.status = 'running';
  s.f.repo.saveRun(run);
  const item = s.f.repo.items(run.id)[0];
  s.scheduler.repo.reserve(run, item, { id: 'budget-one' });
  assert.throws(
    () => s.scheduler.repo.reserve(run, item, { id: 'budget-two' }),
    (e) => e.code === 'budget_exceeded',
  );
  assert.equal(s.f.repo.get('daily_runs', run.id).actual_attempts, 1);
  assert.equal(s.scheduler.repo.used(s.f.sub.id), 1);
});
void test('cancelled and deleted reports retain source consumption and rolling allowance', async (t) => {
  const s = await setup(t, { modelDelay: 5 });
  const c = await s.check();
  s.f.daily.cancel(c.run_id);
  await s.f.finish(c.run_id);
  const n = s.f.calls;
  assert.equal((await s.check()).outcome, 'no_update');
  assert.equal(s.f.calls, n);
  await s.f.daily.deleteReport(s.f.daily.getRun(c.run_id).report_id);
  assert.equal(s.scheduler.repo.getUpdate(c.update_id).status, 'dismissed');
  assert.equal((await s.check()).outcome, 'no_update');
  assert.equal(s.f.repo.runs().length, 0);
  assert.throws(
    () => s.scheduler.process(c.update_id, 'process-deleted-key'),
    (e) => e.code === 'invalid_request',
  );
});
void test('a new source does not implicitly retry unchanged failed candidates', async (t) => {
  const s = await setup(t, {
    mutateModel: (out) => {
      out.text = 'invalid';
    },
  });
  const a = await s.check();
  await s.f.finish(a.run_id);
  const n = s.f.calls;
  s.revise(
    feed(
      xmlEntry('2501.10000') + xmlEntry('2501.10001') + xmlEntry('2501.10002'),
    ),
  );
  const b = await s.check();
  await s.f.finish(b.run_id);
  assert.equal(
    s.f.repo
      .items(b.run_id)
      .filter((i) => i.execution_policy === 'manual_resume_required').length,
    2,
  );
  assert.equal(s.f.calls, n + 1);
});
void test('older dates and source revision rollback cannot repeat consumed analyses', async (t) => {
  const s = await setup(t);
  const a = await s.check();
  await s.f.finish(a.run_id);
  const original = s.current;
  s.revise(
    feed(
      xmlEntry('2501.10000') + xmlEntry('2501.10001') + xmlEntry('2501.10002'),
    ),
  );
  const b = await s.check();
  await s.f.finish(b.run_id);
  const n = s.f.calls;
  s.current = original;
  assert.equal((await s.check()).outcome, 'existing_result');
  assert.equal(s.f.calls, n);
  s.revise(feed(xmlEntry('2501.10000', 'new', 1, '2026-09-06')));
  assert.equal((await s.check()).outcome, 'stale_source');
  assert.equal(s.f.calls, n);
});
void test('settings changed during discovery prevent late scheduled admission', async (t) => {
  const s = await setup(t);
  await s.enable();
  let release;
  s.f.daily.discovery.latest = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const c = s.scheduler.check(s.f.sub.id, 'late-config-key', {
    scheduled: true,
  });
  await delay(2);
  await s.enable({ enabled: false });
  release(s.current);
  assert.equal(
    (await s.finishCheck(c.check.id)).outcome,
    'configuration_changed',
  );
  assert.equal(s.f.calls, 0);
});
void test('restart preserves queued work, interrupts running work and retains unknown reservations', async (t) => {
  const s = await setup(t);
  const run = s.f.daily.prepareStoredRun(s.f.sub, s.current, {
    kind: 'scheduled',
  });
  s.f.repo.analysisDb.transaction(() =>
    s.f.daily.admitStoredRevision(run, s.current),
  );
  run.status = 'running';
  s.f.repo.saveRun(run);
  const item = s.f.repo.items(run.id)[0];
  s.scheduler.repo.reserve(run, item, { id: 'unknown-platform-attempt' });
  s.revise(feed(xmlEntry('2501.10004', 'new', 1, '2026-09-08')));
  const queued = s.f.daily.prepareStoredRun(s.f.sub, s.current, {
    kind: 'scheduled',
  });
  s.f.repo.analysisDb.transaction(() =>
    s.f.daily.admitStoredRevision(queued, s.current),
  );
  await s.scheduler.close();
  await s.f.daily.close();
  await s.f.db.close();
  await s.f.db.open();
  const daily = new DailyService(s.f.analyses, {
    discovery: s.f.daily.discovery,
  });
  const scheduler = new DailyScheduler(daily, { clock: () => s.now });
  try {
    assert.equal(
      s.f.db.db
        .prepare('SELECT status FROM automatic_attempt_reservations')
        .get().status,
      'unknown',
    );
    assert.equal(scheduler.repo.used(s.f.sub.id), 1);
    assert.equal(daily.getRun(run.id).status, 'interrupted');
    assert.equal(daily.getRun(queued.id).status, 'queued');
    daily.start();
    await daily.work;
    assert.equal(daily.getRun(queued.id).status, 'completed');
    assert.equal(daily.getRun(run.id).status, 'interrupted');
    assert.equal(s.f.calls, 1);
    assert.equal(scheduler.repo.used(s.f.sub.id), 2);
  } finally {
    await scheduler.close();
    await daily.close();
  }
});
void test('admission failure rolls back the cursor, update ledger and new report together', async (t) => {
  const s = await setup(t);
  const admit = s.f.daily.admitStoredRevision.bind(s.f.daily);
  s.f.daily.admitStoredRevision = (...args) => {
    admit(...args);
    throw new Error('Injected transaction failure');
  };
  assert.equal((await s.check()).outcome, 'admission_failed');
  assert.equal(s.f.repo.runs().length, 0);
  assert.equal(s.scheduler.repo.updates(s.f.sub.id).length, 0);
  assert.equal(s.scheduler.repo.cursor(s.f.sub.id, sourceScope(s.f.sub)), null);
  assert.equal(s.f.calls, 0);
  s.f.daily.admitStoredRevision = admit;
  const c = await s.check();
  assert.equal(c.outcome, 'admitted');
  await s.f.finish(c.run_id);
});
void test('checking unchanged sources while analysis runs does not start a second task', async (t) => {
  const s = await setup(t, { modelDelay: 40 });
  const first = await s.check();
  assert.ok(
    ['queued', 'running'].includes(s.f.daily.getRun(first.run_id).status),
  );
  assert.equal((await s.check()).outcome, 'no_update');
  await s.f.finish(first.run_id);
  assert.equal(s.f.repo.runs().length, 1);
  assert.equal(s.f.calls, 2);
  assert.equal(s.reads, 1);
});
void test('pending update pagination filters before limiting so old blocked work remains reachable', async (t) => {
  const s = await setup(t);
  const base = {
    subscription_id: s.f.sub.id,
    scope_key: sourceScope(s.f.sub),
    date: '2026-09-07',
    created_at: new Date(s.now).toISOString(),
    run_id: null,
    subscription_snapshot: s.f.sub,
  };
  for (let i = 0; i < 115; i++)
    s.scheduler.repo.saveUpdate({
      ...base,
      id: 'test-update-' + i,
      content_hash: String(i),
      status: i < 11 ? 'blocked_budget' : 'no_eligible_change',
    });
  assert.equal(s.scheduler.listUpdates(s.f.sub.id, 10, 0, true).length, 10);
  const tail = s.scheduler.listUpdates(s.f.sub.id, 10, 10, true);
  assert.equal(tail.length, 1);
  assert.equal(tail[0].id, 'test-update-0');
  assert.equal(tail[0].needs_action, true);
  assert.equal('subscription_snapshot' in tail[0], false);
});
void test('malformed settings leave the automatic switch off', async (t) => {
  const s = await setup(t);
  for (const value of [
    null,
    [],
    { expected_revision: 0, local_time: null },
    { expected_revision: 0, timezone: 42 },
  ])
    await assert.rejects(s.scheduler.save(s.f.sub.id, value), {
      code: 'invalid_settings',
    });
  assert.equal(s.scheduler.settings(s.f.sub.id).enabled, false);
  assert.equal(s.scheduler.settings(s.f.sub.id).revision, 0);
  delete s.f.models.store.state.settings.dsh;
  await assert.rejects(s.enable(), { code: 'unsupported_host_snapshot' });
  assert.equal(s.scheduler.settings(s.f.sub.id).enabled, false);
});
void test('due checks coalesce missed days and no-update rechecks are finite', async (t) => {
  const s = await setup(t, { scheduler: { maxRechecks: 1, recheckMs: 60000 } });
  await s.enable();
  s.advance(4 * 86400000);
  await s.scheduler.tick();
  const first = s.scheduler.repo.checks(s.f.sub.id, 1)[0];
  const c = await s.finishCheck(first.id);
  await s.f.finish(c.run_id);
  assert.equal(s.scheduler.repo.checks(s.f.sub.id).length, 1);
  s.advance(86400000);
  await s.scheduler.tick();
  const d = await s.finishCheck(s.scheduler.repo.checks(s.f.sub.id, 1)[0].id);
  assert.equal(d.outcome, 'no_update');
  s.advance(60000);
  await s.scheduler.tick();
  const e = await s.finishCheck(s.scheduler.repo.checks(s.f.sub.id, 1)[0].id);
  assert.equal(e.check_index, 1);
  s.advance(60000);
  await s.scheduler.tick();
  assert.equal(s.scheduler.repo.checks(s.f.sub.id).length, 3);
});
void test('IANA time validation, spring gap, fall repeat and non-hour zone scheduling', () => {
  assert.equal(validTimezone('garbage'), false);
  assert.equal(
    nextOccurrence(
      Date.parse('2026-03-28T23:00:00Z'),
      '02:30',
      'Europe/Vienna',
    ),
    '2026-03-29T01:00:00.000Z',
  );
  assert.equal(
    nextOccurrence(
      Date.parse('2026-10-24T23:00:00Z'),
      '02:30',
      'Europe/Vienna',
    ),
    '2026-10-25T00:30:00.000Z',
  );
  assert.equal(
    nextOccurrence(
      Date.parse('2026-10-25T00:31:00Z'),
      '02:30',
      'Europe/Vienna',
    ),
    '2026-10-26T01:30:00.000Z',
  );
  assert.equal(
    localParts(
      Date.parse(
        nextOccurrence(
          Date.parse('2026-09-08T00:00:00Z'),
          '07:30',
          'Asia/Kathmandu',
        ),
      ),
      'Asia/Kathmandu',
    ).time,
    '07:30',
  );
});
void test('scheduler API protects origin, validates revisions, persists settings, and exposes capability', async (t) => {
  const s = await setup(t);
  const server = createModelServer(s.f.models, {
    daily: s.f.daily,
    analyses: s.f.analyses,
    publicDirectory: '/tmp/nonexistent',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal(
    (await (await fetch(base + '/api/capabilities')).json()).daily_scheduler,
    true,
  );
  const url = base + `/api/subscriptions/${s.f.sub.id}/schedule`;
  const body = {
    expected_revision: 0,
    enabled: true,
    local_time: '07:30',
    timezone: 'Europe/Vienna',
    max_model_calls_24h: 2,
  };
  const request = (extra = {}) => ({
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'X-Paper-Radar': '1',
      ...extra,
    },
    body: JSON.stringify(body),
  });
  assert.equal(
    (await fetch(url, request({ Origin: 'https://other.example' }))).status,
    403,
  );
  assert.equal((await fetch(url, request())).status, 200);
  assert.equal((await fetch(url, request())).status, 409);
  const status = await (await fetch(url)).json();
  assert.equal(status.schedule.enabled, true);
  const res = await fetch(url + '/check', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Paper-Radar': '1',
      'Idempotency-Key': 'http-schedule-check',
    },
    body: '{}',
  });
  assert.equal(res.status, 202);
  const c = (await res.json()).check;
  const done = await s.finishCheck(c.id);
  await s.f.finish(done.run_id);
  assert.equal(
    'subscription_snapshot' in
      (await (await fetch(base + '/api/schedule-checks/' + c.id)).json()).check,
    false,
  );
  assert.equal(s.f.db.db.prepare('PRAGMA user_version').get().user_version, DATABASE_VERSION);
  assert.equal(s.f.db.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
