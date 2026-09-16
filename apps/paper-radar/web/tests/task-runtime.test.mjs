import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskRuntime } from '../server/tasks/runtime.mjs';
import { taskContext } from '../server/tasks/context.mjs';

async function until(check) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await delay(2);
  }
  throw new Error('The task queue did not reach the expected state');
}
function queue(runtime, kind, { limit = () => 2, group = () => kind, priority = () => 10, exclusive } = {}) {
  const rows = new Map(), started = [], release = new Map();
  const controller = new AbortController();
  const handle = runtime.register(kind, {
    pending: () => [...rows.values()].filter((row) => row.status === 'queued'),
    get: (id) => rows.get(id),
    signal: controller.signal,
    stop: () => controller.abort(),
    group, concurrency: limit, priority, exclusive,
    run: async (row) => {
      row.status = 'running';
      started.push({ id: row.id, context: taskContext.getStore() });
      await new Promise((resolve) => {
        const finish = () => {
          controller.signal.removeEventListener('abort', finish);
          resolve();
        };
        release.set(row.id, finish);
        controller.signal.addEventListener('abort', finish, { once: true });
      });
      row.status = controller.signal.aborted ? 'interrupted' : 'succeeded';
    },
  });
  const add = (id, extra = {}) => rows.set(id, {
    id, status: 'queued', created_at: '2026-09-13T12:00:00Z', ...extra,
  });
  return { ...handle, rows, add, started, release, controller };
}

void test('multiple analyses and independent discussions can run; context carries model priority', async (t) => {
  const runtime = new TaskRuntime();
  t.after(() => runtime.close());
  const analyses = queue(runtime, 'analysis', { priority: () => 20 });
  const discussions = queue(runtime, 'discussion', { priority: () => 30 });
  analyses.add('a'); analyses.add('b'); analyses.add('c');
  discussions.add('q1'); discussions.add('q2');
  const done = analyses.wake();
  void discussions.wake();
  await until(() => analyses.started.length === 2 && discussions.started.length === 2);
  assert.equal(runtime.snapshot().queued.length, 1);
  assert.deepEqual(discussions.started[0].context, { kind: 'discussion', id: 'q1', priority: 30 });
  analyses.release.get('b')();
  await until(() => analyses.started.length === 3);
  assert.equal(analyses.rows.get('a').status, 'running');
  for (const finish of analyses.release.values()) finish();
  for (const finish of discussions.release.values()) finish();
  await done;
  await discussions.idle();
});

void test('priority admission is stable and same-conversation exclusion holds across queue wakes', async (t) => {
  const runtime = new TaskRuntime();
  t.after(() => runtime.close());
  const jobs = queue(runtime, 'jobs', {
    priority: (row) => row.priority,
    exclusive: (row) => row.conversation,
  });
  jobs.add('a', { priority: 0, conversation: 'shared' });
  jobs.add('b', { priority: 30, conversation: 'shared' });
  jobs.add('c', { priority: 10, conversation: 'other' });
  for (let i = 0; i < 10; i++) void jobs.wake();
  await until(() => jobs.started.length === 2);
  assert.deepEqual(jobs.started.map((row) => row.id), ['b', 'c']);
  jobs.release.get('b')();
  await until(() => jobs.started.length === 3);
  assert.equal(new Set(jobs.started.map((row) => row.id)).size, 3);
  for (const finish of jobs.release.values()) finish();
  await jobs.idle();
});

void test('resizing changes subsequent admission without cancelling active work', async (t) => {
  let limit = 1, changed;
  const runtime = new TaskRuntime({ subscribe(fn) { changed = fn; return () => {}; } });
  t.after(() => runtime.close());
  const jobs = queue(runtime, 'jobs', { limit: () => limit });
  for (const id of ['a', 'b', 'c', 'd']) jobs.add(id);
  void jobs.wake();
  await until(() => jobs.started.length === 1);
  limit = 3; changed();
  await until(() => jobs.started.length === 3);
  limit = 1; changed();
  jobs.release.get('a')(); jobs.release.get('b')();
  await delay(5);
  assert.equal(jobs.started.length, 3);
  jobs.release.get('c')();
  await until(() => jobs.started.length === 4);
  jobs.release.get('d')();
  await jobs.idle();
});

