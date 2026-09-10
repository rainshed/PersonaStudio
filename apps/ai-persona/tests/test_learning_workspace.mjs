import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LearningListState, LearningWorkspace} from '../src/ai_persona/static/learning-workspace.mjs';

const item = (id, version = 1, revision = 0, result = 'result-' + id) => ({id, version, current_result_id: result, feedback: {revision}});

test('polling keeps row order, ignores new arrivals and accepts pinned filter-exit rows', () => {
  const state = new LearningListState(); state.apply({events: [item('a'), item('b')]}, true);
  state.apply({events: [item('new'), item('b')], updates: [item('a', 1, 2)]});
  assert.deepEqual(state.ids, ['a', 'b']);
  assert.equal(state.items.get('a').feedback.revision, 2);
  state.apply({events: [item('a', 1, 1)]});
  assert.equal(state.items.get('a').feedback.revision, 2);
  state.apply({events: [item('a', 2, 0, 'new-result')]});
  assert.equal(state.items.get('a').feedback.revision, 0, 'new attempt does not inherit the previous result');
  state.apply({events: [item('a', 1, 3)]});
  assert.equal(state.items.get('a').version, 2);
});

test('automatic polling cannot supersede an explicit list replacement', async () => {
  let resolve, calls = 0;
  const pending = new Promise(done => {resolve = done;});
  const workspace = Object.create(LearningWorkspace.prototype);
  Object.assign(workspace, {list: new LearningListState(), rows: new Map(), query: {}, cursors: [], api: async () => {calls++; return pending;}});
  const elements = new Map();
  workspace.$ = id => {if (!elements.has(id)) elements.set(id, {replaceChildren() {}}); return elements.get(id);};
  workspace.createRow = id => ({root: {id}}); workspace.updateRow = async () => {};
  workspace.markSelection = workspace.remember = () => {};
  const reload = workspace.load(true);
  await workspace.load(false);
  assert.equal(calls, 1);
  resolve({events: [item('a')], cursor: 'boundary', has_more: false, total: 1, all_count: 1});
  await reload;
  assert.deepEqual(workspace.list.ids, ['a']);
  assert.equal(workspace.replacing, null);
});

test('initial deep link survives the first read and opens exactly that task', async () => {
  const w = Object.create(LearningWorkspace.prototype), opened = [];
  Object.assign(w, {configSignature: '[]', initialEvent: 'learn-deep-link', rows: new Map(), load: async () => {}, openDetail: async id => opened.push(id), $: () => ({})});
  await w.refresh({connections: []});
  assert.deepEqual(opened, ['learn-deep-link']); assert.equal(w.initialEvent, null);
});

test('back navigation restores the list before opening the modal, preserving its close position', async t => {
  const steps = [], previousWindow = globalThis.window;
  globalThis.window = {scrollTo: (x, y) => steps.push(['scroll', x, y])};
  t.after(() => {if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;});
  const w = Object.create(LearningWorkspace.prototype);
  Object.assign(w, {configSignature: '[]', initialEvent: 'learn-back', restore: {scroll: 402}, rows: new Map(), load: async () => steps.push(['load']), openDetail: async id => steps.push(['open', id]), $: () => ({})});
  await w.refresh({connections: []});
  assert.deepEqual(steps, [['load'], ['scroll', 0, 402], ['open', 'learn-back']]);
});

test('workspace elements exist and disclosure details do not use main-page scrolling', () => {
  const html = readFileSync(new URL('../src/ai_persona/templates/inbox.html', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../src/ai_persona/static/inbox.mjs', import.meta.url), 'utf8');
  for (const match of script.matchAll(/this\.\$\('([a-z-]+)'\)/g)) assert.ok(html.includes(`id="inbox-${match[1]}"`), match[1]);
  assert.ok(!script.includes('scrollIntoView'));
  assert.ok(!script.includes('innerHTML'));
});

test('task detail shows extracted user input and does not fall back to ambient-only raw text', async () => {
  const w = Object.create(LearningWorkspace.prototype);
  const elements = new Map();
  w.$ = id => {if (!elements.has(id)) elements.set(id, {}); return elements.get(id);};
  const parts = Object.fromEntries(['status', 'input', 'context', 'contextText', 'explanation', 'feedback', 'review', 'reviewLink', 'error', 'origin', 'historyDetails', 'actions'].map(key => [key, {}]));
  parts.history = {dataset: {}, replaceChildren() {}};
  const value = {source_name: 'Codex', status: 'completed', outcome: 'ignored', triggered: false, judgment_input: [{text: '<in-app-browser-context>raw host state</in-app-browser-context>'}], user_input: '请解释测试知识', history: []};
  Object.assign(w, {selected: 'task', detailSequence: 0, detailParts: parts, api: async () => value, status: () => '忽略', mountFeedback: async () => {}, reviewText: () => '', taskActions: () => {}, notice: message => assert.fail(message)});
  await w.readDetail('task', false);
  assert.equal(parts.input.textContent, '请解释测试知识');
  value.user_input = '';
  await w.readDetail('task', false);
  assert.equal(parts.input.textContent, '输入内容已清理。');
});
