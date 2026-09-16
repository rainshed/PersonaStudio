import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  analysisInputSchema,
  subscriptionSchema,
} from '../lib/contracts/analysis.ts';
import { isBinaryDecision, taskPresentation } from '../lib/contracts/task.ts';
import { validateInput } from '../server/analyses/contracts.mjs';
import { AnalysisDatabase } from '../server/analyses/database.mjs';
import {
  DATABASE_VERSION,
  MIGRATIONS,
  migrateDatabase,
} from '../server/storage/migrations.mjs';

void test('shared input rules retain defaults and the server adds paper/scope ownership semantics', () => {
  const input = {
    arxiv_input: '2501.12903v2',
    scope: { tag_ids: [] },
    language: 'zh',
    summary_length: { min: 200, max: 400 },
  };
  const parsed = analysisInputSchema.parse(input);
  assert.equal(parsed.recommendation_strictness, 'balanced');
  assert.equal(
    validateInput(input).arxiv_input,
    'https://arxiv.org/abs/2501.12903v2',
  );
  assert.throws(
    () => validateInput({ ...input, scope: { tag_ids: ['private'] } }),
    { code: 'invalid_settings' },
  );
  assert.equal(
    subscriptionSchema.safeParse({
      name: 'Test',
      subjects: ['quant-ph'],
      ...parsed,
      arxiv_input: undefined,
    }).success,
    false,
  );
  assert.equal(isBinaryDecision('needs_fulltext'), false);
  assert.equal(isBinaryDecision('undetermined'), false);
  assert.equal(isBinaryDecision(undefined), false);
  assert.equal(taskPresentation('partial').successful, false);
  assert.equal(taskPresentation('paused').retryable, true);
});

void test('schema upgrades back up the complete old SQLite state and never rewind a newer schema', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let db = await new AnalysisDatabase(directory).open();
  db.putCache('proof', 'test', { retained: true });
  db.db.exec('PRAGMA user_version=7');
  await db.close();
  db = await new AnalysisDatabase(directory).open();
  assert.equal(
    db.db.prepare('PRAGMA user_version').get().user_version,
    DATABASE_VERSION,
  );
  const files = await readdir(join(directory, 'backups'));
  assert.equal(files.length, 1);
  const backup = join(directory, 'backups', files[0]);
  assert.equal((await stat(backup)).mode & 0o777, 0o600);
  const prior = new DatabaseSync(backup, { readOnly: true });
  assert.equal(prior.prepare('PRAGMA user_version').get().user_version, 7);
  assert.deepEqual(
    JSON.parse(
      prior.prepare('SELECT data FROM cache WHERE key=?').get('proof').data,
    ),
    { retained: true },
  );
  prior.close();
  db.db.exec(`PRAGMA user_version=${DATABASE_VERSION + 1}`);
  await db.close();
  await assert.rejects(new AnalysisDatabase(directory).open(), /版本高于/);
  const untouched = new DatabaseSync(join(directory, 'radar.sqlite'), {
    readOnly: true,
  });
  assert.equal(
    untouched.prepare('PRAGMA user_version').get().user_version,
    DATABASE_VERSION + 1,
  );
  untouched.close();
});

void test('a failed migration ledger write rolls back the schema version and can be retried', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const migration of MIGRATIONS.filter((item) => item.version < 9))
      migration.apply(db);
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT);
      CREATE TRIGGER reject_ledger BEFORE INSERT ON schema_migrations BEGIN SELECT RAISE(ABORT, 'ledger unavailable'); END;`);
    assert.throws(() => migrateDatabase(db), /ledger unavailable/);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 8);
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count,
      0,
    );
    db.exec('DROP TRIGGER reject_ledger');
    migrateDatabase(db);
    assert.equal(
      db.prepare('PRAGMA user_version').get().user_version,
      DATABASE_VERSION,
    );
    assert.equal(
      db.prepare('SELECT count(*) AS count FROM schema_migrations').get().count,
      DATABASE_VERSION,
    );
    assert.equal(
      db
        .prepare('SELECT applied_at FROM schema_migrations WHERE version=1')
        .get().applied_at,
      null,
    );
  } finally {
    db.close();
  }
});
