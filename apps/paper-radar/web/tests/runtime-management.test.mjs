import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  writeFile,
  readFile,
  mkdir,
  rm,
  symlink,
  realpath,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './helpers/daily-fixture.mjs';
import { Onboarding } from '../server/runtime/onboarding.mjs';
import {
  DataManagement,
  archiveCommand,
} from '../server/runtime/data-management.mjs';
import { personaProject, runtimePaths } from '../server/runtime/paths.mjs';
import {
  discoverWorkspace,
  discoverExecutable,
} from '../server/persona/discovery.mjs';
import { bridgeRequest } from '../server/hosts/transport.mjs';
import { createModelServer } from '../server/index.mjs';

void test('fresh onboarding requires setup, existing content completes it, and deleting the last subscription does not reset it', async (t) => {
  const f = await fixture(t);
  f.db.db.prepare('DELETE FROM subscriptions').run();
  const setup = new Onboarding(f.db, {
    settings: () => ({ configured: true, connected: true }),
  });
  assert.equal(setup.status().needs_setup, true);
  f.repo.saveSubscription(f.sub);
  assert.equal(setup.status().needs_setup, false);
  f.db.db.prepare('DELETE FROM subscriptions').run();
  assert.equal(new Onboarding(f.db).status().needs_setup, false);
});

void test('workspace discovery reads the configured external Persona and resolves escaped paths', async (t) => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'radar-discovery-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = join(dir, 'config.toml');
  const workspace = join(dir, '研究 workspace "quoted"');
  await writeFile(
    config,
    `[defaults]\nworkspace = ${JSON.stringify(workspace)}\n`,
  );
  assert.equal(discoverWorkspace({ AI_PERSONA_CONFIG: config }), workspace);
  assert.equal(
    discoverWorkspace({ AI_PERSONA_WORKSPACE: dir, AI_PERSONA_CONFIG: config }),
    dir,
  );
  assert.equal(
    discoverWorkspace({ AI_PERSONA_CONFIG: join(dir, 'missing') }),
    '',
  );
  assert.match(discoverExecutable(), /ai-persona-mcp$/);
  assert.equal(runtimePaths({ PAPER_RADAR_HOME: dir }).data, join(dir, 'data'));
  assert.equal(
    runtimePaths({ PAPER_RADAR_HOME: dir, PAPER_RADAR_STORAGE_DIR: workspace })
      .data,
    workspace,
  );
});

void test('installed Persona discovery prefers the stable command over a version-specific environment', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'radar-installed-discovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const command = join(dir, 'ai-persona-mcp');
  await writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(discoverExecutable('', { AI_PERSONA_MCP_COMMAND: command }), command);
  const root = join(dir, 'installation');
  await mkdir(join(root, 'current/scripts'), { recursive: true });
  const fallback = join(root, 'current/scripts/ai-persona-mcp');
  await writeFile(fallback, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(discoverExecutable('', { AI_PERSONA_INSTALL_ROOT: root }), fallback);
});

