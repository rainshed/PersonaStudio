import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { PromptStore } from '../server/prompts/store.mjs';
import { promptSettingsRoute } from '../server/prompts/settings.mjs';
import { createModelServer } from '../server/index.mjs';
import { fixture } from './helpers/daily-fixture.mjs';

const id = 'paper-radar.task-single.zh';
async function storeFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'radar-prompt-settings-'));
  const store = new PromptStore(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

void test('settings lists production prompts and dependencies and excludes legacy prompts and private records', async (t) => {
  const store = await storeFixture(t);
  const { prompts } = promptSettingsRoute(store, 'GET', '');
  assert.deepEqual(
    new Set(prompts.map((p) => p.id)),
    new Set(
      ['zh', 'en'].flatMap((language) => [
        `paper-radar.shared.${language}`,
        ...['single', 'summary', 'connections', 'review'].map(
          (task) => `paper-radar.task-${task}.${language}`,
        ),
        `paper-radar.screen-autonomous.${language}`,
        ...['focused', 'balanced', 'exploratory'].map(
          (rule) => `paper-radar.screen-${rule}.${language}`,
        ),
      ]),
    ),
  );
  for (const entry of prompts) {
    const detail = promptSettingsRoute(store, 'GET', entry.id);
    assert.ok(detail.used_by.every((key) => prompts.some((p) => p.id === key)));
    assert.ok(
      promptSettingsRoute(store, 'POST', `${entry.id}/preview`, {
        templates: detail.active.templates,
      }).rendered,
    );
  }
  for (const path of [
    'paper-radar.task-discussion.zh',
    'paper-radar.task-discussion.en',
    'paper-radar.summary',
    'paper-radar.screen-agent',
    'captures',
    'experiments',
    'export',
    `${id}/captures`,
  ])
    assert.throws(() => promptSettingsRoute(store, 'GET', path), {
      code: 'not_found',
    });
  assert.equal(store.records('captures').length, 0);
});

void test('preview is non-mutating; save activates validated templates; conflicts retain the winning version', async (t) => {
  const store = await storeFixture(t);
  const before = store.snapshot();
  const initial = promptSettingsRoute(store, 'GET', id);
  const templates = {
    ...initial.active.templates,
    system:
      initial.active.templates.system +
      '\nPrioritize experimental limitations.',
  };
  const preview = promptSettingsRoute(store, 'POST', `${id}/preview`, {
    templates,
  });
  assert.match(preview.rendered.system, /Prioritize experimental limitations/);
  assert.deepEqual(store.snapshot(), before);
  const saved = promptSettingsRoute(store, 'POST', `${id}/save`, {
    templates,
    expected_active: initial.active_version,
    note: 'Limitations first',
  });
  assert.notEqual(saved.active_version, initial.active_version);
  assert.equal(saved.active.base_version, initial.active_version);
  assert.equal(
    store.preview(id, store.definition(id).example).rendered.system,
    preview.rendered.system,
  );
  assert.doesNotMatch(
    store.preview(id, store.definition(id).example, { snapshot: before })
      .rendered.system,
    /Prioritize experimental limitations/,
  );
  const fingerprint = store.snapshot().fingerprint;
  for (const { action, extra } of [
    {
      action: 'save',
      extra: { templates: { system: 'Missing task', user: '{{unknown}}' } },
    },
    { action: 'save', extra: { templates: { ...templates, user: '' } } },
    {
      action: 'save',
      extra: {
        templates: {
          ...templates,
          system: '{{@paper-radar.terminology}}' + 'x'.repeat(10001),
        },
      },
    },
    { action: 'preview', extra: {} },
    { action: 'activate', extra: { version: 'does-not-exist' } },
  ]) {
    assert.throws(() =>
      promptSettingsRoute(store, 'POST', `${id}/${action}`, {
        expected_active: saved.active_version,
        ...extra,
      }),
    );
    assert.equal(store.snapshot().fingerprint, fingerprint);
  }
  const versions = store.detail(id).versions.length;
  assert.throws(
    () =>
      promptSettingsRoute(store, 'POST', `${id}/save`, {
        templates: { ...templates, user: 'New draft {{task}}' },
        expected_active: initial.active_version,
      }),
    { code: 'conflict' },
  );
  assert.equal(store.detail(id).versions.length, versions);
  const restored = promptSettingsRoute(store, 'POST', `${id}/activate`, {
    version: 'default',
    expected_active: saved.active_version,
  });
  assert.equal(restored.active_version, initial.active_version);
  assert.ok(restored.versions.some((v) => v.id === saved.active_version));
});

void test('shared rules and selected screening rules compose without manual references', async (t) => {
  const store = await storeFixture(t);
  for (const language of ['zh', 'en']) {
    const shared = `paper-radar.shared.${language}`;
    promptSettingsRoute(store, 'POST', `${shared}/save`, {
      templates: { text: `${language} shared` },
      expected_active: store.version(shared).id,
    });
    for (const rule of ['focused', 'balanced', 'exploratory']) {
      const key = `paper-radar.screen-${rule}.${language}`;
      promptSettingsRoute(store, 'POST', `${key}/save`, {
        templates: { text: `${language} ${rule}` },
        expected_active: store.version(key).id,
      });
      const preview = promptSettingsRoute(store, 'POST', `${key}/preview`, {
        templates: store.version(key).templates,
      });
      assert.equal(preview.blocks[0].text, `${language} shared`);
      assert.equal(preview.blocks.at(-1).text, `${language} ${rule}`);
      assert.equal(
        preview.blocks.filter((b) => b.kind === 'screening_rule').length,
        1,
      );
      assert.deepEqual(
        new Set(Object.keys(preview.versions)),
        new Set([shared, key, `paper-radar.screen-autonomous.${language}`]),
      );
    }
  }
});

void test('configured remote settings obey application access rules without opening workbench captures or model calls', async (t) => {
  const f = await fixture(t);
  const server = createModelServer(f.models, {
    analyses: f.analyses,
    publicOrigin: 'https://radar.example.ts.net',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const port = server.address().port;
  const headers = {
    Host: 'radar.example.ts.net',
    Origin: 'https://radar.example.ts.net',
    'Content-Type': 'application/json',
    'X-Paper-Radar': '1',
  };
  const send = (path, body, overrides = {}) =>
    new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: body === undefined ? 'GET' : 'POST',
          headers: { ...headers, ...overrides },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => {
            text += chunk;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode, body: JSON.parse(text) }),
          );
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  assert.equal((await send('/api/prompt-settings')).status, 200);
  const detail = (await send(`/api/prompt-settings/${id}`)).body;
  const body = {
    expected_active: detail.active_version,
    templates: {
      ...detail.active.templates,
      user: 'Focus on evidence. {{task}}',
    },
  };
  assert.equal(
    (await send(`/api/prompt-settings/${id}/save`, body)).status,
    200,
  );
  assert.equal(
    (await send(`/api/prompt-settings/${id}/preview`, body)).status,
    200,
  );
  assert.equal(
    (await send(`/api/prompt-settings/${id}/save`, body)).status,
    409,
  );
  assert.equal((await send('/api/prompts/v1/captures')).status, 403);
  for (const overrides of [
    { Origin: 'https://evil.example' },
    { 'X-Paper-Radar': '' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ])
    assert.equal(
      (await send(`/api/prompt-settings/${id}/save`, body, overrides)).status,
      403,
    );
  assert.equal(
    (await send('/api/prompt-settings', undefined, { Host: 'evil.example' }))
      .status,
    403,
  );
  assert.equal(f.calls, 0);
  assert.equal(f.analyses.prompts.records('captures').length, 0);
});

void test('preview language follows the edited prompt and does not alter task settings', async (t) => {
  const store = await storeFixture(t);
  const before = store.snapshot();
  for (const entry of store
    .catalog()
    .filter((p) => p.settings_visible && p.settings_role === 'task')) {
    const original = structuredClone(store.definition(entry.id).example);
    const preview = promptSettingsRoute(store, 'POST', `${entry.id}/preview`, {
      templates: store.version(entry.id).templates,
      language: entry.language,
    });
    assert.equal(
      `paper-radar.shared.${entry.language}` in preview.versions,
      entry.language === 'zh',
    );
    assert.ok(preview.rendered.user.includes(`"language":"${entry.language}"`));
    assert.deepEqual(store.definition(entry.id).example, original);
  }
  assert.throws(
    () =>
      promptSettingsRoute(store, 'POST', `${id}/preview`, {
        templates: store.version(id).templates,
        language: 'en',
      }),
    /不一致/,
  );
  assert.deepEqual(store.snapshot(), before);
});