void test('cancelled or deleted queued rows cannot be started by an already scheduled wake', async (t) => {
  const runtime = new TaskRuntime();
  t.after(() => runtime.close());
  const jobs = queue(runtime, 'jobs');
  jobs.add('a'); jobs.add('b');
  const done = jobs.wake();
  // The admission microtask runs before this continuation, execution afterwards.
  await Promise.resolve();
  jobs.rows.get('a').status = 'cancelled';
  jobs.rows.delete('b');
  await done;
  assert.deepEqual(jobs.started, []);
});

void test('shutdown interrupts active work and leaves queued durable records available for restart', async () => {
  const runtime = new TaskRuntime();
  const jobs = queue(runtime, 'jobs', { limit: () => 1 });
  jobs.add('a'); jobs.add('b');
  const done = jobs.wake();
  await until(() => jobs.started.length === 1);
  await runtime.close();
  await done;
  assert.equal(jobs.rows.get('a').status, 'interrupted');
  assert.equal(jobs.rows.get('b').status, 'queued');
});

void test('unexpected execution failure is surfaced once and does not starve the next task', async (t) => {
  const runtime = new TaskRuntime();
  t.after(() => runtime.close());
  const rows = [{ id: 'bad', status: 'queued' }, { id: 'good', status: 'queued' }];
  const errors = [];
  const jobs = runtime.register('checks', {
    pending: () => rows.filter((row) => row.status === 'queued'),
    run: async (row) => {
      if (row.id === 'bad') throw new Error('Broken adapter');
      row.status = 'succeeded';
    },
    onError(row, error) { errors.push(error.message); row.status = 'failed'; },
  });
  await jobs.wake();
  assert.deepEqual(errors, ['Broken adapter']);
  assert.deepEqual(rows.map((row) => row.status), ['failed', 'succeeded']);
});

void test('admission errors from frozen settings or capacity fail once without starving other queues', async (t) => {
  const runtime = new TaskRuntime();
  t.after(() => runtime.close());
  const rows = [
    { id: 'legacy', status: 'queued', badPool: true },
    { id: 'capacity', status: 'queued', badCapacity: true },
    { id: 'ready', status: 'queued' },
  ];
  const errors = [];
  const handle = runtime.register('admission', {
    pending: () => rows.filter((row) => row.status === 'queued'),
    group: (row) => {
      if (row.badPool) throw new Error('Historical host unavailable');
      return 'ready';
    },
    concurrency: (row) => {
      if (row.badCapacity) throw new Error('Capacity unavailable');
      return 1;
    },
    run: (row) => { row.status = 'succeeded'; },
    onError: async (row, error) => {
      await delay(2);
      row.status = 'failed';
      errors.push(error.message);
    },
  });
  await handle.wake();
  assert.deepEqual(rows.map((row) => row.status), ['failed', 'failed', 'succeeded']);
  assert.equal(errors.length, 2);
  rows[0].badPool = false;
  rows[0].status = 'queued';
  runtime.retry('admission', 'legacy');
  await handle.idle();
  assert.equal(rows[0].status, 'succeeded');
  assert.equal(errors.length, 2);
});

void test('repository faults are visible, isolated and retried only by explicit queue wake', async (t) => {
  const runtime = new TaskRuntime();
  t.after(() => runtime.close());
  let broken = true, reads = 0;
  const row = { id: 'blocked', status: 'queued' };
  const blocked = runtime.register('blocked', {
    pending() { reads++; if (broken) throw new Error('Repository unavailable'); return row.status === 'queued' ? [row] : []; },
    run() { row.status = 'succeeded'; },
  });
  const good = runtime.register('good', { pending: () => [], run() {} });
  await blocked.wake();
  for (let i = 0; i < 5; i++) { runtime.wake(); await good.wake(); }
  assert.equal(reads, 1);
  assert.deepEqual(runtime.snapshot().errors, [{ kind: 'blocked', message: 'Repository unavailable', phase: 'pending' }]);
  broken = false;
  await blocked.wake();
  assert.equal(row.status, 'succeeded');
});

