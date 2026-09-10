import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {test} from 'node:test';

const script = readFileSync(new URL('../src/ai_persona/static/studio-overview.js', import.meta.url), 'utf8');
async function render(health, {lang = 'zh-CN', fail = false} = {}) {
  const nodes = new Map();
  for (const id of ['persona-home', 'home-expand-changes', 'home-extra-changes', 'home-runtime-issue', 'home-runtime-message', 'home-runtime', 'home-runtime-label']) {
    nodes.set(id, {hidden: false, textContent: '', dataset: {expandLabel: '展开全部 5 条', collapseLabel: '收起变化'}, attrs: {}, addEventListener(_, fn) { this.click = fn; }, setAttribute(key, value) { this.attrs[key] = value; }});
  }
  const requests = [];
  runInNewContext(script, {
    document: {documentElement: {lang}, getElementById: id => nodes.get(id)}, AbortSignal,
    fetch: async (url, options) => { requests.push({url, options}); if (fail) throw new Error('offline'); return {ok: true, json: async () => health}; },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/studio/v1/health');
  return id => nodes.get(id);
}
const health = {warnings: [], failure_count: 13, failures: [{input_preview: 'Private prompt'}], waiting_for_worker: 0, learning: {enabled: true, allow_model_calls: true, worker_running: true, worker_stopping: false, queued_count: 0}};
test('history does not become a current failure; changes expand locally', async () => {
  const get = await render(health);
  assert.equal(get('home-runtime-issue').hidden, true);
  assert.equal(get('home-runtime-label').textContent, '对话学习后台运行中');
  assert.equal(get('home-extra-changes').hidden, true);
  get('home-expand-changes').click();
  assert.equal(get('home-extra-changes').hidden, false);
  assert.equal(get('home-expand-changes').attrs['aria-expanded'], 'true');
  get('home-expand-changes').click();
  assert.equal(get('home-extra-changes').hidden, true);
});
test('stopped worker with queued tasks is actionable', async () => {
  const get = await render({...health, waiting_for_worker: 2, learning: {...health.learning, worker_running: false}});
  assert.equal(get('home-runtime-issue').hidden, false);
  assert.match(get('home-runtime-message').textContent, /2 条任务/);
  assert.equal(get('home-runtime').dataset.state, 'attention');
});
test('disabled, paused and stopping are not falsely called healthy', async () => {
  for (const [key, value, expected] of [['enabled', false, '未启用'], ['allow_model_calls', false, '暂停模型调用'], ['worker_stopping', true, '正在停止'], ['worker_running', false, '未运行']]) {
    const get = await render({...health, learning: {...health.learning, [key]: value}});
    assert.ok(get('home-runtime-label').textContent.includes(expected));
    assert.equal(get('home-runtime-issue').hidden, true);
  }
});
test('unavailable health is explicit, without hiding assets or changes', async () => {
  const get = await render(health, {fail: true});
  assert.equal(get('home-runtime').dataset.state, 'unknown');
  assert.equal(get('home-runtime-issue').hidden, false);
  assert.equal(get('persona-home').hidden, false);
});
test('English status and partial-read warning', async () => {
  const get = await render({...health, warnings: ['private internal error']}, {lang: 'en'});
  assert.equal(get('home-runtime-label').textContent, 'Learning worker is running');
  assert.match(get('home-runtime-message').textContent, /Some activity records/);
  assert.doesNotMatch(get('home-runtime-message').textContent, /private/);
});
