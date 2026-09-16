import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { PersonaPathPicker } from '../server/persona/path-picker.mjs';
import { analysisRoute } from '../server/analyses/http.mjs';
import { createModelServer } from '../server/index.mjs';
import { personaSettingsFixture } from './helpers/persona-settings-fixture.mjs';
import { fixture as dailyFixture } from './helpers/daily-fixture.mjs';

void test('native folder and executable selection preserve literal paths and only use fixed helper arguments', async (t) => {
  const f = await personaSettingsFixture(t);
  const folder = join(f.directory, '资料 $(literal) "quotes"');
  await mkdir(folder);
  const calls = [];
  let selected = folder;
  const picker = new PersonaPathPicker({
    platform: 'darwin',
    run: async (...args) => {
      calls.push(args);
      return { stdout: JSON.stringify({ path: selected }) };
    },
  });
  assert.deepEqual(
    await picker.pick({
      kind: 'workspace',
      initial_path: join(folder, 'missing'),
      language: 'en',
    }),
    { path: folder },
  );
  selected = f.config.command;
  assert.deepEqual(
    await picker.pick({ kind: 'executable', initial_path: selected }),
    { path: selected },
  );
  for (const [command, args, options] of calls) {
    assert.equal(command, '/usr/bin/osascript');
    assert.deepEqual(args.slice(0, 2), ['-l', 'JavaScript']);
    assert.ok(args[2].endsWith('/macos-path-picker.jxa'));
    assert.equal(args.length, 6);
    assert.equal(options.shell, undefined);
  }
  assert.deepEqual(calls[0][1].slice(3), ['workspace', folder, 'en']);
  assert.equal(calls[1][1][4], dirname(selected));
});

void test('cancelling or failing the native dialog leaves settings and a valid test unchanged', async (t) => {
  const f = await personaSettingsFixture(t);
  const tested = await f.settings.test(f.draft());
  const original = await readFile(f.path, 'utf8');
  let fail = false;
  f.settings.pathPicker = new PersonaPathPicker({
    platform: 'darwin',
    run: async () => {
      if (fail) throw new Error('Native process unavailable');
      return { stdout: '{"path":null}' };
    },
  });
  const route = (method, body) =>
    analysisRoute(
      { personaSettings: f.settings },
      { method, headers: {} },
      new URL('http://localhost/api/persona/settings/pick'),
      async () => body,
    );
  assert.deepEqual(await route('POST', { kind: 'workspace' }), {
    status: 200,
    body: { path: null },
  });
  fail = true;
  await assert.rejects(route('POST', { kind: 'executable' }), {
    code: 'picker_failed',
  });
  fail = false;
  assert.equal((await route('POST', { kind: 'workspace' })).body.path, null);
  await assert.rejects(route('GET'), { code: 'not_found' });
  assert.equal(await readFile(f.path, 'utf8'), original);
  assert.ok(f.settings.tests.has(tested.test_id));
  assert.equal(f.settings.revision, tested.revision);
});

void test('invalid requests and unsupported systems do not launch a dialog; unexpected helper results are rejected', async (t) => {
  const f = await personaSettingsFixture(t);
  let calls = 0;
  let result = { path: f.workspace };
  const picker = new PersonaPathPicker({
    platform: 'darwin',
    run: async () => {
      calls++;
      return { stdout: JSON.stringify(result) };
    },
  });
  for (const input of [
    { kind: 'command' },
    { kind: 'workspace', script: 'code' },
    { kind: 'workspace', language: 'other' },
  ])
    await assert.rejects(picker.pick(input), {
      code: 'invalid_picker_request',
    });
  const unsupported = new PersonaPathPicker({
    platform: 'linux',
    run: picker.run,
  });
  assert.equal(unsupported.available, false);
  await assert.rejects(unsupported.pick({ kind: 'workspace' }), {
    code: 'picker_unavailable',
  });
  assert.equal(calls, 0);
  await assert.rejects(picker.pick({ kind: 'executable' }), {
    code: 'picker_failed',
  });
  result = { path: '../relative' };
  await assert.rejects(picker.pick({ kind: 'workspace' }), {
    code: 'picker_failed',
  });
  result = { unexpected: true };
  await assert.rejects(picker.pick({ kind: 'workspace' }), {
    code: 'picker_failed',
  });
});

function heldPicker() {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const picker = new PersonaPathPicker({
    platform: 'darwin',
    run: (_command, _args, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
        started({ signal, resolve });
      }),
  });
  return { picker, ready };
}

void test('a second picker is rejected, browser cancellation releases it, and shutdown closes it', async () => {
  const { picker, ready } = heldPicker();
  const controller = new AbortController();
  const first = picker.pick({ kind: 'workspace' }, controller.signal);
  await ready;
  await assert.rejects(picker.pick({ kind: 'executable' }), {
    code: 'picker_busy',
  });
  controller.abort();
  assert.deepEqual(await first, { path: null });
  assert.equal(picker.active, null);
  const second = picker.pick({ kind: 'executable' });
  await picker.close();
  assert.deepEqual(await second, { path: null });
  await assert.rejects(picker.pick({ kind: 'workspace' }), {
    code: 'unavailable',
  });
});

void test('HTTP picker retains browser origin protections and aborts on client disconnect', async (t) => {
  const f = await dailyFixture(t);
  const local = await personaSettingsFixture(t);
  await local.settings.close();
  f.analyses.persona = local.persona;
  const server = createModelServer(f.models, {
    analyses: f.analyses,
    daily: f.daily,
  });
  const { picker, ready } = heldPicker();
  f.analyses.personaSettings.pathPicker = picker;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/persona/settings/pick`;
  const body = JSON.stringify({ kind: 'workspace' });
  const missingHeader = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  assert.equal(missingHeader.status, 403);
  await missingHeader.text();
  const crossSite = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Paper-Radar': '1',
      Origin: 'https://other.example',
    },
    body,
  });
  assert.equal(crossSite.status, 403);
  await crossSite.text();
  assert.equal(picker.active, null);
  const controller = new AbortController();
  const request = fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Paper-Radar': '1' },
    body,
    signal: controller.signal,
  });
  const dialog = await ready;
  const aborted = new Promise((resolve) =>
    dialog.signal.addEventListener('abort', resolve, { once: true }),
  );
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await aborted;
  assert.equal(dialog.signal.aborted, true);
});
