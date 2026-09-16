#!/usr/bin/env node
/** Exercise the built application in an empty temporary home without model calls. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { start, stop, status } from '../apps/paper-radar/scripts/launcher.mjs';

const home = await mkdtemp(join(tmpdir(), 'personastudio-radar smoke-'));
const env = {
  ...process.env,
  PAPER_RADAR_HOME: home,
  PAPER_RADAR_STORAGE_DIR: join(home, 'data'),
  PAPER_RADAR_DATA_DIR: join(home, 'models'),
  PAPER_RADAR_PERSONA_CONFIG: join(home, 'data/persona.json'),
  PAPER_RADAR_CODEX_BIN: join(home, 'no-model-binary'),
  AI_PERSONA_CONFIG: join(home, 'no-persona-config.toml'),
};
let recoveredEnv;
try {
  const started = await start({ env, port: 0, open: false });
  assert.equal(started.running, true);
  assert.equal((await status({ env })).instance_id, started.instance_id);
  assert.equal((await start({ env, open: false })).pid, started.pid);
  assert.equal((await fetch(started.url)).status, 200);
  const setup = await (
    await fetch(new URL('/api/onboarding', started.url))
  ).json();
  assert.equal(setup.needs_setup, true);
  const post = async (path, body = {}) => {
    const response = await fetch(new URL(path, started.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Paper-Radar': '1' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    return data;
  };
  const backup = await post('/api/data/backups');
  const restored = await post('/api/data/restore', { id: backup.id });
  assert.equal(restored.automatic_checks_paused, true);
  assert.notEqual(restored.directory, join(home, 'data'));
  recoveredEnv = {
    ...env,
    PAPER_RADAR_HOME: join(restored.directory, '.app'),
    PAPER_RADAR_STORAGE_DIR: restored.directory,
    PAPER_RADAR_DATA_DIR: join(restored.directory, '.app/models'),
    PAPER_RADAR_PERSONA_CONFIG: join(restored.directory, 'persona.json'),
  };
  const recovered = await post('/api/data/open-restored', { id: restored.id });
  assert.notEqual(recovered.port, started.port);
  assert.equal((await fetch(recovered.url)).status, 200);
  await stop({ env: recoveredEnv });
  const data = await (await fetch(new URL('/api/data', started.url))).json();
  assert.equal(data.counts.jobs, 0);
  assert.equal(data.counts.subscriptions, 0);
  await stop({ env });
  assert.equal((await status({ env })).running, false);
  const again = await start({ env, port: 0, open: false });
  assert.notEqual(again.instance_id, started.instance_id);
  assert.equal(
    (await (await fetch(new URL('/api/data', again.url))).json()).backups
      .length,
    1,
  );
  console.log(
    'Built application: start, reuse, first use, backup, restore, stop and restart passed. No models called.',
  );
} catch (error) {
  console.error(
    await readFile(join(home, 'data/.runtime/server.log'), 'utf8').catch(
      () => 'No server log',
    ),
  );
  if (recoveredEnv)
    console.error(
      await readFile(
        join(recoveredEnv.PAPER_RADAR_STORAGE_DIR, '.runtime/server.log'),
        'utf8',
      ).catch(() => 'No recovered log'),
    );
  throw error;
} finally {
  if (recoveredEnv) await stop({ env: recoveredEnv }).catch(() => {});
  await stop({ env }).catch(() => {});
  await rm(home, { recursive: true, force: true });
}
