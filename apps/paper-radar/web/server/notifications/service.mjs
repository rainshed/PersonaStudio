import { AnalysisError } from '../analyses/contracts.mjs';

export function migrateNotifications(db) {
  // Triggers record a status transition in the same transaction as the result.
  // Existing history is deliberately not turned into new notifications.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, task_id TEXT NOT NULL,
      target_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, read_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(read_at,id);
    CREATE TABLE IF NOT EXISTS notification_deliveries (
      device_id TEXT NOT NULL, notification_id INTEGER NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
      PRIMARY KEY(device_id,notification_id)
    );
  `);
  for (const [table, kind, target, title] of [
    [
      'jobs',
      'analysis',
      'NEW.id',
      "COALESCE(json_extract(NEW.data,'$.paper_title'),json_extract(NEW.data,'$.input.arxiv_input'),'')",
    ],
    [
      'daily_runs',
      'daily',
      'NEW.id',
      "COALESCE(json_extract(NEW.data,'$.subscription.name'),json_extract(NEW.data,'$.date'),'')",
    ],
    [
      'discussion_turns',
      'discussion',
      'NEW.conversation_id',
      "COALESCE((SELECT COALESCE(json_extract(data,'$.paper.title'),json_extract(data,'$.title')) FROM discussions WHERE id=NEW.conversation_id),'')",
    ],
  ]) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS notify_${table}_terminal AFTER UPDATE OF status ON ${table}
      WHEN OLD.status IN ('queued','running') AND NEW.status IN ('succeeded','completed','partial','failed','interrupted','paused','cancelled')
      ${table === 'jobs' ? "AND (json_extract(NEW.data,'$.origin.daily_run_id') IS NULL OR json_extract(NEW.data,'$.origin.trigger')='manual')" : ''}
      BEGIN
        INSERT INTO notifications(kind,task_id,target_id,title,status,created_at)
        VALUES ('${kind}',NEW.id,${target},${title},NEW.status,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
      END;
      CREATE TRIGGER IF NOT EXISTS notify_${table}_deleted AFTER DELETE ON ${table}
      BEGIN DELETE FROM notifications WHERE kind='${kind}' AND task_id=OLD.id; END;
    `);
  }
  db.exec('PRAGMA user_version = 7');
}
const integer = (raw, fallback = 0) => {
  const value = raw === undefined || raw === null ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new AnalysisError('invalid_request', '通知分页参数无效。');
  return value;
};
function idsOf(raw) {
  if (
    !Array.isArray(raw) ||
    raw.length > 100 ||
    raw.some((n) => !Number.isSafeInteger(n) || n < 1)
  )
    throw new AnalysisError('invalid_request', '通知编号无效。');
  return [...new Set(raw)];
}
export class NotificationService {
  constructor(analysisDb) {
    this.store = analysisDb;
    this.db = analysisDb.db;
  }
  list(query = {}) {
    const limit = Math.min(integer(query.limit, 40), 100);
    if (!limit)
      throw new AnalysisError('invalid_request', '通知分页参数无效。');
    const latest =
      this.db
        .prepare("SELECT seq FROM sqlite_sequence WHERE name='notifications'")
        .get()?.seq ?? 0;
    const after = query.after === undefined ? null : integer(query.after),
      before = integer(query.before, Number.MAX_SAFE_INTEGER);
    const items =
      after === null
        ? this.db
            .prepare(
              'SELECT * FROM notifications WHERE id < ? ORDER BY id DESC LIMIT ?',
            )
            .all(before, limit)
        : this.db
            .prepare(
              'SELECT * FROM notifications WHERE id > ? ORDER BY id ASC LIMIT ?',
            )
            .all(after, limit);
    for (const item of items) {
      if (item.kind === 'analysis')
        item.href = '#single-analysis?job=' + encodeURIComponent(item.task_id);
      else if (item.kind === 'evaluation') {
        item.href = '#evaluations';
        const suite = this.db
          .prepare(`
          SELECT suites.data FROM evaluation_runs AS runs
          JOIN evaluation_suites AS suites ON suites.id=json_extract(runs.data,'$.suite_id')
          WHERE runs.id=?
        `)
          .get(item.task_id);
        const data = suite ? JSON.parse(suite.data) : null;
        item.title_is_default =
          data?.automatic === true && item.title === '我的推荐测试集';
      } else if (item.kind === 'discussion')
        item.href =
          '#single-analysis?discussion=' + encodeURIComponent(item.target_id);
      else {
        const run = this.db
          .prepare('SELECT data FROM daily_runs WHERE id=?')
          .get(item.task_id);
        const subscription = run ? JSON.parse(run.data).subscription?.id : '';
        item.href =
          '#daily?' +
          new URLSearchParams({
            run: item.target_id,
            subscription: subscription ?? '',
          });
      }
    }
    return {
      items,
      unread_count: this.db
        .prepare('SELECT count(*) n FROM notifications WHERE read_at IS NULL')
        .get().n,
      latest_id: latest,
      cursor:
        after === null || items.length < limit
          ? latest
          : Math.min(latest, items.at(-1)?.id ?? after),
      next_before:
        after === null && items.length === limit ? items.at(-1).id : null,
    };
  }
  read(raw) {
    if (!raw || typeof raw !== 'object')
      throw new AnalysisError('invalid_request', '通知参数无效。');
    const now = new Date().toISOString();
    if (raw.through_id !== undefined) {
      const through = integer(raw.through_id);
      this.db
        .prepare(
          'UPDATE notifications SET read_at=? WHERE id<=? AND read_at IS NULL',
        )
        .run(now, through);
    } else {
      const ids = idsOf(raw.ids);
      this.store.transaction(() => {
        for (const id of ids)
          this.db
            .prepare(
              'UPDATE notifications SET read_at=? WHERE id=? AND read_at IS NULL',
            )
            .run(now, id);
      });
    }
    return this.list();
  }
  claim(raw) {
    if (
      !raw ||
      typeof raw.device_id !== 'string' ||
      !/^[a-zA-Z0-9-]{16,100}$/.test(raw.device_id)
    )
      throw new AnalysisError('invalid_request', '通知设备标识无效。');
    const ids = idsOf(raw.ids),
      claimed = [];
    this.store.transaction(() => {
      for (const id of ids) {
        const n = this.db
          .prepare(
            "SELECT id FROM notifications WHERE id=? AND read_at IS NULL AND status!='cancelled'",
          )
          .get(id);
        if (
          n &&
          this.db
            .prepare(
              'INSERT OR IGNORE INTO notification_deliveries VALUES (?,?)',
            )
            .run(raw.device_id, id).changes
        )
          claimed.push(id);
      }
    });
    return { claimed };
  }
}
