import { discussionStatusSchema } from '../../lib/contracts/task.ts';
import { AnalysisError } from '../analyses/contracts.mjs';

export function migrateDiscussions(db) {
  if (db.prepare('PRAGMA user_version').get().user_version >= 3) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`
      CREATE TABLE daily_detail_requests (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES daily_items(id) ON DELETE CASCADE, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE);
      CREATE TABLE discussions (id TEXT PRIMARY KEY, source_key TEXT NOT NULL, topic_key TEXT NOT NULL, daily_item_id TEXT REFERENCES daily_items(id), analysis_id TEXT REFERENCES results(id), created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX idx_discussions_source ON discussions(source_key,created_at DESC);
      CREATE INDEX idx_discussions_topic ON discussions(topic_key,created_at DESC);
      CREATE TABLE discussion_turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES discussions(id) ON DELETE CASCADE, status TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX idx_discussion_turns_status ON discussion_turns(status,created_at);
      CREATE INDEX idx_discussion_turns_conversation ON discussion_turns(conversation_id,created_at);
      CREATE TABLE discussion_requests (key TEXT PRIMARY KEY, request_hash TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES discussion_turns(id) ON DELETE CASCADE);
    `);
    // Upgrade legacy daily semantics without discarding reports, evidence or feedback.
    for (const row of db.prepare('SELECT id,data FROM subscriptions').all()) {
      const v = JSON.parse(row.data);
      v.recommendation_strictness ??= 'balanced';
      db.prepare('UPDATE subscriptions SET data=? WHERE id=?').run(
        JSON.stringify(v),
        row.id,
      );
    }
    for (const row of db.prepare('SELECT id,data FROM jobs').all()) {
      const job = JSON.parse(row.data);
      if (
        job.origin?.daily_run_id &&
        job.origin.trigger !== 'manual' &&
        ['queued', 'running'].includes(job.status)
      ) {
        job.status = 'cancelled';
        job.message = '已切换为按需全文分析；已有内容保留。';
        for (const stage of job.stages)
          if (['running', 'pending'].includes(stage.status))
            stage.status = 'cancelled';
        db.prepare('UPDATE jobs SET status=?,data=? WHERE id=?').run(
          job.status,
          JSON.stringify(job),
          row.id,
        );
        if (job.result_id) {
          const row = db
            .prepare('SELECT data FROM results WHERE id=?')
            .get(job.result_id);
          if (row) {
            const r = JSON.parse(row.data);
            for (const k of ['summary', 'personalization'])
              if (r[k]?.status === 'pending')
                r[k] = {
                  status: 'failed',
                  error: {
                    code: 'cancelled',
                    message: job.message,
                    retryable: true,
                  },
                };
            db.prepare('UPDATE results SET data=? WHERE id=?').run(
              JSON.stringify(r),
              job.result_id,
            );
          }
        }
      }
    }
    for (const row of db.prepare('SELECT id,data FROM daily_items').all()) {
      const item = JSON.parse(row.data);
      if (!item.screening_version_id) continue;
      const screen = db
        .prepare('SELECT data FROM daily_item_versions WHERE id=?')
        .get(item.screening_version_id);
      if (item.decision_basis !== 'full_text') {
        const outcome = JSON.parse(screen.data).data.outcome;
        item.final_decision = outcome === 'needs_fulltext' ? null : outcome;
        item.decision_basis = 'abstract';
      }
      if (item.analysis_id && item.decision_basis === 'full_text')
        item.published_analysis_id = item.analysis_id;
      item.processing_status = 'completed';
      item.error = null;
      item.manual_analysis = false;
      if (!item.job_id) item.details_status = 'not_requested';
      db.prepare(
        'UPDATE daily_items SET status=?,decision=?,data=? WHERE id=?',
      ).run(
        item.processing_status,
        item.final_decision,
        JSON.stringify(item),
        row.id,
      );
    }
    for (const row of db.prepare('SELECT id,data FROM daily_runs').all()) {
      const run = JSON.parse(row.data);
      run.legacy_screening = true;
      const items = db
        .prepare('SELECT data FROM daily_items WHERE run_id=?')
        .all(run.id)
        .map((r) => JSON.parse(r.data))
        .filter((i) => !i.excluded);
      const rev =
        run.revision_id &&
        db
          .prepare('SELECT data FROM arxiv_batch_revisions WHERE id=?')
          .get(run.revision_id);
      if (
        rev &&
        JSON.parse(rev.data).completeness === 'complete' &&
        items.every((i) => i.screening_version_id) &&
        run.status !== 'cancelled'
      ) {
        run.status = 'completed';
        run.error = null;
        run.message = '旧版初筛已完成；详细分析改为按需开启。';
      }
      db.prepare('UPDATE daily_runs SET status=?,data=? WHERE id=?').run(
        run.status,
        JSON.stringify(run),
        row.id,
      );
    }
    db.exec('PRAGMA user_version = 3; COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
const decode = (row) => (row ? JSON.parse(row.data) : null);
export class DiscussionRepository {
  constructor(analysisDb) {
    this.analysisDb = analysisDb;
    this.db = analysisDb.db;
  }
  conversation(id) {
    const v = decode(
      this.db.prepare('SELECT data FROM discussions WHERE id=?').get(id),
    );
    if (!v) throw new AnalysisError('not_found', '讨论不存在。', false, 404);
    return v;
  }
  save(c) {
    this.db
      .prepare(
        'INSERT INTO discussions VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(
        c.id,
        c.source_key,
        c.topic_key,
        c.daily_item_id ?? null,
        c.analysis_id ?? null,
        c.created_at,
        JSON.stringify(c),
      );
  }
  related(sourceKey) {
    return this.db
      .prepare(
        'SELECT data FROM discussions WHERE source_key=? ORDER BY created_at DESC',
      )
      .all(sourceKey)
      .map(decode);
  }
  topic(key) {
    return decode(
      this.db
        .prepare(
          'SELECT data FROM discussions WHERE topic_key=? ORDER BY created_at DESC LIMIT 1',
        )
        .get(key),
    );
  }
  turn(id) {
    const v = decode(
      this.db.prepare('SELECT data FROM discussion_turns WHERE id=?').get(id),
    );
    if (!v)
      throw new AnalysisError('not_found', '讨论消息不存在。', false, 404);
    return v;
  }
  turns(id) {
    return this.db
      .prepare(
        'SELECT data FROM discussion_turns WHERE conversation_id=? ORDER BY created_at,rowid',
      )
      .all(id)
      .map(decode);
  }
  saveTurn(t) {
    discussionStatusSchema.parse(t.status);
    this.db
      .prepare(
        'INSERT INTO discussion_turns VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data',
      )
      .run(t.id, t.conversation_id, t.status, t.created_at, JSON.stringify(t));
  }
  queued() {
    return this.queuedAll(1)[0] ?? null;
  }
  queuedAll(limit = 100) {
    return this.db
      .prepare(
        "SELECT data FROM discussion_turns WHERE status='queued' ORDER BY created_at,rowid LIMIT ?",
      )
      .all(limit)
      .map(decode);
  }
  existing(key, h) {
    const r = this.db
      .prepare('SELECT * FROM discussion_requests WHERE key=?')
      .get(key);
    if (r && r.request_hash !== h)
      throw new AnalysisError(
        'conflict',
        '请求标识已用于其他消息。',
        false,
        409,
      );
    return r ? this.turn(r.turn_id) : null;
  }
  request(key, h, id) {
    this.db
      .prepare('INSERT INTO discussion_requests VALUES (?,?,?)')
      .run(key, h, id);
  }
  delete(id) {
    this.db.prepare('DELETE FROM discussions WHERE id=?').run(id);
  }
}
