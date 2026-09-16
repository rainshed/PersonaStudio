import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRequestPolling } from '../lib/request-polling.ts';

function clock() {
  const timers = new Map();
  let id = 0;
  return {
    timers,
    schedule: (callback, delay) => {
      timers.set(++id, { callback, delay });
      return id;
    },
    unschedule: (key) => timers.delete(key),
    fire: () => {
      const [key, { callback }] = timers.entries().next().value;
      timers.delete(key);
      callback();
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

void test('polling coalesces focus and online wakes while a request is running', async () => {
  const timer = clock();
  let calls = 0;
  let resolve;
  const polling = startRequestPolling({
    ...timer,
    intervalMs: 2000,
    run: () => {
      calls += 1;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  timer.fire();
  polling.wake();
  polling.wake();
  assert.equal(calls, 1);
  assert.equal(timer.timers.size, 0);
  resolve();
  await settle();
  assert.equal(timer.timers.size, 1);
  assert.equal([...timer.timers.values()][0].delay, 2000);
  polling.stop();
  assert.equal(timer.timers.size, 0);
});

void test('changing identity or unmounting invalidates a delayed response', async () => {
  const timer = clock();
  let resolve;
  let oldSignal;
  const results = [];
  const previous = startRequestPolling({
    ...timer,
    intervalMs: 1000,
    run: async (signal) => {
      oldSignal = signal;
      await new Promise((done) => {
        resolve = done;
      });
      if (!signal.aborted) results.push('old paper');
    },
  });
  timer.fire();
  previous.stop();
  const current = startRequestPolling({
    ...timer,
    intervalMs: 1000,
    run: async () => {
      results.push('new paper');
      return false;
    },
  });
  timer.fire();
  resolve();
  await settle();
  assert.equal(oldSignal.aborted, true);
  assert.deepEqual(results, ['new paper']);
  assert.equal(timer.timers.size, 0);
  previous.wake();
  assert.equal(timer.timers.size, 0);
  current.stop();
});

void test('transient failures surface errors, back off, and recover without overlap', async () => {
  const timer = clock();
  let calls = 0;
  const errors = [];
  const polling = startRequestPolling({
    ...timer,
    intervalMs: 2000,
    onError: (error) => errors.push(error.message),
    run: async () => {
      calls += 1;
      if (calls < 3) throw new Error('offline');
    },
  });
  timer.fire();
  await settle();
  assert.equal([...timer.timers.values()][0].delay, 2000);
  timer.fire();
  await settle();
  assert.equal([...timer.timers.values()][0].delay, 4000);
  polling.wake();
  await settle();
  assert.deepEqual(errors, ['offline', 'offline']);
  assert.equal([...timer.timers.values()][0].delay, 2000);
  polling.stop();
});

void test('an aborted request never reports a connection error or schedules another poll', async () => {
  const timer = clock();
  let reject;
  const errors = [];
  const polling = startRequestPolling({
    ...timer,
    intervalMs: 1000,
    onError: (error) => errors.push(error),
    run: () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  });
  timer.fire();
  polling.stop();
  reject(new DOMException('Aborted', 'AbortError'));
  await settle();
  assert.deepEqual(errors, []);
  assert.equal(timer.timers.size, 0);
});
