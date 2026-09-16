import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createModelServer } from '../server/index.mjs';
import { HostModelService } from '../server/hosts/service.mjs';
import {
  backendFromSettings,
  requireHostSettings,
} from '../server/hosts/execution.mjs';
import { fixture } from './helpers/daily-fixture.mjs';
import { DshOperations } from '../server/integrations/dsh/operations.mjs';
import { DiscussionService } from '../server/discussions/service.mjs';

void test('removed credential and direct generation endpoints cannot invoke either host', async (t) => {
  let invocations = 0;
  const service = {
    config: () => ({ mode: 'host-router' }),
    run() {
      invocations++;
    },
    saveAccount() {
      invocations++;
    },
  };
  const server = createModelServer(service, { publicDirectory: '.' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const path of [
    'accounts',
    'accounts/remove',
    'accounts/disconnect',
    'accounts/auth/start',
    'connections',
    'remove',
    'disconnect',
    'generate',
    'test',
    'auth/start',
    'auth/answer',
    'auth/cancel',
  ]) {
    const response = await fetch(`${base}/api/models/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-paper-radar': '1' },
      body: '{}',
    });
    assert.equal(response.status, 404, path);
  }
  assert.equal((await fetch(`${base}/api/models/auth/old-login`)).status, 404);
  assert.equal(invocations, 0);
});

void test('old DSH selection and frozen snapshots keep their host without reviving unsupported snapshots', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-host-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, 'backend.json'),
    JSON.stringify({ activeBackend: 'harness', revision: 7 }),
  );
  let calls = 0;
  const host = () => ({
    open() {},
    close() {},
    concurrency: 4,
    config: () => ({ connected: true }),
    runAgent() {
      calls++;
    },
  });
  const router = await new HostModelService({
    directory,
    dsh: host(),
    codex: host(),
    defaultBackend: 'codex',
  }).open();
  t.after(() => router.close());
  assert.equal(router.activeBackend, 'dsh');
  assert.equal(router.revision, 7);
  const old = {
    harness: { protocol: 'paper-radar-harness/v1' },
    connections: [],
  };
  assert.equal(backendFromSettings(old), 'dsh');
  assert.equal(requireHostSettings(old).dsh.protocol, old.harness.protocol);
  assert.equal(old.dsh, undefined);
  assert.equal(router.executionPoolForSettings({ connections: [] }), null);
  assert.equal(router.concurrencyForSettings({ connections: [] }), 1);
  assert.throws(() => router.runAgent({}, { settings: { connections: [] } }), {
    code: 'legacy_model_snapshot',
  });
  assert.equal(calls, 0);
});

void test('unsupported historical analysis retries keep the old record and never snapshot the new host', async (t) => {
  const f = await fixture(t, { count: 1 });
  const old = {
    id: 'old-model-job',
    status: 'interrupted',
    input: {
      arxiv_input: '2501.10000v1',
      language: 'zh',
      scope: { tag_ids: [], tag_match: 'any' },
      summary_length: { min: 200, max: 400 },
    },
    created_at: new Date().toISOString(),
    stages: [],
    model_settings: { connections: [] },
  };
  f.db.insertJob(old, 'historical-job-request', 'old-hash');
  assert.throws(() => f.analyses.retry(old.id, 'retry-historical-job'), {
    code: 'unsupported_host_snapshot',
  });
  assert.deepEqual(f.db.job(old.id).model_settings, old.model_settings);
  assert.equal(f.db.listJobs().length, 1);
  assert.equal(f.calls, 0);
});

void test('DSH integration migration retains operation idempotency and conversation links', async (t) => {
  const f = await fixture(t, { count: 1 });
  f.db.db.exec(
    'CREATE TABLE harness_requests (id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, session_id TEXT, runtime_id TEXT, created_at TEXT NOT NULL, response TEXT)',
  );
  f.db.db
    .prepare('INSERT INTO harness_requests VALUES (?,?,?,?,?,?)')
    .run(
      'old-request',
      'hash',
      'session',
      'runtime',
      '2026-09-01',
      JSON.stringify({ card: { id: 'saved-job' } }),
    );
  const discussions = new DiscussionService(f.analyses, f.daily);
  t.after(() => discussions.close());
  const operations = new DshOperations({
    analyses: f.analyses,
    daily: f.daily,
    discussions,
    models: f.models,
  });
  const value = await operations.dispatch({
    operation: 'session-links',
    host: { sessionId: 'session' },
  });
  assert.equal(value.links[0].card.id, 'saved-job');
  assert.equal(
    f.db.db.prepare('SELECT count(*) AS n FROM dsh_requests').get().n,
    1,
  );
});

void test('shared contracts contain no network, filesystem, host SDK or application runtime dependency', async () => {
  const root = new URL('../../packages/host-contract/', import.meta.url);
  const manifest = JSON.parse(
    await readFile(new URL('package.json', root), 'utf8'),
  );
  assert.deepEqual(manifest.dependencies ?? {}, {});
  for (const path of Object.values(manifest.exports)) {
    const code = await readFile(new URL(path, root), 'utf8');
    assert.doesNotMatch(
      code,
      /from\s+['"](?:node:|@deepseek|.*web\/|.*plugins\/)/,
    );
    assert.doesNotMatch(code, /bridgeRequest|defaultSocket|selectRoute\s*\(/);
  }
});
