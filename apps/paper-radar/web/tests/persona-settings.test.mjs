import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readFile,
  writeFile,
  stat,
  rename,
  symlink,
  realpath,
  cp,
  mkdir,
  access,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PersonaSettings,
  configurePersonaSettings,
} from '../server/persona/settings.mjs';
import { PersonaClient } from '../server/persona/service.mjs';
import { personaConnectionId } from '../server/persona/query-client.mjs';
import { personaSettingsFixture } from './helpers/persona-settings-fixture.mjs';
import { fixture as dailyFixture } from './helpers/daily-fixture.mjs';
import { DailyScheduler } from '../server/daily/scheduler/service.mjs';
import { analysisRoute } from '../server/analyses/http.mjs';

const saveTest = (settings, result) =>
  settings.save({
    test_id: result.test_id,
    expected_revision: result.revision,
  });

void test(
  'local settings launch the real ai-persona-mcp executable against an isolated demo copy',
  { timeout: 60000 },
  async (t) => {
    const project = fileURLToPath(
      new URL('../../../ai-persona', import.meta.url),
    );
    const executable = join(project, '.venv/bin/ai-persona-mcp');
    try {
      await access(executable);
    } catch {
      if (process.env.PAPER_RADAR_REQUIRE_PERSONA_TESTS === '1')
        throw new Error(
          'AI Persona integration dependencies are required by this check. Run npm run setup:radar.',
        );
      t.skip('Sibling AI Persona installation unavailable');
      return;
    }
    const f = await personaSettingsFixture(t, { configured: false });
    await f.settings.close();
    const workspace = join(f.directory, 'real demo');
    await cp(
      join(project, 'examples/demo-persona/persona-data'),
      join(workspace, 'persona-data'),
      { recursive: true },
    );
    await mkdir(join(workspace, 'persona-state'));
    const persona = new PersonaClient(f.path);
    const manager = new PersonaSettings(persona, { pollMs: 100000 });
    t.after(async () => {
      await manager.close();
      await persona.close();
    });
    const result = await manager.test({
      name: 'Isolated demo',
      workspace,
      executable,
      expected_revision: 0,
    });
    assert.ok(result.tag_count > 0);
    assert.equal(
      result.tags.some((tag) => tag.id === 'tag_physics'),
      true,
    );
    const saved = await saveTest(manager, result);
    assert.equal(saved.pending_error, null);
    assert.equal(saved.pending, null);
    assert.equal(
      (await persona.tags()).connection_id,
      saved.current.connection_id,
    );
  },
);

void test('imports legacy settings without changing identity or exposing environment values', async (t) => {
  const f = await personaSettingsFixture(t);
  const original = await readFile(f.path, 'utf8');
  const settings = f.settings.settings();
  assert.equal(settings.current.connection_id, personaConnectionId(f.config));
  assert.equal(settings.draft.workspace, f.workspace);
  assert.equal(settings.pending, null);
  assert.equal(JSON.stringify(settings).includes('never-return-this'), false);
  assert.equal(await readFile(f.path, 'utf8'), original);
  assert.equal(f.connections.length, 0);
});

void test('first connection is detected, actually reads tags, and activates without a restart', async (t) => {
  const f = await personaSettingsFixture(t, { configured: false });
  assert.equal(
    f.settings.settings().draft.workspace,
    await realpath(f.workspace),
  );
  const tested = await f.settings.test(f.draft({ executable: '' }));
  assert.equal(tested.tag_count, 2);
  assert.deepEqual(
    f.calls.map((call) => call.name),
    ['get_knowledge_map'],
  );
  assert.equal(f.connections[0].closed, true);
  assert.equal(f.persona.client, null);
  const result = await saveTest(f.settings, tested);
  assert.equal(result.pending, null);
  assert.equal(result.connected, true);
  assert.equal(
    (await f.persona.tags()).connection_id,
    result.current.connection_id,
  );
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal(
    await readFile(
      join(f.workspace, 'persona-data/config/persona.toml'),
      'utf8',
    ),
    '# fixture\n',
  );
});

void test('empty libraries connect successfully and incompatible tools fail without replacing the active client', async (t) => {
  const f = await personaSettingsFixture(t, { tagCount: 0 });
  await f.persona.connect();
  const active = f.persona.client,
    original = await readFile(f.path, 'utf8');
  assert.equal((await f.settings.test(f.draft())).tag_count, 0);
  f.state.oldTools = true;
  await assert.rejects(f.settings.test(f.draft()), { code: 'persona_version' });
  f.state.oldTools = false;
  f.state.fail = true;
  await assert.rejects(f.settings.test(f.draft()), {
    code: 'persona_unavailable',
  });
  assert.equal(await readFile(f.path, 'utf8'), original);
  assert.equal(f.persona.client, active);
  assert.equal(active.closed, false);
  assert.equal(
    f.connections.slice(1).every((c) => c.closed),
    true,
  );
});

