import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PromptStore, defaultCatalog } from '../server/prompts/store.mjs';
import { promptSettingsRoute } from '../server/prompts/settings.mjs';
import {
  TASK_PROMPTS,
  SCREEN_PROMPT,
  SCREEN_RULES,
} from '../server/prompts/language-prompts.mjs';
import { LEGACY_RENDER_POLICY } from '../server/prompts/render-policy.mjs';
import { promptFingerprint } from '../server/agents/autonomous-task.mjs';
import { screeningPromptFingerprint } from '../server/daily/agent-screening.mjs';
async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'radar-language-prompts-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function activate(store, id, templates) {
  const before = store.version(id).id;
  const version = store.saveVersion(id, templates);
  store.activate([
    { prompt_id: id, version: version.id, expected_active: before },
  ]);
  return version;
}
const variables = (language, rule = 'balanced') => ({
  task: { input: { language }, criteria: { strictness: rule } },
  recommendation_strictness: rule,
});

void test('migration preserves active customization and history, is idempotent, and replays old snapshots unchanged', async (t) => {
  const dir = await directory(t);
  const legacy = new PromptStore(
    dir,
    defaultCatalog().filter((p) => !p.language),
  );
  const term = 'paper-radar.terminology';
  activate(legacy, term, { text: 'EARLIER TERMS' });
  activate(legacy, term, { text: 'CUSTOM CHINESE RULES' });
  const task = 'paper-radar.task-single';
  activate(legacy, task, {
    ...legacy.version(task).templates,
    system: legacy.version(task).templates.system + ' CUSTOM TASK',
  });
  activate(legacy, 'paper-radar.strictness', {
    focused: 'CUSTOM FOCUS',
    balanced: 'CUSTOM BALANCE',
    exploratory: 'CUSTOM EXPLORE',
  });
  const snapshots = [legacy.snapshot(), legacy.snapshot()];
  delete snapshots[0].rendering_policy;
  snapshots[1].rendering_policy = LEGACY_RENDER_POLICY;
  const expected = snapshots.map((snapshot) =>
    legacy.preview(task, variables('en'), { snapshot }),
  );
  legacy.close();
  const store = new PromptStore(dir);
  assert.equal(
    store.version('paper-radar.shared.zh').templates.text,
    'CUSTOM CHINESE RULES',
  );
  assert.equal(store.version('paper-radar.shared.en').templates.text, '');
  assert(
    store
      .detail('paper-radar.shared.zh')
      .versions.some((v) => v.templates.text === 'EARLIER TERMS'),
  );
  for (const lang of ['zh', 'en']) {
    assert.match(
      store.version(`${task}.${lang}`).templates.system,
      /CUSTOM TASK/,
    );
    assert.doesNotMatch(
      store.version(`${task}.${lang}`).templates.system,
      /@paper-radar/,
    );
    assert.equal(
      store.version(`paper-radar.screen-focused.${lang}`).templates.text,
      'CUSTOM FOCUS',
    );
  }
  for (let i = 0; i < snapshots.length; i++)
    assert.deepEqual(
      store.preview(task, variables('en'), { snapshot: snapshots[i] }),
      expected[i],
    );
  const changed = activate(store, 'paper-radar.shared.zh', {
    text: 'NEW USER RULES',
  });
  store.close();
  const reopened = new PromptStore(dir);
  t.after(() => reopened.close());
  assert.equal(reopened.version('paper-radar.shared.zh').id, changed.id);
  assert.equal(reopened.version(term).templates.text, 'CUSTOM CHINESE RULES');
});