void test('equal-timestamp tasks preserve repository FIFO instead of sorting random IDs', async (t) => {
  const runtime = new TaskRuntime();
  t.after(() => runtime.close());
  const jobs = queue(runtime, 'discussion', { limit: () => 1, exclusive: () => 'same-conversation' });
  jobs.add('z-first'); jobs.add('a-second');
  void jobs.wake();
  await until(() => jobs.started.length === 1);
  assert.equal(jobs.started[0].id, 'z-first');
  jobs.release.get('z-first')();
  await until(() => jobs.started.length === 2);
  jobs.release.get('a-second')();
  await jobs.idle();
});

void test('runtime close before execution does not start an admitted task without a signal', async () => {
  const runtime = new TaskRuntime();
  let started = false;
  const row = { id: 'not-started', status: 'queued' };
  const jobs = runtime.register('close-race', {
    pending: () => [row],
    run: () => { started = true; row.status = 'succeeded'; },
  });
  const done = jobs.wake();
  await Promise.resolve();
  await runtime.close();
  await done;
  assert.equal(started, false);
  assert.equal(row.status, 'queued');
  assert.throws(() => runtime.register('late', {}), /cannot be registered/);
});

void test('closing a queue immediately settles its previous wake and removes abort listeners', async (t) => {
  const { getEventListeners } = await import('node:events');
  const runtime = new TaskRuntime();
  t.after(() => runtime.close());
  const jobs = queue(runtime, 'close-now');
  jobs.add('queued');
  const done = jobs.wake();
  await jobs.close();
  await done;
  assert.deepEqual(jobs.started, []);
  assert.equal(getEventListeners(jobs.controller.signal, 'abort').length, 0);
});

void test('a deleted record returned as not_found is skipped and error-handler failures are contained', async (t) => {
  const runtime = new TaskRuntime();
  t.after(() => runtime.close());
  const rows = [{ id: 'deleted', status: 'queued' }, { id: 'bad', status: 'queued' }, { id: 'good', status: 'queued' }];
  const errors = [];
  const jobs = runtime.register('deletion', {
    pending: () => rows.filter((row) => row.status === 'queued'),
    get(id) {
      const row = rows.find((item) => item.id === id);
      if (id === 'deleted') { row.status = 'deleted'; throw Object.assign(new Error('Gone'), { code: 'not_found' }); }
      return row;
    },
    run(row) { if (row.id === 'bad') throw new Error('Failed execution'); row.status = 'succeeded'; },
    onError(row) { errors.push(row.id); throw new Error('Failed persistence'); },
  });
  await jobs.wake();
  assert.deepEqual(errors, ['bad']);
  assert.equal(rows[2].status, 'succeeded');
  assert.equal(runtime.snapshot().errors[0].phase, 'onError');
});

void test('aging admits an old background task ahead of continuously arriving foreground work', async (t) => {
  const now = Date.parse('2026-09-13T12:00:40Z');
  const runtime = new TaskRuntime({ now: () => now, agingMs: 1000 });
  t.after(() => runtime.close());
  const jobs = queue(runtime, 'aged', { limit: () => 1, priority: (row) => row.priority });
  jobs.add('background', { priority: 0, created_at: '2026-09-13T12:00:00Z' });
  jobs.add('interactive', { priority: 30, created_at: '2026-09-13T12:00:40Z' });
  void jobs.wake();
  await until(() => jobs.started.length === 1);
  assert.equal(jobs.started[0].id, 'background');
  jobs.release.get('background')();
  await until(() => jobs.started.length === 2);
  jobs.release.get('interactive')();
  await jobs.idle();
});
