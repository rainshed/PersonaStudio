const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function client(fetch, config = { mode: 'live' }) {
  const window = { ResearchLibraryConfig: config, dispatchEvent() {} };
  const context = vm.createContext({ window, fetch, URL, AbortController, setTimeout, clearTimeout, Event, console });
  for (const name of ['references.js', 'library-client.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, name), 'utf8'), context);
  }
  return { R: window.ResearchReferences, L: window.ResearchLibrary };
}
const id = 'ps_0123456789abcdef_0123456789abcdef0123456789abcdef';
const item = { id, kind: 'knowledge', title: '正式条目', aliases: [], summary: '真实摘要' };
const response = body => ({ ok: true, json: async () => body });
const catalog = { mode: 'live', workspace: { key: 'work', name: '工作区' }, items: [item], counts: { knowledge: 1, material: 0 } };

test('connection failure never falls back to demo search and can recover', async () => {
  let fail = true;
  const { R, L } = client(async () => { if (fail) throw new Error('offline'); return response(catalog); });
  assert.equal(R.search('').length, 0);
  await L.refresh();
  assert.equal(L.state.status, 'error');
  assert.equal(R.search('').length, 0);
  assert.equal(R.get('kn_quasi').source, 'demo');
  fail = false;
  await L.refresh();
  assert.equal(L.state.status, 'ready');
  assert.equal(R.search('')[0].id, id);
  fail = true;
  await L.refresh();
  assert.equal(L.state.status, 'error');
  assert.equal(R.get(id).title, item.title);
});

test('simultaneous refreshes share one request; detail is fetched on demand', async () => {
  let finish, calls = [];
  const { R, L } = client(url => { calls.push(url); return new Promise(resolve => { finish = resolve; }); });
  const first = L.refresh(), second = L.refresh();
  assert.equal(first, second);
  finish(response(catalog));
  await first;
  const detail = L.detail(id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], `/api/library/items/${id}`);
  finish(response({ ...item, body: '正式正文' }));
  await detail;
  assert.equal(R.get(id).body, '正式正文');
});

test('missing detail does not delete saved relationships', async () => {
  const { R, L } = client(async url => url === '/api/library' ? response(catalog) : { ok: false, status: 404 });
  await L.refresh();
  const owner = { related_refs: [id], body: R.makeCitation(id) };
  await assert.rejects(L.detail(id), error => error.status === 404);
  assert.equal(R.related(owner).length, 1);
  assert.equal(R.related(owner)[0].occurrences.length, 1);
});

test('missing runtime config cannot silently select the fictional library', async () => {
  const { R, L } = client(async () => { throw new Error('offline'); }, null);
  await L.refresh();
  assert.equal(L.state.mode, 'live');
  assert.equal(L.state.status, 'error');
  assert.equal(R.search('').length, 0);
});

test('integrated research uses its own API prefix without taking over native routes', async () => {
  const calls = [];
  const { L } = client(async url => { calls.push(url); return response(url.endsWith('/library') ? catalog : item); }, { mode: 'live', apiBase: '/research/api/library', integrated: true });
  await L.refresh();
  await L.detail(id);
  assert.deepEqual(calls, ['/research/api/library', `/research/api/library/items/${id}`]);
});
