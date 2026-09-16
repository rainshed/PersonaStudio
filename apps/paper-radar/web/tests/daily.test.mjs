import { DATABASE_VERSION } from '../server/storage/migrations.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { AnalysisError } from '../server/analyses/contracts.mjs';
import { DailyService } from '../server/daily/service.mjs';
import { parseFeed } from '../server/daily/discovery.mjs';
import {
  parseScreen,
  validateSubscription,
} from '../server/daily/contracts.mjs';
import { createModelServer } from '../server/index.mjs';

import {
  fixture,
  subject,
  xmlEntry,
  feed,
  record,
  context,
  subscription,
  screen,
} from './helpers/daily-fixture.mjs';

void test('old pending recommendation runs require a new generation without spending model calls', async t => {
  const f = await fixture(t, { count: 1 });
  const created = f.create('legacy-pending-request').run;
  const old = f.repo.get('daily_runs', created.id);
  old.workflow_version = 'screening.v2';
  f.repo.saveRun(old);
  const stopped = await f.finish(old.id);
  assert.equal(stopped.error.code, 'persona_context_changed');
  assert.equal(f.calls, 0);
  const fresh = f.create('new-protocol-request', { force_regenerate: true }).run;
  assert.notEqual(fresh.id, old.id);
  assert.equal((await f.finish(fresh.id)).stats.screened, 1);
  assert.equal(f.repo.get('daily_runs', old.id).error.code, 'persona_context_changed');
});

void test('materials alone cannot satisfy a screening knowledge citation', () => {
  const p = parseFeed(feed(xmlEntry()), subject).groups[0].papers[0];
  const c = structuredClone(context);
  c.records[0].entity_type = 'material';
  assert.throws(() => parseScreen(JSON.stringify(screen(p)), p, c), { code: 'insufficient_context' });
});

