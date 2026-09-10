import test from 'node:test';
import assert from 'node:assert/strict';
import {LearningWorkerControl} from '../src/ai_persona/static/learning-worker-control.mjs';

const config = (running, stopping = false, enabled = true) => ({
  worker:{running, stopping}, settings:{enabled},
});

test('unknown status disables the action until backend state arrives', () => {
  const control = new LearningWorkerControl();
  assert.equal(control.view.state, 'unknown');
  assert.equal(control.view.disabled, true);
  assert.equal(control.begin(), null);
});

test('one control shows the current status and opposite action', () => {
  const control = new LearningWorkerControl();
  control.update(config(false));
  assert.equal(control.view.status, '已停止');
  assert.equal(control.view.label, '启动后台处理');
  assert.equal(control.view.disabled, false);
  control.update(config(true));
  assert.equal(control.view.status, '运行中');
  assert.equal(control.view.label, '停止后台处理');
  assert.equal(control.view.disabled, false);
});

test('start acknowledgement waits for actual running state and prevents duplicate clicks', () => {
  const control = new LearningWorkerControl();
  control.update(config(false));
  assert.equal(control.begin(), 'start');
  assert.equal(control.view.state, 'starting');
  assert.equal(control.begin(), null);
  control.update(config(false));
  control.finish();
  control.update(config(false));
  assert.equal(control.view.label, '正在启动…');
  assert.equal(control.view.disabled, true);
  control.update(config(true));
  assert.equal(control.view.label, '停止后台处理');
  assert.equal(control.transitioning, false);
});

test('stop waits for task completion and never reports stopped prematurely', () => {
  const control = new LearningWorkerControl();
  control.update(config(true));
  assert.equal(control.begin(), 'stop');
  assert.equal(control.view.label, '正在停止…');
  assert.equal(control.begin(), null);
  control.finish();
  control.update(config(true, true));
  assert.equal(control.view.status, '正在停止');
  assert.match(control.view.hint, /当前任务/);
  assert.equal(control.view.disabled, true);
  control.update(config(false));
  assert.equal(control.view.label, '启动后台处理');
  assert.equal(control.transitioning, false);
});

test('an external stop request is visible on reload without local pending state', () => {
  const control = new LearningWorkerControl();
  control.update(config(true, true));
  assert.equal(control.view.state, 'stopping');
  assert.equal(control.transitioning, true);
  assert.equal(control.begin(), null);
  control.update(config(false));
  assert.equal(control.begin(), 'start');
});

test('collection disable blocks start but still allows stopping an existing worker', () => {
  const control = new LearningWorkerControl();
  control.update(config(false, false, false));
  assert.equal(control.view.label, '启动后台处理');
  assert.equal(control.view.disabled, true);
  assert.match(control.view.hint, /启用.*对话采集/);
  control.update(config(true, false, false));
  assert.equal(control.view.disabled, false);
  assert.equal(control.begin(), 'stop');
});

test('failed requests require status reconciliation instead of optimistic reversal', () => {
  const control = new LearningWorkerControl();
  control.update(config(false));
  control.begin();
  control.failed();
  assert.equal(control.view.state, 'unknown');
  assert.equal(control.view.disabled, true);
  // A response may be lost even though the process was actually started.
  control.update(config(true));
  assert.equal(control.view.label, '停止后台处理');
});

test('poll failure does not leave a stale enabled stop button', () => {
  const control = new LearningWorkerControl();
  control.update(config(true));
  control.unavailable();
  assert.equal(control.view.state, 'unknown');
  assert.equal(control.begin(), null);
  control.update(config(false));
  assert.equal(control.view.label, '启动后台处理');
});

test('unconfirmed start times out to a retryable stopped state', () => {
  let now = 0;
  const control = new LearningWorkerControl(() => now);
  control.update(config(false));
  control.begin();
  control.finish();
  now = 14999;
  assert.equal(control.update(config(false)), undefined);
  assert.equal(control.view.state, 'starting');
  now = 15000;
  assert.match(control.update(config(false)), /尚未确认后台启动成功/);
  assert.equal(control.view.state, 'stopped');
  assert.equal(control.view.disabled, false);
});

test('old reads during the POST cannot prematurely acknowledge an action', () => {
  const control = new LearningWorkerControl();
  control.update(config(false));
  control.begin();
  control.update(config(true));
  assert.equal(control.view.state, 'starting');
  control.finish();
  control.update(config(true));
  assert.equal(control.view.state, 'running');
});