void test('rejects arbitrary commands, arguments, URLs and invalid directories before starting a process', async (t) => {
  const f = await personaSettingsFixture(t);
  for (const patch of [
    { command: '/bin/sh', args: ['-c', 'anything'] },
    { executable: '/bin/sh' },
    { workspace: 'https://example.com/mcp' },
    { workspace: '../relative' },
    { workspace: f.directory },
    { workspace: f.workspace + '\nanything' },
    { env: { TOKEN: 'x' } },
  ])
    await assert.rejects(f.settings.test(f.draft(patch)));
  assert.equal(f.connections.length, 0);
});

void test('renaming a connection or changing the executable preserves the legacy library identity', async (t) => {
  const f = await personaSettingsFixture(t);
  const oldId = personaConnectionId(f.config);
  const result = await saveTest(
    f.settings,
    await f.settings.test(
      f.draft({
        name: '新名称',
        executable: join(f.other, '.venv/bin/ai-persona-mcp'),
      }),
    ),
  );
  assert.equal(result.current.connection_id, oldId);
  assert.equal(result.current.name, '新名称');
  assert.deepEqual(
    JSON.parse(await readFile(f.path, 'utf8')).env,
    f.config.env,
  );
  await f.settings.close();
  const reloaded = new PersonaSettings(f.persona, {
    clientFactory: f.makeClient,
    pollMs: 100000,
  });
  t.after(() => reloaded.close());
  assert.equal(reloaded.settings().current.connection_id, oldId);
});

void test('symlinks and moved library folders retain identity; replacing a library does not', async (t) => {
  const f = await personaSettingsFixture(t);
  await saveTest(f.settings, await f.settings.test(f.draft()));
  const oldId = f.persona.identity;
  const moved = join(f.directory, 'moved 资料');
  await rename(f.workspace, moved);
  const alias = join(f.directory, 'alias');
  await symlink(moved, alias);
  const result = await f.settings.test(
    f.draft({
      workspace: alias,
      executable: join(moved, '.venv/bin/ai-persona-mcp'),
    }),
  );
  assert.equal(result.connection.connection_id, oldId);
  await rename(f.other, f.workspace);
  const replacement = await f.settings.test(f.draft());
  assert.notEqual(replacement.connection.connection_id, oldId);
});

void test('save waits for jobs and live MCP requests, then switches once; pending changes can be cancelled', async (t) => {
  const f = await personaSettingsFixture(t);
  await f.persona.connect();
  const active = f.persona.client,
    oldId = f.persona.identity;
  f.state.busy = true;
  const result = await saveTest(
    f.settings,
    await f.settings.test(f.draft({ workspace: f.other })),
  );
  assert.ok(result.pending);
  assert.equal(f.persona.identity, oldId);
  assert.equal(active.closed, false);
  f.settings.cancel({ expected_revision: result.revision });
  f.state.busy = false;
  await f.settings.flush();
  assert.equal(f.persona.identity, oldId);
  const tested = await f.settings.test(f.draft({ workspace: f.other }));
  f.persona.inflight++;
  assert.ok((await saveTest(f.settings, tested)).pending);
  f.persona.inflight--;
  await f.settings.flush();
  assert.equal(f.settings.settings().pending, null);
  assert.notEqual(f.persona.identity, oldId);
  await Promise.allSettled(f.persona.retiring);
  assert.equal(active.closed, true);
});

void test('pending saves survive restart and a failed activation preserves the old connection', async (t) => {
  const f = await personaSettingsFixture(t);
  f.state.busy = true;
  await saveTest(
    f.settings,
    await f.settings.test(f.draft({ workspace: f.other })),
  );
  await f.settings.close();
  const persona = new PersonaClient(f.path, { clientFactory: f.factory });
  const reloaded = new PersonaSettings(persona, {
    clientFactory: f.makeClient,
    pollMs: 100000,
  });
  t.after(async () => {
    await reloaded.close();
    await persona.close();
  });
  await persona.connect();
  const oldId = persona.identity;
  f.state.fail = true;
  await reloaded.flush();
  assert.equal(persona.identity, oldId);
  assert.ok(reloaded.settings().pending_error);
  assert.ok(reloaded.settings().pending);
  f.state.fail = false;
  const draft = reloaded.settings().draft;
  await saveTest(
    reloaded,
    await reloaded.test({
      name: draft.name,
      workspace: draft.workspace,
      executable: draft.executable,
      expected_revision: reloaded.revision,
    }),
  );
  assert.notEqual(persona.identity, oldId);
});

