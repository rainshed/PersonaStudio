import { recoverAnalyses } from '../tasks/recovery.mjs';
import { analysisStatusSchema } from '../../lib/contracts/task.ts';
import {
  DATABASE_VERSION,
  databaseVersion,
  migrateDatabase,
} from './migrations.mjs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, chmod, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AnalysisError } from '../analyses/contracts.mjs';

const decode = (row) => (row ? JSON.parse(row.data) : null);
export class RadarDatabase {
  constructor(directory) {
    this.directory = directory;
  }
  async open() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    this.lockPath = join(this.directory, 'analysis.lock');
    try {
      this.lock = await open(this.lockPath, 'wx', 0o600);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(
        await readFile(this.lockPath, 'utf8').catch(() => '0'),
      );
      if (!pid) throw new Error('分析数据目录已锁定');
      try {
        process.kill(pid, 0);
        throw new Error('另一个分析服务正在使用此目录');
      } catch (e) {
        if (e.code !== 'ESRCH') throw e;
      }
      await unlink(this.lockPath);
      this.lock = await open(this.lockPath, 'wx', 0o600);
    }
    try {
      await this.lock.writeFile(String(process.pid));
      this.db = new DatabaseSync(join(this.directory, 'radar.sqlite'), {
        timeout: 5000,
      });
      await chmod(join(this.directory, 'radar.sqlite'), 0o600);
      this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
      const version = databaseVersion(this.db);
      if (version > DATABASE_VERSION)
        throw new Error('分析数据库版本高于当前应用');
      // A SQLite-consistent backup includes WAL contents and precedes any schema
      // change. Existing user data is never overwritten by a rollback attempt.
      if (version > 0 && version < DATABASE_VERSION) {
        const backups = join(this.directory, 'backups');
        await mkdir(backups, { recursive: true, mode: 0o700 });
        const backup = join(
          backups,
          `before-v${DATABASE_VERSION}-${randomUUID()}.sqlite`,
        );
        this.db.prepare('VACUUM INTO ?').run(backup);
        await chmod(backup, 0o600);
      }
      this.migration = migrateDatabase(this.db);
      this.db.exec('PRAGMA optimize;');
      recoverAnalyses(this);
      return this;
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  existing(key) {
    const row =
      this.db
        .prepare('SELECT data, request_hash FROM jobs WHERE idempotency=?')
        .get(key) ??
      this.db
        .prepare(
          'SELECT jobs.data, aliases.request_hash FROM job_request_aliases aliases JOIN jobs ON jobs.id=aliases.job_id WHERE aliases.key=?',
        )
        .get(key);
    return row ? { job: decode(row), hash: row.request_hash } : null;
  }
  aliasRequest(key, jobId, requestHash) {
    this.db
      .prepare('INSERT INTO job_request_aliases VALUES (?,?,?)')
      .run(key, jobId, requestHash);
  }
  insertJob(job, key, requestHash) {
    analysisStatusSchema.parse(job.status);
    this.db
      .prepare('INSERT INTO jobs VALUES (?,?,?,?,?,?)')
      .run(
        job.id,
        job.status,
        job.created_at,
        key,
        requestHash,
        JSON.stringify(job),
      );
  }
  saveJob(job) {
    analysisStatusSchema.parse(job.status);
    job.updated_at = new Date().toISOString();
    this.db
      .prepare('UPDATE jobs SET status=?, data=? WHERE id=?')
      .run(job.status, JSON.stringify(job), job.id);
  }
  job(id) {
    return decode(this.db.prepare('SELECT data FROM jobs WHERE id=?').get(id));
  }
  listJobs(limit = 25, offset = 0) {
    return this.db
      .prepare(
        'SELECT data FROM jobs ORDER BY created_at DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset)
      .map(decode);
  }
  queued() {
    return this.queuedAll(1)[0] ?? null;
  }
  queuedAll(limit = 100) {
    return this.db
      .prepare(
        "SELECT data FROM jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT ?",
      )
      .all(limit)
      .map(decode);
  }
  result(id) {
    if (!id) return null;
    return decode(
      this.db.prepare('SELECT data FROM results WHERE id=?').get(id),
    );
  }
  saveResult(result) {
    this.db
      .prepare(
        'INSERT INTO results VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(result.id, result.job_id, result.created_at, JSON.stringify(result));
  }
  cache(key) {
    return decode(
      this.db.prepare('SELECT data FROM cache WHERE key=?').get(key),
    );
  }
  putCache(key, kind, data) {
    this.db
      .prepare('INSERT OR REPLACE INTO cache VALUES (?,?,?,?)')
      .run(key, kind, JSON.stringify(data), new Date().toISOString());
  }
  addAttempt(value) {
    this.db
      .prepare('INSERT OR REPLACE INTO attempts VALUES (?,?,?)')
      .run(value.id, value.job_id, JSON.stringify(value));
  }
  attempts(jobId) {
    return this.db
      .prepare('SELECT data FROM attempts WHERE job_id=?')
      .all(jobId)
      .map(decode);
  }
  feedback(id) {
    return Object.fromEntries(
      this.db
        .prepare('SELECT dimension,data FROM feedback WHERE result_id=?')
        .all(id)
        .map((r) => [r.dimension, JSON.parse(r.data)]),
    );
  }
  setFeedback(id, dim, value) {
    if (value)
      this.db
        .prepare('INSERT OR REPLACE INTO feedback VALUES (?,?,?)')
        .run(id, dim, JSON.stringify(value));
    else
      this.db
        .prepare('DELETE FROM feedback WHERE result_id=? AND dimension=?')
        .run(id, dim);
  }
  deleteResult(id) {
    const result = this.result(id);
    if (!result)
      throw new AnalysisError('not_found', '分析结果不存在。', false, 404);
    const job = this.job(result.job_id);
    if (['running', 'queued'].includes(job.status))
      throw new AnalysisError('conflict', '请先取消运行中的任务。', false, 409);
    if (
      this.db
        .prepare('SELECT 1 FROM daily_item_versions WHERE analysis_id=?')
        .get(id) ||
      this.db.prepare('SELECT 1 FROM daily_items WHERE job_id=?').get(job.id)
    )
      throw new AnalysisError(
        'conflict',
        '该分析仍被日报引用，请先删除相关日报。',
        false,
        409,
      );
    this.transaction(() => {
      // Archived discussion content remains intact after its source report is deleted.
      this.db
        .prepare('UPDATE discussions SET analysis_id=NULL WHERE analysis_id=?')
        .run(id);
      this.db.prepare('DELETE FROM results WHERE id=?').run(id);
      this.db.prepare('DELETE FROM jobs WHERE id=?').run(job.id);
    });
  }
  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    if (this.lock) {
      await this.lock.close();
      this.lock = null;
      await unlink(this.lockPath).catch(() => {});
    }
  }
}
