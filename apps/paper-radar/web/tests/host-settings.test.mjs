import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  upgradeRoutes,
  materializeRoutes,
  taskChoice,
  cleanModelName,
  HOST_TASKS,
} from '../lib/host-settings.ts';
import {
  emptyRoutes,
  selectRoute,
} from '../../plugins/dsh/src/routing.mjs';
import {
  hostSettingsCopy,
  dshSettingsError,
} from '../lib/host-settings-copy.ts';
import { readBackendResponse } from '../lib/backend-response.ts';
const choice = (model, reasoningEffort = 'high') => ({
  model: { provider: 'host', model },
  reasoningEffort,
});

void test('legacy choices migrate to two presets and preserve task exceptions without mutating saved data', () => {
  const old = emptyRoutes();
  old.tasks.single = choice('quality');
  old.tasks.screen = choice('fast', 'low');
  old.tasks.discussion = choice('discussion');
  old.tasks.review.reasoningEffort = 'medium';
  old.fallback = { enabled: true, ...choice('backup', 'low') };
  const before = structuredClone(old),
    migrated = upgradeRoutes(old);
  assert.deepEqual(old, before);
  assert.equal(migrated.assignments.screen, 'fast');
  for (const task of ['single', 'summary', 'connections'])
    assert.equal(migrated.assignments[task], 'deep');
  assert.equal(migrated.assignments.discussion, 'custom');
  assert.deepEqual(taskChoice(migrated, 'discussion'), old.tasks.discussion);
  assert.equal(migrated.assignments.review, 'custom');
  assert.deepEqual(taskChoice(migrated, 'review'), choice('quality', 'medium'));
  assert.deepEqual(migrated.fallback, old.fallback);
  assert.equal(migrated.concurrency, 4);
  assert.deepEqual(upgradeRoutes(migrated), migrated);
});

void test('preset edits reach assigned tasks while custom choices and explicit host overrides stay independent', () => {
  const old = emptyRoutes();
  old.tasks.single = choice('quality');
  old.tasks.screen = choice('fast', 'low');
  old.tasks.discussion = choice('discussion');
  const routes = upgradeRoutes(old);
  routes.presets.deep = choice('new-quality', 'medium');
  const saved = materializeRoutes(routes),
    defaults = { provider: 'host', model: 'default', reasoningEffort: 'low' };
  assert.equal(saved.tasks.single.model.model, 'new-quality');
  assert.equal(saved.tasks.summary.model.model, 'new-quality');
  assert.equal(saved.tasks.screen.model.model, 'fast');
  assert.equal(saved.tasks.discussion.model.model, 'discussion');
  const explicit = selectRoute('single', saved, defaults, {
    explicit: { model: { provider: 'host', model: 'temporary' } },
  });
  assert.equal(explicit.model, 'temporary');
  assert.equal(explicit.reasoningEffort, undefined);
  saved.assignments.review = 'custom';
  saved.tasks.review = { model: null, reasoningEffort: null };
  assert.equal(
    selectRoute('review', saved, defaults, { parent: 'single' }).model,
    'default',
  );
  assert.equal(
    selectRoute('review', saved, defaults, {
      session: { ...defaults, model: 'session' },
    }).model,
    'session',
  );
  const empty = upgradeRoutes(emptyRoutes());
  for (const task of HOST_TASKS)
    assert.equal(empty.assignments[task], task === 'screen' ? 'fast' : 'deep');
});

void test('model labels remove provider brackets without changing identity; settings errors keep a stable localized code', async () => {
  assert.equal(cleanModelName('[Provider] GPT Example'), 'GPT Example');
  assert.equal(cleanModelName('Model 2 (preview)'), 'Model 2 (preview)');
  for (const code of [
    'conflict',
    'INVALID_REASONING_EFFORT',
    'MISSING_CREDENTIAL',
    'NO_ADAPTER',
    'invalid_settings',
    'unknown',
  ]) {
    assert.doesNotMatch(
      dshSettingsError(code, hostSettingsCopy.en),
      /[\p{Script=Han}]/u,
    );
  }
  assert.deepEqual(
    Object.keys(hostSettingsCopy.en).sort(),
    Object.keys(hostSettingsCopy.zh).sort(),
  );
  await assert.rejects(
    readBackendResponse(
      new Response(
        JSON.stringify({
          error: { code: 'conflict', message: '任务设置已改变' },
        }),
        { status: 409 },
      ),
    ),
    { code: 'conflict', message: '任务设置已改变' },
  );
});

void test('flat HTTP error codes are preserved for the settings interface', async () => {
  await assert.rejects(
    readBackendResponse(
      new Response(
        JSON.stringify({ code: 'conflict', error: '任务设置已改变' }),
        { status: 409 },
      ),
    ),
    { code: 'conflict' },
  );
});