void test('stale tests, concurrent editors and externally changed configuration cannot overwrite a save', async (t) => {
  const f = await personaSettingsFixture(t);
  const first = await f.settings.test(f.draft());
  const second = await f.settings.test(f.draft({ name: '另一页' }));
  await saveTest(f.settings, first);
  await assert.rejects(saveTest(f.settings, second), {
    code: 'settings_conflict',
  });
  const expiring = await f.settings.test(f.draft());
  f.settings.tests.get(expiring.test_id).expires = 0;
  await assert.rejects(saveTest(f.settings, expiring), {
    code: 'test_expired',
  });
  const fresh = await f.settings.test(f.draft());
  await writeFile(f.path, '{"external":true}');
  await assert.rejects(saveTest(f.settings, fresh), {
    code: 'settings_file_changed',
  });
  assert.equal(await readFile(f.path, 'utf8'), '{"external":true}');
});

void test('cancelling while activation is probing cannot apply an obsolete connection', async (t) => {
  const f = await personaSettingsFixture(t);
  const tested = await f.settings.test(f.draft({ workspace: f.other }));
  let resume;
  const barrier = new Promise((resolve) => {
    resume = resolve;
  });
  f.state.beforeRead = () => barrier;
  const saving = saveTest(f.settings, tested);
  f.settings.cancel({ expected_revision: f.settings.revision });
  resume();
  await saving;
  assert.equal(f.settings.settings().pending, null);
  assert.equal(
    f.settings.settings().current.connection_id,
    personaConnectionId(f.config),
  );
});

void test('switching libraries pauses subscriptions and schedules, clears old tags, and preserves report records', async (t) => {
  const f = await dailyFixture(t);
  const generated = f.create();
  await f.finish(generated.run.id);
  const modelCalls = f.calls;
  const historyTables = [
    'daily_reports',
    'daily_runs',
    'daily_items',
    'daily_item_versions',
    'daily_feedback',
  ];
  const history = historyTables.map((table) =>
    f.repo.db.prepare(`SELECT * FROM ${table}`).all(),
  );
  const local = await personaSettingsFixture(t);
  f.analyses.persona = local.persona;
  f.daily.persona = local.persona;
  const scheduler = new DailyScheduler(f.daily);
  t.after(() => scheduler.close());
  const subscription = {
    ...f.sub,
    persona_connection_id: personaConnectionId(local.config),
  };
  f.repo.saveSubscription(subscription);
  scheduler.repo.saveSchedule({
    subscription_id: f.sub.id,
    revision: 1,
    enabled: true,
    next_check_at: '2099-01-01T00:00:00Z',
  });
  const feed = f.repo.db.prepare('SELECT * FROM arxiv_batch_revisions').all();
  const manager = configurePersonaSettings(f.analyses, f.daily, null, null);
  manager.makeClient = local.makeClient;
  t.after(() => manager.close());
  const tested = await manager.test(local.draft({ workspace: local.other }));
  assert.deepEqual(tested.affected_subscriptions, [
    { id: f.sub.id, name: f.sub.name },
  ]);
  await saveTest(manager, tested);
  const changed = f.repo.get('subscriptions', f.sub.id);
  assert.equal(changed.status, 'paused');
  assert.equal(changed.persona_reselection_required, true);
  assert.deepEqual(changed.scope.tag_ids, []);
  assert.equal(changed.persona_connection_id, null);
  assert.equal(scheduler.settings(f.sub.id).enabled, false);
  assert.deepEqual(
    f.repo.db.prepare('SELECT * FROM arxiv_batch_revisions').all(),
    feed,
  );
  assert.deepEqual(
    historyTables.map((table) =>
      f.repo.db.prepare(`SELECT * FROM ${table}`).all(),
    ),
    history,
  );
  assert.equal(f.calls, modelCalls);
  const enabled = await f.daily.saveSubscription(
    {
      status: 'enabled',
      scope: { tag_ids: ['tag-0'], tag_match: 'any' },
      persona_connection_id: local.persona.identity,
      expected_revision: changed.revision,
    },
    f.sub.id,
  );
  assert.equal(enabled.persona_reselection_required, false);
  assert.equal(scheduler.settings(f.sub.id).enabled, false);
});

void test('settings HTTP routes accept structured local fields and never expose hidden launch configuration', async (t) => {
  const f = await personaSettingsFixture(t);
  const service = { personaSettings: f.settings };
  const route = (method, path, body = {}) =>
    analysisRoute(
      service,
      { method, headers: {} },
      new URL('http://localhost/api/persona/settings' + path),
      async () => body,
    );
  const current = await route('GET', '');
  assert.equal(JSON.stringify(current).includes('never-return-this'), false);
  const tested = await route('POST', '/test', f.draft());
  const saved = await route('PUT', '', {
    test_id: tested.body.test_id,
    expected_revision: tested.body.revision,
  });
  assert.equal(saved.body.connected, true);
  await assert.rejects(route('POST', '/test', { ...f.draft(), args: [] }), {
    code: 'invalid_settings',
  });
  await assert.rejects(route('POST', '/unknown'), { code: 'not_found' });
});
