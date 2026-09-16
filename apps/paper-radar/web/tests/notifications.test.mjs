import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnalysisDatabase } from '../server/analyses/database.mjs';
import {
  NotificationService,
  migrateNotifications,
} from '../server/notifications/service.mjs';
import { DailyRepository } from '../server/daily/repository.mjs';
import { DiscussionRepository } from '../server/discussions/repository.mjs';
import { createModelServer } from '../server/index.mjs';
import { fixture } from './helpers/daily-fixture.mjs';

async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-notifications-'));
  const store = await new AnalysisDatabase(dir).open();
  t.after(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, store, service: new NotificationService(store) };
}
function job(store, id, status = 'queued', extra = {}) {
  const value = {
    id,
    status,
    stages: [],
    created_at: new Date().toISOString(),
    input: { arxiv_input: '2501.12345' },
    paper_title: 'Original 中文 paper title',
    ...extra,
  };
  store.insertJob(value, id, id);
  return value;
}
const transition = (store, task, status) =>
  store.saveJob(Object.assign(task, { status }));

void test('terminal transitions are transactional, repeat saves deduplicate, retries produce a new event and reads survive restart', async (t) => {
  const { store } = await setup(t);
  let service = new NotificationService(store);
  const task = job(store, 'analysis-atomic');
  transition(store, task, 'running');
  assert.throws(() =>
    store.transaction(() => {
      transition(store, task, 'succeeded');
      throw Error('rollback');
    }),
  );
  assert.equal(service.list().items.length, 0);
  assert.equal(store.job(task.id).status, 'running');
  store.transaction(() => {
    store.saveResult({
      id: 'result-atomic',
      job_id: task.id,
      created_at: task.created_at,
    });
    transition(store, task, 'succeeded');
  });
  const first = service.list().items[0];
  assert.equal(first.title, task.paper_title);
  assert.equal(first.href, '#single-analysis?job=analysis-atomic');
  assert.ok(store.result('result-atomic'));
  transition(store, task, 'succeeded');
  assert.equal(service.list().items.length, 1);
  service.read({ ids: [first.id] });
  await store.close();
  await store.open();
  service = new NotificationService(store);
  assert.equal(service.list().unread_count, 0);
  assert.ok(service.list().items[0].read_at);
  transition(store, task, 'queued');
  transition(store, task, 'partial');
  assert.equal(service.list().items.length, 2);
  assert.equal(service.list().unread_count, 1);
  assert.equal(service.list().items[0].status, 'partial');
});

void test('daily completion is aggregated, manual details notify, and discussion links target the saved conversation', async (t) => {
  const { store, service } = await setup(t),
    daily = new DailyRepository(store),
    discussion = new DiscussionRepository(store);
  const run = {
    id: 'daily-one',
    status: 'running',
    created_at: new Date().toISOString(),
    subscription: { id: 'subscription-one', name: 'My 中文 subscription' },
  };
  daily.saveRun(run);
  for (let i = 0; i < 4; i++) {
    const task = job(store, 'automatic-' + i, 'running', {
      origin: { daily_run_id: run.id },
    });
    transition(store, task, 'succeeded');
  }
  assert.equal(service.list().items.length, 0);
  run.status = 'partial';
  daily.saveRun(run);
  daily.saveRun(run);
  assert.equal(service.list().items.length, 1);
  assert.equal(
    service.list().items[0].href,
    '#daily?run=daily-one&subscription=subscription-one',
  );
  const manual = job(store, 'manual-one', 'running', {
    origin: { daily_run_id: run.id, trigger: 'manual' },
  });
  transition(store, manual, 'succeeded');
  const c = {
    id: 'topic-1',
    source_key: 'paper-1',
    topic_key: 'topic-1',
    created_at: run.created_at,
    paper: { title: 'Original paper title' },
  };
  discussion.save(c);
  const turn = {
    id: 'turn-1',
    conversation_id: c.id,
    created_at: run.created_at,
    status: 'running',
  };
  discussion.saveTurn(turn);
  turn.status = 'succeeded';
  discussion.saveTurn(turn);
  discussion.saveTurn(turn);
  const all = service.list().items;
  assert.equal(all.length, 3);
  assert.equal(all[0].href, '#single-analysis?discussion=topic-1');
  assert.equal(all[0].title, c.paper.title);
  store.db.prepare('DELETE FROM discussions WHERE id=?').run(c.id);
  assert.equal(service.list().items.length, 2);
});