void test('a verified backup preserves reports, subscriptions and cached files, restores separately, and never replaces an existing directory', async (t) => {
  const f = await fixture(t);
  await f.finish(f.create().run.id);
  await mkdir(join(f.db.directory, 'cache/papers'), { recursive: true });
  await writeFile(
    join(f.db.directory, 'cache/papers/manifest.json'),
    '{"paper":"cached"}',
  );
  f.db.db.prepare('INSERT INTO daily_schedules VALUES (?,?,?,?,?)').run(
    f.sub.id,
    1,
    1,
    '2099-01-01',
    JSON.stringify({
      enabled: true,
      revision: 1,
      next_check_at: '2099-01-01',
    }),
  );
  const manager = new DataManagement(f.analyses, f.daily);
  const result = await manager.createBackup();
  assert.equal(manager.list().backups.length, 1);
  const restored = await manager.restore(result.id);
  t.after(() => rm(restored.directory, { recursive: true, force: true }));
  assert.notEqual(restored.directory, f.db.directory);
  const db = new DatabaseSync(join(restored.directory, 'radar.sqlite'), {
    readOnly: true,
  });
  t.after(() => db.close());
  assert.deepEqual(
    db.prepare('SELECT id,data FROM subscriptions').all(),
    f.db.db.prepare('SELECT id,data FROM subscriptions').all(),
  );
  assert.deepEqual(
    db.prepare('SELECT id FROM daily_runs').all(),
    f.db.db.prepare('SELECT id FROM daily_runs').all(),
  );
  assert.equal(
    db.prepare('SELECT enabled FROM daily_schedules').get().enabled,
    0,
  );
  assert.equal(
    f.db.db.prepare('SELECT enabled FROM daily_schedules').get().enabled,
    1,
  );
  const prompts = new DatabaseSync(
    join(restored.directory, 'prompts/prompts.sqlite3'),
    { readOnly: true },
  );
  assert.deepEqual(
    prompts.prepare('SELECT * FROM active ORDER BY prompt_id').all(),
    f.analyses.prompts.db
      .prepare('SELECT * FROM active ORDER BY prompt_id')
      .all(),
  );
  prompts.close();
  assert.equal(
    await readFile(
      join(restored.directory, 'cache/papers/manifest.json'),
      'utf8',
    ),
    '{"paper":"cached"}',
  );
  assert.throws(
    () =>
      archiveCommand(
        'restore',
        manager.backupPath(result.id),
        restored.directory,
      ),
    /could not be verified/,
  );
  assert.throws(() => manager.backupPath('../radar.sqlite'), /备份/);
  const busy = new DataManagement(f.analyses, f.daily, { busy: () => true });
  await assert.rejects(() => busy.createBackup(), /等待/);
});

void test('backups reject symlinks rather than following them outside the research data', async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.db.directory, 'cache'), { recursive: true });
  await symlink('/etc/hosts', join(f.db.directory, 'cache/external'));
  await assert.rejects(
    () => new DataManagement(f.analyses, f.daily).createBackup(),
    /regular files/,
  );
});

void test('management HTTP keeps mutation and origin protection and diagnostics exclude private values', async (t) => {
  const f = await fixture(t);
  const models = {
    ...f.models,
    config: () => ({
      account: { secret: 'do-not-export' },
      backends: {
        codex: { connected: false, email: 'private@example.org' },
        dsh: { connected: false },
      },
    }),
  };
  const server = createModelServer(models, {
    analyses: f.analyses,
    daily: f.daily,
    publicDirectory: f.db.directory,
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(
    () =>
      new Promise((done) => {
        server.closeAllConnections();
        server.close(done);
      }),
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  const diagnostic = await (await fetch(url + '/api/diagnostics')).json();
  assert.equal(diagnostic.schema, 'personastudio.radar-diagnostics/v1');
  assert.ok(!JSON.stringify(diagnostic).includes('private@example'));
  assert.ok(!JSON.stringify(diagnostic).includes(f.db.directory));
  assert.ok(!JSON.stringify(diagnostic).includes('do-not-export'));
  assert.equal(
    (await fetch(url + '/api/data/backups', { method: 'POST' })).status,
    403,
  );
  assert.equal(
    (
      await fetch(url + '/api/data', {
        headers: { Origin: 'https://untrusted.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await (await fetch(url + '/api/onboarding')).json()).needs_setup,
    false,
  );
});

void test('an overlong local socket path fails as a recoverable connection error before opening a socket', async () => {
  await assert.rejects(
    bridgeRequest('/' + 'long'.repeat(40), '/config', {}),
    (error) => error.code === 'connection_unavailable',
  );
});

void test('restore rejects archive path traversal before creating files outside the recovery directory', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-unsafe-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const archive = join(directory, 'unsafe.tar.gz');
  execFileSync(join(personaProject, '.venv/bin/python'), [
    '-c',
    'import tarfile,io,sys; a=tarfile.open(sys.argv[1],"w:gz"); i=tarfile.TarInfo("../escape"); i.size=1; a.addfile(i,io.BytesIO(b"x")); a.close()',
    archive,
  ]);
  assert.throws(
    () => archiveCommand('restore', archive, join(directory, 'new')),
    /could not be verified/,
  );
  await assert.rejects(readFile(join(directory, 'escape')), { code: 'ENOENT' });
});