void test('announcement date, type and explicit version come from the announcement feed', () => {
  const parsed = parseFeed(
    feed(
      xmlEntry('2501.12903', 'new', 3) +
        xmlEntry('2501.12904', 'replace-cross', 2),
    ),
    subject,
  );
  assert.equal(parsed.groups[0].date, '2026-09-07');
  assert.equal(parsed.groups[0].papers[0].version, 3);
  assert.equal(parsed.groups[0].papers[1].announce_type, 'replace_cross');
  assert.equal(parsed.groups[0].completeness, 'complete');
  assert.equal(
    parseFeed(feed(xmlEntry(), '2026-09-08T09:00:00Z'), subject).groups[0]
      .content_hash,
    parseFeed(feed(xmlEntry()), subject).groups[0].content_hash,
  );
});
void test('truncation, malformed entries, conflicting versions and capacity limits are never complete', () => {
  assert.throws(() =>
    parseFeed(feed(xmlEntry()).replace('</feed>', ''), subject),
  );
  assert.throws(() => parseFeed('<html>error</html>', subject));
  assert.throws(() => parseFeed(feed(''), subject), /不能据此/);
  const conflict = parseFeed(
    feed(xmlEntry() + xmlEntry('2501.12903', 'new', 2)),
    subject,
  ).groups[0];
  assert.equal(conflict.completeness, 'incomplete');
  assert.equal(conflict.papers.length, 1);
  assert.equal(
    parseFeed(feed(xmlEntry() + xmlEntry('bad-id')), subject).groups[0].rejected
      .length,
    1,
  );
  assert.equal(
    parseFeed(feed(xmlEntry().repeat(2000)), subject).groups[0].completeness,
    'incomplete',
  );
});
void test('scope, subject, range and screening evidence are validated', () => {
  assert.throws(() =>
    validateSubscription({ ...subscription, subject: 'https://evil.test' }, [
      { id: subject },
    ]),
  );
  assert.throws(() =>
    validateSubscription(
      { ...subscription, scope: { tag_ids: [], tag_match: 'any' } },
      [{ id: subject }],
    ),
  );
  const paper = parseFeed(feed(xmlEntry()), subject).groups[0].papers[0],
    good = screen(paper);
  assert.deepEqual(parseScreen(JSON.stringify(good), paper, context), { ...good, matched_knowledge_ids: [record.id] });
  assert.throws(() =>
    parseScreen(
      JSON.stringify({ ...good, persona_evidence_ids: ['outside'] }),
      paper,
      context,
    ),
  );
  assert.throws(() =>
    parseScreen(
      JSON.stringify({
        ...good,
        claims: [
          { record_id: record.id, field: 'interest_level', value: 'high' },
        ],
      }),
      paper,
      context,
    ),
  );
});
void test('all candidates get real decisions, no feedback is inferred, and same batch is reused', async (t) => {
  const f = await fixture(t),
    created = f.create();
  const run = await f.finish(created.run.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.stats.total, 3);
  assert.equal(run.stats.not_recommended, 3);
  assert.equal(run.actual_attempts, 3);
  const items = f.daily.items(run.id).items;
  assert(items.every((i) => Object.keys(i.version.feedback).length === 0));
  const again = await f.finish(f.create('another-request').run.id);
  assert.equal(again.id, run.id);
  assert.equal(f.calls, 3);
  assert.throws(
    () => f.create('request-test', { force_regenerate: true }),
    (e) => e.httpStatus === 409,
  );
});
void test('more than fifty candidates are processed without queue truncation', async (t) => {
  const f = await fixture(t, {
    count: 51,
    outcome: 'recommended',
    maxCalls: 400,
  });
  const run = await f.finish(f.create().run.id);
  assert.equal(run.stats.total, 51);
  assert.equal(run.stats.recommended, 51);
  assert.equal(run.stats.details_complete, 0);
  assert.equal(f.db.listJobs().length, 0);
  assert.equal(f.calls, 51);
  assert(
    f.daily
      .items(run.id)
      .items.every(
        (i) =>
          i.details_status === 'not_requested' && i.screening.data.introduction,
      ),
  );
  assert.equal(run.status, 'completed');
});
void test('uncertain papers complete initial screening without full jobs; explicit detail uses independent budget', async (t) => {
  const f = await fixture(t, {
    count: 2,
    outcome: 'needs_fulltext',
    maxCalls: 2,
  });
  const run = await f.finish(f.create().run.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.stats.pending, 2);
  assert.equal(run.stats.screened, 2);
  assert.equal(f.db.listJobs().length, 0);
  assert.equal(f.calls, 2);
  const item = await f.detail(f.daily.items(run.id).items[0].id);
  assert.equal(item.decision_basis, 'abstract');
  assert.equal(item.details_status, 'available');
  assert.equal(f.daily.getRun(run.id).actual_attempts, 2);
  assert.equal(f.daily.getRun(run.id).status, 'completed');
  assert.equal(f.db.job(item.job_id).origin.trigger, 'manual');
  assert.throws(
    () => f.db.deleteResult(item.analysis_id),
    (e) => e.httpStatus === 409,
  );
});
void test('explicit full text preserves a preliminary recommendation despite a negative opinion', async (t) => {
  const f = await fixture(t, {
    count: 1,
    outcome: 'recommended',
    finalDecision: 'not_recommended',
  });
  const run = await f.finish(f.create().run.id);
  assert.equal(run.stats.recommended, 1);
  const item = await f.detail(f.daily.items(run.id).items[0].id);
  assert.equal(item.final_decision, 'recommended');
  assert.equal(item.analysis_decision, 'not_recommended');
  assert.equal(item.decision_basis, 'abstract');
  assert.equal(f.daily.items(run.id, { decision: 'recommended' }).total, 1);
  assert.equal(f.daily.items(run.id, { decision: 'not_recommended' }).total, 0);
  assert.equal(f.daily.getRun(run.id).stats.recommended, 1);
  assert.equal(f.daily.getRun(run.id).status, 'completed');
});
void test('undetermined full analysis preserves the initial recommendation and completed daily status', async (t) => {
  const f = await fixture(t, {
    count: 1,
    outcome: 'recommended',
    finalDecision: 'undetermined',
  });
  const run = await f.finish(f.create().run.id);
  const item = await f.detail(f.daily.items(run.id).items[0].id);
  assert.equal(item.final_decision, 'recommended');
  assert.equal(item.analysis_decision, 'undetermined');
  assert.equal(item.details_status, 'available');
  assert.equal(f.daily.getRun(run.id).status, 'completed');
  assert.equal(f.daily.getRun(run.id).stats.pending, 0);
});
void test('failed screening stays pending and does not fabricate a recommendation decision', async (t) => {
  const f = await fixture(t, {
    count: 1,
    mutateModel(out, req) {
      if (req.task === 'screen') out.text = 'invalid';
    },
  });
  const run = await f.finish(f.create().run.id);
  assert.equal(run.status, 'partial');
  assert.equal(run.stats.pending, 1);
  assert.equal(run.stats.failed, 1);
  assert.equal(f.calls, 1);
});
void test('Persona outage preserves candidates with no model calls and can be retried', async (t) => {
  const f = await fixture(t, { personaError: true });
  const run = await f.finish(f.create().run.id);
  assert.equal(run.status, 'partial');
  assert.equal(run.stats.pending, 3);
  assert.equal(f.calls, 0);
  f.daily.persona.screeningSnapshot = async () => structuredClone(context);
  f.daily.retry(run.id, {}, 'retry-persona');
  assert.equal((await f.finish(run.id)).status, 'completed');
});
void test('run budget pauses without losing candidates and resume uses remaining work only', async (t) => {
  const f = await fixture(t);
  await f.daily.saveSubscription(
    { expected_revision: 1, max_model_calls: 1 },
    f.sub.id,
  );
  f.sub.revision = 2;
  const run = await f.finish(f.create().run.id);
  assert.equal(run.status, 'paused');
  assert.equal(run.stats.total, 3);
  assert.equal(run.stats.not_recommended, 1);
  f.daily.retry(run.id, { max_model_calls: 20 }, 'resume-budget');
  const done = await f.finish(run.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.actual_attempts, 3);
});
void test('recommendation feedback enters the dataset and withdrawal removes it', async (t) => {
  const f = await fixture(t, { count: 1 });
  const run = await f.finish(f.create().run.id),
    item = f.daily.items(run.id).items[0],
    v = item.current_version_id;
  f.daily.feedback(v, 'accuracy', { value: 'negative' });
  assert.equal(f.daily.evaluations.dataset().length, 1);
  assert.throws(() => f.daily.feedback(v, 'reason', {value:'positive'}));
  f.daily.feedback(v, 'accuracy', null);
  assert.equal(f.daily.getVersion(v).feedback.accuracy, undefined);
  assert.equal(f.daily.evaluations.dataset().length, 0);
  assert.throws(() => f.daily.feedback(v, 'summary', { value: 'positive' }));
  const regenerated = await f.finish(
    f.create('regenerate', { force_regenerate: true }).run.id,
  );
  assert.notEqual(regenerated.id, run.id);
  assert.deepEqual(f.daily.items(regenerated.id).items[0].version.feedback, {});
});
void test('manual analysis shares the same paper answer with daily screening', async (t) => {
  const f = await fixture(t, { count: 1 });
  let run = await f.finish(f.create().run.id);
  let item = f.daily.items(run.id).items[0];
  const oldVersion = item.current_version_id;
  f.daily.feedback(oldVersion, 'accuracy', {
    value: 'negative',
    reason: 'Potentially relevant',
  });
  await f.detail(item.id, 'manual-deep-test');
  run = f.daily.getRun(run.id);
  item = f.daily.getItem(item.id);
  assert.equal(run.stats.recommended, 0);
  assert.equal(run.stats.not_recommended, 1);
  assert.equal(run.stats.details_complete, 1);
  assert.equal(item.analysis_decision, 'recommended');
  assert.notEqual(item.current_version_id, oldVersion);
  assert.equal(
    f.daily.getVersion(oldVersion).feedback.accuracy.value,
    'negative',
  );
  assert.equal(item.version.feedback.accuracy.value, 'positive');
  f.daily.feedback(item.current_version_id, 'accuracy', {value:'negative'});
  assert.equal(f.daily.evaluations.dataset().length, 1);
  assert.equal(f.daily.getVersion(oldVersion).feedback.accuracy.value, 'positive');
  assert.equal(f.analyses.getResult(item.analysis_id).feedback.accuracy.value, 'negative');
});
void test('cancellation survives delayed model work and explicit resume processes unfinished candidates', async (t) => {
  const f = await fixture(t, { count: 2, modelDelay: 40 });
  const { run } = f.create();
  await delay(10);
  f.daily.cancel(run.id);
  await delay(60);
  assert.equal(f.daily.getRun(run.id).status, 'cancelled');
  f.daily.retry(run.id, {}, 'resume-cancelled');
  assert.equal((await f.finish(run.id)).status, 'completed');
});
void test('incomplete sources never produce a completed report and subscription edits preserve history', async (t) => {
  const f = await fixture(t, { count: 1 });
  const revised = {
    ...f.revision,
    completeness: 'incomplete',
    issues: ['Source coverage incomplete'],
  };
  f.repo.db
    .prepare('UPDATE arxiv_batch_revisions SET data=? WHERE id=?')
    .run(JSON.stringify(revised), revised.id);
  const run = await f.finish(f.create().run.id);
  assert.equal(run.status, 'partial');
  assert.equal(run.stats.not_recommended, 1);
  await f.daily.saveSubscription(
    { expected_revision: 1, name: 'New name' },
    f.sub.id,
  );
  assert.equal(f.daily.getRun(run.id).subscription.name, 'Transport');
  await assert.rejects(
    () =>
      f.daily.saveSubscription(
        { expected_revision: 1, name: 'Conflict' },
        f.sub.id,
      ),
    (e) => e.httpStatus === 409,
  );
});
void test('deleting a report removes its private analysis and feedback while preserving public sources', async (t) => {
  const f = await fixture(t, { count: 1, outcome: 'recommended' });
  const run = await f.finish(f.create().run.id),
    item = await f.detail(f.daily.items(run.id).items[0].id);
  f.daily.feedback(item.current_version_id, 'accuracy', { value: 'positive' });
  await f.daily.deleteReport(run.report_id);
  assert.equal(f.db.result(item.analysis_id), null);
  assert.equal(f.repo.get('daily_runs', run.id, false), null);
  assert(f.repo.get('arxiv_batch_revisions', f.revision.id));
});
void test('daily HTTP shares origin protection and exposes capabilities, subscriptions and durable tasks', async (t) => {
  const f = await fixture(t, { count: 1 }),
    server = createModelServer(f.models, {
      publicDirectory: tmpdir(),
      analyses: f.analyses,
      daily: f.daily,
    });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal(
    (await (await fetch(base + '/api/capabilities')).json())
      .daily_recommendation,
    true,
  );
  assert.equal(
    (
      await fetch(base + '/api/daily-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (await (await fetch(base + '/api/subscriptions')).json()).subscriptions
      .length,
    1,
  );
  const response = await fetch(base + '/api/daily-runs', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Paper-Radar': '1',
      'Idempotency-Key': 'http-daily-test',
    },
    body: JSON.stringify({
      subscription_id: f.sub.id,
      expected_subscription_revision: 1,
      source: { kind: 'latest_announcement' },
    }),
  });
  assert.equal(response.status, 202);
  const run = await f.finish((await response.json()).run.id);
  const data = await (
    await fetch(base + '/api/daily-runs/' + run.id + '/items')
  ).json();
  assert.equal(data.total, 1);
  const tasks = await (await fetch(base + '/api/tasks')).json();
  assert.equal(tasks.schema, 'paper-radar.task-runtime/v1');
  assert.ok(Array.isArray(tasks.active));
  assert.ok(Array.isArray(tasks.queued));
  assert.ok(Array.isArray(tasks.errors));
  assert.equal(JSON.stringify(tasks).includes('model_settings'), false);
  assert.equal((await fetch(base + '/api/tasks', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/daily-runs?limit=200')).status, 400);
  assert.equal(f.db.db.prepare('PRAGMA user_version').get().user_version, DATABASE_VERSION);
});

void test('updates stay separate by default and an update-only batch can complete with zero model calls', async (t) => {
  const f = await fixture(t, { count: 2 });
  const revision = {
    ...f.revision,
    papers: f.revision.papers.map((p) => ({ ...p, announce_type: 'replace' })),
  };
  f.daily.discovery.latest = async () => revision;
  const run = await f.finish(f.create().run.id);
  assert.equal(run.status, 'completed');
  assert.equal(run.stats.total, 0);
  assert.equal(run.stats.excluded, 2);
  assert.equal(f.calls, 0);
  const saved = await f.daily.saveSubscription(
    { expected_revision: 1, include_updates: true },
    f.sub.id,
  );
  f.sub.revision = saved.revision;
  const next = await f.finish(f.create('include-updates').run.id);
  assert.equal(next.stats.total, 2);
  assert.equal(next.stats.excluded, 0);
});
void test('failed discovery remains in task history without pretending there are zero new papers', async (t) => {
  const f = await fixture(t);
  f.daily.discovery.latest = async () => {
    throw new AnalysisError('arxiv_unavailable', 'Source unavailable', true);
  };
  const run = await f.finish(f.create().run.id);
  assert.equal(run.status, 'failed');
  assert.equal(run.discovery, null);
  assert.equal(run.report_id, null);
  assert.equal(f.daily.listRuns()[0].id, run.id);
  assert.equal(f.calls, 0);
});
void test('screening freezes run settings while explicit detail snapshots current settings', async (t) => {
  const f = await fixture(t, { count: 1, outcome: 'recommended' }),
    created = f.create();
  f.models.store.state.settings.connections[0].modelId = 'different-model';
  const run = await f.finish(created.run.id);
  assert.equal(
    f.repo.get('daily_runs', run.id).model_settings.connections[0].modelId,
    'fixture-model',
  );
  const item = await f.detail(f.daily.items(run.id).items[0].id);
  assert.equal(
    f.db.job(item.job_id).model_settings.connections[0].modelId,
    'different-model',
  );
});
void test('interrupted run resumes persisted candidates without repeating completed screenings', async (t) => {
  const f = await fixture(t, { count: 3, modelDelay: 25 });
  f.models.concurrency = 1;
  const id = f.create().run.id;
  for (let i = 0; i < 200 && f.daily.getRun(id).stats.not_recommended < 1; i++)
    await delay(2);
  await f.daily.close();
  const before = f.daily.getRun(id);
  assert.equal(before.status, 'interrupted');
  assert(before.stats.not_recommended >= 1);
  const prior = f.repo
    .items(id)
    .filter((i) => i.current_version_id)
    .map((i) => i.current_version_id);
  const restored = new DailyService(f.analyses, {
    discovery: { latest: async () => f.revision },
    pollMs: 1,
  });
  t.after(() => restored.close());
  restored.retry(id, {}, 'resume-interruption');
  for (
    let i = 0;
    i < 500 && ['queued', 'running'].includes(restored.getRun(id).status);
    i++
  )
    await delay(2);
  assert.equal(restored.getRun(id).status, 'completed');
  for (const v of prior) assert(f.repo.get('daily_item_versions', v));
  assert.equal(restored.getRun(id).stats.not_recommended, 3);
  await restored.close();
});
void test('repeating a manual analysis request while its child is running does not enqueue another child', async (t) => {
  const f = await fixture(t, { count: 1, modelDelay: 10 });
  const id = f.create().run.id;
  await f.finish(id);
  const item = f.daily.items(id).items[0];
  f.daily.analyzeItem(item.id, 'manual-first');
  for (let i = 0; i < 100 && !f.daily.getItem(item.id).job_id; i++)
    await delay(2);
  const job = f.daily.getItem(item.id).job_id;
  assert(job);
  assert.equal(f.daily.analyzeItem(item.id, 'manual-second').reused, true);
  assert.equal(f.daily.getItem(item.id).job_id, job);
  await f.finish(id);
});

void test('duplicate click aliases do not hide the real run from a small history page', async (t) => {
  const f = await fixture(t, { count: 1 });
  const first = await f.finish(f.create().run.id);
  for (let i = 0; i < 3; i++) await f.finish(f.create('duplicate-' + i).run.id);
  assert.equal(f.daily.listRuns({ limit: 1 })[0].id, first.id);
});
void test('a failed manual analysis of a non-recommended paper can be resumed without losing its original feedback', async (t) => {
  let fail = true;
  const f = await fixture(t, {
    count: 1,
    mutateModel(out, req) {
      if (fail && req.task !== 'screen') out.text = 'invalid';
    },
  });
  const id = f.create().run.id;
  await f.finish(id);
  let item = f.daily.items(id).items[0];
  const old = item.current_version_id;
  f.daily.feedback(old, 'accuracy', { value: 'negative' });
  await f.detail(item.id, 'manual-failure');
  assert.equal(f.daily.getItem(item.id).details_status, 'failed');
  assert.equal(f.daily.getRun(id).status, 'completed');
  fail = false;
  await f.detail(item.id, 'retry-manual-failure');
  item = f.daily.getItem(item.id);
  assert.equal(item.processing_status, 'completed');
  assert.equal(item.final_decision, 'not_recommended');
  assert.equal(item.analysis_decision, 'recommended');
  assert.equal(f.daily.getVersion(old).feedback.accuracy.value, 'negative');
});

void test('manual detail requests are independent and daily cancellation never cancels them', async (t) => {
  const f = await fixture(t, {
    count: 2,
    modelDelay: 20,
    outcome: 'recommended',
  });
  const id = f.create().run.id;
  for (let i = 0; i < 200 && !f.repo.items(id).length; i++) await delay(2);
  const item = f.repo.items(id)[0];
  const requested = f.daily.analyzeItem(item.id, 'detail-during-screening');
  f.daily.cancel(id);
  assert.notEqual(f.analyses.getJob(requested.job.id).status, 'cancelled');
  await f.detail(item.id, 'wait-detail-cancelled-run');
  assert.equal(f.daily.getRun(id).status, 'cancelled');
  assert.equal(f.daily.getItem(item.id).details_status, 'available');
});

void test('malformed XML is rejected even when a permissive parser could recover all fields', () => {
  const valid = feed(xmlEntry());
  for (const xml of [
    valid.replace('</entry>', ''),
    valid.replace('</entry>', '</wrong>'),
    valid.replace('Measured transport', 'A &undefined; transport'),
    valid.replace('</entry>', '</entry></extra>'),
  ])
    assert.throws(() => parseFeed(xml, subject), { code: 'invalid_feed' });
});

void test('strictness changes evidence criteria and cache identity without setting a quota or rewriting older runs', async (t) => {
  const prompts = [];
  const f = await fixture(t, {
    count: 3,
    outcome: 'recommended',
    mutateModel: (_out, req) => {
      if (req.task === 'screen') prompts.push(req.prompt);
    },
  });
  const first = await f.finish(f.create().run.id);
  assert.equal(first.stats.recommended, 3);
  assert.match(prompts[0], /BALANCED/);
  const updated = await f.daily.saveSubscription(
    { expected_revision: f.sub.revision, recommendation_strictness: 'focused' },
    f.sub.id,
  );
  const created = f.daily.create(
    {
      subscription_id: updated.id,
      expected_subscription_revision: updated.revision,
      source: { kind: 'stored_batch', batch_id: f.revision.batch_id },
    },
    'strictness-focused',
  );
  const second = await f.finish(created.run.id);
  assert.notEqual(second.id, first.id);
  assert.equal(second.actual_attempts, 3);
  assert.match(prompts[3], /FOCUSED/);
  assert.equal(
    f.daily.getRun(first.id).subscription.recommendation_strictness,
    'balanced',
  );
  assert.equal(f.db.listJobs().length, 0);
  assert.throws(
    () =>
      f.daily.analyzeItem(
        f.daily.items(first.id).items[0].id,
        'invalid-manual-options',
        { force_regenerate: 'true' },
      ),
    { code: 'invalid_request' },
  );
});
void test('late screening never overwrites a manually requested job, completed full judgment or report feedback', async (t) => {
  const f = await fixture(t, { count: 1, outcome: 'recommended' }),
    run = await f.finish(f.create().run.id);
  const item = await f.detail(f.daily.items(run.id).items[0].id);
  const version = item.current_version_id;
  f.daily.feedback(version, 'accuracy', { value: 'positive' });
  const storedRun = f.repo.get('daily_runs', run.id);
  storedRun.status = 'running';
  storedRun.force_regenerate = true;
  f.repo.saveRun(storedRun);
  await f.daily.screen(
    storedRun,
    f.repo.get('daily_items', item.id),
    new AbortController().signal,
  );
  const saved = f.daily.getItem(item.id);
  assert.equal(saved.job_id, item.job_id);
  assert.equal(saved.current_version_id, version);
  assert.equal(saved.decision_basis, 'abstract');
  assert.equal(saved.analysis_decision, 'recommended');
  assert.equal(saved.version.feedback.accuracy.value, 'positive');
});
void test('manual request replay refers to the original job even after a forced regeneration', async (t) => {
  const f = await fixture(t, { count: 1 }),
    run = await f.finish(f.create().run.id),
    id = f.daily.items(run.id).items[0].id;
  const first = await f.detail(id, 'manual-original');
  const next = f.daily.analyzeItem(id, 'manual-regenerated', {
    force_regenerate: true,
  });
  assert.notEqual(next.job.id, first.job_id);
  assert.equal(f.daily.analyzeItem(id, 'manual-original').job.id, first.job_id);
  assert.throws(
    () =>
      f.daily.analyzeItem(id, 'manual-regenerated', {
        force_regenerate: false,
      }),
    { code: 'conflict' },
  );
});
