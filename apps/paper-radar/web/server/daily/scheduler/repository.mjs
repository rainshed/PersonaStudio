import { randomUUID } from 'node:crypto';
import { AnalysisError } from '../../analyses/contracts.mjs';

export function migrateScheduler(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 5) return;
  db.exec(`BEGIN;
    CREATE TABLE daily_schedules (subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id), enabled INTEGER NOT NULL, revision INTEGER NOT NULL, next_check_at TEXT, data TEXT NOT NULL);
    CREATE INDEX idx_schedules_due ON daily_schedules(enabled,next_check_at);
    CREATE TABLE schedule_checks (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id), status TEXT NOT NULL, created_at TEXT NOT NULL, cycle_key TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE INDEX idx_schedule_checks_sub ON schedule_checks(subscription_id,created_at DESC);
    CREATE UNIQUE INDEX idx_schedule_active ON schedule_checks(subscription_id) WHERE status IN ('queued','checking');
    CREATE TABLE schedule_requests (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, target_id TEXT NOT NULL);
    CREATE TABLE schedule_source_cursors (subscription_id TEXT NOT NULL REFERENCES subscriptions(id), scope_key TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(subscription_id,scope_key));
    CREATE TABLE schedule_updates (id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL REFERENCES subscriptions(id), scope_key TEXT NOT NULL, date TEXT NOT NULL, content_hash TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(subscription_id,scope_key,date,content_hash));
    CREATE INDEX idx_schedule_updates_sub ON schedule_updates(subscription_id,created_at DESC);
    CREATE TABLE automatic_attempt_reservations (attempt_id TEXT PRIMARY KEY, subscription_id TEXT NOT NULL, run_id TEXT NOT NULL, item_id TEXT, reserved_at TEXT NOT NULL, status TEXT NOT NULL);
    CREATE INDEX idx_auto_reservations_window ON automatic_attempt_reservations(subscription_id,reserved_at);
    PRAGMA user_version=5; COMMIT;`);
}
const decode = (row) => (row ? JSON.parse(row.data) : null);
export class ScheduleRepository {
  constructor(daily, clock = Date.now) {
    this.daily = daily;
    this.db = daily.repo.db;
    this.clock = clock;
  }
  now() {
    return new Date(this.clock()).toISOString();
  }
  tx(fn) {
    return this.daily.repo.analysisDb.transaction(fn);
  }
  schedule(id) {
    return decode(
      this.db
        .prepare('SELECT data FROM daily_schedules WHERE subscription_id=?')
        .get(id),
    );
  }
  saveSchedule(s) {
    this.db
      .prepare(
        'INSERT INTO daily_schedules VALUES (?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET enabled=excluded.enabled,revision=excluded.revision,next_check_at=excluded.next_check_at,data=excluded.data',
      )
      .run(
        s.subscription_id,
        Number(s.enabled),
        s.revision,
        s.next_check_at,
        JSON.stringify(s),
      );
    return s;
  }
  getCheck(id) {
    const c = decode(
      this.db.prepare('SELECT data FROM schedule_checks WHERE id=?').get(id),
    );
    if (!c)
      throw new AnalysisError('not_found', '检查记录不存在。', false, 404);
    return c;
  }
  saveCheck(c) {
    this.db
      .prepare(
        'INSERT INTO schedule_checks VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data',
      )
      .run(
        c.id,
        c.subscription_id,
        c.status,
        c.created_at,
        c.cycle_key,
        JSON.stringify(c),
      );
    return c;
  }
  active(id) {
    return decode(
      this.db
        .prepare(
          "SELECT data FROM schedule_checks WHERE subscription_id=? AND status IN ('queued','checking')",
        )
        .get(id),
    );
  }
  checks(id, limit = 25, offset = 0) {
    return this.db
      .prepare(
        'SELECT data FROM schedule_checks WHERE subscription_id=? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?',
      )
      .all(id, limit, offset)
      .map(decode);
  }
  request(key, digest) {
    const r = this.db
      .prepare('SELECT * FROM schedule_requests WHERE key=?')
      .get(key);
    if (r && r.request_hash !== digest)
      throw new AnalysisError(
        'conflict',
        '该操作标识已用于其他参数。',
        false,
        409,
      );
    return r?.target_id;
  }
  addRequest(key, digest, id) {
    this.db
      .prepare('INSERT INTO schedule_requests VALUES (?,?,?)')
      .run(key, digest, id);
  }
  cursor(id, scope) {
    return decode(
      this.db
        .prepare(
          'SELECT data FROM schedule_source_cursors WHERE subscription_id=? AND scope_key=?',
        )
        .get(id, scope),
    );
  }
  saveCursor(id, scope, c) {
    this.db
      .prepare(
        'INSERT INTO schedule_source_cursors VALUES (?,?,?) ON CONFLICT(subscription_id,scope_key) DO UPDATE SET data=excluded.data',
      )
      .run(id, scope, JSON.stringify(c));
  }
  updateFor(id, scope, date, digest) {
    return decode(
      this.db
        .prepare(
          'SELECT data FROM schedule_updates WHERE subscription_id=? AND scope_key=? AND date=? AND content_hash=?',
        )
        .get(id, scope, date, digest),
    );
  }
  getUpdate(id) {
    const u = decode(
      this.db.prepare('SELECT data FROM schedule_updates WHERE id=?').get(id),
    );
    if (!u)
      throw new AnalysisError('not_found', '来源更新记录不存在。', false, 404);
    return u;
  }
  saveUpdate(u) {
    this.db
      .prepare(
        'INSERT INTO schedule_updates VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data',
      )
      .run(
        u.id,
        u.subscription_id,
        u.scope_key,
        u.date,
        u.content_hash,
        u.status,
        u.created_at,
        JSON.stringify(u),
      );
    return u;
  }
  updates(id, limit = 25, offset = 0, needsAction = false) {
    return this.db
      .prepare(
        `SELECT u.data FROM schedule_updates u
         LEFT JOIN daily_runs r ON r.id=json_extract(u.data,'$.run_id')
         WHERE u.subscription_id=? ${needsAction ? "AND u.status!='dismissed' AND (u.status IN ('blocked_budget','blocked_configuration') OR r.status IN ('paused','failed','partial','interrupted','cancelled'))" : ''}
         ORDER BY u.created_at DESC,u.rowid DESC LIMIT ? OFFSET ?`,
      )
      .all(id, limit, offset)
      .map(decode);
  }
  used(id) {
    return this.db
      .prepare(
        "SELECT count(*) AS n FROM automatic_attempt_reservations WHERE subscription_id=? AND reserved_at>? AND status!='released'",
      )
      .get(id, new Date(this.clock() - 86400000).toISOString()).n;
  }
  remaining(id) {
    const sub = this.daily.repo.get('subscriptions', id),
      s = this.schedule(id);
    return Math.max(
      0,
      (s?.max_model_calls_24h ?? sub.max_model_calls) - this.used(id),
    );
  }
  reserve(run, item, attempt) {
    const id = attempt?.id ?? randomUUID();
    this.tx(() => {
      if (
        this.db
          .prepare(
            'SELECT 1 FROM automatic_attempt_reservations WHERE attempt_id=?',
          )
          .get(id)
      )
        throw new AnalysisError('conflict', '模型尝试标识已使用。', false, 409);
      if (this.remaining(run.subscription.id) <= 0)
        throw new AnalysisError(
          'budget_exceeded',
          '过去 24 小时自动调用额度已用完，请调整额度后明确继续。',
          false,
        );
      this.daily.repo.reserveInside(run.id);
      this.db
        .prepare(
          'INSERT INTO automatic_attempt_reservations VALUES (?,?,?,?,?,?)',
        )
        .run(id, run.subscription.id, run.id, item.id, this.now(), 'reserved');
    });
    return id;
  }
  record(id) {
    this.db
      .prepare(
        "UPDATE automatic_attempt_reservations SET status='recorded' WHERE attempt_id=?",
      )
      .run(id);
  }
  markDeleted(reportId) {
    const ids = new Set(
      this.daily.repo.runs({ reportId, limit: 10000 }).map((r) => r.id),
    );
    for (const row of this.db
      .prepare('SELECT data FROM schedule_updates')
      .all()) {
      const u = decode(row);
      if (ids.has(u.run_id))
        this.saveUpdate({ ...u, status: 'dismissed', run_id: null });
    }
  }
}
