import { migrateDaily } from '../daily/repository.mjs';
import { migrateDiscussions } from '../discussions/repository.mjs';
import { migrateDailyListDecisions } from '../daily/list-decisions.mjs';
import { migrateScheduler } from '../daily/scheduler/repository.mjs';
import { migrateAgentScreening } from '../daily/agent-screening.mjs';
import { migrateNotifications } from '../notifications/service.mjs';
import { migrateEvaluations } from '../evaluations/repository.mjs';
import { migrateEvaluationNotifications } from '../evaluations/notifications.mjs';

function migrateAnalysis(db) {
  db.exec(`BEGIN;
    CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, idempotency TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, data TEXT NOT NULL);
    CREATE INDEX idx_jobs_status_created ON jobs(status,created_at);
    CREATE INDEX idx_jobs_created ON jobs(created_at DESC);
    CREATE TABLE results (id TEXT PRIMARY KEY, job_id TEXT UNIQUE NOT NULL REFERENCES jobs(id), created_at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE feedback (result_id TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE, dimension TEXT NOT NULL CHECK(dimension IN ('accuracy','summary','reason','connections')), data TEXT NOT NULL, PRIMARY KEY(result_id,dimension));
    CREATE TABLE cache (key TEXT PRIMARY KEY, kind TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE attempts (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, data TEXT NOT NULL);
    PRAGMA user_version = 1; COMMIT;`);
}

// Historical migrations retain their transactions and data conversions. All
// ordering/version policy is owned here rather than by an analysis service.
export const MIGRATIONS = [
  { version: 1, name: 'analyses', apply: migrateAnalysis },
  { version: 2, name: 'daily', apply: migrateDaily },
  { version: 3, name: 'on-demand-discussions', apply: migrateDiscussions },
  { version: 4, name: 'screening-decisions', apply: migrateDailyListDecisions },
  { version: 5, name: 'automatic-schedules', apply: migrateScheduler },
  { version: 6, name: 'agent-screening', apply: migrateAgentScreening },
  { version: 7, name: 'task-notifications', apply: migrateNotifications },
  {
    version: 8,
    name: 'replay-evaluations',
    apply(db) {
      db.exec('BEGIN IMMEDIATE');
      try {
        migrateEvaluations(db);
        db.exec('PRAGMA user_version = 8; COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  },
  {
    version: 9,
    name: 'task-queues-and-version-queries',
    apply(db) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(`
      CREATE TABLE IF NOT EXISTS job_request_aliases (
        key TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        request_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_daily_items_run_status ON daily_items(run_id,status);
      CREATE INDEX IF NOT EXISTS idx_attempts_job ON attempts(job_id);
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT
      );
      `);
        migrateEvaluationNotifications(db);
        // Legacy versions predate this ledger; do not invent their timestamps.
        // The ledger and final schema version are committed together.
        for (const migration of MIGRATIONS) {
          if (migration.version > 9) continue;
          db.prepare(
            'INSERT OR IGNORE INTO schema_migrations VALUES (?,?,?)',
          ).run(
            migration.version,
            migration.name,
            migration.version === 9 ? new Date().toISOString() : null,
          );
        }
        db.exec('PRAGMA user_version = 9; COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  },
  {
    version: 10,
    name: 'evaluation-experiment-drafts',
    apply(db) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(
          'CREATE TABLE IF NOT EXISTS evaluation_drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
        );
        db.prepare(
          'INSERT OR IGNORE INTO schema_migrations VALUES (?,?,?)',
        ).run(10, 'evaluation-experiment-drafts', new Date().toISOString());
        db.exec('PRAGMA user_version = 10; COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
  },
];
export const DATABASE_VERSION = MIGRATIONS.at(-1).version;
export const databaseVersion = (db) =>
  db.prepare('PRAGMA user_version').get().user_version;

export function migrateDatabase(db) {
  const initial = databaseVersion(db);
  if (initial > DATABASE_VERSION) throw new Error('分析数据库版本高于当前应用');
  for (const migration of MIGRATIONS) {
    if (migration.version <= databaseVersion(db)) continue;
    migration.apply(db);
    if (databaseVersion(db) !== migration.version)
      throw new Error(`数据库迁移未完成：${migration.name}`);
  }
  return { from: initial, to: DATABASE_VERSION };
}
