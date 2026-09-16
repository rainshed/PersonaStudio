import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { PriorityAdmission, waitForCompletion } from '../server/agents/admission.mjs';
import { backendFromSettings, hostCapabilities } from '../server/hosts/execution.mjs';
import { PROTOCOL, BridgeError } from '../server/hosts/transport.mjs';
import { SCREEN_RESULT_SCHEMA } from '@paper-radar/host-contract/agent-contract';
import { HostModelService } from '../server/hosts/service.mjs';

void test('shared contract keeps persisted wire versions and host identity independent from current selection', () => {
  assert.equal(PROTOCOL, 'paper-radar-harness/v1');
  assert.deepEqual(SCREEN_RESULT_SCHEMA.properties.schema.enum, ['screening.autonomous.v1']);
  assert.equal(backendFromSettings({ connections: [] }, 'codex'), null);
  assert.equal(backendFromSettings(undefined, 'codex'), 'codex');
  assert.equal(backendFromSettings({ dsh: {} }, 'codex'), 'dsh');
  assert.equal(backendFromSettings({ codex: {} }, 'dsh'), 'codex');
  assert.equal(hostCapabilities('codex', { concurrency: 4 }).concurrency, 4);
  assert.equal(hostCapabilities('codex').concurrencyUnit, 'agent-turn');
  assert.equal(hostCapabilities('codex').attemptUnit, 'agent-turn');
  assert.equal(hostCapabilities('dsh').attemptUnit, 'model-attempt');
  assert.equal(hostCapabilities('unrecognized').attemptUnit, 'unknown');
  assert.equal(new BridgeError('cancelled', 'cancelled').retryable, false);
  const router = new HostModelService({ directory: '/unused', dsh: {}, codex: {}, defaultBackend: 'codex' });
  assert.equal(router.executionPoolForSettings({ connections: [] }), null);
  assert.throws(() => router.backendForSettings({ connections: [] }), { code: 'legacy_model_snapshot' });
});

void test('host admission prioritizes interactive requests, remains FIFO and ages background work', async () => {
  let now = 0;
  const admission = new PriorityAdmission({ limit: () => 1, now: () => now, agingMs: 100 });
  const signal = new AbortController().signal;
  const release = await admission.acquire(signal);
  const order = [];
  const run = (id, priority) => admission.acquire(signal, priority).then((done) => { order.push(id); done(); });
  const background = run('background', 0);
  const analysis = run('analysis', 20);
  const discussionA = run('discussion-a', 30);
  const discussionB = run('discussion-b', 30);
  release();
  await Promise.all([background, analysis, discussionA, discussionB]);
  assert.deepEqual(order, ['discussion-a', 'discussion-b', 'analysis', 'background']);
  const hold = await admission.acquire(signal);
  const aged = run('aged-background', 0);
  now = 3100;
  const newcomer = run('new-discussion', 30);
  hold();
  await Promise.all([aged, newcomer]);
  assert.deepEqual(order.slice(-2), ['aged-background', 'new-discussion']);
  assert.equal(admission.running, 0);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

void test('cancelled host admissions are removed without consuming a slot or retaining listeners', async () => {
  const admission = new PriorityAdmission();
  const first = new AbortController();
  const waiting = new AbortController();
  const release = await admission.acquire(first.signal);
  const queued = admission.acquire(waiting.signal);
  assert.equal(admission.waiters.length, 1);
  waiting.abort(new Error('cancelled before admission'));
  await assert.rejects(queued, /cancelled before admission/);
  assert.equal(admission.waiters.length, 0);
  release();
  assert.equal(admission.running, 0);
  assert.equal(getEventListeners(first.signal, 'abort').length, 0);
  assert.equal(getEventListeners(waiting.signal, 'abort').length, 0);
});

void test('completion handles cancellation before subscription and removes listeners after success', async () => {
  const cancelled = new AbortController();
  cancelled.abort(new Error('cancelled during setup'));
  await assert.rejects(waitForCompletion(new Promise(() => {}), cancelled.signal), /cancelled during setup/);
  const completed = new AbortController();
  assert.equal(await waitForCompletion(Promise.resolve('done'), completed.signal), 'done');
  assert.equal(getEventListeners(completed.signal, 'abort').length, 0);
});