void test('old history is not backfilled, recovery is notified, deleted tasks also remove deliveries', async (t) => {
  const { store, service } = await setup(t);
  job(store, 'historical', 'succeeded');
  migrateNotifications(store.db);
  assert.equal(service.list().items.length, 0);
  job(store, 'recovered', 'running');
  await store.close();
  await store.open();
  const restarted = new NotificationService(store),
    n = restarted.list().items[0];
  assert.equal(n.status, 'interrupted');
  restarted.claim({ device_id: 'device-first-browser', ids: [n.id] });
  store.db.prepare('DELETE FROM jobs WHERE id=?').run('recovered');
  assert.equal(restarted.list().items.length, 0);
  assert.equal(
    store.db.prepare('SELECT count(*) n FROM notification_deliveries').get().n,
    0,
  );
  assert.equal(restarted.list().latest_id, n.id);
  assert.equal(restarted.list({ after: 0 }).cursor, n.id);
});

void test('pagination never skips unread arrivals, mark-all uses a snapshot and delivery claims deduplicate tabs', async (t) => {
  const { store, service } = await setup(t);
  for (let i = 0; i < 6; i++) {
    const task = job(store, 'task-' + i);
    transition(
      store,
      task,
      i === 5 ? 'cancelled' : i === 4 ? 'failed' : 'succeeded',
    );
  }
  const page = service.list({ limit: 2 });
  assert.deepEqual(
    page.items.map((n) => n.id),
    [6, 5],
  );
  assert.equal(page.next_before, 5);
  assert.deepEqual(
    service.list({ before: 5, limit: 2 }).items.map((n) => n.id),
    [4, 3],
  );
  const unseen = service.list({ after: 1, limit: 2 });
  assert.deepEqual(
    unseen.items.map((n) => n.id),
    [2, 3],
  );
  assert.equal(unseen.cursor, 3);
  const claimed = service.claim({
    device_id: 'same-browser-profile',
    ids: [5, 6],
  });
  assert.deepEqual(claimed.claimed, [5]);
  assert.deepEqual(
    service.claim({ device_id: 'same-browser-profile', ids: [5] }).claimed,
    [],
  );
  assert.deepEqual(
    service.claim({ device_id: 'other-browser-profile', ids: [5] }).claimed,
    [5],
  );
  const later = job(store, 'later');
  transition(store, later, 'failed');
  service.read({ through_id: page.latest_id });
  assert.equal(service.list().unread_count, 1);
  assert.equal(service.list().items[0].read_at, null);
  assert.deepEqual(
    service.claim({ device_id: 'third-browser-profile', ids: [5] }).claimed,
    [],
  );
  for (const query of [
    { after: -1 },
    { after: 'nope' },
    { before: 1.5 },
    { limit: 0 },
    { limit: Infinity },
  ])
    assert.throws(() => service.list(query), { code: 'invalid_request' });
  assert.throws(() => service.read({ ids: [1.5] }), {
    code: 'invalid_request',
  });
  assert.throws(() => service.claim({ device_id: 'short', ids: [] }), {
    code: 'invalid_request',
  });
});

void test('real task results expose notifications through the protected API, including concurrent tab claims', async (t) => {
  const f = await fixture(t, { count: 3 });
  const run = await f.finish(f.create('notifications-integration').run.id);
  const server = createModelServer(f.models, {
    publicDirectory: f.dir,
    analyses: f.analyses,
    daily: f.daily,
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/notifications`;
  const list = await (await fetch(url)).json();
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0].task_id, run.id);
  const headers = { 'content-type': 'application/json', 'x-paper-radar': '1' };
  assert.equal(
    (await fetch(url, { headers: { origin: 'https://untrusted.example' } }))
      .status,
    403,
  );
  assert.equal(
    (await fetch(url + '/read', { method: 'POST', body: '{}' })).status,
    403,
  );
  const claim = {
    method: 'POST',
    headers,
    body: JSON.stringify({
      device_id: 'concurrent-tab-profile',
      ids: [list.items[0].id],
    }),
  };
  const claims = await Promise.all([
    fetch(url + '/claim', claim).then((r) => r.json()),
    fetch(url + '/claim', claim).then((r) => r.json()),
  ]);
  assert.equal(claims.flatMap((c) => c.claimed).length, 1);
  const read = await fetch(url + '/read', {
    method: 'POST',
    headers,
    body: JSON.stringify({ ids: [list.items[0].id] }),
  });
  assert.equal((await read.json()).unread_count, 0);
  assert.equal((await fetch(url + '?after=invalid')).status, 400);
});