void test('runtime language and selected rule determine exactly which prompt blocks and versions are included', async (t) => {
  const store = new PromptStore(await directory(t));
  t.after(() => store.close());
  for (const lang of ['zh', 'en']) {
    activate(store, `paper-radar.shared.${lang}`, { text: `${lang}:SHARED` });
    for (const rule of SCREEN_RULES)
      activate(store, `paper-radar.screen-${rule}.${lang}`, {
        text: `${lang}:${rule}:ONLY`,
      });
    for (const task of TASK_PROMPTS)
      for (const rule of task === SCREEN_PROMPT ? SCREEN_RULES : ['balanced']) {
        const input = variables(lang, rule);
        for (const encoded of [false, true]) {
          const preview = store.preview(task, {
            ...input,
            task: encoded ? JSON.stringify(input.task) : input.task,
            language: lang === 'zh' ? 'en' : 'zh',
            ui_language: 'en',
          });
          const blocks = JSON.parse(preview.rendered.system).instructions;
          assert.equal(blocks[0].text, `${lang}:SHARED`);
          assert(
            blocks.every(
              (block) =>
                block.source.prompt_id &&
                block.source.version &&
                block.source.language === lang,
            ),
          );
          const selected = blocks.filter((b) => b.kind === 'screening_rule');
          assert.equal(selected.length, task === SCREEN_PROMPT ? 1 : 0);
          if (selected.length)
            assert.equal(selected[0].text, `${lang}:${rule}:ONLY`);
          assert(
            !Object.keys(preview.versions).some(
              (key) =>
                key.endsWith(lang === 'zh' ? '.en' : '.zh') ||
                key.includes('terminology'),
            ),
          );
          for (const other of SCREEN_RULES.filter((r) => r !== rule))
            assert(!preview.rendered.system.includes(`:${other}:ONLY`));
        }
      }
  }
  const conflict = store.preview(SCREEN_PROMPT, {
    ...variables('zh', 'focused'),
    recommendation_strictness: 'exploratory',
  });
  assert.equal(conflict.blocks.at(-1).source.rule, 'focused');
});

void test('only relevant language and rule changes invalidate caches; frozen tasks keep their composition', async (t) => {
  const store = new PromptStore(await directory(t));
  t.after(() => store.close());
  const subscription = { language: 'zh', recommendation_strictness: 'focused' };
  const before = store.snapshot();
  const screenKey = (snapshot) =>
    screeningPromptFingerprint(snapshot, SCREEN_PROMPT, subscription);
  const taskKey = (snapshot) =>
    promptFingerprint(snapshot, 'paper-radar.task-single', variables('zh'));
  activate(store, 'paper-radar.shared.en', { text: 'ENGLISH CHANGE' });
  activate(store, 'paper-radar.screen-exploratory.zh', {
    text: 'EXPLORATORY CHANGE',
  });
  assert.equal(screenKey(before), screenKey(store.snapshot()));
  assert.equal(taskKey(before), taskKey(store.snapshot()));
  activate(store, 'paper-radar.screen-focused.zh', { text: 'FOCUSED CHANGE' });
  assert.notEqual(screenKey(before), screenKey(store.snapshot()));
  assert.equal(taskKey(before), taskKey(store.snapshot()));
  const frozen = store.preview(SCREEN_PROMPT, variables('zh', 'focused'), {
    snapshot: before,
  });
  assert.doesNotMatch(frozen.rendered.system, /FOCUSED CHANGE/);
  activate(store, 'paper-radar.shared.zh', { text: 'ZH CHANGE' });
  assert.notEqual(taskKey(before), taskKey(store.snapshot()));
});

void test('combined previews accept only related drafts, do not activate them, and validate before saving', async (t) => {
  const store = new PromptStore(await directory(t));
  t.after(() => store.close());
  const id = 'paper-radar.screen-focused.zh';
  const shared = 'paper-radar.shared.zh';
  const base = `${SCREEN_PROMPT}.zh`;
  const before = store.snapshot();
  const preview = promptSettingsRoute(store, 'POST', `${id}/preview`, {
    templates: { text: 'RULE DRAFT' },
    drafts: {
      [shared]: { text: 'SHARED DRAFT' },
      [base]: { ...store.version(base).templates, system: 'COMMON DRAFT' },
    },
  });
  assert.deepEqual(
    preview.blocks.map((b) => b.text),
    ['SHARED DRAFT', 'COMMON DRAFT', 'RULE DRAFT'],
  );
  assert.deepEqual(store.snapshot(), before);
  for (const key of [
    'paper-radar.shared.en',
    'paper-radar.screen-balanced.zh',
    'paper-radar.terminology',
  ])
    assert.throws(
      () =>
        promptSettingsRoute(store, 'POST', `${id}/preview`, {
          templates: { text: 'x' },
          drafts: { [key]: { text: 'unrelated' } },
        }),
      /当前语言和筛选规则/,
    );
  assert.throws(
    () =>
      promptSettingsRoute(store, 'POST', `${shared}/save`, {
        templates: { text: 'x'.repeat(11000) },
        expected_active: store.version(shared).id,
      }),
    { code: 'context_length' },
  );
  assert.deepEqual(store.snapshot(), before);
});
