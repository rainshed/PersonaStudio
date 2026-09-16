import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptStore, defaultCatalog } from '../server/prompts/store.mjs';
import { PromptAPI } from '../server/prompts/http.mjs';
import { testHost } from './helpers/agent-host.mjs';
import { BridgeError as ModelError } from '../server/hosts/transport.mjs';
import { promptFingerprint } from '../server/agents/autonomous-task.mjs';
import { screeningPromptFingerprint } from '../server/daily/agent-screening.mjs';
async function fixture(t, engine) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-prompts-'));
  const store = new PromptStore(join(dir, 'prompts'));
  const calls = [];
  const models = testHost({
    generate: async (c, r) => {
      calls.push({ c: structuredClone(c), r });
      return engine ? engine(c, r) : { text: '{"issues":[]}' };
    },
  });
  const settings = models.store.state.settings;
  settings.connections[0].id = 'test';
  settings.defaultConnectionId = 'test';
  const api = new PromptAPI(store, models);
  t.after(async () => {
    await api.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { store, models, api, calls, dir, settings };
}
async function done(api, id) {
  await api.active.get(id)?.work;
  return api.store.record('experiments', id);
}
const id = 'paper-radar.review';
void test('saved versions are immutable; grouped activation is atomic and snapshots remain pinned', async (t) => {
  const { store } = await fixture(t);
  const before = store.snapshot();
  const a = store.saveVersion(
    id,
    {
      ...store.version(id).templates,
      system: 'Modified {{@paper-radar.analysis-policy}}',
    },
    'first',
  );
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(store.saveVersion(id, a.templates, 'new description'), a);
  const rule = store.saveVersion('paper-radar.terminology', {
    text: 'Changed terminology',
  });
  const changes = [
    { prompt_id: id, version: a.id, expected_active: before.versions[id].id },
    { prompt_id: rule.prompt_id, version: rule.id, expected_active: 'stale' },
  ];
  assert.throws(() => store.activate(changes), { code: 'conflict' });
  assert.deepEqual(store.snapshot(), before);
  changes[1].expected_active = before.versions[rule.prompt_id].id;
  store.activate(changes);
  assert.notEqual(store.snapshot().fingerprint, before.fingerprint);
  const vars = {
    ...store.definition(id).example,
    language: '中文',
    analysis: '{{untrusted-variable}}',
  };
  assert.match(store.preview(id, vars).rendered.system, /Changed terminology/);
  assert.doesNotMatch(
    store.preview(id, vars, { snapshot: before }).rendered.system,
    /Changed terminology/,
  );
  assert.match(
    store.preview(id, vars).rendered.user,
    /\{\{untrusted-variable\}\}/,
  );
  assert.throws(() => store.preview(id, {}), /缺少变量/);
  assert.throws(
    () =>
      store.saveVersion(id, {
        system: '{{@paper-radar.analysis-policy}}',
        user: '{{unknown}}',
      }),
    /未声明/,
  );
  assert.throws(() => store.definition('__proto__'), { code: 'not_found' });
});
void test('legacy snapshots include terminology only for Chinese output in structured and captured tasks', async (t) => {
  const { store } = await fixture(t);
  const term = 'paper-radar.terminology';
  const custom = store.saveVersion(term, {
    text: 'CUSTOM_CHINESE_TERMINOLOGY',
  });
  store.activate([
    {
      prompt_id: term,
      version: custom.id,
      expected_active: store.version(term).id,
    },
  ]);
  const snapshot = store.snapshot();
  snapshot.rendering_policy = 'terminology-by-output-language/v1';
  for (const entry of store
    .catalog()
    .filter((p) => p.settings_role === 'task' && p.language === 'zh').map((p) => store.definition(p.base_prompt))) {
    for (const language of ['zh', 'en']) {
      const variables = structuredClone(store.definition(entry.id).example);
      const task = variables.task;
      if (task.input) task.input.language = language;
      else task.output.language = language;
      variables.ui_language = language === 'zh' ? 'en' : 'zh';
      for (const encoded of [false, true]) {
        const preview = store.preview(entry.id, {
          ...variables,
          task: encoded ? JSON.stringify(task) : task,
        }, { snapshot });
        assert.equal(
          preview.rendered.system.includes('CUSTOM_CHINESE_TERMINOLOGY'),
          language === 'zh',
          entry.id,
        );
        assert.equal(term in preview.versions, language === 'zh');
        assert.equal(term in preview.version_snapshots, language === 'zh');
        assert.doesNotMatch(
          preview.rendered.system,
          /\{\{@paper-radar\.terminology\}\}/,
        );
        assert.ok(preview.rendered.user.includes(`"language":"${language}"`));
      }
    }
  }
  // Top-level language is used by legacy text prompts, including nested rules.
  for (const language of [
    '中文',
    'zh-CN',
    'Chinese prose with English academic terms',
    'English',
  ]) {
    const preview = store.preview('paper-radar.summary', {
      ...store.definition('paper-radar.summary').example,
      language,
    });
    assert.equal(term in preview.versions, language !== 'English');
  }
  // Editing a rule itself always shows its body; it is not a task invocation.
  assert.equal(
    store.preview(term, {}).rendered.text,
    'CUSTOM_CHINESE_TERMINOLOGY',
  );
});

void test('task language overrides conflicting UI or source language and old snapshots retain their original composition', async (t) => {
  const { store } = await fixture(t);
  const current = store.snapshot();
  const old = structuredClone(current);
  delete old.rendering_policy;
  const promptId = 'paper-radar.task-discussion';
  const variables = {
    task: JSON.stringify({
      input: { language: 'en' },
      paper: { language: 'zh' },
      question: '中文问题',
    }),
    language: '中文',
    ui_language: 'zh',
  };
  const term = 'paper-radar.terminology';
  assert.equal(
    term in store.preview(promptId, variables, { snapshot: current }).versions,
    false,
  );
  assert.equal(
    term in store.preview(promptId, variables, { snapshot: old }).versions,
    true,
  );
  assert.notEqual(
    promptFingerprint(current, promptId),
    promptFingerprint(old, promptId),
  );
  assert.notEqual(
    screeningPromptFingerprint(current),
    screeningPromptFingerprint(old),
  );
  for (const task of [
    null,
    {},
    'invalid-json',
    { input: { language: 'en' }, goal: { language: 'zh' } },
  ]) {
    assert.equal(term in store.preview(promptId, { task }).versions, false);
  }
});
void test('new defaults preserve custom selection and incompatible contracts require explicit migration', async (t) => {
  const { store, dir } = await fixture(t);
  const old = store.version(id),
    custom = store.saveVersion(id, {
      ...old.templates,
      system: 'Custom {{@paper-radar.analysis-policy}}',
    });
  store.activate([
    { prompt_id: id, version: custom.id, expected_active: old.id },
  ]);
  const catalog = defaultCatalog(),
    d = catalog.find((d) => d.id === id);
  d.templates.system = 'New {{@paper-radar.analysis-policy}}';
  const newer = new PromptStore(join(dir, 'prompts'), catalog);
  assert.equal(newer.version(id).id, custom.id);
  assert.notEqual(newer.version(id, 'default').id, old.id);
  newer.close();
  d.schema_version = '2';
  const incompatible = new PromptStore(join(dir, 'prompts'), catalog);
  t.after(() => incompatible.close());
  assert.throws(() => incompatible.preview(id, d.example), {
    code: 'incompatible',
  });
  incompatible.activate([
    { prompt_id: id, version: 'default', expected_active: custom.id },
  ]);
  assert.match(incompatible.preview(id, d.example).rendered.system, /New/);
});
void test('A/B fixes model and inputs, shared-rule drafts never activate implicitly, output is checked', async (t) => {
  const { store, api, calls } = await fixture(t);
  const fingerprint = store.snapshot().fingerprint;
  const experiment = api.start({
    prompt_id: id,
    variables: api.detail(id).example,
    variants: [
      { version: 'active' },
      {
        overrides: {
          'paper-radar.terminology': { templates: { text: 'B rule' } },
        },
      },
    ],
  });
  const result = await done(api, experiment.id);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results[0].validation.issues, []);
  assert.equal(calls[0].r.prompt, calls[1].r.prompt);
  assert.equal(calls[0].c.revision, calls[1].c.revision);
  assert.notEqual(calls[0].r.systemPrompt, calls[1].r.systemPrompt);
  assert.equal(store.snapshot().fingerprint, fingerprint);
  assert.equal(store.records('captures').length, 0);
  assert.equal(
    (
      await api.dispatch('POST', `experiments/${result.id}/feedback`, {
        choice: 'B',
        note: 'clearer',
      })
    ).feedback.choice,
    'B',
  );
});
void test('experiments neither retry nor use fallback', async (t) => {
  const { api, settings, calls } = await fixture(t, async () => {
    throw new ModelError('provider_error', 'Mock failure', true);
  });
  settings.connections.push({
    ...settings.connections[0],
    id: 'backup',
    name: 'backup',
  });
  {
    const s = { settings };
    s.settings.fallback = { enabled: true, connectionId: 'backup' };
  }
  const e = api.start({ prompt_id: id });
  const result = await done(api, e.id);
  assert.equal(result.status, 'failed');
  assert.equal(calls.length, 1);
});
void test('cancel rejects late output and a changed connection is rejected before generation', async (t) => {
  let release;
  const blocked = new Promise((r) => {
    release = r;
  });
  const {
    api,
    store,
    calls,
    models: _models,
    settings,
  } = await fixture(t, async (c) => {
    await blocked;
    return {
      text: '{"issues":[]}',
      modelId: c.modelId,
      providerId: c.providerId,
      stopReason: 'stop',
    };
  });
  const e = api.start({ prompt_id: id });
  await new Promise((r) => setTimeout(r, 10));
  assert.throws(() => store.delete('experiments', e.id), { code: 'busy' });
  api.cancel(e.id);
  release();
  const cancelled = await done(api, e.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.deepEqual(cancelled.results, []);
  const next = api.start({ prompt_id: id });
  settings.connections[0].revision = 'changed';
  const result = await done(api, next.id);
  assert.equal(result.status, 'failed');
  assert.equal(calls.length, 1);
});
void test('private captures are bounded, exports include all samples, additions require no UI changes', async (t) => {
  const { api, store, dir } = await fixture(t);
  for (let i = 0; i < 32; i++)
    store.capture(
      id,
      { ...store.definition(id).example, analysis: { private: i } },
      store.snapshot(),
    );
  assert.equal(store.records('captures').length, 30);
  const list = await api.dispatch('GET', 'captures');
  assert.ok(!('variables' in list.items[0]));
  assert.ok(!('snapshot' in list.items[0]));
  for (let i = 0; i < 105; i++)
    await api.dispatch('POST', 'samples', {
      prompt_id: id,
      name: `sample ${i}`,
      variables: store.definition(id).example,
    });
  assert.equal((await api.dispatch('GET', 'export')).samples.length, 105);
  const d = structuredClone(store.definition('paper-radar.extract'));
  d.id = 'future.extra';
  const extra = new PromptStore(join(dir, 'extension'), [
    ...defaultCatalog(),
    d,
  ]);
  t.after(() => extra.close());
  assert.ok(extra.catalog().some((v) => v.id === d.id));
  assert.ok(extra.preview(d.id, d.example).rendered.user);
});
